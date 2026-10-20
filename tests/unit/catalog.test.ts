import { describe, expect, it } from "vitest";
import type { CatalogModel } from "@llmcrypto/contracts";
import { copyText, filterCatalog, formatContext, formatRate, providersOf, resultCountText, sortCatalog } from "../../apps/web/src/lib/catalog";
import { SAMPLE_CATALOG } from "../../apps/web/src/lib/sample-catalog";

const items = SAMPLE_CATALOG.items;
const ids = (xs: readonly CatalogModel[]) => xs.map((m) => m.id);

describe("filterCatalog", () => {
  it("returns everything for an empty filter", () => {
    expect(filterCatalog(items, { provider: "", search: "  " })).toHaveLength(items.length);
  });
  it("filters by exact provider", () => {
    expect(ids(filterCatalog(items, { provider: "sample-beta", search: "" })).sort()).toEqual(["beta-fast", "beta-reason"]);
    expect(filterCatalog(items, { provider: "sample-bet", search: "" })).toEqual([]);
  });
  it("searches name, ID and provider case-insensitively", () => {
    expect(ids(filterCatalog(items, { provider: "", search: "GAMMA long" }))).toEqual(["gamma-long"]);
    expect(ids(filterCatalog(items, { provider: "", search: "alpha-s" }))).toEqual(["alpha-small"]);
    expect(ids(filterCatalog(items, { provider: "", search: "sample-gamma" })).sort()).toEqual(["gamma-long", "gamma-mini"]);
  });
  it("combines provider and search with AND and can yield an empty set", () => {
    expect(ids(filterCatalog(items, { provider: "sample-alpha", search: "large" }))).toEqual(["alpha-large"]);
    expect(filterCatalog(items, { provider: "sample-alpha", search: "gamma" })).toEqual([]);
  });
});

describe("sortCatalog / providersOf", () => {
  it("sorts by price and context using exact integers", () => {
    expect(ids(sortCatalog(items, "input"))[0]).toBe("gamma-mini");
    expect(ids(sortCatalog(items, "output"))[0]).toBe("gamma-mini");
    expect(ids(sortCatalog(items, "context"))[0]).toBe("gamma-long");
    expect(ids(sortCatalog(items, "name"))[0]).toBe("alpha-large");
  });
  it("does not mutate its input and lists providers once", () => {
    const before = ids(items);
    sortCatalog(items, "context");
    expect(ids(items)).toEqual(before);
    expect(providersOf(items)).toEqual(["sample-alpha", "sample-beta", "sample-gamma"]);
  });
});

describe("formatting", () => {
  it.each([
    ["3000000", "$3.00"],
    ["250000", "$0.25"],
    ["75000", "$0.075"],
    ["1", "$0.000001"],
    ["0", "$0.00"],
    ["123456789000000", "$123456789.00"],
  ])("formatRate(%s) = %s", (input, out) => expect(formatRate(input)).toBe(out));
  it.each([
    ["200000", "200K"],
    ["1000000", "1M"],
    ["128000", "128K"],
    ["1048576", "1,048,576"],
    ["999", "999"],
  ])("formatContext(%s) = %s", (input, out) => expect(formatContext(input)).toBe(out));
  it("describes result counts", () => {
    expect(resultCountText(6, 6)).toBe("Showing all 6 models");
    expect(resultCountText(2, 6)).toBe("Showing 2 of 6 models");
    expect(resultCountText(0, 0)).toBe("No models available");
  });
});

describe("copyText", () => {
  it("writes exactly the given text via the async clipboard", async () => {
    const written: string[] = [];
    expect(await copyText("alpha-large", { writeText: async (t) => void written.push(t) })).toBe("copied");
    expect(written).toEqual(["alpha-large"]);
  });
  it("falls back to the legacy path when the async clipboard rejects", async () => {
    const legacy: string[] = [];
    const r = await copyText("x", { writeText: () => Promise.reject(new Error("denied")), legacyCopy: (t) => (legacy.push(t), true) });
    expect(r).toBe("copied");
    expect(legacy).toEqual(["x"]);
  });
  it("reports failure when every path fails or none exists, never throwing", async () => {
    expect(await copyText("x", { writeText: () => Promise.reject(new Error("no")), legacyCopy: () => false })).toBe("failed");
    expect(await copyText("x", { legacyCopy: () => { throw new Error("boom"); } })).toBe("failed");
    expect(await copyText("x", {})).toBe("failed");
  });
});
