/**
 * API-key console session. A key with the usage:read scope may open a RESTRICTED console session:
 * kind 'api_key', short lifetime, bound to the key (revoking or expiring the key ends the session on the next request).
 * Restrictions are enforced centrally (authorizeSession in ./session.ts): such a session reaches only routes that opt in
 * with access "key_scope" (session view/logout/renew, usage and agent runs), and those narrow data to this key.
 * It can never reveal or create secrets, change identities or security settings, manage keys, or export.
 */
import { audit } from "../audit";
import type { AppConfig } from "../config";
import type { Db } from "../db";
import { ApiError } from "../http";
import { authenticateApiKey } from "../keys/service";
import { createSession } from "./session";

export async function openKeySession(db: Db, config: AppConfig, presentedKey: string, requestId: string): Promise<{ token: string; expiresAt: Date; keyId: string } | null> {
  const r = await authenticateApiKey(db, config, presentedKey);
  if (!r.ok) return null;
  if (!r.key.scopes.includes("usage:read")) throw new ApiError("FORBIDDEN", "This key does not have the usage:read scope");
  const now = config.now();
  // The session acts as the key's creator inside the key's account, only while that membership exists.
  const [owner] = await db.query<{ created_by_user_id: string }>(
    `select k.created_by_user_id from api_keys k join memberships m on m.user_id = k.created_by_user_id and m.account_id = k.account_id where k.id=$1`,
    [r.key.id],
  );
  if (!owner) return null;
  return db.tx(async (q) => {
    const s = await createSession(q, config, owner.created_by_user_id, r.key.account_id, { kind: "api_key", methodRef: r.key.id });
    await audit(q, { accountId: r.key.account_id, actorUserId: owner.created_by_user_id, action: "session.created", targetType: "session", targetId: s.id, requestId, at: now, metadata: { kind: "api_key", keyId: r.key.id } });
    return { token: s.token, expiresAt: s.expiresAt, keyId: r.key.id };
  });
}
