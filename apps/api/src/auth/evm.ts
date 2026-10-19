import { getAddress, isAddress, recoverMessageAddress, type Hex } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";

/**
 * EVM sign-in per ERC-4361 (SIWE) using viem@2.57.7 for message formatting/parsing and ecrecover.
 * Only externally-owned accounts are verified: ERC-1271/ERC-6492 contract-wallet signatures are NOT accepted
 * (spec: contract wallets need a separately tested policy before being advertised).
 */

export const EVM_CHAIN_POLICY = "eip155";
const CLOCK_SKEW_SECONDS = 60;

export function normalizeEvmAddress(address: string): string | null {
  if (!isAddress(address, { strict: true })) return null; // mixed-case must carry a valid EIP-55 checksum
  return getAddress(address);
}

export interface EvmMessageInput {
  address: string; // canonical (EIP-55)
  chainId: string; // decimal
  domain: string;
  uri: string;
  nonce: string; // alphanumeric, >= 8 chars
  issuedAt: Date;
  expiresAt: Date;
  purpose: "login" | "link";
}

const STATEMENT = {
  login: "Sign in to LLM Gateway. This signature authenticates you; it does not authorize any transaction or payment.",
  link: "Link this wallet to your LLM Gateway account. This signature does not authorize any transaction or payment.",
} as const;

export function buildEvmMessage(i: EvmMessageInput): string {
  return createSiweMessage({
    address: i.address as Hex,
    chainId: Number(i.chainId),
    domain: i.domain,
    uri: i.uri,
    nonce: i.nonce,
    version: "1",
    statement: STATEMENT[i.purpose],
    issuedAt: i.issuedAt,
    expirationTime: i.expiresAt,
  });
}

export interface EvmExpectation {
  domain: string;
  uri: string;
  nonce: string;
  address: string; // canonical
  chainId: string;
  allowedChainIds: readonly string[];
  now: Date;
}
export type VerifyResult = { ok: true } | { ok: false; reason: string };

export async function verifyEvmSignature(message: string, signature: string, x: EvmExpectation): Promise<VerifyResult> {
  const m = parseSiweMessage(message);
  if (!m.address || !m.domain || !m.uri || !m.nonce || m.chainId === undefined || !m.issuedAt || !m.expirationTime) {
    return { ok: false, reason: "message is not a complete ERC-4361 message" };
  }
  if (m.version !== "1") return { ok: false, reason: "unsupported version" };
  if (m.domain !== x.domain) return { ok: false, reason: "domain mismatch" };
  if (m.uri !== x.uri) return { ok: false, reason: "uri mismatch" };
  if (m.nonce !== x.nonce) return { ok: false, reason: "nonce mismatch" };
  if (String(m.chainId) !== x.chainId || !x.allowedChainIds.includes(String(m.chainId))) return { ok: false, reason: "chain not allowed" };
  if (getAddress(m.address) !== x.address) return { ok: false, reason: "address mismatch" };
  const now = x.now.getTime();
  if (m.issuedAt.getTime() > now + CLOCK_SKEW_SECONDS * 1000) return { ok: false, reason: "issued in the future" };
  if (m.expirationTime.getTime() <= now) return { ok: false, reason: "expired" };
  if (m.notBefore && m.notBefore.getTime() > now) return { ok: false, reason: "not yet valid" };
  // Reject any text the parser tolerated but the canonical serializer would not emit.
  const canonical = createSiweMessage({
    address: m.address, chainId: m.chainId, domain: m.domain, uri: m.uri, nonce: m.nonce, version: "1",
    ...(m.statement !== undefined ? { statement: m.statement } : {}),
    issuedAt: m.issuedAt, expirationTime: m.expirationTime,
    ...(m.notBefore ? { notBefore: m.notBefore } : {}),
    ...(m.requestId ? { requestId: m.requestId } : {}),
    ...(m.resources ? { resources: m.resources } : {}),
  });
  if (canonical !== message) return { ok: false, reason: "non-canonical message" };

  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return { ok: false, reason: "signature must be 65-byte hex" };
  try {
    const recovered = await recoverMessageAddress({ message, signature: signature as Hex });
    return recovered === x.address ? { ok: true } : { ok: false, reason: "signature does not match address" };
  } catch {
    return { ok: false, reason: "signature unrecoverable" };
  }
}
