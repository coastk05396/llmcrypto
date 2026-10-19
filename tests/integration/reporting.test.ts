/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentRunPage, ErrorEnvelope, Job, LedgerPage, UsagePage, UsageRecord } from "@llmcrypto/contracts";
import { accountBalance, registerPriceVersion } from "@llmcrypto/domain";
import { csvCell } from "../../apps/worker/src/csv";
import { runPendingJobs, startJobRunner } from "../../apps/worker/src/export";
import { randomId } from "../../apps/api/src/crypto";
import { BASE_TIME, advance, call, login, seedMember, type LoggedIn } from "./helpers";
import { createKey, fund, funded, idemKey, makeGatewayHarness, type GatewayHarness } from "./metering-helpers";

let h: GatewayHarness;
beforeAll(async () => {
  h = await makeGatewayHarness();
});
afterAll(async () => {
  await h.db.close();
});
beforeEach(() => {
  h.clock.now = new Date(BASE_TIME);
});

const runner = () => ({ db: h.db, now: () => h.config.now(), newId: randomId });
const chat = async (secret: string, content: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): Promise<Response> => {
  const r = await h.gwApp.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, ...headers },
    body: JSON.stringify({ model: "sample-fast-1", messages: [{ role: "user", content }], max_tokens: 50, ...extra }),
  });
  await r.text();
  await h.gateway.idle();
  advance(h, 1); // an export covers rows created strictly before it was requested
  return r;
};
const addProject = async (accountId: string, name: string): Promise<string> => {
  const id = randomId("prj");
  await h.db.query("insert into projects (id, account_id, name, created_at) values ($1,$2,$3,$4)", [id, accountId, name, h.config.now()]);
  return id;
};

async function allUsage(cookie: string, query = ""): Promise<UsagePage["items"]> {
  const items: UsagePage["items"] = [];
  let cursor: string | null = null;
  do {
    const r: any = await call<any>(h.app, "GET", `/api/usage?limit=200${query}${cursor ? `&cursor=${cursor}` : ""}`, { cookie });
    expect(r.status).toBe(200);
    const page = UsagePage.parse(r.json);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}
async function allLedger(cookie: string, query = ""): Promise<LedgerPage["items"]> {
  const items: LedgerPage["items"] = [];
  let cursor: string | null = null;
  do {
    const r: any = await call<any>(h.app, "GET", `/api/ledger?limit=200${query}${cursor ? `&cursor=${cursor}` : ""}`, { cookie });
    expect(r.status).toBe(200);
    const page = LedgerPage.parse(r.json);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}
const sum = (xs: string[]): bigint => xs.reduce((a, x) => a + BigInt(x), 0n);

async function requestExport(cookie: string, kind: "usage" | "ledger", format: "csv" | "jsonl", filters: Record<string, unknown> = {}, key = idemKey()) {
  return call<any>(h.app, "POST", "/api/exports", { cookie, body: { kind, format, filters }, headers: { "Idempotency-Key": key } });
}
async function exportAndFetch(cookie: string, kind: "usage" | "ledger", format: "csv" | "jsonl", filters: Record<string, unknown> = {}) {
  const acc = await requestExport(cookie, kind, format, filters);
  expect(acc.status, JSON.stringify(acc.json)).toBe(202);
  await runPendingJobs(runner());
  const job = Job.parse((await call<any>(h.app, "GET", `/api/jobs/${acc.json.jobId}`, { cookie })).json);
  expect(job.status).toBe("succeeded");
  const dl = await h.app.request(job.downloadUrl!, { headers: { Cookie: cookie } });
  expect(dl.status).toBe(200);
  return { job, text: await dl.text(), headers: dl.headers, jobId: acc.json.jobId as string };
}

/** Minimal RFC 4180 parser (quoted cells, doubled quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += ch;
  }
  return rows;
}

describe("agent runs", () => {
  it("groups by run id and project; requests without a run id are an explicit unknown bucket, never guessed", async () => {
    const { s, key } = await funded(h, 20_000_000n);
    const capped = await createKey(h, s, { spendCapMicrousd: "1" });
    const p1 = await addProject(s.accountId, "one");
    advance(h, 1);
    await chat(key.secret, "a [[fake:output=10]]", { "X-Run-Id": "run-1", "X-Parent-Id": "root", "X-Project-Id": p1 });
    advance(h, 1);
    await chat(key.secret, "b [[fake:output=20]] [[fake:cached=2]]", { "X-Run-Id": "run-1", "X-Parent-Id": "step-1", "X-Project-Id": p1 });
    advance(h, 1);
    await chat(key.secret, "c [[fake:output=30]]", { "X-Run-Id": "run-2" });
    advance(h, 1);
    await chat(key.secret, "d [[fake:output=5]]");
    advance(h, 1);
    await chat(key.secret, "e [[fake:output=6]]");
    advance(h, 1);
    const refused = await chat(capped.secret, "f", { "X-Run-Id": "run-2" });
    expect(refused.status).toBe(402);
    advance(h, 1);
    await chat(key.secret, "g [[fake:no_usage]]", { "X-Run-Id": "run-2" });

    const runs = AgentRunPage.parse((await call<any>(h.app, "GET", "/api/usage/agent-runs", { cookie: s.cookie })).json);
    const by = new Map(runs.items.map((r) => [`${r.runId}|${r.projectId}`, r]));
    const r1 = by.get(`run-1|${p1}`)!;
    expect(r1).toMatchObject({ correlation: "known", requestCount: "2", failedCount: "0", pendingCount: "0", limitRejectedCount: "0" });
    expect(r1.cachedInputTokens).toBe("2");
    const r2 = by.get("run-2|null")!;
    expect(r2).toMatchObject({ correlation: "known", requestCount: "3", pendingCount: "1", limitRejectedCount: "1" });
    const unknown = by.get("null|null")!;
    expect(unknown).toMatchObject({ runId: null, correlation: "unknown", requestCount: "2" });
    expect(runs.items).toHaveLength(3);

    // run totals equal the usage console, row by row
    const usage = await allUsage(s.cookie);
    const total = sum(usage.map((u) => u.chargeMicrousd));
    expect(sum(runs.items.map((r) => r.chargeMicrousd))).toBe(total);
    expect(sum(runs.items.map((r) => r.requestCount))).toBe(BigInt(usage.length));
    expect(sum(runs.items.map((r) => r.inputTokens))).toBe(sum(usage.map((u) => u.inputTokens)));
    expect(usage.filter((u) => u.runId === "run-1").map((u) => u.parentId)).toEqual(["root", "step-1"]);

    // filters: exact run id and pagination of runs
    const one = await allUsage(s.cookie, "&runId=run-1");
    expect(one).toHaveLength(2);
    const p = AgentRunPage.parse((await call<any>(h.app, "GET", "/api/usage/agent-runs?limit=1", { cookie: s.cookie })).json);
    expect(p.items).toHaveLength(1);
    expect(p.nextCursor).not.toBeNull();
    const seen = [...p.items];
    let cursor = p.nextCursor;
    while (cursor) {
      const n = AgentRunPage.parse((await call<any>(h.app, "GET", `/api/usage/agent-runs?limit=1&cursor=${cursor}`, { cookie: s.cookie })).json);
      seen.push(...n.items);
      cursor = n.nextCursor;
    }
    expect(seen.map((r) => `${r.runId}|${r.projectId}`).sort()).toEqual([...by.keys()].sort());
  });

  it("is isolated per account and hidden from plain members", async () => {
    const a = await funded(h, 5_000_000n);
    const b = await funded(h, 5_000_000n);
    await chat(a.key.secret, "x", { "X-Run-Id": "shared-run-name" });
    await chat(b.key.secret, "y", { "X-Run-Id": "shared-run-name" });
    const ra = AgentRunPage.parse((await call<any>(h.app, "GET", "/api/usage/agent-runs", { cookie: a.s.cookie })).json);
    expect(ra.items).toHaveLength(1);
    expect(ra.items[0]?.requestCount).toBe("1");
    const member = await seedMember(h, a.s.accountId, "member");
    expect(AgentRunPage.parse((await call<any>(h.app, "GET", "/api/usage/agent-runs", { cookie: member.cookie })).json).items).toEqual([]);
  });
});

describe("exports reconcile with the console and the ledger", () => {
  let s: LoggedIn;
  let key: { id: string; secret: string };
  beforeAll(async () => {
    ({ s, key } = await funded(h, 30_000_000n));
    const p = await addProject(s.accountId, "p");
    for (let i = 0; i < 7; i++) {
      advance(h, 1);
      await chat(key.secret, `req ${i} [[fake:output=${5 + i}]]`, i % 2 ? { "X-Run-Id": `run-${i % 3}`, "X-Project-Id": p } : {});
    }
    advance(h, 1);
    await chat(key.secret, "unresolved [[fake:no_usage]]"); // USAGE_PENDING: zero charge so far
    advance(h, 2);
  });

  // the suite clock is reset to BASE_TIME before each test; seeded rows were stamped up to BASE_TIME + ~12 s
  beforeEach(() => advance(h, 60));

  it("usage export total == console total == minus the ledger spend, exactly, in CSV and JSONL", async () => {
    const console_ = await allUsage(s.cookie);
    expect(console_.length).toBe(8);
    const consoleTotal = sum(console_.map((u) => u.chargeMicrousd));
    const ledger = await allLedger(s.cookie, "&kind=spend");
    expect(ledger.length).toBe(7); // the pending request has no posting yet
    expect(-sum(ledger.map((l) => l.amountMicrousd))).toBe(consoleTotal);

    const csv = await exportAndFetch(s.cookie, "usage", "csv");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toMatch(/^attachment; filename="usage-job_[0-9a-f]+\.csv"$/);
    expect(csv.headers.get("x-content-type-options")).toBe("nosniff");
    const rows = parseCsv(csv.text);
    const header = rows[0]!;
    const body = rows.slice(1);
    expect(body).toHaveLength(console_.length);
    expect(csv.job.summary).toEqual({ rowCount: String(console_.length), totalMicrousd: consoleTotal.toString() });
    const col = (n: string) => header.indexOf(n);
    expect(sum(body.map((r) => r[col("chargeMicrousd")]!))).toBe(consoleTotal);
    expect(body.map((r) => r[col("id")])).toEqual(console_.map((u) => u.id)); // same rows, same order as the console
    expect(body.map((r) => r[col("priceVersion")])).toEqual(console_.map((u) => u.priceVersion));

    const jsonl = await exportAndFetch(s.cookie, "usage", "jsonl");
    expect(jsonl.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = jsonl.text.trim().split("\n").map((l) => UsageRecord.parse(JSON.parse(l)));
    expect(lines).toEqual(console_);
    expect(jsonl.job.summary?.totalMicrousd).toBe(consoleTotal.toString());
  });

  it("ledger export net == ledger console net == posted balance; deposits and spend both present", async () => {
    const ledger = await allLedger(s.cookie);
    const net = sum(ledger.map((l) => l.amountMicrousd));
    expect(net).toBe((await accountBalance(h.db, s.accountId)).posted);
    const csv = await exportAndFetch(s.cookie, "ledger", "csv");
    const rows = parseCsv(csv.text);
    expect(rows[0]).toEqual(["id", "transactionId", "createdAt", "kind", "amountMicrousd", "sourceType", "sourceId", "priceVersion"]);
    expect(rows.slice(1).map((r) => r[0])).toEqual(ledger.map((l) => l.id));
    expect(csv.job.summary).toEqual({ rowCount: String(ledger.length), totalMicrousd: net.toString() });
    // a negative amount stays a plain number, not a quoted/escaped "formula"
    expect(csv.text).toMatch(/,-\d+,request,/);
    const spendOnly = await exportAndFetch(s.cookie, "ledger", "jsonl", { kind: "spend" });
    expect(spendOnly.text.trim().split("\n")).toHaveLength(7);
  });

  it("filters (time window, model, run) apply identically to console and export", async () => {
    const q = `&runId=run-1`;
    const console_ = await allUsage(s.cookie, q);
    expect(console_.length).toBeGreaterThan(0);
    const e = await exportAndFetch(s.cookie, "usage", "jsonl", { runId: "run-1" });
    expect(e.text.trim().split("\n").map((l) => JSON.parse(l).id)).toEqual(console_.map((u) => u.id));
    const win = (await allUsage(s.cookie))[3]!.createdAt;
    const e2 = await exportAndFetch(s.cookie, "usage", "csv", { from: win });
    expect(parseCsv(e2.text).length - 1).toBe((await allUsage(s.cookie, `&from=${encodeURIComponent(win)}`)).length);
  });

  it("a later price version leaves exported historic rows and totals unchanged", async () => {
    const before = await exportAndFetch(s.cookie, "usage", "jsonl");
    await h.db.tx((q) =>
      registerPriceVersion(q, { id: "pv_export_raise", source: "test", effectiveAt: new Date("2026-10-18T12:30:00Z"), rates: [{ model: "sample-fast-1", inputMicrousdPerMtok: 900_000n, cachedInputMicrousdPerMtok: 90_000n, outputMicrousdPerMtok: 4_000_000n }] }, h.config.now()),
    );
    advance(h, 3600);
    await chat(key.secret, "after the raise [[fake:output=10]]");
    const after = await exportAndFetch(s.cookie, "usage", "jsonl");
    const oldRows = before.text.trim().split("\n");
    const newRows = after.text.trim().split("\n");
    expect(newRows.slice(0, oldRows.length)).toEqual(oldRows); // byte-identical history
    const added = JSON.parse(newRows[newRows.length - 1]!);
    expect(added.priceVersion).toBe("pv_export_raise");
    expect(BigInt(after.job.summary!.totalMicrousd)).toBe(BigInt(before.job.summary!.totalMicrousd) + BigInt(added.chargeMicrousd));
    const spend = sum((await allLedger(s.cookie, "&kind=spend")).map((l) => l.amountMicrousd));
    expect(-spend).toBe(BigInt(after.job.summary!.totalMicrousd));
  });
});

describe("CSV formula injection", () => {
  const cases: [string, string][] = [
    ["=HYPERLINK(\"http://evil.test\",\"x\")", "\"'=HYPERLINK(\"\"http://evil.test\"\",\"\"x\"\")\""],
    ["+1+1", "\"'+1+1\""],
    ["-2+3", "\"'-2+3\""],
    ["@SUM(A1)", "\"'@SUM(A1)\""],
    ["\t=1+1", "\"'\t=1+1\""],
    ["\r=1+1", "\"'\r=1+1\""],
    [" =1+1", "\"' =1+1\""],
    ["＝1+1", "\"'＝1+1\""],
    ["-run-id", "\"'-run-id\""],
    ["plain", "plain"],
    ["has,comma", "\"has,comma\""],
    ["say \"hi\"", "\"say \"\"hi\"\"\""],
    ["a=b", "a=b"],
  ];
  it.each(cases)("%j", (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });
  it("numeric columns keep real integers (including negatives) and escape anything else", () => {
    expect(csvCell("-1500", true)).toBe("-1500");
    expect(csvCell("0", true)).toBe("0");
    expect(csvCell("-1500+cmd", true)).toBe("\"'-1500+cmd\"");
    expect(csvCell("-15.5", true)).toBe("\"'-15.5\"");
    expect(csvCell(null)).toBe("");
  });

  it("hostile text stored in a request never survives as a formula in the export", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const r = await chat(key.secret, "x", { "X-Run-Id": "-cmd", "X-Correlation-Id": "ok" });
    const reqId = r.headers.get("x-request-id")!;
    await h.db.query("update requests set correlation_id=$2, parent_id=$3 where id=$1", [reqId, "=cmd|' /C calc'!A0", "@evil"]);
    const csv = await exportAndFetch(s.cookie, "usage", "csv");
    const rows = parseCsv(csv.text);
    const head = rows[0]!;
    const row = rows[1]!;
    expect(row[head.indexOf("runId")]).toBe("'-cmd");
    expect(row[head.indexOf("correlationId")]).toBe("'=cmd|' /C calc'!A0");
    expect(row[head.indexOf("parentId")]).toBe("'@evil");
    for (const cell of rows.flatMap((r2, i) => (i === 0 ? [] : r2))) expect(cell).not.toMatch(/^[=+@]/);
    // JSONL keeps the exact value (it is data, not a spreadsheet)
    const j = await exportAndFetch(s.cookie, "usage", "jsonl");
    expect(JSON.parse(j.text.trim())).toMatchObject({ runId: "-cmd", correlationId: "=cmd|' /C calc'!A0" });
  });
});

describe("job lifecycle, idempotency and authorization", () => {
  it("is idempotent per key: same payload replays the job, a changed payload conflicts, a missing key is rejected", async () => {
    const { s } = await funded(h, 1_000_000n);
    const key = idemKey();
    const a = await requestExport(s.cookie, "usage", "csv", {}, key);
    const b = await requestExport(s.cookie, "usage", "csv", {}, key);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.json.jobId).toBe(a.json.jobId);
    expect(b.headers.get("idempotent-replay")).toBe("true");
    const c = await requestExport(s.cookie, "usage", "jsonl", {}, key);
    expect(c.status).toBe(409);
    expect(ErrorEnvelope.parse(c.json).error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await h.db.query("select 1 from jobs where account_id=$1", [s.accountId])).length).toBe(1);
    const missing = await call<any>(h.app, "POST", "/api/exports", { cookie: s.cookie, body: { kind: "usage", format: "csv", filters: {} } });
    expect(missing.status).toBe(400);
    expect(missing.json.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    // replay after completion still returns the job id, now with its final status
    await runPendingJobs(runner());
    const d = await requestExport(s.cookie, "usage", "csv", {}, key);
    expect(d.json).toEqual({ jobId: a.json.jobId, status: "succeeded" });
  });

  it("queued -> running -> succeeded is visible, and two concurrent runners execute a job once", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    await chat(key.secret, "x");
    const acc = await requestExport(s.cookie, "usage", "csv");
    expect(Job.parse((await call<any>(h.app, "GET", `/api/jobs/${acc.json.jobId}`, { cookie: s.cookie })).json).status).toBe("queued");
    const [r1, r2] = await Promise.all([runPendingJobs(runner()), runPendingJobs(runner())]);
    expect([...r1.succeeded, ...r2.succeeded]).toEqual([acc.json.jobId]);
    expect((await h.db.query("select 1 from job_outputs where job_id=$1", [acc.json.jobId])).length).toBe(1);
    const [row] = await h.db.query<any>("select attempts from jobs where id=$1", [acc.json.jobId]);
    expect(row.attempts).toBe(1);
  });

  it("the in-process runner picks queued jobs up on its own", async () => {
    const { s } = await funded(h, 1_000_000n);
    const acc = await requestExport(s.cookie, "ledger", "csv");
    const rn = startJobRunner({ ...runner(), intervalMs: 20 });
    await rn.kick();
    await rn.stop();
    expect(Job.parse((await call<any>(h.app, "GET", `/api/jobs/${acc.json.jobId}`, { cookie: s.cookie })).json).status).toBe("succeeded");
  });

  it("downloads expire; the file is deleted by the runner and the job reports expired", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    await chat(key.secret, "x");
    const e = await exportAndFetch(s.cookie, "usage", "csv");
    expect(Date.parse(e.job.expiresAt!) - h.clock.now.getTime()).toBe(86_400_000);
    advance(h, 86_400 + 1);
    const again = await login(h.app, s.wallet); // the first session has expired, too (24 h)
    const job = Job.parse((await call<any>(h.app, "GET", `/api/jobs/${e.jobId}`, { cookie: again.cookie })).json);
    expect(job.status).toBe("expired");
    expect(job.downloadUrl).toBeUndefined();
    expect((await h.app.request(`/api/jobs/${e.jobId}/download`, { headers: { Cookie: again.cookie } })).status).toBe(404);
    const report = await runPendingJobs(runner());
    expect(report.expired).toContain(e.jobId);
    expect((await h.db.query("select 1 from job_outputs where job_id=$1", [e.jobId])).length).toBe(0);
  });

  it("jobs and files are private to their creator: other accounts, other users and anonymous callers get 404/401", async () => {
    const a = await funded(h, 5_000_000n);
    const b = await funded(h, 5_000_000n);
    await chat(a.key.secret, "secret-ish");
    const e = await exportAndFetch(a.s.cookie, "usage", "csv");
    const colleague = await seedMember(h, a.s.accountId, "admin");
    for (const cookie of [b.s.cookie, colleague.cookie]) {
      expect((await call(h.app, "GET", `/api/jobs/${e.jobId}`, { cookie })).status).toBe(404);
      expect((await h.app.request(`/api/jobs/${e.jobId}/download`, { headers: { Cookie: cookie } })).status).toBe(404);
    }
    expect((await call(h.app, "GET", `/api/jobs/${e.jobId}`, {})).status).toBe(401);
    expect((await h.app.request(`/api/jobs/${e.jobId}/download`)).status).toBe(401);
    // B's own export never contains A's rows even when B filters by A's key and project ids
    const pa = await addProject(a.s.accountId, "pa");
    const eb = await exportAndFetch(b.s.cookie, "usage", "jsonl", { keyId: a.key.id, projectId: pa });
    expect(eb.text.trim()).toBe("");
    expect(eb.job.summary).toEqual({ rowCount: "0", totalMicrousd: "0" });
    const all = await exportAndFetch(b.s.cookie, "usage", "jsonl");
    expect(all.text).not.toContain(a.key.id);
  });

  it("exports follow the console role rules; API-key sessions cannot export", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const admin = await seedMember(h, s.accountId, "admin");
    const billing = await seedMember(h, s.accountId, "billing");
    const member = await seedMember(h, s.accountId, "member");
    expect((await requestExport(admin.cookie, "usage", "csv")).status).toBe(202);
    expect((await requestExport(admin.cookie, "ledger", "csv")).status).toBe(403);
    expect((await requestExport(billing.cookie, "ledger", "csv")).status).toBe(202);
    expect((await requestExport(member.cookie, "usage", "csv")).status).toBe(403);
    expect((await requestExport(member.cookie, "ledger", "csv")).status).toBe(403);
    const k = await createKey(h, s, { scopes: ["usage:read"] });
    const ks = await call<any>(h.app, "POST", "/api/auth/key-sessions", { body: { apiKey: k.secret } });
    expect(ks.status).toBe(200);
    const kc = ks.setCookie.find((c) => c.startsWith("session="))!.split(";")[0]!;
    expect((await requestExport(kc, "usage", "csv")).status).toBe(403);
    expect(key.id).toBeTruthy();
  });

  it("a requester demoted before the job runs gets a FORBIDDEN failure, not the data", async () => {
    const { s } = await funded(h, 1_000_000n);
    const admin = await seedMember(h, s.accountId, "admin");
    const acc = await requestExport(admin.cookie, "usage", "csv");
    await h.db.query("update memberships set role='member' where user_id=$1", [admin.userId]);
    await runPendingJobs(runner());
    const job = Job.parse((await call<any>(h.app, "GET", `/api/jobs/${acc.json.jobId}`, { cookie: admin.cookie })).json);
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("FORBIDDEN");
    expect((await h.db.query("select 1 from job_outputs where job_id=$1", [acc.json.jobId])).length).toBe(0);
  });

  it("validates filters; too many rows fail with a clear error; a crashed runner is retried, then fails visibly", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const bad = await requestExport(s.cookie, "ledger", "csv", { model: "sample-fast-1" });
    expect(bad.status).toBe(422);
    expect((await requestExport(s.cookie, "usage", "csv", { from: "2026-10-18T12:00:00Z", to: "2026-10-18T11:00:00Z" })).status).toBe(422);
    expect((await requestExport(s.cookie, "usage", "csv", { kind: "spend" })).status).toBe(422);

    for (let i = 0; i < 3; i++) await chat(key.secret, `row ${i}`);
    const acc = await requestExport(s.cookie, "usage", "csv");
    await h.db.query("update jobs set params = jsonb_set(params, '{maxRows}', '2') where id=$1", [acc.json.jobId]);
    await runPendingJobs(runner());
    const failed = Job.parse((await call<any>(h.app, "GET", `/api/jobs/${acc.json.jobId}`, { cookie: s.cookie })).json);
    expect(failed).toMatchObject({ status: "failed", error: { code: "EXPORT_TOO_LARGE" } });

    // simulate a runner that died mid-job: running with a lapsed lease is claimed again
    const crashed = await requestExport(s.cookie, "usage", "jsonl");
    await h.db.query("update jobs set status='running', attempts=1, lease_until=$2 where id=$1", [crashed.json.jobId, new Date(h.clock.now.getTime() - 1000)]);
    const rep = await runPendingJobs(runner());
    expect(rep.succeeded).toContain(crashed.json.jobId);
    // ...and one that keeps dying is failed rather than hanging forever
    const doomed = await requestExport(s.cookie, "usage", "jsonl");
    await h.db.query("update jobs set status='running', attempts=3, lease_until=$2 where id=$1", [doomed.json.jobId, new Date(h.clock.now.getTime() - 1000)]);
    await runPendingJobs(runner());
    const d = Job.parse((await call<any>(h.app, "GET", `/api/jobs/${doomed.json.jobId}`, { cookie: s.cookie })).json);
    expect(d).toMatchObject({ status: "failed", error: { code: "RUNNER_LOST" } });
  });

  it("limits exports in progress per account", async () => {
    const { s } = await funded(h, 1_000_000n);
    for (let i = 0; i < 5; i++) expect((await requestExport(s.cookie, "usage", "csv")).status).toBe(202);
    const r = await requestExport(s.cookie, "usage", "csv");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("30");
  });
});

describe("large pagination", () => {
  it("pages 2,507 rows that share timestamps without gaps or duplicates, and the export matches", async () => {
    const s = await login(h.app);
    await fund(h, s.accountId, 1_000_000n);
    const keyId = randomId("key");
    await h.db.query(
      "insert into api_keys (id, account_id, name, prefix, key_hash, scopes, model_allowlist, created_by_user_id, created_at) values ($1,$2,'bulk','sk_bulk00',$3,'[\"usage:read\"]','[]',$4,$5)",
      [keyId, s.accountId, `hash-${keyId}`, s.userId, h.config.now()],
    );
    const N = 2507;
    await h.db.query(
      `insert into requests (id, account_id, key_id, protocol, model, stream, state, outcome, price_version_id, reserved_microusd, created_at, updated_at)
       select 'bulk_' || lpad(g::text, 6, '0'), $1, $2, 'openai_chat', 'sample-fast-1', false, 'SETTLED', 'succeeded', 'pv_sample_2026-10-18', 0,
              $3::timestamptz + ((g / 50) || ' seconds')::interval, $3::timestamptz + ((g / 50) || ' seconds')::interval
       from generate_series(1, ${N}) g`,
      [s.accountId, keyId, h.config.now()],
    );
    await h.db.query(
      `insert into usage_records (id, request_id, price_version_id, input_rate_microusd, cached_input_rate_microusd, output_rate_microusd,
                                  input_tokens, cached_input_tokens, output_tokens, charge_microusd, usage_source, created_at, settled_at)
       select 'bulku_' || lpad(g::text, 6, '0'), 'bulk_' || lpad(g::text, 6, '0'), 'pv_sample_2026-10-18', 1, 1, 1, g, 0, 1, g, 'provider', $1, $1 from generate_series(1, ${N}) g`,
      [h.config.now()],
    );
    const expectedTotal = (BigInt(N) * BigInt(N + 1)) / 2n;
    advance(h, 120); // rows are stamped up to ~50 s after the insert time

    const seen = await allUsage(s.cookie);
    expect(seen).toHaveLength(N);
    expect(new Set(seen.map((u) => u.id)).size).toBe(N);
    expect(seen.map((u) => u.id)).toEqual([...seen.map((u) => u.id)].sort()); // (createdAt, id) order == id order here
    expect(sum(seen.map((u) => u.chargeMicrousd))).toBe(expectedTotal);
    // page sizes: 200 + ... and the boundary row of every page is the next page's predecessor
    const p1 = UsagePage.parse((await call<any>(h.app, "GET", "/api/usage?limit=200", { cookie: s.cookie })).json);
    expect(p1.items).toHaveLength(200);
    expect(p1.nextCursor).not.toBeNull();
    expect((await call<any>(h.app, "GET", "/api/usage?limit=201", { cookie: s.cookie })).status).toBe(422);
    expect((await call<any>(h.app, "GET", "/api/usage?cursor=garbage", { cookie: s.cookie })).status).toBe(400);

    const e = await exportAndFetch(s.cookie, "usage", "csv");
    expect(e.job.summary).toEqual({ rowCount: String(N), totalMicrousd: expectedTotal.toString() });
    const rows = parseCsv(e.text);
    expect(rows.length - 1).toBe(N);
    expect(rows.slice(1).map((r) => r[0])).toEqual(seen.map((u) => u.id));
    const runs = AgentRunPage.parse((await call<any>(h.app, "GET", "/api/usage/agent-runs", { cookie: s.cookie })).json);
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]).toMatchObject({ correlation: "unknown", requestCount: String(N), chargeMicrousd: expectedTotal.toString() });
  });
});
