import { MICROS_PER_USD, parseMicrousd } from "@llmcrypto/domain";

/** Pure display/parse helpers for the credits and usage pages. Amounts are bigint-backed decimal strings; no floats. */

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** "-1500000" -> "-1.50", "2000000" -> "+2.00" when `plus`. Same 2..6 decimal rule as formatUsdDisplay. */
export function formatSignedUsd(micros: string, plus = true): string {
  const v = BigInt(micros);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / MICROS_PER_USD;
  let frac = (abs % MICROS_PER_USD).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : plus ? "+" : ""}${group(whole.toString())}.${frac}`;
}

/** Whole-number token or request counts (decimal strings) with thousands separators. */
export function formatCount(n: string): string {
  return group(parseMicrousd(n).toString());
}

/** Atomic chain units to a decimal token amount: ("1500000", 6) -> "1.5". Trailing zeros trimmed, never rounded. */
export function formatAtomic(atomic: string, decimals: number): string {
  const s = BigInt(atomic).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return `${group(whole)}${frac ? `.${frac}` : ""}`;
}

/** "1.5", 6 -> "1500000". Null for empty, negative, non-numeric, zero, or more fractional digits than the asset supports. */
export function decimalToAtomic(text: string, decimals: number): string | null {
  const m = /^(\d{1,30})(?:\.(\d{1,36}))?$/.exec(text.trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  const v = BigInt(`${m[1]}${frac.padEnd(decimals, "0")}`);
  return v === 0n ? null : v.toString();
}

/** yyyy-mm-dd to an RFC 3339 UTC instant; `end` = the last millisecond of that day. Null when not a real date. */
export function dayToInstant(day: string, end: boolean): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T${end ? "23:59:59.999" : "00:00:00.000"}Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return null;
  return d.toISOString();
}

/** Stable absolute UTC rendering used for audit-style tables: 2026-10-18 12:30:05 UTC. */
export function formatUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}
