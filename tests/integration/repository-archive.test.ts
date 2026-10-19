import { describe, expect, it } from "vitest";
import { DEFAULT_IMPORT_LIMITS } from "@llmcrypto/domain";
import { ArchiveError, detectFormat, linkTargetStaysInside, normalizeEntryPath, openArchive } from "../../apps/worker/src/repository-archive";
import { analyzeEntries } from "../../apps/worker/src/repository-import";
import { buildTarGz, buildZip } from "./beta-helpers";

const L = DEFAULT_IMPORT_LIMITS;

describe("archive reader (pure, in memory)", () => {
  it("normalises names and rejects traversal in every spelling", () => {
    expect(normalizeEntryPath("a//b/./c.ts", L)).toBe("a/b/c.ts");
    expect(normalizeEntryPath("a\\b\\c.ts", L)).toBe("a/b/c.ts");
    for (const bad of ["../x", "a/../../x", "a/..", "/abs", "\\abs", "C:/x", "c:\\x", "a\0b", "a\tb", "a/\u007fb", "..\\x", "x".repeat(600), Array(40).fill("d").join("/")]) {
      expect(() => normalizeEntryPath(bad, L), JSON.stringify(bad)).toThrow(ArchiveError);
    }
    expect(normalizeEntryPath("..foo/bar..", L)).toBe("..foo/bar.."); // dots inside a name are fine
  });

  it("link targets: only relative targets that stay inside the root are acceptable", () => {
    expect(linkTargetStaysInside("a/b/link", "../x")).toBe(true);
    expect(linkTargetStaysInside("a/b/link", "../../x")).toBe(true);
    expect(linkTargetStaysInside("a/b/link", "../../../x")).toBe(false);
    expect(linkTargetStaysInside("link", "..")).toBe(false);
    expect(linkTargetStaysInside("link", "/etc/passwd")).toBe(false);
    expect(linkTargetStaysInside("link", "C:\\x")).toBe(false);
    expect(linkTargetStaysInside("link", "")).toBe(false);
    expect(linkTargetStaysInside("a/link", "..\\..\\x")).toBe(false);
  });

  it("detects formats by magic bytes only", () => {
    expect(detectFormat(buildZip([{ name: "a", data: "x" }]))).toBe("zip");
    expect(detectFormat(buildTarGz([{ name: "a", data: "x" }]))).toBe("tar.gz");
    expect(detectFormat(Buffer.from("PK nope"))).toBeNull();
    expect(detectFormat(Buffer.from([0x1f, 0x8b, 0x09]))).toBeNull();
    expect(detectFormat(Buffer.alloc(0))).toBeNull();
  });

  it("the entry reader never returns bytes that disagree with the header", () => {
    const { entries } = openArchive(buildZip([{ name: "ok.ts", data: "hello world", method: 0 }, { name: "z.ts", data: "hello ".repeat(100) }]), L);
    expect(entries.map((e) => e.read().toString())).toEqual(["hello world", "hello ".repeat(100)]);
    const lying = openArchive(buildZip([{ name: "a.ts", data: "0123456789", lie: { usize: 3 } }]), L).entries[0]!;
    expect(() => lying.read()).toThrow(/size|expands/);
  });

  it("analysis is pure: it strips one wrapper directory, applies the policy and produces evidence, executing nothing", () => {
    const { entries } = openArchive(buildZip([
      { name: "w/", mode: 0o040755 }, { name: "w/a.js", data: 'const fs = require("fs");\nfs.writeFileSync("/tmp/should-not-exist", "x");\nrequire("./b");\n' },
      { name: "w/b.js", data: "module.exports = 1;\n" }, { name: "w/.env", data: "A=1" },
    ]), L);
    const a = analyzeEntries(entries, L);
    expect(a.files.map((f) => f.path)).toEqual(["a.js", "b.js"]);
    expect(a.skipped).toEqual([{ path: ".env", reason: "secret" }]);
    expect(a.edges.map((e) => [e.from, e.line, e.specifier, e.toKind, e.toPath ?? e.external])).toEqual([["a.js", 1, "fs", "external", "fs"], ["a.js", 3, "./b", "file", "b.js"]]);
  });
});
