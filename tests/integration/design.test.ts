/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Design, DesignExport, DESIGN_EXPORT_LABEL } from "@llmcrypto/contracts";
import { randomId } from "../../apps/api/src/crypto";
import { reconcileUsage } from "../../apps/worker/src/reconcile-usage";
import { BASE_TIME, advance, call, dumpDatabase, login, seedMember } from "./helpers";
import { makeBetaHarness, newProject, runDesigns, type BetaHarness } from "./beta-helpers";
import { fund, idemKey } from "./metering-helpers";

let h: BetaHarness;
beforeAll(async () => {
  h = await makeBetaHarness();
});
afterAll(async () => {
  await h.db.close();
});
beforeEach(() => {
  h.clock.now = new Date(BASE_TIME);
  h.fake.requests.length = 0;
  h.fake.calls.length = 0;
});

const BRIEF = "A small service that lets customers export their invoices as PDF files on demand.";
const createDesign = (cookie: string, projectId: string, over: Record<string, unknown> = {}, key: string | null = idemKey()) =>
  call<any>(h.app, "POST", `/api/projects/${projectId}/designs`, { cookie, body: { title: "Invoice export", brief: BRIEF, ...over }, headers: key ? { "Idempotency-Key": key } : {} });
const revise = (cookie: string, designId: string, body: Record<string, unknown>, key: string | null = idemKey()) =>
  call<any>(h.app, "POST", `/api/designs/${designId}/revisions`, { cookie, body, headers: key ? { "Idempotency-Key": key } : {} });
const getDesign = (cookie: string, id: string) => call<any>(h.app, "GET", `/api/designs/${id}`, { cookie });
const balance = async (cookie: string) => (await call<any>(h.app, "GET", "/api/accounts/current/balance", { cookie })).json;

async function funded(micro = 50_000_000n) {
  const s = await login(h.app);
  await fund(h, s.accountId, micro);
  const project = await newProject(h, s.cookie);
  return { s, project };
}

describe("brief -> metered proposal", () => {
  it("replays an accepted revision while queued and completed without mutable admission checks", async () => {
    const { s, project } = await funded();
    const created = await createDesign(s.cookie, project);
    await runDesigns(h);
    const key = idemKey();
    const body = { baseRevision: 1, instruction: "Add a short section on retention." };
    const accepted = await revise(s.cookie, created.json.designId, body, key);
    expect(accepted.status).toBe(202);
    const queued = await revise(s.cookie, created.json.designId, body, key);
    expect(queued.status).toBe(202);
    expect(queued.headers.get("idempotent-replay")).toBe("true");
    expect(queued.json).toEqual(accepted.json);
    await runDesigns(h);
    const completed = await revise(s.cookie, created.json.designId, body, key);
    expect(completed.status).toBe(202);
    expect(completed.headers.get("idempotent-replay")).toBe("true");
    expect(completed.json).toMatchObject({ revision: 2, status: "succeeded", maxCostMicrousd: accepted.json.maxCostMicrousd });
    expect((await getDesign(s.cookie, created.json.designId)).json.revisions).toHaveLength(2);
    expect((await revise(s.cookie, created.json.designId, { ...body, instruction: "Changed instruction" }, key)).json.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("queues a generation with a visible cost quote, runs it through the reservation path, charges exactly the reported usage", async () => {
    const { s, project } = await funded();
    const before = await balance(s.cookie);
    const r = await createDesign(s.cookie, project);
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ revision: 1, status: "queued" });
    expect(BigInt(r.json.maxCostMicrousd)).toBeGreaterThan(0n);
    const queued = Design.parse((await getDesign(s.cookie, r.json.designId)).json);
    expect(queued.revisions[0]).toMatchObject({ status: "queued", document: null, aiGenerated: true, cost: { state: "none", chargedMicrousd: null, maxMicrousd: r.json.maxCostMicrousd } });
    expect(h.fake.calls).toHaveLength(0); // creating only queues

    const report = await runDesigns(h);
    expect(report.succeeded).toHaveLength(1);
    expect(h.fake.calls).toHaveLength(1);

    const d = Design.parse((await getDesign(s.cookie, r.json.designId)).json);
    const rev = d.revisions[0]!;
    expect(rev.status).toBe("succeeded");
    expect(rev.document?.title).toBe("Proposal: Invoice export");
    expect(rev.cost.state).toBe("charged");
    const charge = BigInt(rev.cost.chargedMicrousd!);
    expect(charge).toBeGreaterThan(0n);
    expect(charge).toBeLessThanOrEqual(BigInt(r.json.maxCostMicrousd));
    expect(d.totalChargedMicrousd).toBe(charge.toString());

    // Same ledger/usage/request rows the gateway writes: one balanced spend, usage record == ledger == reported cost.
    const [u] = await h.db.query<any>("select charge_microusd::text c, ledger_transaction_id, usage_source from usage_records where request_id=$1", [rev.cost.requestId]);
    expect(u).toMatchObject({ c: charge.toString(), usage_source: "provider" });
    const [spend] = await h.db.query<any>("select sum(amount)::text s from ledger_entries where transaction_id=$1 and ledger_account='customer_funds'", [u.ledger_transaction_id]);
    expect(spend.s).toBe((-charge).toString());
    const [rq] = await h.db.query<any>("select state, outcome, protocol, key_id, project_id, run_id from requests where id=$1", [rev.cost.requestId]);
    expect(rq).toMatchObject({ state: "SETTLED", outcome: "succeeded", protocol: "openai_chat", key_id: null, project_id: project, run_id: `design:${r.json.designId}` });
    const after = await balance(s.cookie);
    expect(BigInt(before.postedMicrousd) - BigInt(after.postedMicrousd)).toBe(charge);
    expect(after.heldMicrousd).toBe("0");

    // Cost is visible in the usage report like any other metered call.
    const usage = (await call<any>(h.app, "GET", `/api/usage?projectId=${project}`, { cookie: s.cookie })).json.items;
    expect(usage.find((x: any) => x.requestId === rev.cost.requestId)).toMatchObject({ chargeMicrousd: charge.toString(), runId: `design:${r.json.designId}` });

    // The brief reached the provider as delimited, untrusted data under the versioned system prompt.
    const sent = h.fake.requests[0]!.messages;
    expect(sent[0]!.role).toBe("system");
    expect(sent[0]!.text).toContain("DESIGN_PROPOSAL_V1");
    expect(sent[1]!.text).toContain(`<brief>\n${BRIEF}\n</brief>`);
    // Prompts and outputs are not stored on the request side.
    expect(JSON.stringify(await h.db.query("select * from requests where id=$1", [rev.cost.requestId]))).not.toContain("invoices");
  });

  it("refuses up front when the quote exceeds available credit, creating nothing", async () => {
    const s = await login(h.app);
    const project = await newProject(h, s.cookie);
    const r = await createDesign(s.cookie, project);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("INSUFFICIENT_FUNDS");
    expect((await h.db.query<any>("select count(*)::int n from designs where account_id=$1", [s.accountId]))[0].n).toBe(0);
  });

  it("validates input and the model", async () => {
    const { s, project } = await funded();
    expect((await createDesign(s.cookie, project, { brief: "short" })).status).toBe(422);
    expect((await createDesign(s.cookie, project, { title: "" })).status).toBe(422);
    expect((await createDesign(s.cookie, project, { extra: 1 })).status).toBe(422);
    const bad = await createDesign(s.cookie, project, { model: "no-such-model" });
    expect(bad.status).toBe(422);
    expect(bad.json.error.fieldErrors[0].field).toBe("model");
    expect((await createDesign(s.cookie, project, {}, null)).json.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await call(h.app, "POST", `/api/projects/${project}/designs`, { body: { title: "t", brief: BRIEF }, headers: { "Idempotency-Key": idemKey() } })).status).toBe(401);
  });

  it("is idempotent: the same key replays one design, and a rerun of the worker does not charge twice", async () => {
    const { s, project } = await funded();
    const key = idemKey();
    const a = await createDesign(s.cookie, project, {}, key);
    const b = await createDesign(s.cookie, project, {}, key);
    expect(b.json.designId).toBe(a.json.designId);
    expect(b.headers.get("idempotent-replay")).toBe("true");
    expect((await createDesign(s.cookie, project, { title: "Other" }, key)).json.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await h.db.query<any>("select count(*)::int n from designs where project_id=$1", [project]))[0].n).toBe(1);
    await runDesigns(h);
    await runDesigns(h);
    expect(h.fake.calls).toHaveLength(1);
    expect((await h.db.query<any>("select count(*)::int n from ledger_transactions where kind='spend' and account_id=$1", [s.accountId]))[0].n).toBe(1);
  });

  it("two runners generate a queued revision exactly once", async () => {
    const { s, project } = await funded();
    await createDesign(s.cookie, project);
    const [a, b] = await Promise.all([runDesigns(h), runDesigns(h)]);
    expect([...a.succeeded, ...b.succeeded]).toHaveLength(1);
    expect(h.fake.calls).toHaveLength(1);
  });
});

describe("revisions", () => {
  it("revises from the latest proposal; stale base or a running generation is a 409; each revision is metered", async () => {
    const { s, project } = await funded();
    const r = await createDesign(s.cookie, project);
    const id = r.json.designId;
    // Cannot revise while revision 1 is still queued.
    expect((await revise(s.cookie, id, { instruction: "Add audit logging", baseRevision: 1 })).json.error.code).toBe("VERSION_CONFLICT");
    await runDesigns(h);
    expect((await revise(s.cookie, id, { instruction: "Add audit logging", baseRevision: 7 })).status).toBe(409);
    expect((await revise(s.cookie, id, { instruction: "x", baseRevision: 1 })).status).toBe(422);
    const rv = await revise(s.cookie, id, { instruction: "Add audit logging", baseRevision: 1 });
    expect(rv.status).toBe(202);
    expect(rv.json).toMatchObject({ designId: id, revision: 2, status: "queued" });
    expect((await revise(s.cookie, id, { instruction: "Another", baseRevision: 1 })).status).toBe(409); // not the latest any more
    h.fake.requests.length = 0;
    await runDesigns(h);
    const d = Design.parse((await getDesign(s.cookie, id)).json);
    expect(d.latestRevision).toBe(2);
    expect(d.revisions.map((x) => [x.number, x.kind, x.status])).toEqual([[1, "proposal", "succeeded"], [2, "revision", "succeeded"]]);
    expect(d.revisions[1]!.instruction).toBe("Add audit logging");
    expect(d.revisions[1]!.document?.sections.map((x) => x.heading)).toContain("Revision");
    expect(d.revisions[1]!.document?.sections.find((x) => x.heading === "Revision")?.body).toContain("Add audit logging");
    // The revision prompt carried the previous document and the instruction (delimited).
    const prompt = h.fake.requests[0]!.messages[1]!.text;
    expect(prompt).toContain("Current proposal (JSON):");
    expect(prompt).toContain('"title":"Proposal: Invoice export"');
    expect(prompt).toContain("<instruction>\nAdd audit logging\n</instruction>");
    const charges = d.revisions.map((x) => BigInt(x.cost.chargedMicrousd!));
    expect(d.totalChargedMicrousd).toBe((charges[0]! + charges[1]!).toString());
    expect(new Set(d.revisions.map((x) => x.cost.requestId)).size).toBe(2);
    // Past revisions stay readable and unchanged.
    expect(d.revisions[0]!.document?.sections).toHaveLength(1);
  });

  it("the revision cap and the active-generation cap are enforced", async () => {
    const hh = await makeBetaHarness((c) => ({ ...c, design: { ...c.design, maxRevisionsPerDesign: 2, maxActivePerAccount: 1 } }));
    try {
      const s = await login(hh.app);
      await fund(hh, s.accountId, 50_000_000n);
      const p = await newProject(hh, s.cookie);
      const mk = (title: string) => call<any>(hh.app, "POST", `/api/projects/${p}/designs`, { cookie: s.cookie, body: { title, brief: BRIEF }, headers: { "Idempotency-Key": idemKey() } });
      const first = await mk("one");
      expect(first.status).toBe(202);
      const second = await mk("two");
      expect(second.status).toBe(429);
      await runDesigns(hh);
      const rev = (n: number) => call<any>(hh.app, "POST", `/api/designs/${first.json.designId}/revisions`, { cookie: s.cookie, body: { instruction: "tweak it", baseRevision: n }, headers: { "Idempotency-Key": idemKey() } });
      expect((await rev(1)).status).toBe(202);
      await runDesigns(hh);
      const over = await rev(2);
      expect(over.status).toBe(422);
    } finally {
      await hh.db.close();
    }
  });
});

describe("failed or malformed generation", () => {
  it("a provider that rejects the request releases the hold and charges nothing", async () => {
    const { s, project } = await funded();
    const before = await balance(s.cookie);
    const r = await createDesign(s.cookie, project, { brief: `${BRIEF} [[fake:reject]]` });
    await runDesigns(h);
    const d = Design.parse((await getDesign(s.cookie, r.json.designId)).json);
    expect(d.revisions[0]).toMatchObject({ status: "failed", document: null, failure: { code: "PROVIDER_REJECTED" }, cost: { state: "released", chargedMicrousd: "0" } });
    const [res] = await h.db.query<any>("select status, charge_microusd from reservations where request_id=$1", [d.revisions[0]!.cost.requestId]);
    expect(res.status).toBe("released");
    expect((await h.db.query<any>("select count(*)::int n from ledger_transactions where kind='spend' and account_id=$1", [s.accountId]))[0].n).toBe(0);
    expect(await balance(s.cookie)).toMatchObject({ postedMicrousd: before.postedMicrousd, heldMicrousd: "0" });
    expect((await call(h.app, "GET", `/api/designs/${r.json.designId}/export`, { cookie: s.cookie })).status).toBe(404); // nothing to export
    // The user can try again from the failed revision (the brief still carries the reject directive, so the fake rejects again).
    const again = await revise(s.cookie, r.json.designId, { instruction: "Please try once more", baseRevision: 1 });
    expect(again.status).toBe(202);
    await runDesigns(h);
    expect(Design.parse((await getDesign(s.cookie, r.json.designId)).json).revisions[1]).toMatchObject({ status: "failed", failure: { code: "PROVIDER_REJECTED" } });
    expect(await balance(s.cookie)).toMatchObject({ postedMicrousd: before.postedMicrousd, heldMicrousd: "0" });
  });

  it.each([
    ["prose instead of JSON", "[[fake:malformed]]", /not valid JSON/],
    ["JSON of the wrong shape", "[[fake:bad_schema]]", /does not match the design schema/],
  ])("malformed output (%s) is a clear failure: no document is kept, the completed call is billed and the hold closes", async (_n, directive, msg) => {
    const { s, project } = await funded();
    const r = await createDesign(s.cookie, project, { brief: `${BRIEF} ${directive}` });
    await runDesigns(h);
    const d = Design.parse((await getDesign(s.cookie, r.json.designId)).json);
    expect(d.revisions[0]).toMatchObject({ status: "failed", document: null, failure: { code: "MALFORMED_OUTPUT" }, cost: { state: "charged" } });
    expect(d.revisions[0]!.failure!.message).toMatch(msg);
    expect(BigInt(d.revisions[0]!.cost.chargedMicrousd!)).toBeGreaterThan(0n);
    expect((await balance(s.cookie)).heldMicrousd).toBe("0");
    // The raw model output is not stored anywhere.
    expect(await dumpDatabase(h.db)).not.toContain("great design with many parts");
  });

  it("output cut off at the token cap is malformed JSON and says so", async () => {
    const { s, project } = await funded();
    const r = await createDesign(s.cookie, project);
    await runDesigns(h, { maxOutputTokens: 12 });
    const d = Design.parse((await getDesign(s.cookie, r.json.designId)).json);
    expect(d.revisions[0]).toMatchObject({ status: "failed", failure: { code: "MALFORMED_OUTPUT" }, document: null });
    expect(d.revisions[0]!.failure!.message).toMatch(/cut off at the token cap/);
  });

  it("a reservation refusal at run time (project cap) fails the revision with no provider call and no charge", async () => {
    const { s, project } = await funded();
    const r = await createDesign(s.cookie, project);
    await h.db.query("update projects set spend_cap_microusd=1 where id=$1", [project]);
    await runDesigns(h);
    const d = Design.parse((await getDesign(s.cookie, r.json.designId)).json);
    expect(d.revisions[0]).toMatchObject({ status: "failed", failure: { code: "PROJECT_CAP_EXCEEDED" }, cost: { state: "released", chargedMicrousd: "0" } });
    expect(h.fake.calls).toHaveLength(0);
    expect((await balance(s.cookie)).heldMicrousd).toBe("0");
  });

  it("a provider timeout keeps the hold as USAGE_PENDING (never an assumed zero charge) until reconciliation", async () => {
    const { s, project } = await funded();
    const r = await createDesign(s.cookie, project, { brief: `${BRIEF} [[fake:hang]]` });
    await runDesigns(h, { timeoutMs: 40, usagePendingSeconds: 60 });
    const d = Design.parse((await getDesign(s.cookie, r.json.designId)).json);
    expect(d.revisions[0]).toMatchObject({ status: "failed", failure: { code: "PROVIDER_TIMEOUT" }, cost: { state: "pending", chargedMicrousd: null } });
    expect(BigInt((await balance(s.cookie)).heldMicrousd)).toBeGreaterThan(0n);
    advance(h, 120);
    const rep = await reconcileUsage({ db: h.db, source: h.fake, now: () => h.config.now(), newId: randomId });
    expect(rep.absorbed).toEqual([d.revisions[0]!.cost.requestId]);
    expect(Design.parse((await getDesign(s.cookie, r.json.designId)).json).revisions[0]!.cost).toMatchObject({ state: "released", chargedMicrousd: "0" });
    expect((await balance(s.cookie)).heldMicrousd).toBe("0");
  });

  it("a generation whose runner died is failed as INTERRUPTED once its lease expires, and is never re-run", async () => {
    const { s, project } = await funded();
    const r = await createDesign(s.cookie, project);
    await h.db.query("update design_revisions set status='generating', lease_until=$2 where design_id=$1", [r.json.designId, new Date(BASE_TIME.getTime() - 1000)]);
    const report = await runDesigns(h);
    expect(report.interrupted).toHaveLength(1);
    expect(h.fake.calls).toHaveLength(0);
    expect(Design.parse((await getDesign(s.cookie, r.json.designId)).json).revisions[0]).toMatchObject({ status: "failed", failure: { code: "INTERRUPTED" } });
  });
});

describe("export", () => {
  it("exports markdown and JSON, labelled AI-generated, inert (escaped, attachment, sandboxed) and never executed", async () => {
    const { s, project } = await funded();
    const r = await createDesign(s.cookie, project, { title: "Export <b>me</b>", brief: `${BRIEF} <script>alert(1)</script>` });
    await runDesigns(h);
    const id = r.json.designId;
    const md = await h.app.request(`/api/designs/${id}/export?format=markdown`, { headers: { Cookie: s.cookie } });
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(md.headers.get("content-disposition")).toMatch(/^attachment; filename="design-.*-r1\.md"$/);
    expect(md.headers.get("content-security-policy")).toContain("sandbox");
    expect(md.headers.get("x-content-type-options")).toBe("nosniff");
    const text = await md.text();
    expect(text.startsWith(`> **${DESIGN_EXPORT_LABEL}**`)).toBe(true);
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
    expect(text).toContain("Deterministic output of the FakeProvider");
    const js = await h.app.request(`/api/designs/${id}/export?format=json`, { headers: { Cookie: s.cookie } });
    expect(js.headers.get("content-disposition")).toContain(".json");
    const parsed = DesignExport.parse(await js.json());
    expect(parsed.label).toBe(DESIGN_EXPORT_LABEL);
    expect(parsed.generation.chargedMicrousd).not.toBeNull();
    expect(parsed.revision.number).toBe(1);
    // A chosen revision, an unknown one and a bad format.
    expect((await call(h.app, "GET", `/api/designs/${id}/export?revision=1`, { cookie: s.cookie })).status).toBe(200);
    expect((await call(h.app, "GET", `/api/designs/${id}/export?revision=9`, { cookie: s.cookie })).status).toBe(404);
    expect((await call(h.app, "GET", `/api/designs/${id}/export?format=html`, { cookie: s.cookie })).status).toBe(422);
    expect((await h.db.query<any>("select count(*)::int n from audit_events where action='design.exported' and target_id=$1", [id]))[0].n).toBe(3);
  });
});

describe("ownership, roles and deletion", () => {
  it("another account or project can never read, revise, export or delete a design; billing is excluded; members can't delete others' designs", async () => {
    const { s, project } = await funded();
    const r = await createDesign(s.cookie, project);
    await runDesigns(h);
    const id = r.json.designId;
    const other = await login(h.app);
    await fund(h, other.accountId, 50_000_000n);
    for (const [m, path, body] of [["GET", `/api/designs/${id}`], ["GET", `/api/designs/${id}/export`], ["DELETE", `/api/designs/${id}`], ["POST", `/api/designs/${id}/revisions`, { instruction: "steal it", baseRevision: 1 }]] as const) {
      const res = await call<any>(h.app, m, path, { cookie: other.cookie, ...(body ? { body, headers: { "Idempotency-Key": idemKey() } } : {}) });
      expect(res.status, `${m} ${path}`).toBe(404);
    }
    expect((await createDesign(other.cookie, project)).status).toBe(404); // someone else's project
    const otherProject = await newProject(h, other.cookie);
    expect((await call<any>(h.app, "GET", `/api/projects/${otherProject}/designs`, { cookie: other.cookie })).json.items).toEqual([]);
    expect((await call<any>(h.app, "GET", `/api/projects/${project}/designs`, { cookie: other.cookie })).status).toBe(404);
    expect((await call<any>(h.app, "GET", `/api/projects/${project}/designs`, { cookie: s.cookie })).json.items.map((x: any) => x.id)).toEqual([id]);

    const billing = await seedMember(h, s.accountId, "billing");
    expect((await getDesign(billing.cookie, id)).status).toBe(403);
    expect((await createDesign(billing.cookie, project)).status).toBe(403);
    const member = await seedMember(h, s.accountId, "member");
    expect((await getDesign(member.cookie, id)).status).toBe(200);
    expect((await call(h.app, "DELETE", `/api/designs/${id}`, { cookie: member.cookie })).status).toBe(403);
    expect((await call(h.app, "GET", `/api/designs/${id}`, {})).status).toBe(401);
    // API-key sessions are refused centrally.
    expect((await call(h.app, "GET", `/api/designs/${id}`, { cookie: "session=bogus" })).status).toBe(401);
  });

  it("delete removes the brief, instructions and documents for good; financial rows stay and hold no text", async () => {
    const { s, project } = await funded();
    const unique = `zq${randomId("u")}`;
    const r = await createDesign(s.cookie, project, { brief: `${BRIEF} ${unique}` });
    await runDesigns(h);
    const d = Design.parse((await getDesign(s.cookie, r.json.designId)).json);
    expect(await dumpDatabase(h.db)).toContain(unique);
    expect((await call(h.app, "DELETE", `/api/designs/${r.json.designId}`, { cookie: s.cookie })).status).toBe(204);
    expect(await dumpDatabase(h.db)).not.toContain(unique);
    expect((await h.db.query<any>("select count(*)::int n from design_revisions where design_id=$1", [r.json.designId]))[0].n).toBe(0);
    expect((await h.db.query<any>("select count(*)::int n from requests where id=$1", [d.revisions[0]!.cost.requestId]))[0].n).toBe(1);
    expect((await getDesign(s.cookie, r.json.designId)).status).toBe(404);
    expect((await h.db.query<any>("select metadata from audit_events where action='design.deleted' and target_id=$1", [r.json.designId]))).toHaveLength(1);
  });
});

describe("feature flag", () => {
  it("off: 404 FEATURE_DISABLED", async () => {
    const off = await makeBetaHarness((c) => ({ ...c, features: { repositoryGraph: true, designBeta: false } }));
    try {
      const s = await login(off.app);
      const p = await newProject(off, s.cookie);
      const r = await call<any>(off.app, "POST", `/api/projects/${p}/designs`, { cookie: s.cookie, body: { title: "t", brief: BRIEF }, headers: { "Idempotency-Key": idemKey() } });
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe("FEATURE_DISABLED");
    } finally {
      await off.db.close();
    }
  });

  it("the two beta flags are independent, and neither gates the other's (or any other) project routes", async () => {
    const only = await makeBetaHarness((c) => ({ ...c, features: { repositoryGraph: false, designBeta: true } }));
    try {
      const s = await login(only.app);
      await fund(only, s.accountId, 50_000_000n);
      const p = await newProject(only, s.cookie);
      const d = await call<any>(only.app, "POST", `/api/projects/${p}/designs`, { cookie: s.cookie, body: { title: "t", brief: BRIEF }, headers: { "Idempotency-Key": idemKey() } });
      expect(d.status).toBe(202);
      expect((await call<any>(only.app, "GET", `/api/projects/${p}/repository-imports`, { cookie: s.cookie })).json.error.code).toBe("FEATURE_DISABLED");
      expect((await call(only.app, "GET", `/api/projects/${p}/memories`, { cookie: s.cookie })).status).toBe(200);
      expect((await call<any>(only.app, "GET", "/api/features", {})).json).toEqual({ repositoryGraph: false, designBeta: true });
    } finally {
      await only.db.close();
    }
  });
});
