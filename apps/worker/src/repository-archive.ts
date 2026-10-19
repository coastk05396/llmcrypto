/**
 * Safe, in-memory reader for uploaded repository archives (ZIP and tar.gz). Nothing is ever written to disk, nothing is
 * executed, and no link is ever followed: an archive is only a list of (path, bytes) pairs here.
 *
 * Whole-archive rejections (ArchiveError): too large, too many entries, decompressed size/ratio beyond the limits (bombs),
 * overlapping or lying ZIP records, truncated/corrupt data, path traversal (".." segments, absolute or drive paths, NUL or
 * control characters, over-long or over-deep paths), duplicate paths, and symlinks/hardlinks that point outside the
 * archive root. In-root links, devices and fifos are not rejected but are never followed or read: they are reported as
 * skipped entries.
 */
import { createHash } from "node:crypto";
import type { ImportLimits } from "@llmcrypto/domain";
import { crc32, gunzipSync, inflateRawSync } from "node:zlib";

export type ArchiveErrorCode =
  | "ARCHIVE_FORMAT"
  | "ARCHIVE_TOO_LARGE"
  | "ARCHIVE_TOO_MANY_ENTRIES"
  | "ARCHIVE_EXPANDS_TOO_MUCH"
  | "ARCHIVE_UNSAFE_PATH"
  | "ARCHIVE_UNSAFE_LINK"
  | "ARCHIVE_DUPLICATE_PATH"
  | "ARCHIVE_MALFORMED"
  | "ARCHIVE_UNSUPPORTED";

export class ArchiveError extends Error {
  constructor(readonly code: ArchiveErrorCode, message: string) {
    super(message);
  }
}

export type ArchiveFormat = "zip" | "tar.gz";
export type EntryKind = "file" | "dir" | "link" | "special";
export type EntrySkip = "symlink" | "link" | "special" | "encrypted" | "unsupported_compression";

export interface ArchiveEntry {
  /** Normalised, relative, forward-slash path (a single wrapping top-level directory is NOT stripped here). */
  path: string;
  kind: EntryKind;
  /** Declared decompressed size. */
  size: number;
  /** Set for entries that must not be read (links, encrypted data, ...). */
  skip: EntrySkip | null;
  /** Decompressed bytes; throws ArchiveError when the data disagrees with its header. */
  read(): Buffer;
}

export function detectFormat(buf: Uint8Array): ArchiveFormat | null {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05) && (buf[3] === 0x04 || buf[3] === 0x06)) return "zip";
  if (buf.length >= 3 && buf[0] === 0x1f && buf[1] === 0x8b && buf[2] === 0x08) return "tar.gz";
  return null;
}

/** Normalises an entry name or throws ARCHIVE_UNSAFE_PATH. Backslashes are separators (so "..\\x" is traversal). */
export function normalizeEntryPath(raw: string, limits: Pick<ImportLimits, "maxPathBytes" | "maxDepth">): string {
  if (raw.includes("\0")) throw new ArchiveError("ARCHIVE_UNSAFE_PATH", "Entry name contains a NUL byte");
  const name = raw.replaceAll("\\", "/");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new ArchiveError("ARCHIVE_UNSAFE_PATH", "Entry name is an absolute path");
  const segs: string[] = [];
  for (const seg of name.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new ArchiveError("ARCHIVE_UNSAFE_PATH", "Entry name escapes the archive root (..)");
    // eslint-disable-next-line no-control-regex -- control characters in names are rejected on purpose
    if (/[\u0000-\u001f\u007f]/.test(seg)) throw new ArchiveError("ARCHIVE_UNSAFE_PATH", "Entry name contains a control character");
    segs.push(seg);
  }
  const path = segs.join("/");
  if (Buffer.byteLength(path, "utf8") > limits.maxPathBytes) throw new ArchiveError("ARCHIVE_UNSAFE_PATH", "Entry name is too long");
  if (segs.length > limits.maxDepth) throw new ArchiveError("ARCHIVE_UNSAFE_PATH", "Entry name is nested too deeply");
  return path;
}

/** A link target is safe when it is relative and, resolved from the link's directory, stays inside the root. */
export function linkTargetStaysInside(linkPath: string, target: string): boolean {
  if (target === "" || target.includes("\0")) return false;
  const t = target.replaceAll("\\", "/");
  if (t.startsWith("/") || /^[A-Za-z]:/.test(t)) return false;
  const depth = linkPath.split("/").length - 1; // directories above the link
  let level = depth;
  for (const seg of t.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      level--;
      if (level < 0) return false;
    } else level++;
  }
  return true;
}

/** Opens an archive, validating everything that can be validated without reading file data. */
export function openArchive(buf: Buffer, limits: ImportLimits): { format: ArchiveFormat; entries: ArchiveEntry[] } {
  if (buf.length > limits.maxArchiveBytes) throw new ArchiveError("ARCHIVE_TOO_LARGE", `Archive is larger than ${limits.maxArchiveBytes} bytes`);
  const format = detectFormat(buf);
  if (!format) throw new ArchiveError("ARCHIVE_FORMAT", "Not a ZIP or tar.gz archive");
  const entries = format === "zip" ? openZip(buf, limits) : openTarGz(buf, limits);
  checkDuplicates(entries);
  return { format, entries };
}

function checkDuplicates(entries: readonly ArchiveEntry[]): void {
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.path === "") continue;
    const key = e.path.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new ArchiveError("ARCHIVE_DUPLICATE_PATH", "Archive contains the same path twice");
    seen.add(key);
  }
}

// ------------------------------------------------------------------------------------------------ ZIP

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
/** The ratio rule only applies to entries/archives whose decompressed size is above this floor. */
const RATIO_FLOOR_BYTES = 256 * 1024;

function openZip(buf: Buffer, limits: ImportLimits): ArchiveEntry[] {
  // End of central directory: scan backwards over a possible comment (max 65535 bytes).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError("ARCHIVE_MALFORMED", "ZIP end of central directory not found");
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0) throw new ArchiveError("ARCHIVE_UNSUPPORTED", "Multi-disk ZIP archives are not supported");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ArchiveError("ARCHIVE_UNSUPPORTED", "ZIP64 archives are not supported");
  if (total > limits.maxEntries) throw new ArchiveError("ARCHIVE_TOO_MANY_ENTRIES", `Archive declares ${total} entries; the limit is ${limits.maxEntries}`);
  if (cdOffset + cdSize > eocd) throw new ArchiveError("ARCHIVE_MALFORMED", "ZIP central directory is out of bounds");

  const entries: ArchiveEntry[] = [];
  let pos = cdOffset;
  let declaredTotal = 0;
  let compressedTotal = 0;
  for (let n = 0; n < total; n++) {
    if (pos + 46 > cdOffset + cdSize || buf.readUInt32LE(pos) !== CEN_SIG) throw new ArchiveError("ARCHIVE_MALFORMED", "ZIP central directory entry is corrupt");
    const madeBy = buf.readUInt16LE(pos + 4);
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const csize = buf.readUInt32LE(pos + 20);
    const usize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const extAttr = buf.readUInt32LE(pos + 38);
    const localOffset = buf.readUInt32LE(pos + 42);
    const next = pos + 46 + nameLen + extraLen + commentLen;
    if (next > cdOffset + cdSize) throw new ArchiveError("ARCHIVE_MALFORMED", "ZIP central directory entry overruns the directory");
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) throw new ArchiveError("ARCHIVE_UNSUPPORTED", "ZIP64 entries are not supported");
    const rawName = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    pos = next;

    const path = normalizeEntryPath(rawName, limits);
    const unixMode = madeBy >>> 8 === 3 ? (extAttr >>> 16) & 0xf000 : 0;
    const isDir = rawName.endsWith("/") || rawName.endsWith("\\") || unixMode === 0x4000;
    declaredTotal += usize;
    compressedTotal += csize;
    if (declaredTotal > limits.maxTotalBytes) throw new ArchiveError("ARCHIVE_EXPANDS_TOO_MUCH", `Archive would expand beyond ${limits.maxTotalBytes} bytes`);
    if (usize > RATIO_FLOOR_BYTES && usize > Math.max(csize, 1) * limits.maxRatio) throw new ArchiveError("ARCHIVE_EXPANDS_TOO_MUCH", "An entry's compression ratio is beyond the limit");

    const dataStart = (): number => {
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) throw new ArchiveError("ARCHIVE_MALFORMED", "ZIP local header is missing");
      const lName = buf.readUInt16LE(localOffset + 26);
      const lExtra = buf.readUInt16LE(localOffset + 28);
      const lRaw = buf.subarray(localOffset + 30, localOffset + 30 + lName).toString("utf8");
      if (lRaw !== rawName) throw new ArchiveError("ARCHIVE_MALFORMED", "ZIP local and central names disagree");
      const start = localOffset + 30 + lName + lExtra;
      if (start + csize > cdOffset) throw new ArchiveError("ARCHIVE_MALFORMED", "ZIP entry data is out of bounds");
      return start;
    };
    const read = (): Buffer => {
      const start = dataStart();
      const raw = buf.subarray(start, start + csize);
      let out: Buffer;
      if (method === 0) {
        if (csize !== usize) throw new ArchiveError("ARCHIVE_MALFORMED", "ZIP stored entry size mismatch");
        out = Buffer.from(raw);
      } else {
        try {
          out = inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
        } catch (e) {
          const code = (e as { code?: string }).code;
          throw new ArchiveError("ARCHIVE_MALFORMED", code === "ERR_BUFFER_TOO_LARGE" ? "ZIP entry expands beyond its declared size" : "ZIP entry data is corrupt");
        }
      }
      if (out.length !== usize) throw new ArchiveError("ARCHIVE_MALFORMED", "ZIP entry size does not match its header");
      if (crc32(out) !== crc) throw new ArchiveError("ARCHIVE_MALFORMED", "ZIP entry checksum mismatch");
      return out;
    };

    if (isDir) {
      entries.push({ path, kind: "dir", size: 0, skip: null, read: () => Buffer.alloc(0) });
      continue;
    }
    if (unixMode === 0xa000) {
      // Symlink: the data is the target. Read it (bounded) to decide between reject and skip; it is never followed.
      if (usize > 4096 || (method !== 0 && method !== 8) || flags & 1) throw new ArchiveError("ARCHIVE_UNSAFE_LINK", "Symlink entry cannot be validated");
      const target = read().toString("utf8");
      if (!linkTargetStaysInside(path, target)) throw new ArchiveError("ARCHIVE_UNSAFE_LINK", "Symlink points outside the archive root");
      entries.push({ path, kind: "link", size: usize, skip: "symlink", read: () => Buffer.alloc(0) });
      continue;
    }
    if (unixMode !== 0 && unixMode !== 0x8000) {
      entries.push({ path, kind: "special", size: usize, skip: "special", read: () => Buffer.alloc(0) });
      continue;
    }
    const skip: EntrySkip | null = flags & 1 ? "encrypted" : method !== 0 && method !== 8 ? "unsupported_compression" : null;
    entries.push({ path, kind: "file", size: usize, skip, read });
  }
  // Overlapping entries (one compressed stream claimed by many entries) are the classic zip-quine bomb.
  if (compressedTotal > buf.length) throw new ArchiveError("ARCHIVE_MALFORMED", "ZIP entries overlap");
  return entries;
}

// ------------------------------------------------------------------------------------------------ tar.gz

function openTarGz(gz: Buffer, limits: ImportLimits): ArchiveEntry[] {
  const outputCap = Math.min(limits.maxTotalBytes + limits.maxEntries * 1024 + 1024, Math.max(gz.length * limits.maxRatio, RATIO_FLOOR_BYTES));
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: outputCap });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ERR_BUFFER_TOO_LARGE") throw new ArchiveError("ARCHIVE_EXPANDS_TOO_MUCH", "Archive expands beyond the size or compression-ratio limit");
    throw new ArchiveError("ARCHIVE_MALFORMED", "gzip data is corrupt or truncated");
  }
  return parseTar(tar, limits);
}

const octal = (b: Buffer, off: number, len: number): number => {
  if (b[off]! & 0x80) throw new ArchiveError("ARCHIVE_UNSUPPORTED", "Base-256 tar sizes are not supported");
  const s = b.subarray(off, off + len).toString("latin1").replace(/\0.*$/s, "").trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new ArchiveError("ARCHIVE_MALFORMED", "tar header has a bad number");
  return parseInt(s, 8);
};
const cstr = (b: Buffer, off: number, len: number): string => b.subarray(off, off + len).toString("utf8").replace(/\0.*$/s, "");

function parsePax(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(data.subarray(i, sp).toString("latin1"));
    if (!Number.isInteger(len) || len <= sp - i + 1 || i + len > data.length) throw new ArchiveError("ARCHIVE_MALFORMED", "tar pax header is corrupt");
    const rec = data.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out.set(rec.slice(0, eq), rec.slice(eq + 1));
    i += len;
  }
  return out;
}

function parseTar(tar: Buffer, limits: ImportLimits): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let pos = 0;
  let declaredTotal = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax = new Map<string, string>();
  let sawEnd = false;
  while (pos + 512 <= tar.length) {
    const h = tar.subarray(pos, pos + 512);
    if (h.every((x) => x === 0)) {
      sawEnd = true;
      break;
    }
    // Checksum: sum of header bytes with the checksum field treated as spaces.
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== octal(h, 148, 8)) throw new ArchiveError("ARCHIVE_MALFORMED", "tar header checksum mismatch");
    const type = String.fromCharCode(h[156] || 0x30);
    let size = octal(h, 124, 12);
    const paxSize = pax.get("size");
    if (paxSize !== undefined && /^\d+$/.test(paxSize)) size = Number(paxSize);
    const dataStart = pos + 512;
    if (size > tar.length - dataStart) throw new ArchiveError("ARCHIVE_MALFORMED", "tar entry is truncated");
    const body = tar.subarray(dataStart, dataStart + size);
    pos = dataStart + Math.ceil(size / 512) * 512;

    if (type === "L") { longName = cstr(body, 0, body.length); continue; }
    if (type === "K") { longLink = cstr(body, 0, body.length); continue; }
    if (type === "x") { pax = new Map([...pax, ...parsePax(body)]); continue; }
    if (type === "g") continue; // global pax headers carry no per-entry paths we rely on

    const magic = cstr(h, 257, 6);
    const base = cstr(h, 0, 100);
    const prefix = magic.startsWith("ustar") ? cstr(h, 345, 155) : "";
    const rawName = pax.get("path") ?? longName ?? (prefix ? `${prefix}/${base}` : base);
    const linkName = pax.get("linkpath") ?? longLink ?? cstr(h, 157, 100);
    longName = null;
    longLink = null;
    pax = new Map();

    if (entries.length >= limits.maxEntries) throw new ArchiveError("ARCHIVE_TOO_MANY_ENTRIES", `Archive has more than ${limits.maxEntries} entries`);
    const path = normalizeEntryPath(rawName, limits);
    if (type === "5") {
      entries.push({ path, kind: "dir", size: 0, skip: null, read: () => Buffer.alloc(0) });
      continue;
    }
    if (type === "2" || type === "1") {
      // Symlink / hardlink. A hardlink target is relative to the archive root, a symlink target to the link's directory.
      const ok = type === "2" ? linkTargetStaysInside(path, linkName) : linkTargetStaysInside("x", linkName);
      if (!ok) throw new ArchiveError("ARCHIVE_UNSAFE_LINK", "Link points outside the archive root");
      entries.push({ path, kind: "link", size: 0, skip: type === "2" ? "symlink" : "link", read: () => Buffer.alloc(0) });
      continue;
    }
    if (type !== "0" && type !== "7") {
      entries.push({ path, kind: "special", size: 0, skip: "special", read: () => Buffer.alloc(0) });
      continue;
    }
    declaredTotal += size;
    if (declaredTotal > limits.maxTotalBytes) throw new ArchiveError("ARCHIVE_EXPANDS_TOO_MUCH", `Archive would expand beyond ${limits.maxTotalBytes} bytes`);
    entries.push({ path, kind: "file", size, skip: null, read: () => Buffer.from(body) });
  }
  if (!sawEnd && pos < tar.length) throw new ArchiveError("ARCHIVE_MALFORMED", "tar archive is truncated");
  return entries;
}

export const archiveSha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
