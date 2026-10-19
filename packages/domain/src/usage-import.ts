/**
 * Local usage-export import and price comparison (task 18).
 *
 * Pure and environment-neutral: it only needs Uint8Array, TextDecoder and (for ZIP) the standard
 * DecompressionStream, so the same code runs in a Web Worker and in Node tests. It performs no I/O.
 * All token and money arithmetic uses bigint micro-USD from ./money; no floats touch a charge.
 */
import { formatUsd, tokenCharge } from "./money";

// Module-scoped structural declarations: avoid a DOM lib dependency in this package.
declare const TextDecoder: new (label?: string) => { decode(input: Uint8Array): string };
interface InflateStream {
  readable: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } };
  writable: { getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> } };
}
declare const DecompressionStream: (new (format: "deflate-raw") => InflateStream) | undefined;

export const IMPORT_LIMITS = {
  /** Input file (or archive) size: matches the public reference's 25 MB. */
  maxInputBytes: 25 * 1024 * 1024,
  /** Entries in a ZIP central directory, directories and ignored files included. */
  maxZipEntries: 100,
  /** Decompressed size of any single ZIP entry. */
  maxEntryBytes: 64 * 1024 * 1024,
  /** Decompressed size of all read ZIP entries together. */
  maxTotalBytes: 128 * 1024 * 1024,
  /** Data rows across all files. */
  maxRows: 200_000,
  maxColumns: 200,
  /** Longest accepted integer token string. */
  maxDigits: 18,
  /** Cap of excluded-row details retained for display. */
  maxExcludedDetails: 100,
  maxUnknownColumns: 50,
} as const;
export type UsageImportLimits = { -readonly [K in keyof typeof IMPORT_LIMITS]: number };

export type ImportErrorCode =
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "EMPTY"
  | "ZIP_INVALID"
  | "ZIP_UNSUPPORTED"
  | "ZIP_TOO_MANY_FILES"
  | "ZIP_ENTRY_TOO_LARGE"
  | "ZIP_TOTAL_TOO_LARGE"
  | "NO_READABLE_FILES"
  | "TOO_MANY_ROWS"
  | "PARSE_ERROR";

export class UsageImportError extends Error {
  readonly code: ImportErrorCode;
  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = "UsageImportError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ ZIP */

export interface SourceFile {
  name: string;
  bytes: Uint8Array;
}
export interface SkippedEntry {
  name: string;
  reason: "directory" | "unsafe_path" | "unsupported_type" | "encrypted" | "unsupported_method" | "hidden_metadata";
}

const TEXT_EXT = /\.(csv|json|jsonl|ndjson)$/i;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(b: Uint8Array, o: number): number {
  return (b[o] as number) | ((b[o + 1] as number) << 8);
}
function u32(b: Uint8Array, o: number): number {
  return ((b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16) | ((b[o + 3] as number) << 24)) >>> 0;
}

async function inflateRaw(data: Uint8Array, maxOut: number): Promise<Uint8Array> {
  if (!DecompressionStream) throw new UsageImportError("ZIP_UNSUPPORTED", "This environment cannot decompress ZIP files.");
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  writer.write(data).then(() => writer.close()).catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > maxOut) {
          await reader.cancel().catch(() => undefined);
          throw new UsageImportError("ZIP_ENTRY_TOO_LARGE", "A ZIP entry expands beyond the allowed size.");
        }
        chunks.push(value);
      }
    }
  } catch (e) {
    if (e instanceof UsageImportError) throw e;
    throw new UsageImportError("ZIP_INVALID", "A ZIP entry could not be decompressed.");
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function isUnsafePath(name: string): boolean {
  return (
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    /^[a-zA-Z]:/.test(name) ||
    name.split("/").some((p) => p === "..")
  );
}

/**
 * Reads text-like entries from a ZIP. Archives are never written to disk. The central directory is
 * checked for entry count and declared sizes before any inflation, and inflation itself is capped, so a
 * lying header cannot expand past the limits.
 */
export async function readZip(
  bytes: Uint8Array,
  limits: UsageImportLimits = { ...IMPORT_LIMITS },
): Promise<{ files: SourceFile[]; skipped: SkippedEntry[] }> {
  if (bytes.length < 22) throw new UsageImportError("ZIP_INVALID", "The ZIP archive is truncated.");
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new UsageImportError("ZIP_INVALID", "No ZIP end-of-directory record found.");
  const disk = u16(bytes, eocd + 4);
  const cdDisk = u16(bytes, eocd + 6);
  const count = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (disk !== 0 || cdDisk !== 0) throw new UsageImportError("ZIP_UNSUPPORTED", "Multi-part ZIP archives are not supported.");
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new UsageImportError("ZIP_UNSUPPORTED", "ZIP64 archives are not supported.");
  }
  if (count > limits.maxZipEntries) {
    throw new UsageImportError("ZIP_TOO_MANY_FILES", `The archive has ${count} entries; the limit is ${limits.maxZipEntries}.`);
  }
  if (cdOffset + cdSize > eocd) throw new UsageImportError("ZIP_INVALID", "The ZIP directory is out of bounds.");

  interface Entry {
    name: string;
    method: number;
    crc: number;
    csize: number;
    usize: number;
    localOffset: number;
  }
  const decoder = new TextDecoder("utf-8");
  const skipped: SkippedEntry[] = [];
  const entries: Entry[] = [];
  let declaredTotal = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || u32(bytes, p) !== 0x02014b50) throw new UsageImportError("ZIP_INVALID", "A ZIP directory entry is malformed.");
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const crc = u32(bytes, p + 16);
    const csize = u32(bytes, p + 20);
    const usize = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const localOffset = u32(bytes, p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > eocd) throw new UsageImportError("ZIP_INVALID", "A ZIP directory entry is out of bounds.");
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) {
      skipped.push({ name, reason: "directory" });
      continue;
    }
    if (isUnsafePath(name)) {
      skipped.push({ name, reason: "unsafe_path" });
      continue;
    }
    if (name.startsWith("__MACOSX/") || name.split("/").pop()?.startsWith("._")) {
      skipped.push({ name, reason: "hidden_metadata" });
      continue;
    }
    if (!TEXT_EXT.test(name)) {
      skipped.push({ name, reason: "unsupported_type" });
      continue;
    }
    if (flags & 1) {
      skipped.push({ name, reason: "encrypted" });
      continue;
    }
    if (method !== 0 && method !== 8) {
      skipped.push({ name, reason: "unsupported_method" });
      continue;
    }
    if (csize === 0xffffffff || usize === 0xffffffff) throw new UsageImportError("ZIP_UNSUPPORTED", "ZIP64 entries are not supported.");
    if (usize > limits.maxEntryBytes) {
      throw new UsageImportError("ZIP_ENTRY_TOO_LARGE", `"${name}" would expand to ${usize} bytes; the limit is ${limits.maxEntryBytes}.`);
    }
    declaredTotal += usize;
    if (declaredTotal > limits.maxTotalBytes) {
      throw new UsageImportError("ZIP_TOTAL_TOO_LARGE", `The archive would expand beyond ${limits.maxTotalBytes} bytes.`);
    }
    entries.push({ name, method, crc, csize, usize, localOffset });
  }

  const files: SourceFile[] = [];
  let actualTotal = 0;
  for (const e of entries) {
    const lo = e.localOffset;
    if (lo + 30 > bytes.length || u32(bytes, lo) !== 0x04034b50) throw new UsageImportError("ZIP_INVALID", `"${e.name}" has no valid local header.`);
    const start = lo + 30 + u16(bytes, lo + 26) + u16(bytes, lo + 28);
    if (start + e.csize > cdOffset) throw new UsageImportError("ZIP_INVALID", `"${e.name}" data is out of bounds.`);
    const raw = bytes.subarray(start, start + e.csize);
    let data: Uint8Array;
    if (e.method === 0) {
      if (e.csize !== e.usize) throw new UsageImportError("ZIP_INVALID", `"${e.name}" has inconsistent sizes.`);
      data = raw;
    } else {
      // Cap by the declared size (already within limits); a larger real output means the header lied.
      data = await inflateRaw(raw, Math.min(e.usize, limits.maxTotalBytes - actualTotal));
    }
    actualTotal += data.length;
    if (actualTotal > limits.maxTotalBytes) throw new UsageImportError("ZIP_TOTAL_TOO_LARGE", "The archive expands beyond the allowed size.");
    if (data.length !== e.usize) throw new UsageImportError("ZIP_INVALID", `"${e.name}" does not match its declared size.`);
    if (crc32(data) !== e.crc) throw new UsageImportError("ZIP_INVALID", `"${e.name}" failed its integrity check.`);
    files.push({ name: e.name, bytes: data });
  }
  return { files, skipped };
}

/* ------------------------------------------------------- text parsing */

export type RawRow = Map<string, unknown>;
interface ParsedTable {
  columns: string[];
  rows: { row: number; data: RawRow }[];
  invalid: { row: number; detail: string }[];
}

function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseCsv(text: string, limits: Pick<UsageImportLimits, "maxRows" | "maxColumns">): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    field = "";
    if (!(row.length === 1 && row[0] === "")) {
      if (row.length > limits.maxColumns) throw new UsageImportError("PARSE_ERROR", `A CSV row has more than ${limits.maxColumns} columns.`);
      out.push(row);
      if (out.length > limits.maxRows + 1) throw new UsageImportError("TOO_MANY_ROWS", `More than ${limits.maxRows} rows.`);
    }
    row = [];
  };
  while (i < text.length) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === "") inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") endRow();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else field += ch;
    i++;
  }
  if (inQuotes) throw new UsageImportError("PARSE_ERROR", "A CSV quoted field is not closed.");
  if (field !== "" || row.length > 0) endRow();
  return out;
}

/** Flattens nested objects to `a_b` keys up to two levels; arrays and deeper values stay opaque. */
function flatten(obj: unknown, prefix: string, depth: number, out: RawRow): void {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v) && depth < 2) flatten(v, key, depth + 1, out);
    else out.set(key, v);
  }
}

function canonKey(k: string): string {
  return k.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function tableFromRecords(records: { row: number; value: unknown }[], limits: UsageImportLimits): ParsedTable {
  const cols = new Set<string>();
  const rows: ParsedTable["rows"] = [];
  const invalid: ParsedTable["invalid"] = [];
  for (const r of records) {
    if (r.value === null || typeof r.value !== "object" || Array.isArray(r.value)) {
      invalid.push({ row: r.row, detail: "Not a JSON object" });
      continue;
    }
    const data: RawRow = new Map();
    flatten(r.value, "", 0, data);
    const canon: RawRow = new Map();
    for (const [k, v] of data) {
      const c = canonKey(k);
      if (c === "") continue;
      cols.add(c);
      if (!canon.has(c)) canon.set(c, v);
    }
    rows.push({ row: r.row, data: canon });
    if (cols.size > limits.maxColumns) throw new UsageImportError("PARSE_ERROR", "Too many distinct fields.");
  }
  return { columns: [...cols], rows, invalid };
}

function parseTable(name: string, bytes: Uint8Array, limits: UsageImportLimits): ParsedTable {
  const text = decodeText(bytes);
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv")) {
    const grid = parseCsv(text, limits);
    const header = grid[0];
    if (!header) return { columns: [], rows: [], invalid: [] };
    const keys = header.map(canonKey);
    const rows: ParsedTable["rows"] = [];
    for (let i = 1; i < grid.length; i++) {
      const cells = grid[i] as string[];
      const data: RawRow = new Map();
      keys.forEach((k, idx) => {
        if (k !== "" && !data.has(k) && cells[idx] !== undefined) data.set(k, cells[idx]);
      });
      rows.push({ row: i, data });
    }
    return { columns: keys.filter((k) => k !== ""), rows, invalid: [] };
  }
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) {
    const records: { row: number; value: unknown }[] = [];
    const bad: { row: number; detail: string }[] = [];
    let n = 0;
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      n++;
      if (n > limits.maxRows) throw new UsageImportError("TOO_MANY_ROWS", `More than ${limits.maxRows} rows.`);
      try {
        records.push({ row: n, value: JSON.parse(line) as unknown });
      } catch {
        bad.push({ row: n, detail: "Line is not valid JSON" });
      }
    }
    const t = tableFromRecords(records, limits);
    t.invalid.push(...bad);
    return t;
  }
  // .json
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageImportError("PARSE_ERROR", `"${name}" is not valid JSON.`);
  }
  let list: unknown[];
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed !== null && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    const wrapped = ["data", "records", "items", "usage", "rows"].map((k) => o[k]).find((v) => Array.isArray(v));
    list = Array.isArray(wrapped) ? wrapped : [parsed];
  } else throw new UsageImportError("PARSE_ERROR", `"${name}" has no records.`);
  if (list.length > limits.maxRows) throw new UsageImportError("TOO_MANY_ROWS", `More than ${limits.maxRows} rows.`);
  return tableFromRecords(list.map((value, i) => ({ row: i + 1, value })), limits);
}

/* ------------------------------------------------------- normalisation */

const ALIASES = {
  model: ["model", "model_id", "model_name", "modelid"],
  input: ["input_tokens", "prompt_tokens", "input_token_count", "tokens_in"],
  output: ["output_tokens", "completion_tokens", "output_token_count", "tokens_out"],
  cached: ["cached_tokens", "cached_input_tokens", "cache_read_input_tokens", "cache_read_tokens"],
  cost: ["cost_usd", "cost", "total_cost", "total_cost_usd"],
  timestamp: ["timestamp", "created_at", "time", "date"],
} as const;
type Field = keyof typeof ALIASES;
const KNOWN_KEYS = new Set<string>(Object.values(ALIASES).flat().flatMap((a) => [a, `usage_${a}`]));

function lookup(data: RawRow, field: Field): unknown {
  for (const a of ALIASES[field]) {
    if (data.has(a)) return data.get(a);
    if (data.has(`usage_${a}`)) return data.get(`usage_${a}`);
  }
  return undefined;
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/** Strict token count: a non-negative whole number, as an integer string or a safe JSON integer. */
export function parseTokenCount(v: unknown): bigint | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^[0-9]+$/.test(s) && s.length <= IMPORT_LIMITS.maxDigits ? BigInt(s) : null;
}

/** Decimal USD string to micro-USD, rounded up once; null when unreadable. No float arithmetic. */
export function parseUsdToMicro(v: unknown): bigint | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(/^\$/, "") : "";
  const m = /^([0-9]{1,12})(?:\.([0-9]{1,18}))?$/.exec(s);
  if (!m) return null;
  const whole = BigInt(m[1] as string);
  const frac = (m[2] ?? "").padEnd(6, "0");
  let micro = whole * 1_000_000n + BigInt(frac.slice(0, 6));
  if (/[1-9]/.test(frac.slice(6))) micro += 1n;
  return micro;
}

export type ExcludeReason = "missing_model" | "missing_input_tokens" | "missing_output_tokens" | "invalid_number" | "invalid_row";

export interface UsageRow {
  file: string;
  row: number;
  model: string;
  inputTokens: bigint;
  outputTokens: bigint;
  cachedInputTokens: bigint;
  recordedCostMicrousd: bigint | null;
  timestamp: string | null;
}
export interface ExcludedRow {
  file: string;
  row: number;
  reason: ExcludeReason;
  detail: string;
}
export interface ImportResult {
  files: { name: string; rows: number }[];
  rows: UsageRow[];
  excluded: ExcludedRow[];
  excludedTotal: number;
  excludedByReason: Partial<Record<ExcludeReason, number>>;
  unknownColumns: string[];
  skippedEntries: SkippedEntry[];
  unreadableCostValues: number;
}

function sourceKind(name: string): "zip" | "text" | null {
  const l = name.toLowerCase();
  if (l.endsWith(".zip")) return "zip";
  return TEXT_EXT.test(l) ? "text" : null;
}

/** Imports one user-selected file (or a ZIP of files). Throws UsageImportError for limit/format failures. */
export async function importUsage(input: SourceFile, overrides: Partial<UsageImportLimits> = {}): Promise<ImportResult> {
  const limits: UsageImportLimits = { ...IMPORT_LIMITS, ...overrides };
  if (input.bytes.length > limits.maxInputBytes) {
    throw new UsageImportError("FILE_TOO_LARGE", `The file is larger than ${Math.round(limits.maxInputBytes / 1024 / 1024)} MB.`);
  }
  if (input.bytes.length === 0) throw new UsageImportError("EMPTY", "The file is empty.");
  const kind = sourceKind(input.name);
  if (!kind) throw new UsageImportError("UNSUPPORTED_TYPE", "Use a .zip, .csv, .json or .jsonl file.");

  let files: SourceFile[];
  let skippedEntries: SkippedEntry[] = [];
  if (kind === "zip") {
    if (!looksLikeZip(input.bytes) && !(input.bytes.length >= 22 && u32(input.bytes, input.bytes.length - 22) === 0x06054b50)) {
      throw new UsageImportError("ZIP_INVALID", "The file is not a ZIP archive.");
    }
    const z = await readZip(input.bytes, limits);
    files = z.files;
    skippedEntries = z.skipped;
    if (files.length === 0) throw new UsageImportError("NO_READABLE_FILES", "The archive has no .csv, .json or .jsonl files.");
  } else files = [input];

  const rows: UsageRow[] = [];
  const excluded: ExcludedRow[] = [];
  const excludedByReason: ImportResult["excludedByReason"] = {};
  let excludedTotal = 0;
  let unreadableCostValues = 0;
  const unknown = new Set<string>();
  const fileSummaries: ImportResult["files"] = [];
  let rowBudget = limits.maxRows;

  const exclude = (file: string, row: number, reason: ExcludeReason, detail: string) => {
    excludedTotal++;
    excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
    if (excluded.length < limits.maxExcludedDetails) excluded.push({ file, row, reason, detail });
  };

  for (const f of files) {
    const table = parseTable(f.name, f.bytes, limits);
    rowBudget -= table.rows.length + table.invalid.length;
    if (rowBudget < 0) throw new UsageImportError("TOO_MANY_ROWS", `More than ${limits.maxRows} rows.`);
    fileSummaries.push({ name: f.name, rows: table.rows.length + table.invalid.length });
    for (const c of table.columns) if (!KNOWN_KEYS.has(c) && unknown.size < limits.maxUnknownColumns) unknown.add(c);
    for (const bad of table.invalid) exclude(f.name, bad.row, "invalid_row", bad.detail);
    for (const { row, data } of table.rows) {
      const modelRaw = lookup(data, "model");
      const model = typeof modelRaw === "string" ? modelRaw.trim() : "";
      if (model === "" || model.length > 200) {
        exclude(f.name, row, "missing_model", "No model value");
        continue;
      }
      const inRaw = lookup(data, "input");
      const outRaw = lookup(data, "output");
      if (isBlank(inRaw)) {
        exclude(f.name, row, "missing_input_tokens", "No input token count");
        continue;
      }
      if (isBlank(outRaw)) {
        exclude(f.name, row, "missing_output_tokens", "No output token count");
        continue;
      }
      const inputTokens = parseTokenCount(inRaw);
      const outputTokens = parseTokenCount(outRaw);
      const cachedRaw = lookup(data, "cached");
      const cached = isBlank(cachedRaw) ? 0n : parseTokenCount(cachedRaw);
      if (inputTokens === null || outputTokens === null || cached === null) {
        exclude(f.name, row, "invalid_number", "Token counts must be non-negative whole numbers");
        continue;
      }
      const costRaw = lookup(data, "cost");
      let cost: bigint | null = null;
      if (!isBlank(costRaw)) {
        cost = parseUsdToMicro(costRaw);
        if (cost === null) unreadableCostValues++;
      }
      const ts = lookup(data, "timestamp");
      rows.push({
        file: f.name,
        row,
        model,
        inputTokens,
        outputTokens,
        cachedInputTokens: cached,
        recordedCostMicrousd: cost,
        timestamp: typeof ts === "string" && ts.length <= 64 ? ts : null,
      });
    }
  }
  return {
    files: fileSummaries,
    rows,
    excluded,
    excludedTotal,
    excludedByReason,
    unknownColumns: [...unknown].sort(),
    skippedEntries,
    unreadableCostValues,
  };
}

/* --------------------------------------------------------- comparison */

export interface PriceSnapshotModel {
  id: string;
  inputMicrousdPerMtok: string;
  cachedInputMicrousdPerMtok: string | null;
  outputMicrousdPerMtok: string;
}
export interface PriceSnapshot {
  pricingVersion: string;
  /** Where the prices came from, e.g. "Gateway API" or "Bundled sample data". */
  source: string;
  /** Date the prices apply to (YYYY-MM-DD). */
  asOf: string;
  isSample: boolean;
  models: PriceSnapshotModel[];
}

export interface ModelLine {
  model: string;
  catalogId: string;
  requests: number;
  inputTokens: bigint;
  outputTokens: bigint;
  cachedInputTokens: bigint;
  estimatedMicrousd: bigint;
  cachedRateAssumed: boolean;
  recordedMicrousd: bigint | null;
  rowsWithRecordedCost: number;
}
export interface UnmatchedLine {
  model: string;
  /** unknown_model: not in the snapshot. invalid_rate: in the snapshot but a rate is not a canonical integer, so it is never priced. */
  reason: "unknown_model" | "invalid_rate";
  requests: number;
  inputTokens: bigint;
  outputTokens: bigint;
  cachedInputTokens: bigint;
}
export type Comparison =
  | { status: "insufficient_data"; reason: "no_matched_rows" | "recorded_cost_missing"; rowsWithRecordedCost: number; matchedRows: number }
  | {
      status: "complete";
      recordedMicrousd: bigint;
      estimatedMicrousd: bigint;
      /** Magnitude of the gap; direction says whether the snapshot estimate is below, above or equal to the recorded cost. */
      differenceMicrousd: bigint;
      direction: "estimate_lower" | "estimate_higher" | "equal";
    };
export interface UsageReport {
  generatedAt: string;
  /** True only when the usage rows themselves are bundled example data. Price provenance is snapshot.isSample. */
  sample: boolean;
  snapshot: Omit<PriceSnapshot, "models"> & { modelCount: number };
  rowsRead: number;
  rowsMatched: number;
  rowsUnmatched: number;
  excludedTotal: number;
  excludedByReason: ImportResult["excludedByReason"];
  files: ImportResult["files"];
  unknownColumns: string[];
  skippedEntries: SkippedEntry[];
  unreadableCostValues: number;
  matched: ModelLine[];
  unmatched: UnmatchedLine[];
  comparison: Comparison;
  notes: string[];
}

const CANONICAL_INT = /^(0|[1-9][0-9]*)$/;

/** True only when every rate the model needs is a canonical non-negative integer string. A malformed rate must never price as 0. */
function ratesReadable(m: PriceSnapshotModel): boolean {
  return CANONICAL_INT.test(m.inputMicrousdPerMtok) && CANONICAL_INT.test(m.outputMicrousdPerMtok)
    && (m.cachedInputMicrousdPerMtok === null || CANONICAL_INT.test(m.cachedInputMicrousdPerMtok));
}

/** Only called for models that passed ratesReadable; throws instead of yielding a silent 0. */
function toBig(s: string): bigint {
  if (!CANONICAL_INT.test(s)) throw new RangeError("unreadable price rate");
  return BigInt(s);
}

/**
 * Prices the recorded tokens at the dated snapshot. Rule (documented in the UI): each token category of
 * each model is summed, multiplied by the snapshot rate, and rounded up once to a micro-USD. Cached tokens
 * are treated as separate from input tokens (the export is assumed to report cached tokens apart from, not
 * inside, the input count; if your export includes them in the input count the estimate double-counts them).
 * Recorded costs are decimal USD read per row and rounded up to a micro-USD per row (parseUsdToMicro).
 * Models match by exact ID, ignoring case and surrounding space. A snapshot model with an unreadable rate is
 * listed as unmatched (reason invalid_rate) and is not priced.
 */
export function buildReport(
  result: ImportResult,
  snapshot: PriceSnapshot,
  generatedAt: string,
  opts: { sampleData?: boolean } = {},
): UsageReport {
  const byId = new Map(snapshot.models.filter(ratesReadable).map((m) => [m.id.trim().toLowerCase(), m]));
  const invalidRate = new Set(snapshot.models.filter((m) => !ratesReadable(m)).map((m) => m.id.trim().toLowerCase()));
  interface Acc { model: string; catalogId: string; n: number; i: bigint; o: bigint; c: bigint; cost: bigint; costRows: number }
  const matched = new Map<string, Acc>();
  const unmatched = new Map<string, UnmatchedLine>();
  let rowsMatched = 0;
  let rowsUnmatched = 0;
  let matchedWithCost = 0;
  for (const r of result.rows) {
    const key = r.model.toLowerCase();
    const cat = byId.get(key);
    if (cat) {
      rowsMatched++;
      const a = matched.get(key) ?? { model: r.model, catalogId: cat.id, n: 0, i: 0n, o: 0n, c: 0n, cost: 0n, costRows: 0 };
      a.n++;
      a.i += r.inputTokens;
      a.o += r.outputTokens;
      a.c += r.cachedInputTokens;
      if (r.recordedCostMicrousd !== null) {
        a.cost += r.recordedCostMicrousd;
        a.costRows++;
        matchedWithCost++;
      }
      matched.set(key, a);
    } else {
      rowsUnmatched++;
      const u = unmatched.get(key) ?? { model: r.model, reason: invalidRate.has(key) ? "invalid_rate" as const : "unknown_model" as const, requests: 0, inputTokens: 0n, outputTokens: 0n, cachedInputTokens: 0n };
      u.requests++;
      u.inputTokens += r.inputTokens;
      u.outputTokens += r.outputTokens;
      u.cachedInputTokens += r.cachedInputTokens;
      unmatched.set(key, u);
    }
  }
  const lines: ModelLine[] = [...matched.entries()]
    .map(([key, a]) => {
      const cat = byId.get(key) as PriceSnapshotModel;
      const inRate = toBig(cat.inputMicrousdPerMtok);
      const cachedAssumed = cat.cachedInputMicrousdPerMtok === null && a.c > 0n;
      const cachedRate = cat.cachedInputMicrousdPerMtok === null ? inRate : toBig(cat.cachedInputMicrousdPerMtok);
      return {
        model: a.model,
        catalogId: a.catalogId,
        requests: a.n,
        inputTokens: a.i,
        outputTokens: a.o,
        cachedInputTokens: a.c,
        estimatedMicrousd: tokenCharge(a.i, inRate) + tokenCharge(a.o, toBig(cat.outputMicrousdPerMtok)) + tokenCharge(a.c, cachedRate),
        cachedRateAssumed: cachedAssumed,
        recordedMicrousd: a.costRows === a.n ? a.cost : null,
        rowsWithRecordedCost: a.costRows,
      };
    })
    .sort((x, y) => x.catalogId.localeCompare(y.catalogId));

  let comparison: Comparison;
  if (rowsMatched === 0) {
    comparison = { status: "insufficient_data", reason: "no_matched_rows", rowsWithRecordedCost: 0, matchedRows: 0 };
  } else if (matchedWithCost !== rowsMatched) {
    comparison = { status: "insufficient_data", reason: "recorded_cost_missing", rowsWithRecordedCost: matchedWithCost, matchedRows: rowsMatched };
  } else {
    const rec = lines.reduce((s, l) => s + (l.recordedMicrousd ?? 0n), 0n);
    const est = lines.reduce((s, l) => s + l.estimatedMicrousd, 0n);
    comparison = {
      status: "complete",
      recordedMicrousd: rec,
      estimatedMicrousd: est,
      differenceMicrousd: est > rec ? est - rec : rec - est,
      direction: est === rec ? "equal" : est < rec ? "estimate_lower" : "estimate_higher",
    };
  }

  const notes = [
    `Estimate priced at snapshot ${snapshot.pricingVersion} (${snapshot.source}, as of ${snapshot.asOf}). It is not a quote or a promise of savings.`,
    "Each token category per model is totalled, multiplied by the snapshot rate and rounded up once to a micro-USD.",
    "Cached tokens are treated as separate from input tokens. Check how your export reports them.",
    "Batching, long-context tiers, tool charges and other billing details are not modelled.",
  ];
  if (unmatched.size && [...unmatched.values()].some((u) => u.reason === "invalid_rate")) notes.push("Some snapshot models have an unreadable price rate; their rows are listed as unmatched and were not priced.");
  notes.push("Recorded costs are rounded up to a micro-USD per row.");
  if (lines.some((l) => l.cachedRateAssumed)) notes.push("Where the snapshot has no cached-input rate, cached tokens were priced at the input rate.");
  if (snapshot.isSample) notes.push("SAMPLE PRICES: this snapshot is bundled example data, not live gateway prices.");

  return {
    generatedAt,
    sample: opts.sampleData === true,
    snapshot: {
      pricingVersion: snapshot.pricingVersion,
      source: snapshot.source,
      asOf: snapshot.asOf,
      isSample: snapshot.isSample,
      modelCount: snapshot.models.length,
    },
    rowsRead: result.rows.length,
    rowsMatched,
    rowsUnmatched,
    excludedTotal: result.excludedTotal,
    excludedByReason: result.excludedByReason,
    files: result.files,
    unknownColumns: result.unknownColumns,
    skippedEntries: result.skippedEntries,
    unreadableCostValues: result.unreadableCostValues,
    matched: lines,
    unmatched: [...unmatched.values()].sort((a, b) => a.model.localeCompare(b.model)),
    comparison,
    notes,
  };
}

/* -------------------------------------------------------------- export */

/** Neutralises spreadsheet formulas: any text cell starting with = + - @ tab or CR gets a leading apostrophe. */
export function csvSafeCell(value: string): string {
  const guarded = /^[\s]*[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function reportToCsv(report: UsageReport): string {
  const head = [
    "section", "model", "catalog_id", "requests", "input_tokens", "output_tokens", "cached_input_tokens",
    "estimated_cost_usd", "recorded_cost_usd", "price_snapshot", "sample",
  ];
  const snap = `${report.snapshot.pricingVersion} as of ${report.snapshot.asOf}`;
  const sample = report.sample || report.snapshot.isSample ? "sample" : "";
  const lines = [head.join(",")];
  const row = (cells: string[]) => lines.push(cells.map(csvSafeCell).join(","));
  for (const m of report.matched) {
    row([
      "matched", m.model, m.catalogId, String(m.requests), String(m.inputTokens), String(m.outputTokens),
      String(m.cachedInputTokens), formatUsd(m.estimatedMicrousd),
      m.recordedMicrousd === null ? "" : formatUsd(m.recordedMicrousd), snap, sample,
    ]);
  }
  for (const u of report.unmatched) {
    row([
      "unmatched", u.model, "", String(u.requests), String(u.inputTokens), String(u.outputTokens),
      String(u.cachedInputTokens), "", "", snap, sample,
    ]);
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function reportToJson(report: UsageReport): string {
  return JSON.stringify(report, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}
