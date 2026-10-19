/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, login } from "./helpers";
import { makeBetaHarness, newProject, type BetaHarness } from "./beta-helpers";

let h: BetaHarness;
beforeAll(async () => {
  h = await makeBetaHarness();
});
afterAll(async () => {
  await h.db.close();
});

const b64 = (v: unknown): string => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

describe("malformed cursors are a 400 everywhere, never a 500", () => {
  it("garbage, wrong-shape, NUL and out-of-range cursors on every paged list", async () => {
    const s = await login(h.app);
    const p = await newProject(h, s.cookie);
    const paths = [
      "/api/keys", "/api/projects", "/api/ledger", "/api/usage", "/api/usage/agent-runs", "/api/deposits", "/api/audit",
      `/api/projects/${p}/memories`, `/api/projects/${p}/memories/usage`, `/api/projects/${p}/repository-imports`, `/api/projects/${p}/designs`,
      "/api/optimization/evidence", "/api/connectivity/deliveries",
    ];
    const bad = ["%%%not-base64", b64("not json"), b64(null), b64([1, 2]), b64(["2026-01-01T00:00:00Z", 5]), b64(["nope", "x"]), b64(["2026-01-01T00:00:00Z", "a\u0000b"]), b64(["+275000-01-01T00:00:00Z", "x"]), b64({ s: "abc" }), "a".repeat(600)];
    for (const path of paths) {
      for (const cursor of bad) {
        const r = await call<any>(h.app, "GET", `${path}?cursor=${encodeURIComponent(cursor)}`, { cookie: s.cookie });
        expect([path, cursor.slice(0, 12), r.status < 500 ? "ok" : r.status].join("|")).toMatch(/\|ok$/);
        expect([400, 404, 422, 403]).toContain(r.status);
      }
    }
  });
});
