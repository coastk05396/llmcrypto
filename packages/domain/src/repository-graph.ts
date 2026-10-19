/**
 * Static import extraction for JavaScript/TypeScript, Python and Go, and resolution of each import against the files that
 * were actually imported. These are deliberately simple lexical scanners, NOT language parsers and NOT evaluators: nothing
 * is executed, no module system is consulted, and each edge carries the file and 1-based line of the statement it came from.
 *
 * Known limits (documented in docs/import-limits.md): TS path aliases / baseUrl, bundler aliases, package.json "exports",
 * Python sys.path tricks and dynamic imports with computed names are not resolved; a regex-literal that contains a quote can
 * blank the rest of its line; import-like text inside a template-literal expression is ignored.
 */
import type { SourceLanguage } from "./repository-policy";
import { redactSnippet, redactUrlCredentials } from "./repository-policy";

export interface ImportRef {
  /** 1-based line where the statement starts. */
  line: number;
  specifier: string;
  snippet: string;
}

export type ResolvedTarget =
  | { kind: "file"; path: string }
  | { kind: "directory"; path: string }
  | { kind: "external"; name: string }
  | { kind: "unresolved" };

export const MAX_EDGES_PER_FILE = 5000;
/** Lexical-scan guards: a crafted file can make a naive scanner quadratic, so every look-ahead is bounded. */
export const MAX_LINE_CHARS = 4000;
export const MAX_CONTINUATION_LINES = 50;
export const MAX_GO_IMPORT_BLOCK_CHARS = 20_000;

const lineStarts = (text: string): number[] => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
};
function lineAt(starts: readonly number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
const lineText = (text: string, starts: readonly number[], line: number): string => {
  const s = starts[line - 1] ?? 0;
  const bounded = text.slice(s, s + 1001);
  const e = bounded.indexOf("\n");
  // A cut through URL userinfo hides its terminating @ from redaction. Omit long evidence lines entirely;
  // the independently sanitized specifier and source line number still identify the import. Keep lookup bounded.
  if (e < 0 && bounded.length > 1000) return "[evidence omitted: source line exceeds 1000 characters]";
  return bounded.slice(0, e < 0 ? bounded.length : e).replace(/\r$/, "");
};

/**
 * Same-length copy of `src` where comments are spaces and the CONTENTS of string literals are spaces (quotes kept), so
 * regexes cannot match inside comments or strings. Newlines are always kept so offsets and line numbers are unchanged.
 */
export function blankJs(src: string): string {
  const out = src.split("");
  const blank = (i: number): void => {
    if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") blank(i++);
    } else if (c === "/" && d === "*") {
      blank(i++);
      blank(i++);
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) blank(i++);
      if (i < n) {
        blank(i++);
        blank(i++);
      }
    } else if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < n && src[i] !== c) {
        if (c !== "`" && src[i] === "\n") break; // unterminated: stop at end of line
        if (src[i] === "\\") blank(i++);
        if (i < n) blank(i++);
      }
      i++;
    } else i++;
  }
  return out.join("");
}

// `import x from "m"`, `import "m"`, `export * from "m"`, `export {a} from "m"`, `import type {T} from "m"`.
// The tempered segment cannot contain another import/export keyword, a quote or a semicolon, so statements without
// semicolons do not swallow each other.
const JS_STATIC = /\b(?:import|export)\b(?:(?!\b(?:import|export)\b)[^'";`]){0,2000}?(?:\bfrom\s*)?(['"])([^'"\n]*)\1/dg;
const JS_DYNAMIC = /\b(?:import|require)\s*\(\s*(['"])([^'"\n]*)\1\s*\)/dg;
const JS_BARE = /\bimport\s*(['"])([^'"\n]*)\1/dg;

export function parseJsImports(src: string): ImportRef[] {
  const masked = blankJs(src);
  const starts = lineStarts(src);
  const refs: ImportRef[] = [];
  const seen = new Set<number>();
  const take = (re: RegExp, requireFromOrBare: boolean): void => {
    for (const m of masked.matchAll(re)) {
      const idx = m.indices?.[2];
      if (!idx) continue;
      if (seen.has(m.index)) continue;
      if (refs.length >= MAX_EDGES_PER_FILE) return;
      const matched = m[0];
      // The static pattern also matches `export const x = 'y'`: require a real `from` or a bare `import 'x'`.
      if (requireFromOrBare && !/^import\s*['"]/.test(matched) && !/\bfrom\s*['"][^'"\n]*['"]$/.test(matched)) continue;
      const spec = src.slice(idx[0], idx[1]);
      if (spec === "") continue;
      seen.add(m.index);
      const line = lineAt(starts, m.index);
      refs.push({ line, specifier: redactUrlCredentials(spec), snippet: redactSnippet(lineText(src, starts, line)) });
    }
  };
  take(JS_STATIC, true);
  take(JS_BARE, false);
  take(JS_DYNAMIC, false);
  return refs.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier)).slice(0, MAX_EDGES_PER_FILE);
}

// ------------------------------------------------------------------------------------------------ Python

/** Blank comments and triple-quoted strings (line structure kept). Single-line strings are left alone: they cannot start an import. */
export function blankPython(src: string): string {
  const out = src.split("");
  const blank = (i: number): void => {
    if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "#") {
      while (i < n && src[i] !== "\n") blank(i++);
    } else if ((c === '"' || c === "'") && src.startsWith(c.repeat(3), i)) {
      const q = c.repeat(3);
      blank(i++);
      blank(i++);
      blank(i++);
      while (i < n && !src.startsWith(q, i)) {
        if (src[i] === "\\") blank(i++);
        if (i < n) blank(i++);
      }
      for (let k = 0; k < 3 && i < n; k++) blank(i++);
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
    } else i++;
  }
  return out.join("");
}

export function parsePythonImports(src: string): ImportRef[] {
  const masked = blankPython(src).split("\n");
  const original = src.split("\n");
  const refs: ImportRef[] = [];
  for (let i = 0; i < masked.length; i++) {
    const line = masked[i]!.replace(/\r$/, "");
    if (line.length > MAX_LINE_CHARS) continue; // a single enormous line is not an import statement we will scan
    const snippet = redactSnippet(original[i]?.replace(/\r$/, "") ?? "");
    const plain = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)[ \t]*$/.exec(line);
    if (plain) {
      for (const part of plain[1]!.split(",")) {
        const name = part.trim().split(/\s+/)[0];
        if (name) refs.push({ line: i + 1, specifier: redactUrlCredentials(name), snippet });
      }
      continue;
    }
    const from = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(.*)$/.exec(line);
    if (from) {
      const dots = from[1]!;
      const mod = from[2]!;
      if (mod || !dots) {
        refs.push({ line: i + 1, specifier: dots + mod, snippet });
        continue;
      }
      // `from . import a, b`: each name may be a sibling module. Join a parenthesised continuation.
      let rest = from[3]!;
      let j = i;
      if (rest.includes("(") && !rest.includes(")")) {
        // Bounded: at most MAX_CONTINUATION_LINES physical lines and MAX_LINE_CHARS characters are joined, so a file full of unclosed
        // `from . import (` lines costs O(lines * cap), not O(lines^2).
        while (j + 1 < masked.length && j - i < MAX_CONTINUATION_LINES && rest.length < MAX_LINE_CHARS && !masked[j]!.includes(")")) {
          j++;
          rest += ` ${masked[j]!.slice(0, MAX_LINE_CHARS)}`;
        }
      }
      for (const part of rest.replace(/[()]/g, " ").split(",")) {
        const name = part.trim().split(/\s+/)[0];
        if (name && /^\w+$/.test(name)) refs.push({ line: i + 1, specifier: `${dots}${name}`, snippet });
      }
    }
  }
  return refs.slice(0, MAX_EDGES_PER_FILE);
}

// ------------------------------------------------------------------------------------------------ Go

export function parseGoImports(src: string): ImportRef[] {
  // Blank comments only (Go import paths are the string literals we want).
  const out = src.split("");
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") out[i++] = " ";
    } else if (c === "/" && src[i + 1] === "*") {
      out[i++] = " ";
      out[i++] = " ";
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) {
        out[i++] = " ";
        out[i++] = " ";
      }
    } else if (c === '"' || c === "`") {
      i++;
      while (i < n && src[i] !== c && (c === "`" || src[i] !== "\n")) {
        if (c === '"' && src[i] === "\\") i++;
        i++;
      }
      i++;
    } else i++;
  }
  const masked = out.join("");
  const starts = lineStarts(src);
  const refs: ImportRef[] = [];
  const add = (index: number, spec: string): void => {
    const line = lineAt(starts, index);
    refs.push({ line, specifier: redactUrlCredentials(spec), snippet: redactSnippet(lineText(src, starts, line)) });
  };
  for (const m of masked.matchAll(/^[ \t]*import[ \t]+(?:[\w.]+[ \t]+)?"([^"\n]*)"/gm)) add(m.index, m[1]!);
  // Grouped imports. Each `import (` finds its `)` through ONE forward pointer (a cached next-')' position), never by rescanning to the end
  // of the file per candidate, and a block longer than MAX_GO_IMPORT_BLOCK_CHARS (or without a `)`) is ignored.
  let closeAt = -2;
  for (const open of masked.matchAll(/^[ \t]*import[ \t]*\(/gm)) {
    const bodyStart = open.index + open[0].length;
    if (closeAt !== -1 && closeAt < bodyStart) closeAt = masked.indexOf(")", bodyStart);
    if (closeAt === -1) break; // no ')' anywhere after this point, so no later block can close either
    if (closeAt - bodyStart > MAX_GO_IMPORT_BLOCK_CHARS) continue;
    const body = masked.slice(bodyStart, closeAt);
    for (const m of body.matchAll(/^[ \t]*(?:[\w.]+[ \t]+)?"([^"\n]*)"/gm)) add(bodyStart + m.index, m[1]!);
  }
  return refs.filter((r) => r.specifier !== "").sort((a, b) => a.line - b.line).slice(0, MAX_EDGES_PER_FILE);
}

export function parseImports(language: SourceLanguage, text: string): ImportRef[] {
  switch (language) {
    case "javascript":
    case "typescript":
      return parseJsImports(text);
    case "python":
      return parsePythonImports(text);
    case "go":
      return parseGoImports(text);
  }
}

// ------------------------------------------------------------------------------------------------ resolution

export interface ResolveContext {
  /** Every imported file path. */
  files: ReadonlySet<string>;
  /** Every directory that contains an imported file. */
  dirs: ReadonlySet<string>;
  /** Go module path by the directory of its go.mod ("" = root). */
  goModules: ReadonlyMap<string, string>;
}

const dirname = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** posix-style join + normalise; null when the result would leave the root. */
function joinPath(base: string, rel: string): string | null {
  const parts = base === "" ? [] : base.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

const JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_EXT_SWAP: Record<string, string[]> = {
  ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"],
};

function resolveJs(from: string, spec: string, ctx: ResolveContext): ResolvedTarget {
  if (spec.startsWith(".")) {
    const target = joinPath(dirname(from), spec);
    if (target === null) return { kind: "unresolved" };
    const tries: string[] = [target];
    const ext = /\.[A-Za-z]+$/.exec(target)?.[0];
    if (ext && JS_EXT_SWAP[ext]) {
      const stem = target.slice(0, -ext.length);
      for (const e of JS_EXT_SWAP[ext]!) tries.push(stem + e);
    }
    for (const e of JS_EXTS) tries.push(target + e);
    for (const e of JS_EXTS) tries.push(`${target}/index${e}`);
    const hit = tries.find((t) => ctx.files.has(t));
    return hit ? { kind: "file", path: hit } : { kind: "unresolved" };
  }
  if (spec.startsWith("/") || spec.startsWith("@/") || spec.startsWith("~") || spec.startsWith("#")) return { kind: "unresolved" }; // aliases/absolute: not resolved
  if (spec.startsWith("node:")) return { kind: "external", name: spec };
  const segs = spec.split("/");
  const name = spec.startsWith("@") ? segs.slice(0, 2).join("/") : (segs[0] ?? spec);
  return { kind: "external", name };
}

function resolvePython(from: string, spec: string, ctx: ResolveContext): ResolvedTarget {
  const dots = /^\.*/.exec(spec)![0].length;
  const mod = spec.slice(dots).split(".").filter(Boolean).join("/");
  const find = (base: string): ResolvedTarget | null => {
    const stem = mod === "" ? base : base === "" ? mod : `${base}/${mod}`;
    if (mod !== "" && ctx.files.has(`${stem}.py`)) return { kind: "file", path: `${stem}.py` };
    if (ctx.files.has(stem === "" ? "__init__.py" : `${stem}/__init__.py`)) return { kind: "file", path: stem === "" ? "__init__.py" : `${stem}/__init__.py` };
    if (mod !== "" && ctx.dirs.has(stem)) return { kind: "directory", path: stem };
    return null;
  };
  if (dots > 0) {
    let base = dirname(from);
    for (let i = 1; i < dots; i++) {
      if (base === "") return { kind: "unresolved" };
      base = dirname(base);
    }
    return find(base) ?? { kind: "unresolved" };
  }
  // Absolute: the repository root, then each ancestor directory of the importing file (src layouts).
  const bases: string[] = [""];
  const parts = dirname(from) === "" ? [] : dirname(from).split("/");
  for (let i = 1; i <= parts.length; i++) bases.push(parts.slice(0, i).join("/"));
  for (const b of bases) {
    const hit = find(b);
    if (hit) return hit;
  }
  return { kind: "external", name: spec.split(".")[0] ?? spec };
}

function resolveGo(spec: string, ctx: ResolveContext): ResolvedTarget {
  let best: { dir: string; mod: string } | null = null;
  for (const [dir, mod] of ctx.goModules) {
    if ((spec === mod || spec.startsWith(`${mod}/`)) && (!best || mod.length > best.mod.length)) best = { dir, mod };
  }
  if (best) {
    const rest = spec.slice(best.mod.length).replace(/^\//, "");
    const path = best.dir === "" ? rest : rest === "" ? best.dir : `${best.dir}/${rest}`;
    return ctx.dirs.has(path) || path === "" ? { kind: "directory", path } : { kind: "unresolved" };
  }
  return { kind: "external", name: spec };
}

export function resolveImport(language: SourceLanguage, from: string, specifier: string, ctx: ResolveContext): ResolvedTarget {
  switch (language) {
    case "javascript":
    case "typescript":
      return resolveJs(from, specifier, ctx);
    case "python":
      return resolvePython(from, specifier, ctx);
    case "go":
      return resolveGo(specifier, ctx);
  }
}

export const goModulePath = (goMod: string): string | null => /^module\s+("?)([^\s"]+)\1/m.exec(goMod)?.[2] ?? null;
