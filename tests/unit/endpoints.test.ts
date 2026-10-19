import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CONSOLE_ENDPOINTS } from "../../apps/web/src/lib/endpoints";

describe("docs endpoint list matches packages/contracts/openapi.yaml", () => {
  const spec = parse(readFileSync(new URL("../../packages/contracts/openapi.yaml", import.meta.url), "utf8")) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const fromSpec = Object.entries(spec.paths)
    .filter(([path]) => path.startsWith("/api/")) // /v1 and /v1beta are the compatible gateway routes; tests/contracts/gateway-openapi.test.ts covers them
    .flatMap(([path, ops]) => Object.keys(ops).filter((m) => ["get", "post", "delete", "put", "patch"].includes(m)).map((m) => `${m.toUpperCase()} ${path}`))
    .sort();
  it("lists the same operations", () => {
    expect(CONSOLE_ENDPOINTS.map((e) => `${e.method} ${e.path}`).sort()).toEqual(fromSpec);
  });
});
