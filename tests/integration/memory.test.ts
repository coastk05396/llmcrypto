/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_OPTIMIZATION_CONFIG, Memory, MemoryExport } from "@llmcrypto/contracts";
import { MEMORY_PREFIX } from "@llmcrypto/domain";
import { randomId } from "../../apps/api/src/crypto";
import { purgeExpiredMemories } from "../../apps/worker/src/memory-retention";
import { BASE_TIME, advance, call, dumpDatabase, login, seedMember, type LoggedIn } from "./helpers";
import { createKey, fund, funded, makeGatewayHarness, type GatewayHarness } from "./metering-helpers";

let h: GatewayHarness;
beforeAll(async () => {
  h = await makeGatewayHarness({ providerTimeoutMs: 2000 });
});
afterAll(async () => {
  await h.db.close();
});
beforeEach(() => {
  h.clock.now = new Date(BASE_TIME);
});

type Who = Pick<LoggedIn, "cookie">;
const api = <T = any>(method: string, path: string, s: Who | null, body?: unknown) =>
  call<T>(h.gwApp, method, path, { cookie: s?.cookie, ...(body !== undefined ? { body } : {}) });
const newProject = async (s: Who, name = `proj-${randomId("n")}`): Promise<string> => {
  const r = await api("POST", "/api/projects", s, { name });
  if (r.status !== 201) throw new Error(`project failed ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.id;
};
const addNote = (s: Who, project: string, text: string, extra: Record<string, unknown> = {}) =>
  api<any>("POST", `/api/projects/${project}/memories`, s, { text, storageConsent: true, ...extra });
const putNote = (s: Who, project: string, id: string, body: Record<string, unknown>) => api<any>("PUT", `/api/projects/${project}/memories/${id}`, s, { storageConsent: true, ...body });
const chat = (secret: string, content: string, headers: Record<string, string> = {}) =>
  Promise.resolve(h.gwApp.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, ...headers },
    body: JSON.stringify({ model: "sample-fast-1", max_tokens: 60, messages: [{ role: "user", content }] }),
  }));
const reqId = (r: Response): string => r.headers.get("x-request-id")!;
const policy = (s: Who, expectedVersion: number, projectContext: Record<string, unknown>) =>
  api("PUT", "/api/optimization/policy", s, { expectedVersion, config: { ...DEFAULT_OPTIMIZATION_CONFIG, projectContext } });
const ON = { enabled: true, maxNotes: 5, maxChars: 2000 };
const sentMessages = () => h.fake.requests.at(-1)!.messages;
const usageRows = (project: string) => h.db.query<any>("select memory_id, version, request_id, status, reason from memory_usage where project_id=$1 order by created_at, seq", [project]);

describe("projects", () => {
  it("create, list (paged), get; names are unique per account case-insensitively; roles and isolation", async () => {
    const s = await login(h.gwApp);
    const a = await api("POST", "/api/projects", s, { name: "  Billing Service " });
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ name: "Billing Service" });
    expect((await api("POST", "/api/projects", s, { name: "billing service" })).json.error.fieldErrors[0].field).toBe("name");
    for (const n of ["b", "c", "d"]) await api("POST", "/api/projects", s, { name: n });
    const p1 = await api("GET", "/api/projects?limit=3", s);
    expect(p1.json.items).toHaveLength(3);
    const p2 = await api("GET", `/api/projects?limit=3&cursor=${p1.json.nextCursor}`, s);
    expect(p2.json.items).toHaveLength(1);
    expect(p2.json.nextCursor).toBeNull();
    expect((await api("GET", `/api/projects/${a.json.id}`, s)).json.id).toBe(a.json.id);
    const member = await seedMember(h, s.accountId, "member");
    expect((await api("POST", "/api/projects", member, { name: "mine" })).status).toBe(403);
    expect((await api("GET", "/api/projects", member)).json.items).toHaveLength(4);
    const other = await login(h.gwApp);
    expect((await api("GET", `/api/projects/${a.json.id}`, other)).status).toBe(404);
    expect((await api("GET", "/api/projects", other)).json.items).toHaveLength(0);
    expect((await api("POST", "/api/projects", other, { name: "billing service" })).status).toBe(201); // names are per account
    expect((await api("POST", "/api/projects", s, { name: "" })).status).toBe(422);
    expect((await api("POST", "/api/projects", null, { name: "x" })).status).toBe(401);
  });
});

describe("notes: explicit consent, versions, conflicts, delete, export", () => {
  it("nothing is stored without storageConsent=true", async () => {
    const s = await login(h.gwApp);
    const p = await newProject(s);
    for (const body of [{ text: "x" }, { text: "x", storageConsent: false }, { text: "x", storageConsent: "true" }, { text: "", storageConsent: true }]) {
      const r = await api("POST", `/api/projects/${p}/memories`, s, body);
      expect(r.status, JSON.stringify(body)).toBe(422);
    }
    expect((await h.db.query<any>("select count(*)::int n from project_memories where project_id=$1", [p]))[0].n).toBe(0);
  });

  it("create -> list -> get -> edit -> delete, with versions and a contract-shaped body", async () => {
    const s = await login(h.gwApp);
    const p = await newProject(s);
    const c = await addNote(s, p, "Prefer small PRs.", { expectedVersion: 0 });
    expect(c.status).toBe(201);
    expect(Memory.parse(c.json)).toMatchObject({ projectId: p, version: 1, inject: false, expiresAt: null });
    expect((await addNote(s, p, "v", { expectedVersion: 3 })).json.error.code).toBe("VERSION_CONFLICT");
    const list = await api("GET", `/api/projects/${p}/memories`, s);
    expect(list.json.items.map((n: any) => n.id)).toEqual([c.json.id]);
    expect((await api("GET", `/api/projects/${p}/memories/${c.json.id}`, s)).json.text).toBe("Prefer small PRs.");
    const e = await putNote(s, p, c.json.id, { text: "Prefer small, reviewable PRs.", expectedVersion: 1, inject: true });
    expect(e.status).toBe(200);
    expect(e.json).toMatchObject({ version: 2, inject: true, text: "Prefer small, reviewable PRs." });
    expect(Date.parse(e.json.updatedAt)).toBeGreaterThanOrEqual(Date.parse(e.json.createdAt));
    const stale = await putNote(s, p, c.json.id, { text: "stale", expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(stale.json.error.message).toMatch(/version 2/);
    expect((await putNote(s, p, c.json.id, { text: "x", expectedVersion: 2, storageConsent: false })).status).toBe(422);
    expect((await putNote(s, p, c.json.id, { text: "x", expectedVersion: 0 })).status).toBe(422);
    expect((await putNote(s, p, "mem_missing", { text: "x", expectedVersion: 1 })).status).toBe(404);
    const keep = await putNote(s, p, c.json.id, { text: "keeps flag", expectedVersion: 2 }); // inject omitted = unchanged
    expect(keep.json.inject).toBe(true);
    expect((await api("DELETE", `/api/projects/${p}/memories/${c.json.id}`, s)).status).toBe(204);
    expect((await api("GET", `/api/projects/${p}/memories/${c.json.id}`, s)).status).toBe(404);
    expect((await api("DELETE", `/api/projects/${p}/memories/${c.json.id}`, s)).status).toBe(404);
    expect((await api("GET", `/api/projects/${p}/memories`, s)).json.items).toEqual([]);
    expect((await h.db.query<any>("select count(*)::int n from project_memories where id=$1", [c.json.id]))[0].n).toBe(0); // really gone
    const aud = await h.db.query<any>("select action, metadata from audit_events where target_id=$1 order by created_at", [c.json.id]);
    expect(aud.map((a) => a.action)).toEqual(["memory.created", "memory.updated", "memory.updated", "memory.deleted"]);
    expect(JSON.stringify(aud)).not.toContain("PRs"); // audit holds ids and lengths, never note text
  });

  it("A8 concurrency: parallel edits from the same version - exactly one wins, the rest are 409 VERSION_CONFLICT", async () => {
    const s = await login(h.gwApp);
    const p = await newProject(s);
    const n = (await addNote(s, p, "base")).json;
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => putNote(s, p, n.id, { text: `edit ${i}`, expectedVersion: 1 })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(7);
    const cur = (await api("GET", `/api/projects/${p}/memories/${n.id}`, s)).json;
    expect(cur.version).toBe(2);
    expect(cur.text).toBe(rs.find((r) => r.status === 200)!.json.text);
  });

  it("list pages with a cursor and caps notes per project", async () => {
    const s = await login(h.gwApp);
    const p = await newProject(s);
    for (let i = 0; i < 5; i++) await addNote(s, p, `note ${i}`);
    const p1 = await api("GET", `/api/projects/${p}/memories?limit=2`, s);
    const p2 = await api("GET", `/api/projects/${p}/memories?limit=2&cursor=${p1.json.nextCursor}`, s);
    const p3 = await api("GET", `/api/projects/${p}/memories?limit=2&cursor=${p2.json.nextCursor}`, s);
    expect([...p1.json.items, ...p2.json.items, ...p3.json.items].map((n: any) => n.text)).toEqual(["note 0", "note 1", "note 2", "note 3", "note 4"]);
    expect(p3.json.nextCursor).toBeNull();
    const q = await newProject(s);
    await h.db.query(
      `insert into project_memories (id, account_id, project_id, text, created_by_user_id, updated_by_user_id, created_at, updated_at)
       select 'cap_' || g, $1, $2, 't', $3, $3, $4, $4 from generate_series(1, 200) g`, [s.accountId, q, s.userId, h.clock.now]);
    const over = await addNote(s, q, "one too many");
    expect(over.status).toBe(422);
    expect(over.json.error.fieldErrors[0].message).toMatch(/at most 200/);
  });

  it("export returns notes, retention and usage evidence; it is a download and is audited", async () => {
    const s = await login(h.gwApp);
    const p = await newProject(s);
    const n = (await addNote(s, p, "export me", { inject: true })).json;
    await api("PUT", `/api/projects/${p}/memory-settings`, s, { retentionDays: 30, expectedVersion: 0 });
    const res = await h.gwApp.request(`/api/projects/${p}/memories/export`, { headers: { Cookie: s.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(`memory-${p}.json`);
    const body = MemoryExport.parse(await res.json());
    expect(body).toMatchObject({ projectId: p, noteCount: "1", usageTruncated: false, settings: { retentionDays: 30, version: 1 } });
    expect(body.notes[0]).toMatchObject({ id: n.id, text: "export me", expiresAt: "2026-11-17T12:00:00.000Z" });
    expect((await h.db.query<any>("select action from audit_events where action='memory.exported' and target_id=$1", [p])).length).toBe(1);
  });
});

describe("isolation and roles", () => {
  it("another account, and another project of the same account, can never read, list, edit, delete, export or inject the note", async () => {
    const a = await login(h.gwApp);
    const b = await login(h.gwApp);
    const pa = await newProject(a);
    const pa2 = await newProject(a);
    const pb = await newProject(b);
    const n = (await addNote(a, pa, "account A secret-ish note")).json;
    // account B uses A's project id or note id
    expect((await addNote(b, pa, "intrude")).status).toBe(404);
    expect((await api("GET", `/api/projects/${pa}/memories`, b)).status).toBe(404);
    expect((await api("GET", `/api/projects/${pa}/memories/${n.id}`, b)).status).toBe(404);
    expect((await putNote(b, pa, n.id, { text: "x", expectedVersion: 1 })).status).toBe(404);
    expect((await api("DELETE", `/api/projects/${pa}/memories/${n.id}`, b)).status).toBe(404);
    expect((await api("GET", `/api/projects/${pa}/memories/export`, b)).status).toBe(404);
    expect((await api("GET", `/api/projects/${pa}/memories/usage`, b)).status).toBe(404);
    expect((await api("PUT", `/api/projects/${pa}/memory-settings`, b, { retentionDays: 1, expectedVersion: 0 })).status).toBe(404);
    // B addressing A's note id under B's own project, and A addressing the note under A's other project
    expect((await api("GET", `/api/projects/${pb}/memories/${n.id}`, b)).status).toBe(404);
    expect((await api("GET", `/api/projects/${pa2}/memories/${n.id}`, a)).status).toBe(404);
    expect((await putNote(a, pa2, n.id, { text: "x", expectedVersion: 1 })).status).toBe(404);
    expect((await api("DELETE", `/api/projects/${pa2}/memories/${n.id}`, a)).status).toBe(404);
    expect((await api("GET", `/api/projects/${pb}/memories`, b)).json.items).toEqual([]);
    // injection stays inside the project
    await addNote(a, pa, "only for A project one", { inject: true });
    await addNote(a, pa2, "only for A project two", { inject: true });
    const ka = await createKey(h, a);
    await h.db.query("select 1");
    expect((await policy(a, 0, ON)).status).toBe(200);
    await fund(h, a.accountId, 2_000_000n);
    const r = await chat(ka.secret, "hi", { "X-Project-Id": pa2 });
    expect(r.status).toBe(200);
    await h.gateway.idle();
    const sys = sentMessages()[0]!.text;
    expect(sys).toContain("only for A project two");
    expect(sys).not.toContain("only for A project one");
    expect(sys).not.toContain("secret-ish");
    // account B's key cannot name A's project at all
    const kb = await funded(h, 1_000_000n);
    expect((await chat(kb.key.secret, "hi", { "X-Project-Id": pa })).status).toBe(403);
  });

  it("billing cannot use notes; members can; retention settings are owner/admin; API-key sessions are refused", async () => {
    const owner = await login(h.gwApp);
    const p = await newProject(owner);
    const billing = await seedMember(h, owner.accountId, "billing");
    const member = await seedMember(h, owner.accountId, "member");
    const admin = await seedMember(h, owner.accountId, "admin");
    expect((await addNote(billing, p, "x")).status).toBe(403);
    expect((await api("GET", `/api/projects/${p}/memories`, billing)).status).toBe(403);
    expect((await addNote(member, p, "member note")).status).toBe(201);
    expect((await api("PUT", `/api/projects/${p}/memory-settings`, member, { retentionDays: 5, expectedVersion: 0 })).status).toBe(403);
    expect((await api("PUT", `/api/projects/${p}/memory-settings`, admin, { retentionDays: 5, expectedVersion: 0 })).status).toBe(200);
    expect((await api("GET", `/api/projects/${p}/memories`, null)).status).toBe(401);
    expect((await call(h.gwApp, "POST", `/api/projects/${p}/memories`, { body: { text: "x", storageConsent: true }, cookie: member.cookie, origin: null })).status).toBe(403); // CSRF origin check
    const k = await createKey(h, owner, { scopes: ["usage:read"] });
    const ks = await call<any>(h.gwApp, "POST", "/api/auth/key-sessions", { body: { apiKey: k.secret } });
    expect(ks.status).toBe(200);
    const kcookie = ks.setCookie.find((c) => c.startsWith("session="))!.split(";")[0]!;
    expect((await api("GET", `/api/projects/${p}/memories`, { cookie: kcookie })).status).toBe(403);
  });
});

describe("retention", () => {
  it("settings are versioned; expired notes vanish from reads, export and injection; the worker deletes them", async () => {
    h.config.sessionTtlSeconds = 30 * 86_400; // the test moves the clock by days; keep the session alive
    const s = await login(h.gwApp); // gwApp shares h.config, so the longer TTL applies
    await fund(h, s.accountId, 5_000_000n);
    const key = await createKey(h, s);
    const p = await newProject(s);
    expect((await api("GET", `/api/projects/${p}/memory-settings`, s)).json).toMatchObject({ retentionDays: null, version: 0, updatedAt: null });
    const keepForever = (await addNote(s, p, "forever until deleted", { inject: true })).json;
    expect(keepForever.expiresAt).toBeNull();
    expect((await api("PUT", `/api/projects/${p}/memory-settings`, s, { retentionDays: 0, expectedVersion: 0 })).status).toBe(422);
    const set = await api("PUT", `/api/projects/${p}/memory-settings`, s, { retentionDays: 2, expectedVersion: 0 });
    expect(set.json).toMatchObject({ retentionDays: 2, version: 1 });
    expect((await api("PUT", `/api/projects/${p}/memory-settings`, s, { retentionDays: 3, expectedVersion: 0 })).json.error.code).toBe("VERSION_CONFLICT");
    const [c1, c2] = await Promise.all([
      api("PUT", `/api/projects/${p}/memory-settings`, s, { retentionDays: 5, expectedVersion: 1 }),
      api("PUT", `/api/projects/${p}/memory-settings`, s, { retentionDays: 6, expectedVersion: 1 }),
    ]);
    expect([c1.status, c2.status].sort()).toEqual([200, 409]);
    await api("PUT", `/api/projects/${p}/memory-settings`, s, { retentionDays: 2, expectedVersion: 2 });

    // every note's clock restarts at its last edit
    expect((await api("GET", `/api/projects/${p}/memories`, s)).json.items[0].expiresAt).toBe("2026-10-20T12:00:00.000Z");
    expect((await policy(s, 0, ON)).status).toBe(200);
    advance(h, 86_400); // day 1: still alive
    const edited = await putNote(s, p, keepForever.id, { text: "edited on day one", expectedVersion: 1 });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    expect(edited.json.expiresAt).toBe("2026-10-21T12:00:00.000Z");
    advance(h, 86_400 + 60); // day 2 + 1 min: only the untouched-for-2-days note would be gone; edited one lives
    expect((await api("GET", `/api/projects/${p}/memories/${keepForever.id}`, s)).status).toBe(200);
    advance(h, 86_400); // day 3: past the edited note's window
    expect((await api("GET", `/api/projects/${p}/memories/${keepForever.id}`, s)).status).toBe(404);
    expect((await api("GET", `/api/projects/${p}/memories`, s)).json.items).toEqual([]);
    expect((await putNote(s, p, keepForever.id, { text: "revive", expectedVersion: 2 })).status).toBe(404);
    expect(MemoryExport.parse((await api("GET", `/api/projects/${p}/memories/export`, s)).json).notes).toEqual([]);
    const r = await chat(key.secret, "after expiry", { "X-Project-Id": p });
    expect(r.status).toBe(200);
    await h.gateway.idle();
    expect(sentMessages()).toEqual([{ role: "user", text: "after expiry" }]); // expired note is never injected
    // still physically stored until the worker runs
    expect((await h.db.query<any>("select count(*)::int n from project_memories where project_id=$1", [p]))[0].n).toBe(1);
    const report = await purgeExpiredMemories({ db: h.db, now: () => new Date(h.clock.now), newId: randomId });
    expect(report).toEqual({ deleted: 1, projects: [p] });
    expect((await h.db.query<any>("select count(*)::int n from project_memories where project_id=$1", [p]))[0].n).toBe(0);
    expect((await purgeExpiredMemories({ db: h.db, now: () => new Date(h.clock.now), newId: randomId })).deleted).toBe(0);
    const aud = await h.db.query<any>("select metadata from audit_events where action='memory.retention_purged' and target_id=$1", [p]);
    expect(aud[0].metadata).toEqual({ deleted: 1 });
    h.config.sessionTtlSeconds = 86_400;
  });
});

describe("scoped injection and usage evidence", () => {
  it("no implicit injection: a flagged note is not sent unless the account's policy opted in", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const p = await newProject(s);
    await addNote(s, p, "flagged but policy off", { inject: true });
    const r = await chat(key.secret, "hello", { "X-Project-Id": p });
    expect(r.status).toBe(200);
    await h.gateway.idle();
    expect(sentMessages()).toEqual([{ role: "user", text: "hello" }]);
    expect(await usageRows(p)).toEqual([]);
  });

  it("injects only inject-flagged notes of the request's project, labelled as reference data, and records 'note N version V used in request R'", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const p = await newProject(s);
    const n1 = (await addNote(s, p, "Use TypeScript strict mode.", { inject: true })).json;
    const n2 = (await addNote(s, p, "Never touch the billing tables.", { inject: true })).json;
    const unflagged = (await addNote(s, p, "private scratch note")).json;
    expect((await policy(s, 0, ON)).status).toBe(200);

    const r = await chat(key.secret, "do the thing", { "X-Project-Id": p });
    expect(r.status).toBe(200);
    await h.gateway.idle();
    expect(sentMessages()).toEqual([
      { role: "user", text: `${MEMORY_PREFIX}- Use TypeScript strict mode.\n- Never touch the billing tables.` },
      { role: "user", text: "do the thing" },
    ]);
    expect(JSON.stringify(sentMessages())).not.toContain("private scratch note");
    const id = reqId(r);
    expect(await usageRows(p)).toEqual([
      { memory_id: n1.id, version: 1, request_id: id, status: "injected", reason: null },
      { memory_id: n2.id, version: 1, request_id: id, status: "injected", reason: null },
    ]);
    const ev = (await h.db.query<any>("select status, detail from optimization_evidence where request_id=$1 and feature='project_context'", [id]))[0];
    expect(ev).toMatchObject({ status: "applied", detail: { notes: 2, eligibleNotes: 2 } });

    // an edit bumps the version; the next request records the new one
    await putNote(s, p, n1.id, { text: "Use TypeScript strict mode and noUncheckedIndexedAccess.", expectedVersion: 1 });
    const r2 = await chat(key.secret, "again", { "X-Project-Id": p });
    await h.gateway.idle();
    expect(sentMessages()[0]!.text).toContain("noUncheckedIndexedAccess");
    const used = await api<any>("GET", `/api/projects/${p}/memories/usage?memoryId=${n1.id}`, s);
    expect(used.json.items.map((u: any) => [u.requestId, u.version, u.status])).toEqual([[reqId(r2), 2, "injected"], [id, 1, "injected"]]);
    expect(used.json.items[0]).toMatchObject({ memoryId: n1.id, reason: null });
    expect((await api("GET", `/api/projects/${p}/memories/usage?memoryId=${unflagged.id}`, s)).json.items).toEqual([]);

    // evidence survives deleting the note, but holds only ids and versions
    await api("DELETE", `/api/projects/${p}/memories/${n2.id}`, s);
    const after = await api<any>("GET", `/api/projects/${p}/memories/usage?limit=1`, s);
    expect(after.json.items).toHaveLength(1);
    expect(after.json.nextCursor).toBeTruthy();
    const all = MemoryExport.parse((await api("GET", `/api/projects/${p}/memories/export`, s)).json);
    expect(all.usage.filter((u) => u.memoryId === n2.id)).toHaveLength(2);
    expect(JSON.stringify(all.usage)).not.toContain("billing tables");
    await expect(h.db.query("delete from memory_usage")).rejects.toThrow(/append-only/);
  });

  it("budgets: notes beyond maxNotes / maxChars are recorded as skipped (over_budget), not silently dropped", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const p = await newProject(s);
    const ids: string[] = [];
    for (const t of ["note one", "note two", "note three"]) ids.push((await addNote(s, p, t, { inject: true })).json.id);
    await policy(s, 0, { enabled: true, maxNotes: 2, maxChars: 2000 });
    const r = await chat(key.secret, "q", { "X-Project-Id": p });
    await h.gateway.idle();
    expect(sentMessages()[0]!.text).toBe(`${MEMORY_PREFIX}- note one\n- note two`);
    const rows = await usageRows(p);
    expect(rows.map((u) => [u.memory_id, u.status, u.reason])).toEqual([[ids[0], "injected", null], [ids[1], "injected", null], [ids[2], "skipped", "over_budget"]]);
    expect(rows.every((u) => u.request_id === reqId(r))).toBe(true);
    await policy(s, 1, { enabled: true, maxNotes: 20, maxChars: 100 });
    await addNote(s, p, "x".repeat(300), { inject: true });
    const r2 = await chat(key.secret, "q2", { "X-Project-Id": p });
    await h.gateway.idle();
    expect(reqId(r2)).toBeTruthy();
    expect(sentMessages()[0]!.text).toBe(`${MEMORY_PREFIX}- note one\n- note two\n- note three`);
  });

  it("skips with a reason: no project, no eligible notes, per-request opt-out", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const p = await newProject(s);
    const empty = await newProject(s);
    const n = (await addNote(s, p, "context", { inject: true })).json;
    await policy(s, 0, ON);
    const noProject = await chat(key.secret, "no project header");
    const noNotes = await chat(key.secret, "empty project", { "X-Project-Id": empty });
    const optOut = await chat(key.secret, "opt out", { "X-Project-Id": p, "X-Optimize": "off" });
    await h.gateway.idle();
    const why = async (r: Response) => (await h.db.query<any>("select status, reason from optimization_evidence where request_id=$1 and feature='project_context'", [reqId(r)]))[0];
    expect(await why(noProject)).toEqual({ status: "skipped", reason: "no_project" });
    expect(await why(noNotes)).toEqual({ status: "skipped", reason: "no_eligible_notes" });
    expect(await why(optOut)).toEqual({ status: "skipped", reason: "request_opt_out" });
    expect(await usageRows(p)).toEqual([{ memory_id: n.id, version: 1, request_id: reqId(optOut), status: "skipped", reason: "request_opt_out" }]);
    expect(sentMessages()).toEqual([{ role: "user", text: "opt out" }]);
  });

  it("a key bound to a project injects that project's notes without any header", async () => {
    const s = await login(h.gwApp);
    await fund(h, s.accountId, 3_000_000n);
    const p = await newProject(s);
    await addNote(s, p, "bound project note", { inject: true });
    const key = await createKey(h, s, { projectId: p });
    await policy(s, 0, ON);
    const r = await chat(key.secret, "via bound key");
    expect(r.status).toBe(200);
    await h.gateway.idle();
    expect(sentMessages()[0]!.text).toContain("bound project note");
    expect((await usageRows(p))[0]).toMatchObject({ status: "injected", request_id: reqId(r) });
  });

  it("preview shows the notes that would be injected without recording usage", async () => {
    const s = await login(h.gwApp);
    const p = await newProject(s);
    await addNote(s, p, "preview note", { inject: true });
    await policy(s, 0, ON);
    const pv = await api<any>("POST", "/api/optimization/preview", s, { model: "sample-fast-1", projectId: p, messages: [{ role: "user", content: "q" }] });
    expect(pv.json.messages.map((m: any) => m.origin)).toEqual(["project_memory", "request"]);
    expect(pv.json.messages[0].content).toContain("preview note");
    expect(pv.json.changes[0]).toMatchObject({ feature: "project_context", status: "applied", detail: { notes: 1 } });
    expect(await usageRows(p)).toEqual([]);
  });

  it("no implicit retention: prompts and completions never reach project_memories, and the dump holds only explicit note text", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const p = await newProject(s);
    await addNote(s, p, "the only stored text", { inject: true });
    await policy(s, 0, ON);
    const marker = "IMPLICIT-PROMPT-MARKER-9981";
    const r = await chat(key.secret, `${marker} please remember this forever`, { "X-Project-Id": p });
    expect(r.status).toBe(200);
    await h.gateway.idle();
    expect((await h.db.query<any>("select count(*)::int n from project_memories where project_id=$1", [p]))[0].n).toBe(1);
    const dump = await dumpDatabase(h.db);
    expect(dump).not.toContain(marker);
    expect(dump).not.toContain("tok0"); // no completion text either
    expect(dump).toContain("the only stored text");
  });
});

describe("injection right (owner/admin only) and non-system delivery", () => {
  it("members cannot create, flag or edit injected notes; owner/admin can; notes reach the provider as user-role context", async () => {
    const owner = await login(h.gwApp);
    const p = await newProject(owner);
    const member = await seedMember(h, owner.accountId, "member");
    const admin = await seedMember(h, owner.accountId, "admin");
    expect((await addNote(member, p, "member note", { inject: true })).status).toBe(403);
    const plain = (await addNote(member, p, "plain member note")).json;
    expect((await putNote(member, p, plain.id, { text: "now flagged", expectedVersion: 1, inject: true })).status).toBe(403);
    const flagged = await addNote(admin, p, "admin injected note", { inject: true });
    expect(flagged.status).toBe(201);
    expect((await putNote(member, p, flagged.json.id, { text: "member rewrites an injected note", expectedVersion: 1 })).status).toBe(403);
    expect((await putNote(member, p, plain.id, { text: "member edits own plain note", expectedVersion: 1 })).status).toBe(200);
    expect((await putNote(owner, p, flagged.json.id, { text: "owner edit", expectedVersion: 1 })).status).toBe(200);
    expect((await policy(owner, 0, ON)).status).toBe(200);
    const key = await createKey(h, owner);
    await fund(h, owner.accountId, 5_000_000n);
    expect((await chat(key.secret, "go", { "X-Project-Id": p })).status).toBe(200);
    await h.gateway.idle();
    const sent = sentMessages();
    expect(sent.filter((m) => m.role === "system")).toEqual([]);
    expect(sent[0]).toEqual({ role: "user", text: `${MEMORY_PREFIX}- owner edit` });
  });
});
