import { randomBytes } from "node:crypto";
import type { WalletChallenge, WalletChallengeRequest } from "@llmcrypto/contracts";
import type { AppConfig } from "../config";
import { hmacHex, randomId, randomToken } from "../crypto";
import type { Db } from "../db";
import { ApiError } from "../http";
import { buildEvmMessage, EVM_CHAIN_POLICY, normalizeEvmAddress, verifyEvmSignature } from "./evm";
import { buildTronMessage, normalizeTronAddress, tronChainPolicy, verifyTronSignature } from "./tron";

export interface ChallengeRow {
  id: string;
  purpose: "login" | "link";
  protocol: "evm" | "tron";
  address: string;
  chain_id: string;
  chain_policy: string;
  nonce: string;
  message: string;
  user_id: string | null;
  session_id: string | null;
  expires_at: Date;
}

/** Validates address and chain against policy; returns canonical forms or throws 422. */
export function checkWalletRequest(req: WalletChallengeRequest, config: AppConfig): { address: string; chainPolicy: string } {
  if (req.protocol === "evm") {
    const address = normalizeEvmAddress(req.address);
    if (!address) throw new ApiError("VALIDATION_FAILED", "Invalid address", [{ field: "address", message: "not a valid EVM address" }]);
    if (!config.evmChainIds.includes(req.chainId)) {
      throw new ApiError("VALIDATION_FAILED", "Chain not allowed", [{ field: "chainId", message: "chain is not enabled for sign-in" }]);
    }
    return { address, chainPolicy: EVM_CHAIN_POLICY };
  }
  const address = normalizeTronAddress(req.address);
  if (!address) throw new ApiError("VALIDATION_FAILED", "Invalid address", [{ field: "address", message: "not a valid TRON address" }]);
  if (!config.tronNetworks.includes(req.chainId)) {
    throw new ApiError("VALIDATION_FAILED", "Network not allowed", [{ field: "chainId", message: "network is not enabled for sign-in" }]);
  }
  return { address, chainPolicy: tronChainPolicy(req.chainId) };
}

export async function issueChallenge(
  db: Db,
  config: AppConfig,
  req: WalletChallengeRequest,
  bind: { userId: string; sessionId: string } | null,
): Promise<{ challenge: WalletChallenge; bindingToken: string | null }> {
  const { address, chainPolicy } = checkWalletRequest(req, config);
  const purpose = req.purpose ?? "login";
  const now = config.now();
  const expiresAt = new Date(now.getTime() + config.challengeTtlSeconds * 1000);
  const nonce = randomBytes(16).toString("hex"); // alphanumeric, 128 bits
  const base = { address, domain: config.authDomain, uri: config.authUri, nonce, issuedAt: now, expiresAt, purpose };
  const message = req.protocol === "evm" ? buildEvmMessage({ ...base, chainId: req.chainId }) : buildTronMessage({ ...base, network: req.chainId });
  const id = randomId("chl");
  // Login challenges are bound to the browser that asked for them: the caller receives a random token (set as an HttpOnly,
  // SameSite=Strict cookie by the route), only its keyed digest is stored, and session creation must present it. A challenge id
  // and signature obtained any other way (a leaked id, a relayed signature) cannot start a session. Link challenges are bound to
  // the signed-in session instead.
  const bindingToken = purpose === "login" ? randomToken(32) : null;
  const bindingHash = bindingToken && config.sessionSecret ? hmacHex(config.sessionSecret, `wallet-challenge|${id}|${bindingToken}`) : null;
  await db.query(
    `insert into wallet_challenges (id, purpose, protocol, address, chain_id, chain_policy, nonce, message, user_id, session_id, created_at, expires_at, binding_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, purpose, req.protocol, address, req.chainId, chainPolicy, nonce, message, bind?.userId ?? null, bind?.sessionId ?? null, now, expiresAt, bindingHash],
  );
  return { challenge: { challengeId: id, message, expiresAt: expiresAt.toISOString() }, bindingToken };
}

/**
 * Atomically consumes a challenge (one conditional UPDATE: exactly one concurrent caller wins), then verifies
 * the signature. Consumption is deliberately NOT rolled back on a bad signature: any attempt burns the challenge,
 * so guessing signatures against one nonce is impossible. Every failure is the same CHALLENGE_INVALID.
 */
export async function consumeAndVerify(
  db: Db,
  config: AppConfig,
  challengeId: string,
  signature: string,
  purpose: "login" | "link",
  bind: { userId: string; sessionId: string } | null,
  bindingToken: string | null = null,
): Promise<ChallengeRow> {
  const now = config.now();
  const bindingHash = purpose === "login" ? (bindingToken && config.sessionSecret ? hmacHex(config.sessionSecret, `wallet-challenge|${challengeId}|${bindingToken}`) : "no-binding") : null;
  const rows = await db.query<ChallengeRow>(
    `update wallet_challenges set consumed_at = $2
     where id = $1 and purpose = $3 and consumed_at is null and expires_at > $2
       and ($4::text is null or (user_id = $4 and session_id = $5))
       and ($6::text is null or binding_hash = $6)
     returning id, purpose, protocol, address, chain_id, chain_policy, nonce, message, user_id, session_id, expires_at`,
    [challengeId, now, purpose, bind?.userId ?? null, bind?.sessionId ?? null, bindingHash],
  );
  const row = rows[0];
  const invalid = new ApiError("CHALLENGE_INVALID", "Challenge is expired, consumed or the signature is invalid");
  if (!row) throw invalid;
  const result =
    row.protocol === "evm"
      ? await verifyEvmSignature(row.message, signature, {
          domain: config.authDomain, uri: config.authUri, nonce: row.nonce, address: row.address,
          chainId: row.chain_id, allowedChainIds: config.evmChainIds, now,
        })
      : await verifyTronSignature(row.message, signature, {
          domain: config.authDomain, uri: config.authUri, nonce: row.nonce, address: row.address,
          network: row.chain_id, allowedNetworks: config.tronNetworks, now,
        });
  if (!result.ok) throw invalid;
  return row;
}
