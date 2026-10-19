/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped rows */
/**
 * REAL PostgreSQL concurrency (embedded-postgres: genuine server binaries, one connection per transaction), unlike PGlite which
 * serialises everything on a single connection. Skipped, with the reason printed, when the binaries cannot start on this machine.
 * Prerequisite on pnpm: the @embedded-postgres/linux-x64 postinstall (symlinks) must have run (package.json pnpm.onlyBuiltDependencies).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  beginRequest, creditPostings, getActiveRates, markDispatched, markUsagePending, postTransaction, resolveUnrecoverable, settleRequest, verifyLedger,
} from "@llmcrypto/domain";
import { randomId } from "../../apps/api/src/crypto";
import { DEFAULT_MIGRATIONS_DIR } from "../../apps/api/src/config";
import { migrate, type Db, type Queryable } from "../../apps/api/src/db";
import { ensureSamplePriceVersion } from "../../apps/api/src/gateway/prices";

const port = 54000 + Math.floor(Math.random() * 900);
const password = randomBytes(32).toString("hex");
const dir = mkdtempSync(join(tmpdir(), "pgreal-"));
let server: EmbeddedPostgres | null = null;
let pool: pg.Pool | null = null;
let skipReason = "";
try {
  server = new EmbeddedPostgres({ databaseDir: dir, user: "t", password, port, persistent: false, onLog: () => undefined, onError: () => undefined });
  await server.initialise();
  await server.start();
  await server.createDatabase("app");
  pool = new pg.Pool({ host: "localhost", port, user: "t", password, database: "app", max: 24 });
  // An idle client that the server terminates (57P01 at shutdown) emits 'error' on the pool; unhandled it would crash the run.
  pool.on("error", () => undefined);
} catch (e) {
  skipReason = e instanceof Error ? e.message.split("\n")[0]! : "unknown";
  console.warn(`pg-real.test.ts SKIPPED: embedded PostgreSQL could not start (${skipReason})`);
  if (process.env["REQUIRE_REAL_POSTGRES"] === "true") {
    await pool?.end().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    throw new Error("Required PostgreSQL concurrency tests could not start", { cause: e });
  }
}

function wrap(c: { query: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }> }): Queryable {
  return {
    query: async <T extends object>(sql: string, params: readonly unknown[] = []) => (await c.query(sql, [...params])).rows as T[],
    exec: async (sql: string) => void (await c.query(sql)),
  };
}
function openDb(p: pg.Pool): Db {
  return {
    ...wrap(p),
    async tx(fn) {
      const c = await p.connect();
      try {
        await c.query("begin");
        const out = await fn(wrap(c));
        await c.query("commit");
        return out;
      } catch (e) {
        await c.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    },
    close: async () => undefined,
  };
}

afterAll(async () => {
  // Order matters: end the pool (waits for checked-out clients to be released and closes idle ones) BEFORE stopping the server.
  await pool?.end().catch(() => undefined);
  await server?.stop().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

const maybe = skipReason ? describe.skip : describe;
maybe(`real PostgreSQL concurrency${skipReason ? ` (skipped: ${skipReason})` : ""}`, () => {
  const db = pool ? openDb(pool) : (undefined as unknown as Db);
  const now = new Date("2026-10-18T12:00:00Z");
  const user = async (micro: bigint): Promise<string> => {
    const u = randomId("usr");
    const a = randomId("acc");
    await db.query("insert into users (id, created_at) values ($1,$2)", [u, now]);
    await db.query("insert into accounts (id, name, created_at) values ($1,null,$2)", [a, now]);
    await db.tx((q) => postTransaction(q, { id: randomId("ltx"), accountId: a, kind: "adjustment", sourceType: "adjustment", sourceId: randomId("src"), priceVersion: null, reason: "test funding", at: now, postings: creditPostings(a, micro), newEntryId: () => randomId("le") }));
    return a;
  };
  const begin = async (accountId: string, amount: bigint) => {
    const rates = (await getActiveRates(db, "sample-fast-1", now))!;
    const id = randomId("req");
    const r = await beginRequest(db, { id, accountId, keyId: null, projectId: null, runId: null, parentId: null, correlationId: null, protocol: "openai_chat", model: "sample-fast-1", stream: false, rates, reservedMicrousd: amount, at: now, newId: randomId });
    return { id, ok: r.ok };
  };
  const USAGE = { inputTokens: 100n, cachedInputTokens: 0n, outputTokens: 100n };

  it("migrations apply once even when two migrators race on separate connections", async () => {
    const [a, b] = await Promise.all([migrate(db, DEFAULT_MIGRATIONS_DIR), migrate(db, DEFAULT_MIGRATIONS_DIR)]);
    expect(a.applied.length + b.applied.length).toBe(a.applied.length + a.skipped.length);
    expect((await db.query<any>("select count(*)::int n from schema_migrations"))[0].n).toBe(a.applied.length + a.skipped.length);
    await ensureSamplePriceVersion(db, now);
  }, 120_000);

  it("A5: 20 concurrent reservations of 0.3 against 1.0 credit -> exactly 3 succeed, held never exceeds posted", async () => {
    const acc = await user(1_000_000n);
    const results = await Promise.all(Array.from({ length: 20 }, () => begin(acc, 300_000n)));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const [held] = await db.query<any>("select coalesce(sum(amount),0)::text s from reservations where account_id=$1 and status='active'", [acc]);
    expect(BigInt(held.s)).toBe(900_000n);
  }, 60_000);

  it("16 concurrent settles of one request: one spend, one set of transitions, one winner", async () => {
    const acc = await user(5_000_000n);
    const { id } = await begin(acc, 50_000n);
    await markDispatched(db, id, "prov_c", now);
    const outcomes = ["succeeded", "failed", "cancelled", "succeeded"] as const;
    const res = await Promise.all(Array.from({ length: 16 }, (_, i) => settleRequest(db, { requestId: id, usage: USAGE, outcome: outcomes[i % 4]!, at: now, newId: randomId })));
    expect(res.filter((r) => r.status === "settled" && !r.alreadySettled)).toHaveLength(1);
    expect(res.every((r) => r.status === "settled")).toBe(true);
    expect((await db.query<any>("select count(*)::int n from ledger_transactions where source_type='request' and source_id=$1", [id]))[0].n).toBe(1);
    const tr = await db.query<any>("select from_state, to_state from request_transitions where request_id=$1 order by id", [id]);
    expect(tr.map((t) => t.to_state).filter((s) => s === "SETTLED")).toHaveLength(1);
    expect(tr).toHaveLength(5);
    const [r] = await db.query<any>("select state, outcome from requests where id=$1", [id]);
    expect(r.state).toBe("SETTLED");
    expect(tr[4]).toMatchObject({ to_state: "SETTLED" });
    expect((await verifyLedger(db)).totalSum).toBe(0n);
  }, 60_000);

  it("settle racing the unrecoverable sweep: exactly one of charge or absorb happens, never both", async () => {
    for (let round = 0; round < 5; round++) {
      const acc = await user(5_000_000n);
      const { id } = await begin(acc, 50_000n);
      await markDispatched(db, id, "prov_r", now);
      await markUsagePending(db, id, { code: "PROVIDER_TIMEOUT", deadline: now, at: now });
      const [s, u] = await Promise.all([
        settleRequest(db, { requestId: id, usage: USAGE, outcome: "succeeded", at: now, newId: randomId }),
        resolveUnrecoverable(db, id, now),
      ]);
      const spends = (await db.query<any>("select count(*)::int n from ledger_transactions where source_type='request' and source_id=$1", [id]))[0].n;
      const [row] = await db.query<any>("select state, outcome from requests where id=$1", [id]);
      expect(row.state).toBe("SETTLED");
      if (s.status === "settled" && !s.alreadySettled) {
        expect([spends, u, row.outcome]).toEqual([1, false, "failed"]);
      } else {
        expect([spends, u, row.outcome]).toEqual([0, true, "usage_unresolved"]);
      }
      expect((await db.query<any>("select count(*)::int n from request_transitions where request_id=$1 and to_state='SETTLED'", [id]))[0].n).toBe(1);
    }
  }, 60_000);
});
