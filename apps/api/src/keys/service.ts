import type { ApiKey, KeyScope } from "@llmcrypto/contracts";
import { keyUnusableReason, type KeyUnusableReason } from "@llmcrypto/domain";
import type { AppConfig } from "../config";
import { hmacHex } from "../crypto";
import type { Db, Queryable } from "../db";

export interface KeyRow {
  id: string;
  account_id: string;
  project_id: string | null;
  name: string;
  prefix: string;
  scopes: KeyScope[];
  model_allowlist: string[];
  spend_cap: string | null;
  expires_at: Date | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export const KEY_COLUMNS = `id, account_id, project_id, name, prefix, scopes, model_allowlist, spend_cap_microusd::text as spend_cap,
  expires_at, created_at, last_used_at, revoked_at`;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const toApiKey = (r: KeyRow): ApiKey => ({
  id: r.id, name: r.name, projectId: r.project_id, prefix: r.prefix, scopes: r.scopes, modelAllowlist: r.model_allowlist,
  spendCapMicrousd: r.spend_cap, expiresAt: iso(r.expires_at), createdAt: r.created_at.toISOString(),
  lastUsedAt: iso(r.last_used_at), revokedAt: iso(r.revoked_at),
});

export async function getKey(q: Queryable, accountId: string, id: string): Promise<KeyRow | undefined> {
  const [r] = await q.query<KeyRow>(`select ${KEY_COLUMNS} from api_keys where id=$1 and account_id=$2`, [id, accountId]);
  return r;
}

export type KeyAuthResult =
  | { ok: true; key: KeyRow }
  | { ok: false; reason: "unknown" | KeyUnusableReason };

const LAST_USED_GRANULARITY_MS = 60_000;

/** Verifies a presented secret against the stored keyed digest, enforces revocation/expiry, records last use. */
export async function authenticateApiKey(db: Db, config: AppConfig, presented: string): Promise<KeyAuthResult> {
  if (!config.apiKeyPepper || presented.length > 256) return { ok: false, reason: "unknown" };
  const [key] = await db.query<KeyRow>(`select ${KEY_COLUMNS} from api_keys where key_hash=$1`, [hmacHex(config.apiKeyPepper, presented)]);
  if (!key) return { ok: false, reason: "unknown" };
  const now = config.now();
  const reason = keyUnusableReason({ revokedAt: key.revoked_at, expiresAt: key.expires_at }, now);
  if (reason) return { ok: false, reason };
  if (!key.last_used_at || now.getTime() - key.last_used_at.getTime() >= LAST_USED_GRANULARITY_MS) {
    await db.query("update api_keys set last_used_at=$2 where id=$1", [key.id, now]);
    key.last_used_at = now;
  }
  return { ok: true, key };
}
