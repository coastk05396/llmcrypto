/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RepositoryExport } from "@llmcrypto/contracts";
import { randomId } from "../../apps/api/src/crypto";
import { BASE_TIME, call, dumpDatabase, login, seedMember } from "./helpers";
import { buildTar, buildTarGz, buildZip, get, makeBetaHarness, newProject, runImports, upload, withLimits, type BetaHarness, type ZipEntry } from "./beta-helpers";

let h: BetaHarness;
beforeAll(async () => {
  h = await makeBetaHarness(withLimits({ maxFileBytes: 2000, maxEntries: 60, maxTotalBytes: 6 * 1024 * 1024, maxArchiveBytes: 2 * 1024 * 1024 }));
});
afterAll(async () => {
  await h.db.close();
});
beforeEach(() => {
  h.clock.now = new Date(BASE_TIME);
});

const MARKER = join(tmpdir(), `llmcrypto-exec-marker-${randomId("m")}`);
// Built at runtime so no secret-shaped literal exists in this source file.
const FAKE_KEY = `${"AK"}${"IA"}ABCDEFGHIJKLMNOP`;

const APP_TS = [
  "// entry point",
  'import { helper } from "./util";',
  'import type { Config } from "./types.js";',
  'import React from "react";',
  "import {",
  "  a,",
  "  b,",
  '} from "@scope/pkg/deep";',
  'const lazy = () => import("./lazy");',
  'const fs = require("node:fs");',
  '// import ghost from "./ghost";',
  "const s = \"import fake from './fake'\";",
  'export * from "./util";',
  "",
].join("\n");
const MAIN_PY = ['"""module doc', "import notreal", '"""', "import os, sys", "from . import helpers", "from .helpers import thing", "from pkg.inner import z", "import requests  # comment", ""].join("\n");
const MAIN_GO = ["package main", "", "import (", '\t"fmt"', '\tutil "example.com/acme/internal/util"', '\t_ "github.com/lib/pq"', ")", '// import "ghost"', ""].join("\n");

const repoFiles = (prefix = "acme-main/"): ZipEntry[] => {
  const f = (name: string, data: string | Buffer, extra: Partial<ZipEntry> = {}): ZipEntry => ({ name: prefix + name, data, ...extra });
  return [
    { name: prefix, mode: 0o040755 },
    f("src/app.ts", APP_TS), f("src/util.ts", 'import { x } from "./missing";\nexport const helper = 1;\n'), f("src/types.ts", "export type Config = {};\n"), f("src/lazy/index.ts", "export {};\n"),
    f("lib/main.py", MAIN_PY), f("lib/helpers.py", "thing = 1\n"), f("lib/pkg/inner.py", "z = 1\n"),
    f("go.mod", "module example.com/acme\n\ngo 1.22\n"), f("cmd/main.go", MAIN_GO), f("internal/util/util.go", "package util\n"),
    f("README.md", "# Acme\n"),
    f("node_modules/dep/index.js", "module.exports = 1;\n"), f(".env", "TOKEN=abc\n"), f("config/id_rsa", "not a real key\n"),
    f("assets/app.min.js", "var a=1;"), f("assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])), f("data/raw.txt", Buffer.from([0x68, 0x00, 0x69])),
    f("src/huge.ts", "x".repeat(3000)), f("src/creds.ts", `export const k = "${FAKE_KEY}";\n`), f("package-lock.json", "{}"),
    // Hostile-but-inert content: nothing here may ever run.
    f("src/evil.js", `require("fs").writeFileSync(${JSON.stringify(MARKER)}, "pwned");\n`), f("lib/evil.py", `open(${JSON.stringify(MARKER)}, "w").write("pwned")\n`),
    f("package.json", JSON.stringify({ scripts: { postinstall: `node src/evil.js` } })),
  ];
};

async function importZip(cookie: string, projectId: string, zip: Buffer, name?: string) {
  const up = await upload(h, cookie, projectId, zip, name ? { name } : {});
  expect(up.status, JSON.stringify(up.json)).toBe(202);
  const report = await runImports(h);
  return { id: up.json.importId as string, report };
}

describe("happy path: upload -> worker -> evidence-linked graph", () => {
  it.each([1, 50])("never persists or exports credentials from URL import specifiers (%i password segments)", async (segments) => {
    const s = await login(h.app);
    const p = await newProject(h, s.cookie);
    const secretPrefix = "distinctive-import-password";
    const secret = secretPrefix.repeat(segments);
    const url = `https://import-user:${secret}@example.test/library`;
    const { id } = await importZip(s.cookie, p, buildZip([
      { name: "main.ts", data: `import "${url}";\nimport "safe-package";` },
      { name: "main.go", data: `package main\nimport "${url}"` },
    ]));
    const dump = await dumpDatabase(h.db);
    expect(dump).not.toContain(secretPrefix);
    expect(dump).not.toContain("import-user");
    const exported = await get(h, s.cookie, `/api/projects/${p}/repository-imports/${id}/export`);
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.json)).not.toContain(secretPrefix);
    expect(JSON.stringify(exported.json)).not.toContain("import-user");
    const edges = (await get(h, s.cookie, `/api/projects/${p}/repository-imports/${id}/edges`)).json.items;
    expect(JSON.stringify(edges)).not.toContain(secretPrefix);
    expect(JSON.stringify(edges)).not.toContain("import-user");
    expect(edges.some((e: any) => e.specifier === "safe-package")).toBe(true);
  });

  it("imports a ZIP, excludes secrets/vendor/generated/binary, links every edge to file+line, never executes code", async () => {
    const s = await login(h.app);
    const p = await newProject(h, s.cookie);
    const { id, report } = await importZip(s.cookie, p, buildZip(repoFiles()), "acme");
    expect(report.succeeded).toEqual([id]);

    const imp = await get(h, s.cookie, `/api/projects/${p}/repository-imports/${id}`);
    expect(imp.status).toBe(200);
    expect(imp.json).toMatchObject({ status: "succeeded", name: "acme", format: "zip", error: null, projectId: p });
    const skip = Object.fromEntries((await h.db.query<any>("select path, reason from repo_skipped where import_id=$1", [id])).map((r) => [r.path, r.reason]));
    expect(skip).toEqual({
      "node_modules/dep/index.js": "vendor", ".env": "secret", "config/id_rsa": "secret", "assets/app.min.js": "generated", "assets/logo.png": "binary",
      "data/raw.txt": "binary", "src/huge.ts": "too_large", "src/creds.ts": "secret_content", "package-lock.json": "generated",
    });
    expect(imp.json.stats).toMatchObject({ files: 14, skipped: 9, skippedByReason: { vendor: 1, secret: 2, generated: 2, binary: 2, too_large: 1, secret_content: 1 } });

    // Evidence: exact file + line for every edge of app.ts.
    const edges = (await get(h, s.cookie, `/api/projects/${p}/repository-imports/${id}/edges?from=src/app.ts&limit=50`)).json.items as any[];
    const brief = edges.map((e) => [e.line, e.specifier, e.to.kind, e.to.path ?? e.to.name]);
    expect(brief).toEqual([
      [2, "./util", "file", "src/util.ts"],
      [3, "./types.js", "file", "src/types.ts"],
      [4, "react", "external", "react"],
      [5, "@scope/pkg/deep", "external", "@scope/pkg"],
      [9, "./lazy", "file", "src/lazy/index.ts"],
      [10, "node:fs", "external", "node:fs"],
      [13, "./util", "file", "src/util.ts"],
    ]);
    expect(edges[0]).toMatchObject({ from: "src/app.ts", kind: "import", language: "typescript", snippet: 'import { helper } from "./util";' });
    expect(edges.find((e) => e.line === 5).snippet).toBe("import {"); // multi-line statement is evidenced at its first line
    // Evidence lines really are the lines of the source text.
    const lines = APP_TS.split("\n");
    for (const e of edges) expect(lines[e.line - 1]!.trim()).toBe(e.snippet);

    const py = (await get(h, s.cookie, `/api/projects/${p}/repository-imports/${id}/edges?from=lib/main.py`)).json.items as any[];
    expect(py.map((e) => [e.line, e.specifier, e.to.kind, e.to.path ?? e.to.name])).toEqual([
      [4, "os", "external", "os"], [4, "sys", "external", "sys"], [5, ".helpers", "file", "lib/helpers.py"], [6, ".helpers", "file", "lib/helpers.py"],
      [7, "pkg.inner", "file", "lib/pkg/inner.py"], [8, "requests", "external", "requests"],
    ]);
    const go = (await get(h, s.cookie, `/api/projects/${p}/repository-imports/${id}/edges?from=cmd/main.go`)).json.items as any[];
    expect(go.map((e) => [e.line, e.specifier, e.to.kind, e.to.path ?? e.to.name])).toEqual([
      [4, "fmt", "external", "fmt"], [5, "example.com/acme/internal/util", "directory", "internal/util"], [6, "github.com/lib/pq", "external", "github.com/lib/pq"],
    ]);
    const unresolved = (await get(h, s.cookie, `/api/projects/${p}/repository-imports/${id}/edges?toKind=unresolved`)).json.items as any[];
    expect(unresolved.map((e) => [e.from, e.line, e.specifier])).toEqual([["src/util.ts", 1, "./missing"]]);

    // Files list with degrees; incoming edges are counted on the target.
    const files = (await get(h, s.cookie, `/api/projects/${p}/repository-imports/${id}/files?limit=200`)).json.items as any[];
    expect(files.find((f) => f.path === "src/util.ts")).toMatchObject({ incoming: 2, outgoing: 1, language: "typescript" });
    expect(files.map((f) => f.path)).not.toContain(".env");

    // Derived architecture view.
    const graph = (await get(h, s.cookie, `/api/projects/${p}/repository-imports/${id}/graph?depth=1`)).json;
    expect(graph.nodes.map((n: any) => n.path)).toEqual([".", "cmd", "internal", "lib", "src"]);
    expect(graph.edges).toContainEqual({ from: "cmd", to: "internal", count: 1, evidence: [{ path: "cmd/main.go", line: 5 }] });
    expect(graph.external.map((x: any) => x.name)).toContain("react");

    // Nothing was executed (JS postinstall/require, Python open()).
    expect(existsSync(MARKER)).toBe(false);
    // No file CONTENT is stored (only paths, hashes and the import line). The secret never reached the database.
    const dump = await dumpDatabase(h.db);
    expect(dump).not.toContain(FAKE_KEY);
    expect(dump).not.toContain("TOKEN=abc");
    // The uploaded archive is dropped once the job ends.
    expect((await h.db.query<any>("select count(*)::int n from repo_import_uploads where import_id=$1", [id]))[0].n).toBe(0);

    // Export is complete, parses against the contract and equals what the paged endpoints return.
    const ex = await call<any>(h.app, "GET", `/api/projects/${p}/repository-imports/${id}/export`, { cookie: s.cookie });
    expect(ex.status).toBe(200);
    expect(ex.headers.get("content-disposition")).toContain("attachment");
    const parsed = RepositoryExport.parse(ex.json);
    expect(parsed.edges.length).toBe(imp.json.stats.edges);
    expect(parsed.skipped).toHaveLength(9);
    expect(parsed.label).toMatch(/not executed/);
  });

  it("imports a tar.gz (GNU long names, pax names, wrapper directory) the same way", async () => {
    const s = await login(h.app);
    const p = await newProject(h, s.cookie);
    const long = `pkg/${"deep/".repeat(20)}mod.ts`;
    const tgz = buildTarGz([
      { name: "wrap/", type: "5" },
      { name: "wrap/a.ts", data: 'import { b } from "./b";\n' }, { name: "wrap/b.ts", data: "export const b = 1;\n" },
      { name: `wrap/${long}`, gnuLong: true, data: 'import "../../x";\n' }, { name: "wrap/paxed/name.py", pax: true, data: "import json\n" },
      { name: "wrap/ok-link", type: "2", link: "a.ts" },
    ]);
    const up = await upload(h, s.cookie, p, tgz);
    expect(up.status).toBe(202);
    await runImports(h);
    const imp = (await get(h, s.cookie, `/api/projects/${p}/repository-imports/${up.json.importId}`)).json;
    expect(imp).toMatchObject({ status: "succeeded", format: "tar.gz", stats: { files: 4, skipped: 1, skippedByReason: { symlink: 1 } } });
    const files = (await get(h, s.cookie, `/api/projects/${p}/repository-imports/${up.json.importId}/files?limit=200`)).json.items.map((f: any) => f.path);
    expect(files).toContain(long);
    expect(files).toContain("paxed/name.py");
    const edge = (await get(h, s.cookie, `/api/projects/${p}/repository-imports/${up.json.importId}/edges?from=a.ts`)).json.items[0];
    expect(edge).toMatchObject({ line: 1, to: { kind: "file", path: "b.ts" } });
  });
});

describe("hostile archives are rejected, visibly, and leave nothing behind", () => {
  const hostile: [string, () => Buffer, string][] = [
    ["path traversal (..)", () => buildZip([{ name: "ok.ts", data: "x" }, { name: "a/../../evil.ts", data: "x" }]), "ARCHIVE_UNSAFE_PATH"],
    ["leading ../", () => buildZip([{ name: "../evil.ts", data: "x" }]), "ARCHIVE_UNSAFE_PATH"],
    ["backslash traversal", () => buildZip([{ name: "..\\evil.ts", data: "x" }]), "ARCHIVE_UNSAFE_PATH"],
    ["absolute path", () => buildZip([{ name: "/etc/passwd", data: "x" }]), "ARCHIVE_UNSAFE_PATH"],
    ["drive path", () => buildZip([{ name: "C:\\Windows\\x.ts", data: "x" }]), "ARCHIVE_UNSAFE_PATH"],
    ["NUL in name", () => buildZip([{ name: "a\0b.ts", data: "x" }]), "ARCHIVE_UNSAFE_PATH"],
    ["control character in name", () => buildZip([{ name: "a\nb.ts", data: "x" }]), "ARCHIVE_UNSAFE_PATH"],
    ["tar traversal", () => buildTarGz([{ name: "../../evil", data: "x" }]), "ARCHIVE_UNSAFE_PATH"],
    ["tar traversal via pax path", () => buildTarGz([{ name: "ok/../../evil", pax: true, data: "x" }]), "ARCHIVE_UNSAFE_PATH"],
    ["zip symlink escaping the root", () => buildZip([{ name: "link", data: "../../../etc/passwd", mode: 0o120777 }]), "ARCHIVE_UNSAFE_LINK"],
    ["zip symlink to an absolute path", () => buildZip([{ name: "link", data: "/etc/passwd", mode: 0o120777 }]), "ARCHIVE_UNSAFE_LINK"],
    ["tar symlink escaping the root", () => buildTarGz([{ name: "a/link", type: "2", link: "../../x" }]), "ARCHIVE_UNSAFE_LINK"],
    ["tar symlink to an absolute path", () => buildTarGz([{ name: "link", type: "2", link: "/etc/shadow" }]), "ARCHIVE_UNSAFE_LINK"],
    ["tar hardlink escaping the root", () => buildTarGz([{ name: "hl", type: "1", link: "../secret" }]), "ARCHIVE_UNSAFE_LINK"],
    ["duplicate path", () => buildZip([{ name: "a.ts", data: "1" }, { name: "A.ts", data: "2" }]), "ARCHIVE_DUPLICATE_PATH"],
    ["zip bomb (ratio)", () => buildZip([{ name: "zeros.txt", data: Buffer.alloc(5 * 1024 * 1024) }]), "ARCHIVE_EXPANDS_TOO_MUCH"],
    ["zip declaring a huge total", () => buildZip([{ name: "a.txt", data: "x", lie: { usize: 5 * 1024 * 1024 } }, { name: "b.txt", data: "x", lie: { usize: 5 * 1024 * 1024 } }]), "ARCHIVE_EXPANDS_TOO_MUCH"],
    ["tar.gz bomb", () => gzipSync(Buffer.alloc(40 * 1024 * 1024)), "ARCHIVE_EXPANDS_TOO_MUCH"],
    ["tar.gz bomb with valid tar header", () => buildTarGz([{ name: "z", data: Buffer.alloc(30 * 1024 * 1024) }]), "ARCHIVE_EXPANDS_TOO_MUCH"],
    ["too many entries (zip)", () => buildZip(Array.from({ length: 61 }, (_, i) => ({ name: `f${i}.txt`, data: "x" }))), "ARCHIVE_TOO_MANY_ENTRIES"],
    ["too many entries (tar)", () => buildTarGz(Array.from({ length: 61 }, (_, i) => ({ name: `f${i}.txt`, data: "x" }))), "ARCHIVE_TOO_MANY_ENTRIES"],
    ["lying size (header smaller than data)", () => buildZip([{ name: "a.ts", data: "0123456789", lie: { usize: 3 } }]), "ARCHIVE_MALFORMED"],
    ["lying size (header larger than data)", () => buildZip([{ name: "a.ts", data: "0123", lie: { usize: 9 } }]), "ARCHIVE_MALFORMED"],
    ["checksum mismatch", () => buildZip([{ name: "a.ts", data: "hello", lie: { crc: 123 } }]), "ARCHIVE_MALFORMED"],
    ["local/central name mismatch", () => buildZip([{ name: "a.ts", localName: "b.ts", data: "hello" }]), "ARCHIVE_MALFORMED"],
    ["overlapping entries", () => { const z = buildZip([{ name: "a.ts", data: "hello world".repeat(50) }]); return buildZip([{ name: "a.ts", rawCompressed: z.subarray(30 + 4, 30 + 4 + 40), data: "x", lie: { csize: 9999 } }]); }, "ARCHIVE_MALFORMED"],
    ["truncated gzip", () => buildTarGz([{ name: "a.ts", data: "x".repeat(2000) }]).subarray(0, 40), "ARCHIVE_MALFORMED"],
    ["truncated tar", () => gzipSync(buildTar([{ name: "a.ts", data: "x".repeat(1500) }]).subarray(0, 700)), "ARCHIVE_MALFORMED"],
    ["corrupt tar checksum", () => { const t = buildTar([{ name: "a.ts", data: "x" }]); t[0] = 0x7a; return gzipSync(t); }, "ARCHIVE_MALFORMED"],
  ];

  it.each(hostile)("%s -> import fails with %s-class code, no rows, no stored archive", async (_name, make, code) => {
    const s = await login(h.app);
    const p = await newProject(h, s.cookie);
    const up = await upload(h, s.cookie, p, make());
    expect(up.status, JSON.stringify(up.json)).toBe(202);
    const report = await runImports(h);
    expect(report.failed).toEqual([up.json.importId]);
    const imp = (await get(h, s.cookie, `/api/projects/${p}/repository-imports/${up.json.importId}`)).json;
    expect(imp.status).toBe("failed");
    expect(imp.error.code).toBe(code);
    expect(imp.stats).toBeNull();
    for (const t of ["repo_files", "repo_edges", "repo_skipped", "repo_import_uploads"]) {
      expect((await h.db.query<any>(`select count(*)::int n from ${t} where import_id=$1`, [up.json.importId]))[0].n, t).toBe(0);
    }
  });

  it("in-root symlinks, hardlinks, devices and encrypted entries are skipped, never followed or read", async () => {
    const s = await login(h.app);
    const p = await newProject(h, s.cookie);
    const zip = buildZip([
      { name: "a.ts", data: 'import "./b";\n' }, { name: "b.ts", data: "export {};\n" },
      { name: "docs/ln", data: "../a.ts", mode: 0o120777 }, { name: "enc.ts", data: "secret", flags: 1 },
      { name: "weird", data: "", mode: 0o020644 },
    ]);
    const { id } = await importZip(s.cookie, p, zip);
    const imp = (await get(h, s.cookie, `/api/projects/${p}/repository-imports/${id}`)).json;
    expect(imp).toMatchObject({ status: "succeeded", stats: { files: 2, skippedByReason: { symlink: 1, encrypted: 1, special: 1 } } });
    const tar = buildTarGz([{ name: "x.ts", data: "1" }, { name: "dev", type: "3" }, { name: "hl", type: "1", link: "x.ts" }]);
    const up = await upload(h, s.cookie, p, tar);
    await runImports(h);
    expect((await get(h, s.cookie, `/api/projects/${p}/repository-imports/${up.json.importId}`)).json.stats).toMatchObject({ files: 1, skippedByReason: { special: 1, link: 1 } });
  });

  it("the file-count limit skips the surplus (reported), not the whole import", async () => {
    const hh = await makeBetaHarness(withLimits({ maxFiles: 3 }));
    try {
      const s = await login(hh.app);
      const p = await newProject(hh, s.cookie);
      const up = await upload(hh, s.cookie, p, buildZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.ts`, data: "export {};\n" }))));
      await runImports(hh);
      expect((await get(hh, s.cookie, `/api/projects/${p}/repository-imports/${up.json.importId}`)).json.stats).toMatchObject({ files: 3, skippedByReason: { file_limit: 2 } });
    } finally {
      await hh.db.close();
    }
  });

  it("the edge limit truncates and says so", async () => {
    const hh = await makeBetaHarness(withLimits({ maxEdges: 3 }));
    try {
      const s = await login(hh.app);
      const p = await newProject(hh, s.cookie);
      const up = await upload(hh, s.cookie, p, buildZip([{ name: "a.ts", data: Array.from({ length: 10 }, (_, i) => `import "p${i}";`).join("\n") }]));
      await runImports(hh);
      expect((await get(hh, s.cookie, `/api/projects/${p}/repository-imports/${up.json.importId}`)).json.stats).toMatchObject({ edges: 3, edgesTruncated: true });
    } finally {
      await hh.db.close();
    }
  });
});

describe("upload endpoint", () => {
  it("refuses non-archives (422), oversize bodies (413) and missing keys/origin before storing anything", async () => {
    const s = await login(h.app);
    const p = await newProject(h, s.cookie);
    const before = (await h.db.query<any>("select count(*)::int n from repo_imports"))[0].n;
    const notZip = await upload(h, s.cookie, p, Buffer.from("just text, not an archive"));
    expect(notZip.status).toBe(422);
    expect(notZip.json.error.fieldErrors[0].field).toBe("body");
    expect((await upload(h, s.cookie, p, Buffer.alloc(0))).status).toBe(400);
    const big = await upload(h, s.cookie, p, Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(2 * 1024 * 1024)]));
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect((await upload(h, s.cookie, p, buildZip([{ name: "a.ts", data: "x" }]), { key: null })).json.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await upload(h, s.cookie, p, buildZip([{ name: "a.ts", data: "x" }]), { origin: null })).status).toBe(403);
    expect((await upload(h, s.cookie, p, buildZip([{ name: "a.ts", data: "x" }]), { name: "bad\nname" })).status).toBe(422);
    expect((await h.db.query<any>("select count(*)::int n from repo_imports"))[0].n).toBe(before);
    const anon = await h.app.request(`/api/projects/${p}/repository-imports`, { method: "POST", headers: { Origin: "https://app.example.test", "Idempotency-Key": "abcdefgh12" }, body: new Uint8Array([1]) });
    expect(anon.status).toBe(401);
  });

  it("is idempotent: same key+bytes replays, changed bytes conflict, one import row", async () => {
    const s = await login(h.app);
    const p = await newProject(h, s.cookie);
    const zip = buildZip([{ name: "a.ts", data: "export {};\n" }]);
    const a = await upload(h, s.cookie, p, zip, { key: "idem-repo-0001" });
    const b = await upload(h, s.cookie, p, zip, { key: "idem-repo-0001" });
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(b.json.importId).toBe(a.json.importId);
    expect(b.headers.get("idempotent-replay")).toBe("true");
    const c = await upload(h, s.cookie, p, buildZip([{ name: "b.ts", data: "x" }]), { key: "idem-repo-0001" });
    expect(c.json.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await h.db.query<any>("select count(*)::int n from repo_imports where project_id=$1", [p]))[0].n).toBe(1);
  });

  it("limits imports in progress and imports kept per project", async () => {
    const hh = await makeBetaHarness((c) => ({ ...c, repository: { ...c.repository, maxActivePerProject: 2, maxRetainedPerProject: 3 } }));
    try {
      const s = await login(hh.app);
      const p = await newProject(hh, s.cookie);
      const z = (n: number) => buildZip([{ name: `f${n}.ts`, data: `${n}` }]);
      expect((await upload(hh, s.cookie, p, z(1))).status).toBe(202);
      expect((await upload(hh, s.cookie, p, z(2))).status).toBe(202);
      const third = await upload(hh, s.cookie, p, z(3));
      expect(third.status).toBe(429);
      expect(third.headers.get("retry-after")).toBeTruthy();
      await runImports(hh);
      expect((await upload(hh, s.cookie, p, z(3))).status).toBe(202);
      await runImports(hh);
      const fourth = await upload(hh, s.cookie, p, z(4));
      expect(fourth.status).toBe(422);
    } finally {
      await hh.db.close();
    }
  });
});

describe("isolation and roles", () => {
  it("every verb is scoped by account and project; foreign ids are 404; billing cannot use it; members can't delete others' imports", async () => {
    const owner = await login(h.app);
    const p1 = await newProject(h, owner.cookie);
    const p2 = await newProject(h, owner.cookie);
    const { id } = await importZip(owner.cookie, p1, buildZip([{ name: "a.ts", data: 'import "./b";\n' }, { name: "b.ts", data: "x" }]));
    const base = (p: string, i = id) => `/api/projects/${p}/repository-imports/${i}`;
    for (const sub of ["", "/files", "/edges", "/graph", "/export"]) {
      expect((await get(h, owner.cookie, base(p2) + sub)).status, `other project ${sub}`).toBe(404);
      expect((await get(h, owner.cookie, base(p1) + sub)).status, `own ${sub}`).toBe(200);
    }
    expect((await call(h.app, "DELETE", base(p2), { cookie: owner.cookie })).status).toBe(404);
    expect((await get(h, owner.cookie, `/api/projects/${p2}/repository-imports`)).json.items).toEqual([]);

    const stranger = await login(h.app);
    for (const sub of ["", "/files", "/edges", "/graph", "/export"]) expect((await get(h, stranger.cookie, base(p1) + sub)).status, `stranger ${sub}`).toBe(404);
    expect((await call(h.app, "DELETE", base(p1), { cookie: stranger.cookie })).status).toBe(404);
    const strangerProject = await newProject(h, stranger.cookie);
    expect((await get(h, stranger.cookie, base(strangerProject))).status).toBe(404);

    const billing = await seedMember(h, owner.accountId, "billing");
    expect((await get(h, billing.cookie, base(p1))).status).toBe(403);
    expect((await upload(h, billing.cookie, p1, buildZip([{ name: "a.ts", data: "x" }]))).status).toBe(403);
    const member = await seedMember(h, owner.accountId, "member");
    expect((await get(h, member.cookie, base(p1))).status).toBe(200);
    expect((await call(h.app, "DELETE", base(p1), { cookie: member.cookie })).status).toBe(403);
    const own = await upload(h, member.cookie, p1, buildZip([{ name: "m.ts", data: "x" }]));
    expect(own.status).toBe(202);
    expect((await call(h.app, "DELETE", base(p1, own.json.importId), { cookie: member.cookie })).status).toBe(204); // uploader may delete
    expect((await call(h.app, "GET", base(p1), {})).status).toBe(401);
  });

  it("an import's rows never reference another project's data (graph edges stay in their own import)", async () => {
    const s = await login(h.app);
    const p1 = await newProject(h, s.cookie);
    const p2 = await newProject(h, s.cookie);
    const a = await importZip(s.cookie, p1, buildZip([{ name: "only-in-p1.ts", data: 'import "./nope";\n' }]));
    const b = await importZip(s.cookie, p2, buildZip([{ name: "only-in-p2.ts", data: "export {};\n" }]));
    const f1 = (await get(h, s.cookie, `/api/projects/${p1}/repository-imports/${a.id}/files`)).json.items.map((f: any) => f.path);
    const f2 = (await get(h, s.cookie, `/api/projects/${p2}/repository-imports/${b.id}/files`)).json.items.map((f: any) => f.path);
    expect(f1).toEqual(["only-in-p1.ts"]);
    expect(f2).toEqual(["only-in-p2.ts"]);
  });
});

describe("deletion removes stored content", () => {
  it("delete leaves no row or blob of the import, and the distinctive content is gone from the database", async () => {
    const s = await login(h.app);
    const p = await newProject(h, s.cookie);
    const unique = `zz_${randomId("u")}`;
    const { id } = await importZip(s.cookie, p, buildZip([{ name: `${unique}/main.ts`, data: `import { q } from "./${unique}-sibling";\n` }, { name: `${unique}/other.ts`, data: "x" }]));
    expect(await dumpDatabase(h.db)).toContain(unique);
    const del = await call(h.app, "DELETE", `/api/projects/${p}/repository-imports/${id}`, { cookie: s.cookie });
    expect(del.status).toBe(204);
    for (const t of ["repo_imports", "repo_files", "repo_edges", "repo_skipped", "repo_import_uploads"]) {
      const col = t === "repo_imports" ? "id" : "import_id";
      expect((await h.db.query<any>(`select count(*)::int n from ${t} where ${col}=$1`, [id]))[0].n, t).toBe(0);
    }
    expect(await dumpDatabase(h.db)).not.toContain(unique); // not in rows, edges, snippets or audit metadata
    expect((await get(h, s.cookie, `/api/projects/${p}/repository-imports/${id}`)).status).toBe(404);
    expect((await call(h.app, "DELETE", `/api/projects/${p}/repository-imports/${id}`, { cookie: s.cookie })).status).toBe(404);
    const audit = await h.db.query<any>("select metadata from audit_events where action='repository.deleted' and target_id=$1", [id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ files: 2, edges: 1 });
  });

  it("deleting a still-queued import also removes its stored archive; the worker then has nothing to do", async () => {
    const s = await login(h.app);
    const p = await newProject(h, s.cookie);
    const up = await upload(h, s.cookie, p, buildZip([{ name: "queued.ts", data: "x" }]));
    expect((await h.db.query<any>("select count(*)::int n from repo_import_uploads where import_id=$1", [up.json.importId]))[0].n).toBe(1);
    expect((await call(h.app, "DELETE", `/api/projects/${p}/repository-imports/${up.json.importId}`, { cookie: s.cookie })).status).toBe(204);
    expect((await h.db.query<any>("select count(*)::int n from repo_import_uploads where import_id=$1", [up.json.importId]))[0].n).toBe(0);
    expect(await runImports(h)).toEqual({ succeeded: [], failed: [], retried: [] });
  });
});

describe("job runner", () => {
  it("two concurrent runners process an import exactly once", async () => {
    const s = await login(h.app);
    const p = await newProject(h, s.cookie);
    const up = await upload(h, s.cookie, p, buildZip([{ name: "a.ts", data: 'import "./b";\n' }, { name: "b.ts", data: "x" }]));
    const [r1, r2] = await Promise.all([runImports(h), runImports(h)]);
    expect([...r1.succeeded, ...r2.succeeded]).toEqual([up.json.importId]);
    expect((await h.db.query<any>("select count(*)::int n from repo_edges where import_id=$1", [up.json.importId]))[0].n).toBe(1);
  });

  it("a runner that died on every attempt fails the import visibly and drops the archive", async () => {
    const s = await login(h.app);
    const p = await newProject(h, s.cookie);
    const up = await upload(h, s.cookie, p, buildZip([{ name: "a.ts", data: "x" }]));
    await h.db.query("update repo_imports set status='running', attempts=3, lease_until=$2 where id=$1", [up.json.importId, new Date(BASE_TIME.getTime() - 1000)]);
    await runImports(h);
    const imp = (await get(h, s.cookie, `/api/projects/${p}/repository-imports/${up.json.importId}`)).json;
    expect(imp).toMatchObject({ status: "failed", error: { code: "RUNNER_LOST" } });
    expect((await h.db.query<any>("select count(*)::int n from repo_import_uploads where import_id=$1", [up.json.importId]))[0].n).toBe(0);
  });
});

describe("feature flag", () => {
  it("flags off: endpoints answer 404 FEATURE_DISABLED and /api/features says so (unavailable, not complete)", async () => {
    const off = await makeBetaHarness((c) => ({ ...c, features: { repositoryGraph: false, designBeta: false } }));
    try {
      const s = await login(off.app);
      const p = await newProject(off, s.cookie);
      const r = await upload(off, s.cookie, p, buildZip([{ name: "a.ts", data: "x" }]));
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe("FEATURE_DISABLED");
      expect((await call<any>(off.app, "GET", "/api/features", {})).json).toEqual({ repositoryGraph: false, designBeta: false });
      expect((await call<any>(h.app, "GET", "/api/features", {})).json).toEqual({ repositoryGraph: true, designBeta: true });
    } finally {
      await off.db.close();
    }
  });
});
