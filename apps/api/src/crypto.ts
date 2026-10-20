import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const randomId = (prefix: string): string => `${prefix}_${randomBytes(12).toString("hex")}`;
export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");
export const hmacHex = (secret: string, s: string): string => createHmac("sha256", secret).update(s).digest("hex");

/** Deterministic JSON (sorted object keys) for payload hashing. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

const replayKey = (secret: string): Buffer => Buffer.from(hkdfSync("sha256", secret, "llmcrypto", "key-replay-v1", 32));

/** AES-256-GCM; aad binds the ciphertext to its idempotency record and session. Output: v1.iv.tag.ct (base64url). */
export function sealSecret(secret: string, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", replayKey(secret), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

/** Returns null when the blob is malformed, tampered with, or bound to different aad. */
export function openSecret(secret: string, sealed: string, aad: string): string | null {
  try {
    const [v, iv, tag, ct] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || !ct) return null;
    const d = createDecipheriv("aes-256-gcm", replayKey(secret), Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
