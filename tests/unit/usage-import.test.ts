import { describe, expect, it } from "vitest";
import {
  IMPORT_LIMITS,
  UsageImportError,
  buildReport,
  csvSafeCell,
  importUsage,
  parseTokenCount,
  parseUsdToMicro,
  reportToCsv,
  reportToJson,
  type ImportErrorCode,
  type PriceSnapshot,
} from "../../packages/domain/src/usage-import";
import { makeZip } from "./zip-fixture";

const enc = new TextEncoder();
const file = (name: string, text: string) => ({ name, bytes: enc.encode(text) });

const snapshot: PriceSnapshot = {
  pricingVersion: "pv_test",
  source: "test fixture",
  asOf: "2026-10-18",
  isSample: false,
  models: [
    { id: "alpha-small", inputMicrousdPerMtok: "3000000", cachedInputMicrousdPerMtok: "300000", outputMicrousdPerMtok: "15000000" },
    { id: "beta-fast", inputMicrousdPerMtok: "1", cachedInputMicrousdPerMtok: null, outputMicrousdPerMtok: "7" },
  ],
};

async function codeOf(p: Promise<unknown>): Promise<ImportErrorCode | "no-error"> {
  try {
    await p;
    return "no-error";
  } catch (e) {
    if (e instanceof UsageImportError) return e.code;
    throw e;
  }
}

describe("CSV import and arithmetic", () => {
  it("prices tokens with bigint micro-USD, rounding up once per model and category", async () => {
    const csv = [
      "model,input_tokens,output_tokens,cached_tokens",
      "alpha-small,1000000,250001,2000000",
      "ALPHA-SMALL ,500000,0,0",
    ].join("\n");
    const r = await importUsage(file("u.csv", csv));
    const rep = buildReport(r, snapshot, "2026-10-18T00:00:00Z");
    const line = rep.matched[0];
    expect(rep.matched).toHaveLength(1);
    expect(line?.requests).toBe(2);
    // input 1,500,000 * 3,000,000 / 1e6 = 4,500,000; output 250,001 * 15 = 3,750,015; cached 2,000,000 * 0.3 = 600,000
    expect(line?.estimatedMicrousd).toBe(4_500_000n + 3_750_015n + 600_000n);
    expect(rep.comparison.status).toBe("insufficient_data");
  });

  it("rounds a sub-micro charge up, never to zero, and prices cached at the input rate when no cached rate exists", async () => {
    const r = await importUsage(file("u.csv", "model,input_tokens,output_tokens,cached_tokens\nbeta-fast,1,1,1\n"));
    const line = buildReport(r, snapshot, "t").matched[0];
    expect(line?.estimatedMicrousd).toBe(1n + 1n + 1n);
    expect(line?.cachedRateAssumed).toBe(true);
  });

  it("keeps exact precision beyond 2^53", async () => {
    const big = "9007199254740993";
    const r = await importUsage(file("u.csv", `model,input_tokens,output_tokens\nalpha-small,${big},0\n`));
    expect(r.rows[0]?.inputTokens).toBe(9007199254740993n);
    const rep = buildReport(r, snapshot, "t");
    expect(rep.matched[0]?.estimatedMicrousd).toBe(9007199254740993n * 3n);
  });

  it("handles BOM, CRLF, quoted commas and embedded newlines", async () => {
    const csv = '﻿model,input_tokens,output_tokens,note\r\n"alpha-small",1,2,"a, ""b""\nc"\r\n';
    const r = await importUsage(file("u.csv", csv));
    expect(r.rows).toHaveLength(1);
    expect(r.unknownColumns).toEqual(["note"]);
  });

  it("rejects an unterminated quoted field", async () => {
    expect(await codeOf(importUsage(file("u.csv", 'model,input_tokens,output_tokens\n"alpha,1,2\n')))).toBe("PARSE_ERROR");
  });
});

describe("validation, exclusions and unknown models", () => {
  it("excludes rows with missing or invalid fields and reports reasons", async () => {
    const csv = [
      "model,input_tokens,output_tokens",
      ",1,1",
      "alpha-small,,1",
      "alpha-small,1,",
      "alpha-small,-5,1",
      "alpha-small,1.5,1",
      "alpha-small,1e3,1",
      "alpha-small,12345678901234567890,1",
      "alpha-small,10,20",
    ].join("\n");
    const r = await importUsage(file("u.csv", csv));
    expect(r.rows).toHaveLength(1);
    expect(r.excludedTotal).toBe(7);
    expect(r.excludedByReason).toEqual({ missing_model: 1, missing_input_tokens: 1, missing_output_tokens: 1, invalid_number: 4 });
  });

  it("lists unknown models separately and never prices them", async () => {
    const csv = "model,input_tokens,output_tokens\nmystery-model,100,200\nmystery-model,1,1\nalpha-small,1000000,0\n";
    const rep = buildReport(await importUsage(file("u.csv", csv)), snapshot, "t");
    expect(rep.unmatched).toEqual([
      { model: "mystery-model", reason: "unknown_model", requests: 2, inputTokens: 101n, outputTokens: 201n, cachedInputTokens: 0n },
    ]);
    expect(rep.rowsMatched).toBe(1);
    expect(rep.rowsUnmatched).toBe(2);
    expect(rep.matched[0]?.estimatedMicrousd).toBe(3_000_000n);
  });

  it("never prices a model whose snapshot rate is malformed as zero: it is listed as unmatched with reason invalid_rate", async () => {
    const bad: PriceSnapshot = {
      ...snapshot,
      models: [
        { id: "bad-input", inputMicrousdPerMtok: "3.5", cachedInputMicrousdPerMtok: null, outputMicrousdPerMtok: "7" },
        { id: "bad-output", inputMicrousdPerMtok: "1", cachedInputMicrousdPerMtok: null, outputMicrousdPerMtok: "" },
        { id: "bad-cached", inputMicrousdPerMtok: "1", cachedInputMicrousdPerMtok: "-1", outputMicrousdPerMtok: "1" },
        ...snapshot.models,
      ],
    };
    const csv = "model,input_tokens,output_tokens\nbad-input,1000000,1\nbad-output,1,1\nbad-cached,1,1\nalpha-small,1000000,0\n";
    const rep = buildReport(await importUsage(file("u.csv", csv)), bad, "t");
    expect(rep.matched.map((m) => m.catalogId)).toEqual(["alpha-small"]);
    expect(rep.unmatched.map((u) => [u.model, u.reason])).toEqual([["bad-cached", "invalid_rate"], ["bad-input", "invalid_rate"], ["bad-output", "invalid_rate"]]);
    expect(rep.rowsUnmatched).toBe(3);
    expect(rep.notes.join(" ")).toContain("unreadable price rate");
  });

  it("does not fuzzy-match model IDs", async () => {
    const rep = buildReport(await importUsage(file("u.csv", "model,input_tokens,output_tokens\nalpha-small-2,1,1\nanthropic/alpha-small,1,1\n")), snapshot, "t");
    expect(rep.rowsMatched).toBe(0);
    expect(rep.unmatched).toHaveLength(2);
  });

  it("parses token counts and USD strictly", () => {
    expect(parseTokenCount("0")).toBe(0n);
    expect(parseTokenCount(12)).toBe(12n);
    for (const bad of ["", "-1", "1.0", " ", "0x1", "1,000", 1.5, -1, Number.NaN, 2 ** 60, null, {}]) {
      expect(parseTokenCount(bad)).toBeNull();
    }
    expect(parseUsdToMicro("0.0123")).toBe(12_300n);
    expect(parseUsdToMicro("$1")).toBe(1_000_000n);
    expect(parseUsdToMicro("0.0000011")).toBe(2n); // rounded up once
    expect(parseUsdToMicro("-1")).toBeNull();
    expect(parseUsdToMicro("1e-7")).toBeNull();
  });
});

describe("JSON and JSONL", () => {
  it("reads nested usage objects and wrapper arrays", async () => {
    const json = JSON.stringify({ data: [{ model: "alpha-small", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 } }] });
    const r = await importUsage(file("u.json", json));
    expect(r.rows[0]).toMatchObject({ inputTokens: 10n, outputTokens: 20n, cachedInputTokens: 5n });
  });

  it("JSONL keeps good lines and excludes malformed ones", async () => {
    const jsonl = ['{"model":"alpha-small","prompt_tokens":1,"completion_tokens":2}', "{not json", "[1,2]", ""].join("\n");
    const r = await importUsage(file("u.jsonl", jsonl));
    expect(r.rows).toHaveLength(1);
    expect(r.excludedByReason).toEqual({ invalid_row: 2 });
  });

  it("is not affected by __proto__ keys", async () => {
    const r = await importUsage(file("u.json", '[{"model":"alpha-small","input_tokens":1,"output_tokens":1,"__proto__":{"polluted":true}}]'));
    expect(r.rows).toHaveLength(1);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("rejects invalid JSON", async () => {
    expect(await codeOf(importUsage(file("u.json", "{oops")))).toBe("PARSE_ERROR");
  });
});

describe("recorded cost comparison", () => {
  it("compares only when every matched row has a recorded cost", async () => {
    const csv = "model,input_tokens,output_tokens,cost_usd\nalpha-small,1000000,0,4.00\nalpha-small,0,1000000,10\n";
    const rep = buildReport(await importUsage(file("u.csv", csv)), snapshot, "t");
    expect(rep.comparison).toEqual({
      status: "complete",
      recordedMicrousd: 14_000_000n,
      estimatedMicrousd: 18_000_000n,
      differenceMicrousd: 4_000_000n,
      direction: "estimate_higher",
    });
  });

  it("says insufficient data when costs are partly absent", async () => {
    const csv = "model,input_tokens,output_tokens,cost_usd\nalpha-small,1,1,0.1\nalpha-small,1,1,\n";
    const rep = buildReport(await importUsage(file("u.csv", csv)), snapshot, "t");
    expect(rep.comparison).toMatchObject({ status: "insufficient_data", reason: "recorded_cost_missing", rowsWithRecordedCost: 1, matchedRows: 2 });
  });
});

describe("size and type limits", () => {
  it("rejects files over 25 MB before parsing", async () => {
    const bytes = new Uint8Array(IMPORT_LIMITS.maxInputBytes + 1);
    expect(await codeOf(importUsage({ name: "big.csv", bytes }))).toBe("FILE_TOO_LARGE");
  });
  it("rejects unsupported and empty files", async () => {
    expect(await codeOf(importUsage(file("x.txt", "hi")))).toBe("UNSUPPORTED_TYPE");
    expect(await codeOf(importUsage({ name: "x.csv", bytes: new Uint8Array(0) }))).toBe("EMPTY");
  });
  it("enforces the row limit", async () => {
    const csv = "model,input_tokens,output_tokens\n" + "alpha-small,1,1\n".repeat(11);
    expect(await codeOf(importUsage(file("u.csv", csv), { maxRows: 10 }))).toBe("TOO_MANY_ROWS");
  });
});

describe("ZIP handling", () => {
  const goodCsv = "model,input_tokens,output_tokens\nalpha-small,1000000,0\n";

  it("reads deflated and stored entries across several files", async () => {
    const zip = makeZip([
      { name: "a.csv", data: goodCsv },
      { name: "dir/b.jsonl", data: '{"model":"beta-fast","input_tokens":5,"output_tokens":6}\n', method: 0 },
      { name: "notes.txt", data: "ignored" },
    ]);
    const r = await importUsage({ name: "export.zip", bytes: zip });
    expect(r.files.map((f) => f.name)).toEqual(["a.csv", "dir/b.jsonl"]);
    expect(r.rows).toHaveLength(2);
    expect(r.skippedEntries).toEqual([{ name: "notes.txt", reason: "unsupported_type" }]);
  });

  it("rejects archives with too many entries before reading any", async () => {
    const zip = makeZip(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.csv`, data: goodCsv })));
    expect(await codeOf(importUsage({ name: "e.zip", bytes: zip }, { maxZipEntries: 5 }))).toBe("ZIP_TOO_MANY_FILES");
  });

  it("rejects a decompression bomb by its declared size without inflating it", async () => {
    const zip = makeZip([{ name: "bomb.csv", data: new Uint8Array(8 * 1024 * 1024) }]);
    expect(zip.length).toBeLessThan(64 * 1024);
    expect(await codeOf(importUsage({ name: "b.zip", bytes: zip }, { maxEntryBytes: 1024 * 1024 }))).toBe("ZIP_ENTRY_TOO_LARGE");
  });

  it("rejects when the total declared size exceeds the archive budget", async () => {
    const chunk = new Uint8Array(600 * 1024);
    const zip = makeZip([
      { name: "a.csv", data: chunk },
      { name: "b.csv", data: chunk },
    ]);
    expect(await codeOf(importUsage({ name: "t.zip", bytes: zip }, { maxTotalBytes: 1024 * 1024 }))).toBe("ZIP_TOTAL_TOO_LARGE");
  });

  it("stops inflation when the header lies about the size", async () => {
    const zip = makeZip([{ name: "lie.csv", data: new Uint8Array(4 * 1024 * 1024), declaredSize: 100 }]);
    expect(await codeOf(importUsage({ name: "l.zip", bytes: zip }))).toBe("ZIP_ENTRY_TOO_LARGE");
  });

  it("detects a size mismatch when data is smaller than declared", async () => {
    const zip = makeZip([{ name: "short.csv", data: goodCsv, declaredSize: goodCsv.length + 50 }]);
    expect(await codeOf(importUsage({ name: "s.zip", bytes: zip }))).toBe("ZIP_INVALID");
  });

  it("detects a CRC mismatch", async () => {
    const zip = makeZip([{ name: "crc.csv", data: goodCsv, crc: 1234 }]);
    expect(await codeOf(importUsage({ name: "c.zip", bytes: zip }))).toBe("ZIP_INVALID");
  });

  it("never reads path-traversal, absolute or backslash entries", async () => {
    const zip = makeZip([
      { name: "../evil.csv", data: goodCsv },
      { name: "/abs.csv", data: goodCsv },
      { name: "..\\win.csv", data: goodCsv },
      { name: "ok.csv", data: goodCsv },
    ]);
    const r = await importUsage({ name: "p.zip", bytes: zip });
    expect(r.files.map((f) => f.name)).toEqual(["ok.csv"]);
    expect(r.skippedEntries.map((s) => s.reason)).toEqual(["unsafe_path", "unsafe_path", "unsafe_path"]);
  });

  it("reports NO_READABLE_FILES for archives without usable entries or only encrypted ones", async () => {
    expect(await codeOf(importUsage({ name: "n.zip", bytes: makeZip([{ name: "a.png", data: "x" }]) }))).toBe("NO_READABLE_FILES");
    expect(await codeOf(importUsage({ name: "n.zip", bytes: makeZip([{ name: "a.csv", data: goodCsv, flags: 1 }]) }))).toBe("NO_READABLE_FILES");
  });

  it("rejects truncated and non-ZIP input named .zip", async () => {
    const zip = makeZip([{ name: "a.csv", data: goodCsv }]);
    expect(await codeOf(importUsage({ name: "t.zip", bytes: zip.subarray(0, zip.length - 10) }))).toBe("ZIP_INVALID");
    expect(await codeOf(importUsage(file("fake.zip", "a,b,c\n1,2,3\n")))).toBe("ZIP_INVALID");
  });

  it("does not expand a nested zip", async () => {
    const inner = makeZip([{ name: "a.csv", data: goodCsv }]);
    const outer = makeZip([{ name: "inner.zip", data: inner }, { name: "top.csv", data: goodCsv }]);
    const r = await importUsage({ name: "o.zip", bytes: outer });
    expect(r.files.map((f) => f.name)).toEqual(["top.csv"]);
  });
});

describe("CSV export is formula-injection safe", () => {
  it.each([
    ["=1+1", "'=1+1"],
    ["+SUM(A1)", "'+SUM(A1)"],
    ["-2+3", "'-2+3"],
    ["@cmd", "'@cmd"],
    ["\tTAB", "'\tTAB"],
    ["  =spaced", "'  =spaced"],
    ["plain", "plain"],
    ["a,b", '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
  ])("csvSafeCell(%j)", (input, expected) => {
    expect(csvSafeCell(input)).toBe(expected);
  });

  it("neutralises hostile model names in the report CSV", async () => {
    const csv = 'model,input_tokens,output_tokens\n"=HYPERLINK(""http://evil.example"",""x"")",1,1\n"@SUM(1)",1,1\nalpha-small,1,1\n';
    const rep = buildReport(await importUsage(file("u.csv", csv)), snapshot, "t");
    const out = reportToCsv(rep);
    for (const line of out.split("\r\n").slice(1)) {
      const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [];
      for (const c of cells) {
        const v = c.replace(/,$/, "").replace(/^"|"$/g, "");
        expect(/^[=+@\t\r]/.test(v)).toBe(false);
      }
    }
    expect(out).toContain("'=HYPERLINK");
    expect(out).toContain("'@SUM(1)");
  });

  it("serialises bigint values in the JSON report", async () => {
    const rep = buildReport(await importUsage(file("u.csv", "model,input_tokens,output_tokens\nalpha-small,1,1\n")), snapshot, "t");
    const parsed = JSON.parse(reportToJson(rep)) as { matched: { inputTokens: string }[] };
    expect(parsed.matched[0]?.inputTokens).toBe("1");
  });
});
