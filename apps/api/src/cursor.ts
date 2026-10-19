import { ApiError } from "./http";

/** Opaque (createdAt, id) keyset cursor shared by list endpoints. */
export const encodeCursor = (t: Date, id: string): string => Buffer.from(JSON.stringify([t.toISOString(), id])).toString("base64url");

export function decodeCursor(s: string): [Date, string] {
  try {
    const [t, id] = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as [string, string];
    const d = new Date(t);
    // Bounds matter: a NUL in the id or an out-of-range date would otherwise reach PostgreSQL and surface as a 500.
    if (typeof id !== "string" || id.length > 256 || id.includes("\0") || Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1970 || d.getUTCFullYear() > 9999) throw new Error("bad");
    return [d, id];
  } catch {
    throw new ApiError("BAD_REQUEST", "Invalid cursor");
  }
}
