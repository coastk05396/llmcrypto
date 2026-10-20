import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

export interface Queryable {
  query<T extends object = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Multi-statement script without parameters (migrations). */
  exec(sql: string): Promise<void>;
}
export interface Db extends Queryable {
  /** Runs fn in one transaction; any throw rolls back. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** PGlite-backed Db (embedded PostgreSQL; used for dev and tests). dataDir undefined = in memory. */
export async function openPglite(dataDir?: string): Promise<Db> {
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  const wrap = (q: { query: PGlite["query"]; exec: PGlite["exec"] }): Queryable => ({
    async exec(sql: string): Promise<void> {
      await q.exec(sql);
    },
    async query<T extends object>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const res = await q.query<T>(sql, [...params]);
      return res.rows;
    },
  });
  return {
    ...wrap(pg),
    tx: (fn) => pg.transaction((t) => fn(wrap(t as unknown as { query: PGlite["query"]; exec: PGlite["exec"] }))),
    close: () => pg.close(),
  };
}

/**
 * Checksum of the migration's executable text: comment-only lines and blank lines are ignored, so adding documentation (rollback
 * notes) to an applied migration is not a change. Rows written before this rule hold the full-text hash and are still accepted.
 */
const checksumOf = (sql: string): string =>
  createHash("sha256").update(sql.split("\n").filter((l) => l.trim() !== "" && !l.trimStart().startsWith("--")).join("\n")).digest("hex");

/** Arbitrary constant identifying the migration lock (pg_advisory_xact_lock key). */
const MIGRATION_LOCK_KEY = 7_340_021;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies db/migrations/*.sql in filename order, each in its own transaction, recording
 * name + sha256 in schema_migrations. An already-applied file whose content changed is an error.
 */
export async function migrate(db: Db, dir: string): Promise<MigrationResult> {
  // `create table if not exists` is NOT race-safe on its own (two sessions can both pass the existence check and one fails with a
  // pg_type unique violation; observed on real PostgreSQL), so it runs under the same advisory lock.
  await db.tx(async (q) => {
    await q.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await q.query(
      `create table if not exists schema_migrations (
         name text primary key, checksum text not null, applied_at timestamptz not null default now())`,
    );
  });
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const result: MigrationResult = { applied: [], skipped: [] };
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8");
    const checksum = checksumOf(sql);
    const legacyChecksum = createHash("sha256").update(sql).digest("hex");
    // The advisory lock serialises concurrent migrators (two instances starting together): the loser waits for the winner's
    // commit, then re-reads schema_migrations INSIDE the lock and skips the file instead of applying it twice.
    const outcome = await db.tx(async (q) => {
      await q.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      const [prior] = await q.query<{ checksum: string }>("select checksum from schema_migrations where name=$1", [file]);
      if (prior) {
        if (prior.checksum !== checksum && prior.checksum !== legacyChecksum) throw new Error(`migration ${file} changed after being applied`);
        return "skipped" as const;
      }
      await q.exec(sql);
      await q.query("insert into schema_migrations (name, checksum) values ($1, $2)", [file, checksum]);
      return "applied" as const;
    });
    result[outcome].push(file);
  }
  return result;
}
