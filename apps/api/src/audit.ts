import type { Queryable } from "./db";
import { randomId } from "./crypto";

export interface AuditInput {
  accountId: string | null;
  actorUserId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  requestId?: string;
  /** Must never contain secrets, signatures or key material. */
  metadata?: Record<string, string | number | boolean | null>;
  at: Date;
}

export async function audit(q: Queryable, e: AuditInput): Promise<void> {
  await q.query(
    `insert into audit_events (id, account_id, actor_user_id, action, target_type, target_id, request_id, metadata, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
    [randomId("aud"), e.accountId, e.actorUserId, e.action, e.targetType ?? null, e.targetId ?? null, e.requestId ?? null, JSON.stringify(e.metadata ?? {}), e.at],
  );
}
