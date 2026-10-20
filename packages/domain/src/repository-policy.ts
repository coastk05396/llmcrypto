/**
 * What a repository import keeps. Pure functions over paths and bytes; nothing here touches the file system.
 *
 * Excluded before any parsing: vendored/dependency directories, generated and lock files, secret-bearing files (by name
 * AND by high-confidence content patterns), binary files, files over the size limit. Every exclusion is reported with its
 * reason (path + reason only, never content), so a user can see what was left out.
 */
export type SkipReason =
  | "vendor"
  | "generated"
  | "secret"
  | "secret_content"
  | "binary"
  | "too_large"
  | "file_limit"
  | "parse_budget"
  | "symlink"
  | "link"
  | "special"
  | "encrypted"
  | "unsupported_compression";

export type SourceLanguage = "javascript" | "typescript" | "python" | "go";

const VENDOR_DIRS = new Set([
  "node_modules", "vendor", "third_party", "third-party", "bower_components", ".git", ".hg", ".svn", ".venv", "venv", "env",
  "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", "site-packages", "dist", "build", "out", ".next", ".nuxt", ".turbo",
  ".cache", "coverage", "target", "Pods", ".gradle", ".idea", ".vscode",
]);
const SECRET_DIRS = new Set([".aws", ".ssh", ".gnupg", ".kube", ".docker"]);
const GENERATED_FILES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "go.sum", "poetry.lock", "Pipfile.lock", "Cargo.lock", "composer.lock", "Gemfile.lock", "bun.lockb", "npm-shrinkwrap.json",
]);
const GENERATED_SUFFIX = [".min.js", ".min.css", ".map", ".pb.go", "_pb2.py", "_pb2_grpc.py", ".generated.ts", ".generated.js", ".gen.go", ".snap"];
const SECRET_FILES = new Set([
  ".npmrc", ".pypirc", ".netrc", ".htpasswd", "credentials", "credentials.json", "secrets.json", "secrets.yaml", "secrets.yml", "id_rsa", "id_dsa",
  "id_ecdsa", "id_ed25519", "kubeconfig", ".git-credentials", "terraform.tfstate", "terraform.tfstate.backup",
]);
const SECRET_SUFFIX = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".tfvars", ".kdbx", ".ovpn", ".gpg", ".asc"];
const BINARY_SUFFIX = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".pdf", ".zip", ".gz", ".tgz", ".tar", ".7z", ".rar", ".bz2", ".xz",
  ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".class", ".jar", ".war", ".wasm", ".pyc", ".pyo", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".avi", ".webm", ".ogg", ".wav", ".bin", ".dat", ".db", ".sqlite", ".sqlite3", ".psd", ".ai", ".iso", ".dmg",
];

/** Path-only classification (the cheap pass, before any bytes are read). null = keep reading. */
export function classifyPath(path: string): SkipReason | null {
  const segs = path.split("/");
  const file = segs[segs.length - 1] ?? "";
  const lower = file.toLowerCase();
  for (const d of segs.slice(0, -1)) {
    if (VENDOR_DIRS.has(d)) return "vendor";
    if (SECRET_DIRS.has(d)) return "secret";
  }
  if (lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".env")) return "secret";
  if (SECRET_FILES.has(lower) || /^service[-_]?account.*\.json$/.test(lower) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(lower)) return "secret";
  if (SECRET_SUFFIX.some((s) => lower.endsWith(s))) return "secret";
  if (GENERATED_FILES.has(file) || GENERATED_SUFFIX.some((s) => lower.endsWith(s)) || /^(.*\.)?generated\./.test(lower)) return "generated";
  if (BINARY_SUFFIX.some((s) => lower.endsWith(s))) return "binary";
  return null;
}

/** True when `b` is well-formed UTF-8 (a multi-byte sequence cut off at the very end is tolerated: the caller truncates at 8 KiB). */
function isUtf8(b: Uint8Array, allowTruncatedTail: boolean): boolean {
  let i = 0;
  while (i < b.length) {
    const c = b[i]!;
    const need = c < 0x80 ? 0 : c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : -1;
    if (need < 0) return false;
    if (need > 0 && i + need >= b.length) return allowTruncatedTail;
    for (let k = 1; k <= need; k++) if ((b[i + k]! & 0xc0) !== 0x80) return false;
    i += need + 1;
  }
  return true;
}

/** NUL byte in the first 8 KiB, or invalid UTF-8, means binary. */
export function isBinaryContent(buf: Uint8Array): boolean {
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return true;
  return !isUtf8(head, buf.length > head.length);
}

// High-confidence secret shapes only (a generic "password =" rule would exclude half of all test files).
// Built from parts so this source file never contains a literal that a secret scanner would flag.
const SECRET_PATTERNS: RegExp[] = [
  new RegExp(`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE ${"KEY"}`),
  new RegExp(`\\b${"AKIA"}[0-9A-Z]{16}\\b`),
  new RegExp(`\\bgh[pousr]_[A-Za-z0-9]{36,}\\b`),
  new RegExp(`\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b`),
  new RegExp(`\\b${"sk_"}live_[A-Za-z0-9]{16,}\\b`),
  new RegExp(`\\b${"sk-"}ant-[A-Za-z0-9_-]{20,}\\b`),
  new RegExp(`\\b${"sk-"}[A-Za-z0-9]{40,}\\b`),
];
export function hasSecretContent(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

const EXT_LANG: Record<string, SourceLanguage> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  py: "python", go: "go",
};
export function languageOf(path: string): SourceLanguage | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return (m && EXT_LANG[m[1]!.toLowerCase()]) || null;
}

/** Removes `scheme://user:password@` credentials from any text that is stored or exported (evidence lines AND specifiers). */
export const redactUrlCredentials = (text: string): string => text.replace(/(\w+:\/\/)[^\s/'"`]+@/g, "$1[redacted]@");

/** Only the import line itself is ever stored, with URL credentials removed. */
export function redactSnippet(line: string, max = 200): string {
  const t = redactUrlCredentials(line.trim());
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ------------------------------------------------------------------------------------------------ limits

export interface ImportLimits {
  /** Compressed upload size. */
  maxArchiveBytes: number;
  /** Entries (files, directories, links) declared by the archive; checked before any entry is read. */
  maxEntries: number;
  /** Files kept in the graph. Files beyond it are skipped (file_limit), not rejected. */
  maxFiles: number;
  /** Sum of decompressed sizes of ALL entries; above it the archive is rejected as a bomb. */
  maxTotalBytes: number;
  /** One file's decompressed size; larger files are skipped (too_large). */
  maxFileBytes: number;
  maxPathBytes: number;
  maxDepth: number;
  /** Decompressed / compressed size. Above it (once past a small floor) the archive is rejected as a bomb. */
  maxRatio: number;
  /** Import edges kept for the whole import. */
  maxEdges: number;
  /** Total wall-clock milliseconds spent scanning imports; source files after the budget is used up are skipped (parse_budget). */
  maxParseMs: number;
  /** A source file with more lines than this is not scanned (parse_budget). */
  maxParseLines: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxArchiveBytes: 25 * 1024 * 1024,
  maxEntries: 20_000,
  maxFiles: 5_000,
  maxTotalBytes: 100 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  maxPathBytes: 512,
  maxDepth: 32,
  maxRatio: 100,
  maxEdges: 50_000,
  maxParseMs: 20_000,
  maxParseLines: 100_000,
};

/** Ceilings the configuration cannot raise (so a config typo cannot disable the protection). */
export const HARD_IMPORT_LIMITS: ImportLimits = {
  maxArchiveBytes: 100 * 1024 * 1024,
  maxEntries: 100_000,
  maxFiles: 20_000,
  maxTotalBytes: 500 * 1024 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
  maxPathBytes: 1024,
  maxDepth: 64,
  maxRatio: 1000,
  maxEdges: 200_000,
  maxParseMs: 120_000,
  maxParseLines: 500_000,
};

/** Clamps every requested limit into [1, hard ceiling]. */
export function resolveLimits(requested: Partial<ImportLimits> = {}): ImportLimits {
  const out = { ...DEFAULT_IMPORT_LIMITS };
  for (const k of Object.keys(out) as (keyof ImportLimits)[]) {
    const v = requested[k];
    if (v !== undefined) out[k] = Math.max(1, Math.min(Math.floor(v), HARD_IMPORT_LIMITS[k]));
  }
  return out;
}
