/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers parse untyped JSON */
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { resolveLimits, type ImportLimits } from "@llmcrypto/domain";
import { createApp } from "../../apps/api/src/app";
import { randomId } from "../../apps/api/src/crypto";
import { createGateway } from "../../apps/api/src/gateway/dispatch";
import { FakeProvider } from "../../apps/api/src/gateway/fake-provider";
import { ensureSamplePriceVersion } from "../../apps/api/src/gateway/prices";
import { findCatalogModel } from "../../apps/api/src/catalog/routes";
import type { AppConfig } from "../../apps/api/src/config";
import { runDesignGenerations } from "../../apps/worker/src/design-generation";
import { runRepositoryImports } from "../../apps/worker/src/repository-import";
import { ORIGIN, call, makeHarness, type Harness, type Res } from "./helpers";
import { idemKey } from "./metering-helpers";

export interface BetaHarness extends Harness {
  fake: FakeProvider;
}

/** Harness with both beta areas switched ON, the FakeProvider, and optional config tweaks. */
export async function makeBetaHarness(tweak: (c: AppConfig) => AppConfig = (c) => c, env: Record<string, string | undefined> = {}): Promise<BetaHarness> {
  const h = await makeHarness({}, { GATEWAY_PROVIDER: "fake", FEATURE_REPOSITORY_GRAPH: "true", FEATURE_DESIGN_BETA: "true", ...env });
  const config = tweak(h.config);
  const fake = new FakeProvider();
  const gateway = createGateway({ db: h.db, config, provider: fake });
  return { ...h, config, fake, app: createApp({ db: h.db, config, gateway }), appWith: (o) => createApp({ db: h.db, config: { ...config, ...o }, gateway }) };
}

export const withLimits = (l: Partial<ImportLimits>) => (c: AppConfig): AppConfig => ({ ...c, repository: { ...c.repository, limits: resolveLimits({ ...c.repository.limits, ...l }) } });

export const runImports = (h: Harness) => runRepositoryImports({ db: h.db, now: () => h.config.now(), newId: randomId });

export function runDesigns(h: BetaHarness, over: Partial<Parameters<typeof runDesignGenerations>[0]> = {}) {
  return runDesignGenerations({
    db: h.db, provider: h.fake, now: () => h.config.now(), newId: randomId, ensurePrices: () => ensureSamplePriceVersion(h.db, h.config.now()),
    contextWindowOf: (m) => { const x = findCatalogModel(m); return x ? Number(x.contextWindowTokens) : null; },
    maxOutputTokens: h.config.design.maxOutputTokens, timeoutMs: 2000, usagePendingSeconds: h.config.gateway.usagePendingSeconds, ...over,
  });
}

/** Raw-body upload (the archive is the request body). */
export async function upload(h: Harness, cookie: string, projectId: string, body: Buffer | Uint8Array, o: { key?: string | null; name?: string; contentType?: string; origin?: string | null } = {}): Promise<Res<any>> {
  const headers: Record<string, string> = { "Content-Type": o.contentType ?? "application/octet-stream", Cookie: cookie };
  if (o.origin !== null) headers["Origin"] = o.origin ?? ORIGIN;
  if (o.key !== null) headers["Idempotency-Key"] = o.key ?? idemKey();
  const res = await h.app.request(`/api/projects/${projectId}/repository-imports${o.name ? `?name=${encodeURIComponent(o.name)}` : ""}`, { method: "POST", headers, body: body as BodyInit });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, headers: res.headers, setCookie: [] };
}

export const get = (h: Harness, cookie: string, path: string) => call<any>(h.app, "GET", path, { cookie });
export async function newProject(h: Harness, cookie: string, name = `proj-${randomId("n")}`): Promise<string> {
  const r = await call<any>(h.app, "POST", "/api/projects", { cookie, body: { name } });
  if (r.status !== 201) throw new Error(`project failed ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.id;
}

// ------------------------------------------------------------------------------------------------ archive writers

export interface ZipEntry {
  name: string;
  data?: Buffer | string;
  /** 0 = stored, 8 = deflate (default). */
  method?: 0 | 8;
  /** Unix mode in the external attributes (default 0o100644; 0o120777 = symlink, 0o040755 = directory). */
  mode?: number;
  /** Override header fields to make them lie. */
  lie?: { usize?: number; csize?: number; crc?: number };
  flags?: number;
  /** Override the name written in the LOCAL header only. */
  localName?: string;
  /** Raw compressed bytes to use instead of compressing `data`. */
  rawCompressed?: Buffer;
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    const method = e.method ?? 8;
    const comp = e.rawCompressed ?? (method === 8 ? deflateRawSync(data) : data);
    const crc = e.lie?.crc ?? crc32(data);
    const csize = e.lie?.csize ?? comp.length;
    const usize = e.lie?.usize ?? data.length;
    const name = Buffer.from(e.name, "utf8");
    const lname = Buffer.from(e.localName ?? e.name, "utf8");
    const flags = 0x0800 | (e.flags ?? 0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(lname.length, 26); lh.writeUInt16LE(0, 28);
    const local = Buffer.concat([lh, lname, comp]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE((((e.mode ?? 0o100644) << 16) >>> 0), 38); ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export interface TarEntry {
  name: string;
  data?: Buffer | string;
  /** '0' file, '5' dir, '2' symlink, '1' hardlink, '3' char device. */
  type?: string;
  link?: string;
  /** Emit the name through a pax extended header instead of the 100-byte field. */
  pax?: boolean;
  /** Emit the name through a GNU long-name record. */
  gnuLong?: boolean;
}

function tarHeader(name: string, size: number, type: string, link = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.fill(0x20, 148, 156);
  h.write(type, 156);
  h.write(link.slice(0, 100), 157, "utf8");
  h.write("ustar\0", 257); h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}
const padTo512 = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

export function buildTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    const type = e.type ?? "0";
    if (e.pax) {
      const rec = `path=${e.name}\n`;
      let len = rec.length + 3;
      while (`${len} ${rec}`.length !== len) len = `${len} ${rec}`.length;
      const body = Buffer.from(`${len} ${rec}`);
      parts.push(tarHeader("PaxHeader", body.length, "x"), padTo512(body));
    }
    if (e.gnuLong) {
      const body = Buffer.from(`${e.name}\0`);
      parts.push(tarHeader("././@LongLink", body.length, "L"), padTo512(body));
    }
    parts.push(tarHeader(e.pax || e.gnuLong ? "placeholder" : e.name, type === "0" ? data.length : 0, type, e.link));
    if (type === "0") parts.push(padTo512(data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
export const buildTarGz = (entries: TarEntry[]): Buffer => gzipSync(buildTar(entries));
