/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, login, makeHarness, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(async () => {
  await h.db.close();
});

describe("memory lists order rows with equal timestamps numerically (seq), not as text", () => {
  it("12 notes created at the same instant list in insertion order and page without gaps or repeats", async () => {
    const s = await login(h.app);
    const p = (await call<any>(h.app, "POST", "/api/projects", { cookie: s.cookie, body: { name: "order" } })).json.id;
    for (let i = 1; i <= 12; i++) {
      const r = await call<any>(h.app, "POST", `/api/projects/${p}/memories`, { cookie: s.cookie, body: { text: `note ${i}`, storageConsent: true } });
      expect(r.status).toBe(201);
    }
    const all = (await call<any>(h.app, "GET", `/api/projects/${p}/memories?limit=50`, { cookie: s.cookie })).json.items.map((n: any) => n.text);
    expect(all).toEqual(Array.from({ length: 12 }, (_, i) => `note ${i + 1}`));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: any = (await call<any>(h.app, "GET", `/api/projects/${p}/memories?limit=5${cursor ? `&cursor=${cursor}` : ""}`, { cookie: s.cookie })).json;
      seen.push(...page.items.map((n: any) => n.text));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);
    const exported = (await call<any>(h.app, "GET", `/api/projects/${p}/memories/export`, { cookie: s.cookie })).json.notes.map((n: any) => n.text);
    expect(exported).toEqual(all);
  });
});
