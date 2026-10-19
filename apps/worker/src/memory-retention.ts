/**
 * Deletes project notes past their project's retention window (db/migrations/008). Reads already hide expired notes and
 * injection ignores them; this removes the stored text for good. Usage evidence (ids and versions only) is kept.
 */
import type { SqlDb } from "@llmcrypto/domain";

export interface RetentionOptions {
  db: SqlDb;
  now: () => Date;
  newId: (prefix: string) => string;
}
export interface RetentionReport {
  deleted: number;
  projects: string[];
}

export async function purgeExpiredMemories(o: RetentionOptions): Promise<RetentionReport> {
  const at = o.now();
  return o.db.tx(async (q) => {
    const rows = await q.query<{ id: string; project_id: string; account_id: string }>(
      `delete from project_memories m using project_memory_settings s
        where s.project_id = m.project_id and s.retention_days is not null and m.updated_at + make_interval(days => s.retention_days) <= $1
        returning m.id, m.project_id, m.account_id`,
      [at],
    );
    const byProject = new Map<string, { account: string; n: number }>();
    for (const r of rows) {
      const cur = byProject.get(r.project_id) ?? { account: r.account_id, n: 0 };
      cur.n++;
      byProject.set(r.project_id, cur);
    }
    for (const [projectId, v] of byProject) {
      await q.query(
        "insert into audit_events (id, account_id, actor_user_id, action, target_type, target_id, metadata, created_at) values ($1,$2,null,'memory.retention_purged','project',$3,$4::jsonb,$5)",
        [o.newId("aud"), v.account, projectId, JSON.stringify({ deleted: v.n }), at],
      );
    }
    return { deleted: rows.length, projects: [...byProject.keys()] };
  });
}
