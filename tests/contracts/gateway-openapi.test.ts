/* eslint-disable @typescript-eslint/no-explicit-any -- parses untyped JSON */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, login } from "../integration/helpers";
import { createKey, fund, makeGatewayHarness, type GatewayHarness } from "../integration/metering-helpers";

const root = new URL("../../", import.meta.url).pathname;
const oas = parse(readFileSync(join(root, "packages/contracts/openapi.yaml"), "utf8")) as { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any> } };

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith(".ts") && !f.endsWith(".test.ts") ? [join(dir, f)] : []));
const apiSource = walk(join(root, "apps/api/src")).map((f) => readFileSync(f, "utf8")).join("\n");

let h: GatewayHarness;
beforeAll(async () => {
  h = await makeGatewayHarness();
});
afterAll(async () => {
  await h.db.close();
});

describe("OpenAPI documents the /v1 gateway surface (drift guard)", () => {
  it("every registered /v1 and /v1beta route is in openapi.yaml, and nothing else is", () => {
    const registered = h.gwApp.routes
      .filter((r) => (r.path.startsWith("/v1/") || r.path.startsWith("/v1beta/")) && r.method !== "ALL")
      .map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:(\w+)\{[^}]*\}/g, "{$1}").replace(/:(\w+)/g, "{$1}")}`);
    const documented = Object.entries(oas.paths)
      .filter(([p]) => p.startsWith("/v1"))
      .flatMap(([p, ops]) => Object.keys(ops).filter((m) => ["get", "post", "put", "delete"].includes(m)).map((m) => `${m} ${p}`));
    expect([...new Set(registered)].sort()).toEqual(documented.sort());
  });

  it("GatewayErrorCode lists exactly the codes the source can raise", () => {
    const fromSource = new Set<string>();
    for (const m of apiSource.matchAll(/new GatewayError\(\s*\d+,\s*"([a-z_]+)"/g)) fromSource.add(m[1]!);
    for (const m of apiSource.matchAll(/return \{ status: \d+, code: "([a-z_]+)"/g)) fromSource.add(m[1]!); // dispatch Failure results
    expect([...fromSource].sort()).toEqual([...oas.components.schemas["GatewayErrorCode"].enum].sort());
  });

  describe("live responses validate against the documented envelopes", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema({ $id: "oas", components: oas.components });
    const check = (name: string, body: unknown): boolean => ajv.getSchema(`oas#/components/schemas/${name}`)!(body) as boolean;

    it("OpenAI-shaped, Anthropic-shaped and model-list bodies", async () => {
      const s = await login(h.gwApp);
      await fund(h, s.accountId, 5_000_000n);
      const key = await createKey(h, s);
      const post = (path: string, headers: Record<string, string>, body: unknown) =>
        h.gwApp.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
      const codes = new Set(oas.components.schemas["GatewayErrorCode"].enum as string[]);

      const noKey = await post("/v1/chat/completions", {}, { model: "sample-fast-1", messages: [{ role: "user", content: "hi" }] });
      expect(noKey.status).toBe(401);
      const noKeyBody: any = await noKey.json();
      expect(check("OpenAIErrorEnvelope", noKeyBody)).toBe(true);
      expect(codes.has(noKeyBody.error.code)).toBe(true);

      const badModel = await post("/v1/chat/completions", { Authorization: `Bearer ${key.secret}` }, { model: "nope", messages: [{ role: "user", content: "hi" }] });
      const bm: any = await badModel.json();
      expect([badModel.status, check("OpenAIErrorEnvelope", bm), codes.has(bm.error.code)]).toEqual([404, true, true]);

      const anth = await post("/v1/messages", { "x-api-key": "sk_bogus" }, { model: "sample-fast-1", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
      const ab: any = await anth.json();
      expect([anth.status, check("AnthropicErrorEnvelope", ab)]).toEqual([401, true]);

      const gem: any = await (await post("/v1beta/models/x:generateContent", {}, {})).json();
      expect([check("OpenAIErrorEnvelope", gem), gem.error.code]).toEqual([true, "protocol_not_implemented"]);

      const models = await call<any>(h.gwApp, "GET", "/v1/models", {});
      expect(check("ModelList", models.json)).toBe(true);
    });
  });
});
