import { describe, expect, it } from "vitest";
import {
  blankJs, classifyPath, goModulePath, hasSecretContent, isBinaryContent, languageOf, parseGoImports, parseJsImports, parsePythonImports,
  redactSnippet, resolveImport, resolveLimits, DEFAULT_IMPORT_LIMITS, HARD_IMPORT_LIMITS, type ResolveContext,
} from "./index";

const lines = (refs: { line: number; specifier: string }[]): [number, string][] => refs.map((r) => [r.line, r.specifier]);

describe("JS/TS import scanner", () => {
  it.each([parseJsImports, parseGoImports])("does not expose URL userinfo past the evidence boundary", (parse) => {
    const source = `import "https://boundary-user:${"boundary-password-".repeat(80)}@example.test/library";`;
    const refs = parse(source);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.specifier).toBe("https://[redacted]@example.test/library");
    expect(refs[0]?.snippet).toBe("[evidence omitted: source line exceeds 1000 characters]");
    expect(JSON.stringify(refs)).not.toContain("boundary-user");
    expect(JSON.stringify(refs)).not.toContain("boundary-password");
  });

  it("redacts the entire userinfo when a URL password contains an at sign", () => {
    const refs = parseJsImports('import "https://review-user:password@secret-tail@example.test/library";');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.specifier).toBe("https://[redacted]@example.test/library");
    expect(JSON.stringify(refs)).not.toContain("secret-tail");
    expect(JSON.stringify(refs)).not.toContain("review-user");
  });

  it("finds static, side-effect, re-export, type, dynamic and require imports with their start lines", () => {
    const src = [
      'import a from "a";', // 1
      'import "side-effect";', // 2
      'export * from "./re";', // 3
      'export { x } from "./re2";', // 4
      'import type { T } from "./types";', // 5
      "import {", // 6
      "  one,",
      "  two,",
      '} from "multi";', // 9 (statement starts at 6)
      'const d = await import("dyn");', // 10
      'const r = require("req");', // 11
      'import fs = require("legacy");', // 12
    ].join("\n");
    expect(lines(parseJsImports(src))).toEqual([
      [1, "a"], [2, "side-effect"], [3, "./re"], [4, "./re2"], [5, "./types"], [6, "multi"], [10, "dyn"], [11, "req"], [12, "legacy"],
    ]);
  });

  it("ignores comments, strings, template literals and non-import exports", () => {
    const src = [
      '// import a from "ghost-a";',
      '/* import b from "ghost-b";',
      ' import c from "ghost-c"; */',
      "const s = 'import d from \"ghost-d\"';",
      "const t = `require(\"ghost-e\")`;",
      'export const value = "not-an-import";',
      "export function f() { return 1 }",
      'const x = foo("import")',
      'import real from "real";',
    ].join("\n");
    expect(lines(parseJsImports(src))).toEqual([[9, "real"]]);
  });

  it("does not let semicolon-less statements swallow each other", () => {
    const src = ['export const a = 1', 'export const b = 2', 'import x from "x"', 'export const c = "c"'].join("\n");
    expect(lines(parseJsImports(src))).toEqual([[3, "x"]]);
  });

  it("keeps offsets: blankJs preserves length and newlines", () => {
    const src = 'a // c\n"str" /* x\ny */ b';
    const out = blankJs(src);
    expect(out).toHaveLength(src.length);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).not.toContain("str");
  });

  it("handles CRLF files and a huge single line without catastrophic backtracking", () => {
    expect(lines(parseJsImports('import a from "a";\r\nimport b from "b";\r\n'))).toEqual([[1, "a"], [2, "b"]]);
    const t0 = Date.now();
    parseJsImports(`${"export const aaaaaaaaaa = 1; ".repeat(40_000)}import z from "z";`);
    parseJsImports("export ".repeat(50_000));
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("Python import scanner", () => {
  it("handles plain, aliased, relative, from-import, multi-line and ignores docstrings/comments", () => {
    const src = [
      '"""docstring', // 1
      "import ghost", // 2
      '"""', // 3
      "import os, sys as system, a.b.c", // 4
      "from . import sibling, other as o", // 5
      "from ..pkg import thing", // 6
      "from x.y import (", // 7
      "    a,",
      "    b,",
      ")", // 10
      "# import commented", // 11
      "def f():", // 12
      "    import lazy  # trailing", // 13
      "x = 'import not_real'", // 14
    ].join("\n");
    expect(lines(parsePythonImports(src))).toEqual([
      [4, "os"], [4, "sys"], [4, "a.b.c"], [5, ".sibling"], [5, ".other"], [6, "..pkg"], [7, "x.y"], [13, "lazy"],
    ]);
  });
});

describe("Go import scanner", () => {
  it("handles single, grouped, aliased, blank and dot imports; ignores comments", () => {
    const src = [
      "package main", // 1
      'import "single"', // 2
      "import (", // 3
      '\t"fmt"', // 4
      '\talias "example.com/a/b"', // 5
      '\t_ "driver"', // 6
      '\t. "dot"', // 7
      '\t// "commented"', // 8
      ")", // 9
      '// import "ghost"', // 10
      "/* import (",
      '"ghost2" ) */',
    ].join("\n");
    expect(lines(parseGoImports(src))).toEqual([[2, "single"], [4, "fmt"], [5, "example.com/a/b"], [6, "driver"], [7, "dot"]]);
    expect(goModulePath("module example.com/acme\n\ngo 1.22")).toBe("example.com/acme");
    expect(goModulePath('module "quoted.example/x"')).toBe("quoted.example/x");
  });
});

describe("resolution", () => {
  const files = new Set(["src/a.ts", "src/b.ts", "src/c/index.ts", "src/d.tsx", "lib/m.py", "lib/pkg/__init__.py", "lib/pkg/x.py", "top.py", "svc/h.go"]);
  const dirs = new Set(["src", "src/c", "lib", "lib/pkg", "svc", "svc/util"]);
  const ctx: ResolveContext = { files, dirs, goModules: new Map([["svc", "example.com/svc"], ["", "example.com/root"]]) };
  const js = (spec: string, from = "src/a.ts") => resolveImport("typescript", from, spec, ctx);

  it("resolves relative JS/TS with extension swaps, index files and refuses escaping the root", () => {
    expect(js("./b")).toEqual({ kind: "file", path: "src/b.ts" });
    expect(js("./b.js")).toEqual({ kind: "file", path: "src/b.ts" });
    expect(js("./c")).toEqual({ kind: "file", path: "src/c/index.ts" });
    expect(js("./d")).toEqual({ kind: "file", path: "src/d.tsx" });
    expect(js("./nope")).toEqual({ kind: "unresolved" });
    expect(js("../../../x")).toEqual({ kind: "unresolved" });
    expect(js("@/alias/x")).toEqual({ kind: "unresolved" });
    expect(js("react/jsx-runtime")).toEqual({ kind: "external", name: "react" });
    expect(js("@scope/pkg/sub")).toEqual({ kind: "external", name: "@scope/pkg" });
    expect(js("node:fs")).toEqual({ kind: "external", name: "node:fs" });
  });

  it("resolves Python relative and absolute (root and ancestor) imports; others are external", () => {
    const py = (spec: string, from = "lib/m.py") => resolveImport("python", from, spec, ctx);
    expect(py(".pkg")).toEqual({ kind: "file", path: "lib/pkg/__init__.py" });
    expect(py(".pkg.x")).toEqual({ kind: "file", path: "lib/pkg/x.py" });
    expect(py("top")).toEqual({ kind: "file", path: "top.py" });
    expect(py("pkg.x")).toEqual({ kind: "file", path: "lib/pkg/x.py" });
    expect(py("os.path")).toEqual({ kind: "external", name: "os" });
    expect(py("....way.up")).toEqual({ kind: "unresolved" });
  });

  it("resolves Go module-local packages to directories by longest module prefix", () => {
    const go = (spec: string) => resolveImport("go", "svc/h.go", spec, ctx);
    expect(go("example.com/svc/util")).toEqual({ kind: "directory", path: "svc/util" });
    expect(go("example.com/svc/missing")).toEqual({ kind: "unresolved" });
    expect(go("github.com/x/y")).toEqual({ kind: "external", name: "github.com/x/y" });
  });
});

describe("policy", () => {
  it.each([
    ["node_modules/x/index.js", "vendor"], ["a/vendor/b.go", "vendor"], ["dist/app.js", "vendor"], [".git/config", "vendor"],
    [".env", "secret"], ["app/.env.production", "secret"], ["id_rsa", "secret"], ["keys/server.pem", "secret"], ["x/.aws/credentials", "secret"], ["secrets.json", "secret"],
    ["config/service-account-prod.json", "secret"], ["infra/prod.tfvars", "secret"],
    ["pnpm-lock.yaml", "generated"], ["a/b.min.js", "generated"], ["api.pb.go", "generated"], ["x_pb2.py", "generated"],
    ["logo.PNG", "binary"], ["a/b.wasm", "binary"],
    ["src/main.ts", null], ["README.md", null], ["go.mod", null],
  ])("classifyPath(%s) = %s", (path, reason) => {
    expect(classifyPath(path)).toBe(reason);
  });

  it("detects binary content, secret content and languages", () => {
    expect(isBinaryContent(new Uint8Array([104, 0, 105]))).toBe(true);
    expect(isBinaryContent(new Uint8Array([112, 108, 97, 105, 110, 32, 0xc3, 0xbc, 0xc3, 0xb1, 32, 111, 107]))).toBe(false);
    expect(isBinaryContent(new Uint8Array([0xff, 0xfe, 0xfd, 0x80]))).toBe(true);
    expect(hasSecretContent(`-----BEGIN ${"RSA"} PRIVATE ${"KEY"}-----\nabc`)).toBe(true);
    expect(hasSecretContent(`${"AK"}${"IA"}ABCDEFGHIJKLMNOP`)).toBe(true);
    expect(hasSecretContent(`token = ghp_${"a".repeat(36)}`)).toBe(true);
    expect(hasSecretContent("const password = 'hunter2'; // not a recognised shape")).toBe(false);
    expect(hasSecretContent("AKIA is just a word here")).toBe(false);
    expect([languageOf("a.ts"), languageOf("a.TSX"), languageOf("a.mjs"), languageOf("a.py"), languageOf("a.go"), languageOf("a.rs"), languageOf("Makefile")]).toEqual(["typescript", "typescript", "javascript", "python", "go", null, null]);
  });

  it("redacts URL credentials and truncates evidence lines", () => {
    expect(redactSnippet('  import x from "https://user:pw@host/p";  ')).toBe('import x from "https://[redacted]@host/p";');
    expect(redactSnippet("x".repeat(500))).toHaveLength(200);
  });

  it("limits are clamped to hard ceilings and never below 1", () => {
    expect(resolveLimits()).toEqual(DEFAULT_IMPORT_LIMITS);
    expect(resolveLimits({ maxArchiveBytes: 10 ** 12, maxFiles: 0, maxRatio: -5 })).toMatchObject({ maxArchiveBytes: HARD_IMPORT_LIMITS.maxArchiveBytes, maxFiles: 1, maxRatio: 1 });
  });
});

describe("scanner cost is bounded (256 KB crafted inputs finish well under a second)", () => {
  const time = (f: () => unknown): number => {
    const t0 = Date.now();
    f();
    return Date.now() - t0;
  };
  const pad = (unit: string): string => unit.repeat(Math.ceil(256 * 1024 / unit.length));

  it("Go: thousands of unclosed `import (` blocks", () => {
    expect(time(() => parseGoImports(pad("import (\n")))).toBeLessThan(1000);
    expect(time(() => parseGoImports(`${pad("import (\n")})\n`))).toBeLessThan(1000); // one far-away ')'
    expect(time(() => parseGoImports(pad('import (\n"a"\n)\n')))).toBeLessThan(1000);
  });
  it("Go: a legitimate block still parses; an oversize block is ignored", () => {
    expect(parseGoImports('package x\nimport (\n\t"fmt"\n\t"os"\n)\n').map((r) => r.specifier)).toEqual(["fmt", "os"]);
    expect(parseGoImports(`import (\n${'"x"\n'.repeat(10_000)})\n`)).toEqual([]);
  });
  it("Python: thousands of unclosed `from . import (` continuations and giant lines", () => {
    expect(time(() => parsePythonImports(pad("from . import (\n")))).toBeLessThan(1000);
    expect(time(() => parsePythonImports(pad("from . import (a,\n")))).toBeLessThan(1000);
    expect(time(() => parsePythonImports(`import ${"a, ".repeat(100_000)}`))).toBeLessThan(1000);
    expect(parsePythonImports("from . import (\n    a,\n    b,\n)\n").map((r) => r.specifier)).toEqual([".a", ".b"]);
  });
  it("JS/TS: keyword floods, quote floods, comment floods", () => {
    for (const unit of ["import ", "export ", "export {a} from ", 'import "', "/*", "//", "`${", "require(", "import("]) {
      expect(time(() => parseJsImports(pad(unit))), unit).toBeLessThan(1000);
    }
  });
});
