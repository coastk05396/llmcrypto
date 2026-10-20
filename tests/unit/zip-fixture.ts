import { crc32 as nodeCrc32, deflateRawSync } from "node:zlib";

export interface ZipEntrySpec {
  name: string;
  data: Uint8Array | string;
  /** 0 = stored, 8 = deflate (default). */
  method?: 0 | 8;
  /** Override the size written to headers, to simulate a lying archive. */
  declaredSize?: number;
  /** Override the CRC written to headers. */
  crc?: number;
  flags?: number;
}

const enc = new TextEncoder();

function le16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function le32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** Minimal ZIP writer for tests; produces archives that unzip tools accept unless a field is overridden. */
export function makeZip(entries: ZipEntrySpec[]): Uint8Array {
  const parts: number[][] = [];
  const central: number[][] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === "string" ? enc.encode(e.data) : e.data;
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw, { level: 9 }) : raw;
    const name = Array.from(enc.encode(e.name));
    const crc = e.crc ?? nodeCrc32(raw);
    const usize = e.declaredSize ?? raw.length;
    const flags = e.flags ?? 0;
    const local = [
      ...le32(0x04034b50), ...le16(20), ...le16(flags), ...le16(method), ...le16(0), ...le16(0x21),
      ...le32(crc), ...le32(body.length), ...le32(usize), ...le16(name.length), ...le16(0), ...name,
    ];
    parts.push(local, Array.from(body));
    central.push([
      ...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(flags), ...le16(method), ...le16(0), ...le16(0x21),
      ...le32(crc), ...le32(body.length), ...le32(usize), ...le16(name.length), ...le16(0), ...le16(0),
      ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...name,
    ]);
    offset += local.length + body.length;
  }
  const cd = central.flat();
  const eocd = [
    ...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(entries.length), ...le16(entries.length),
    ...le32(cd.length), ...le32(offset), ...le16(0),
  ];
  return Uint8Array.from([...parts.flat(), ...cd, ...eocd]);
}
