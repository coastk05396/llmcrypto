import { createHash } from "node:crypto";
import { concat, keccak256, recoverAddress, stringToBytes, type Hex } from "viem";
import type { VerifyResult } from "./evm";

/**
 * TRON sign-in. Library: viem@2.57.7 (keccak256 + secp256k1 recovery); base58check implemented here with
 * node:crypto sha256. No TronWeb dependency. SIWE/ERC-4361 does NOT apply: the message is a domain-bound
 * canonical text defined below. Signatures follow TronLink/TronWeb `signMessageV2`:
 *   digest = keccak256("\x19TRON Signed Message:\n" + byteLength(message) + message)
 * recovered with secp256k1 (v = 27/28 or 0/1) and compared as TRON address
 * base58check(0x41 || last20(keccak256(pubkey))).
 */

export const TRON_MESSAGE_PREFIX = "\x19TRON Signed Message:\n";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const sha256 = (b: Uint8Array): Buffer => createHash("sha256").update(b).digest();

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const hex = n === 0n ? "" : n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0");
  const body = Buffer.from(hex, "hex");
  let zeros = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    zeros++;
  }
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

export function tronAddressFromBytes20(addr20: Uint8Array): string {
  const payload = Buffer.concat([Buffer.from([0x41]), addr20]);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

/** Returns the address when it is a valid mainnet-format TRON address (0x41 prefix, valid checksum), else null. */
export function normalizeTronAddress(address: string): string | null {
  const raw = base58Decode(address);
  if (!raw || raw.length !== 25 || raw[0] !== 0x41) return null;
  const payload = raw.subarray(0, 21);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  if (!Buffer.from(raw.subarray(21)).equals(checksum)) return null;
  return tronAddressFromBytes20(raw.subarray(1, 21)) === address ? address : null;
}

export function tronChainPolicy(network: string): string {
  return `tron:${network}`;
}

export interface TronMessageInput {
  address: string;
  network: string;
  domain: string;
  uri: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  purpose: "login" | "link";
}

const iso = (d: Date): string => d.toISOString();

export function buildTronMessage(i: TronMessageInput): string {
  const statement =
    i.purpose === "login"
      ? "Sign in to LLM Gateway. This signature authenticates you; it does not authorize any transaction or payment."
      : "Link this wallet to your LLM Gateway account. This signature does not authorize any transaction or payment.";
  return [
    `${i.domain} wants you to sign in with your TRON account:`,
    i.address,
    "",
    statement,
    "",
    `URI: ${i.uri}`,
    "Version: 1",
    `Network: ${i.network}`,
    `Nonce: ${i.nonce}`,
    `Issued At: ${iso(i.issuedAt)}`,
    `Expiration Time: ${iso(i.expiresAt)}`,
  ].join("\n");
}

export function tronMessageDigest(message: string): Hex {
  const body = stringToBytes(message);
  return keccak256(concat([stringToBytes(TRON_MESSAGE_PREFIX), stringToBytes(String(body.length)), body]));
}

export interface TronExpectation {
  domain: string;
  uri: string;
  nonce: string;
  address: string;
  network: string;
  allowedNetworks: readonly string[];
  now: Date;
}

const SKEW_MS = 60_000;

export async function verifyTronSignature(message: string, signature: string, x: TronExpectation): Promise<VerifyResult> {
  if (!x.allowedNetworks.includes(x.network)) return { ok: false, reason: "network not allowed" };
  const lines = message.split("\n");
  const expect = (i: number, prefix: string): string | null => (lines[i]?.startsWith(prefix) ? lines[i]!.slice(prefix.length) : null);
  if (lines.length !== 11 || lines[0] !== `${x.domain} wants you to sign in with your TRON account:`) return { ok: false, reason: "domain mismatch" };
  if (lines[1] !== x.address) return { ok: false, reason: "address mismatch" };
  if (expect(5, "URI: ") !== x.uri) return { ok: false, reason: "uri mismatch" };
  if (lines[6] !== "Version: 1") return { ok: false, reason: "unsupported version" };
  if (expect(7, "Network: ") !== x.network) return { ok: false, reason: "network mismatch" };
  if (expect(8, "Nonce: ") !== x.nonce) return { ok: false, reason: "nonce mismatch" };
  const issued = Date.parse(expect(9, "Issued At: ") ?? "");
  const expires = Date.parse(expect(10, "Expiration Time: ") ?? "");
  if (Number.isNaN(issued) || Number.isNaN(expires)) return { ok: false, reason: "bad timestamps" };
  if (issued > x.now.getTime() + SKEW_MS) return { ok: false, reason: "issued in the future" };
  if (expires <= x.now.getTime()) return { ok: false, reason: "expired" };

  const sig = signature.startsWith("0x") ? signature : `0x${signature}`;
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return { ok: false, reason: "signature must be 65-byte hex" };
  try {
    const recovered = await recoverAddress({ hash: tronMessageDigest(message), signature: sig as Hex });
    const addr20 = Buffer.from(recovered.slice(2), "hex");
    return tronAddressFromBytes20(addr20) === x.address ? { ok: true } : { ok: false, reason: "signature does not match address" };
  } catch {
    return { ok: false, reason: "signature unrecoverable" };
  }
}
