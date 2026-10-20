import type { ApiKey, CreateKeyRequest, KeyScope } from "@llmcrypto/contracts";
import { MICROS_PER_USD, parseMicrousd } from "@llmcrypto/domain";
import type { ApiFailure } from "./api";

/** Pure form/display logic for the keys page. Money is bigint micro-USD; never floats. */

export const SCOPE_LABELS: Record<KeyScope, string> = {
  "gateway:invoke": "Send gateway requests",
  "usage:read": "Read usage",
};

export interface KeyFormValues {
  name: string;
  scopes: KeyScope[];
  /** Empty means every model. */
  models: string[];
  /** USD text such as "50" or "12.5"; empty means no cap. */
  spendCapUsd: string;
  /** yyyy-mm-dd or empty; interpreted as the end of that day in UTC. */
  expiresOn: string;
}

export interface FormIssue {
  field: "name" | "scopes" | "spendCapUsd" | "expiresOn";
  message: string;
}

/** "12.5" -> "12500000". Rejects empty, negative, more than 6 decimals, or zero. */
export function usdToMicrousd(text: string): string | null {
  const t = text.trim();
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(t);
  if (!m) return null;
  const micros = BigInt(m[1]!) * MICROS_PER_USD + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  return micros === 0n ? null : micros.toString();
}

/** Two decimals minimum, up to six when needed: 1500000 -> "1.50", 1234567 -> "1.234567". */
export function formatUsdDisplay(micros: string): string {
  const v = parseMicrousd(micros);
  const whole = v / MICROS_PER_USD;
  let frac = (v % MICROS_PER_USD).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

export function validateKeyForm(v: KeyFormValues, now: Date): { issues: FormIssue[]; request: CreateKeyRequest | null } {
  const issues: FormIssue[] = [];
  const name = v.name.trim();
  if (!name) issues.push({ field: "name", message: "Enter a name for this key." });
  else if (name.length > 100) issues.push({ field: "name", message: "Use 100 characters or fewer." });
  if (v.scopes.length === 0) issues.push({ field: "scopes", message: "Choose at least one permission." });
  let cap: string | undefined;
  if (v.spendCapUsd.trim() !== "") {
    const c = usdToMicrousd(v.spendCapUsd);
    if (c === null) issues.push({ field: "spendCapUsd", message: "Enter an amount above zero in USD with up to six decimals, or leave it empty for no cap." });
    else cap = c;
  }
  let expiresAt: string | undefined;
  if (v.expiresOn !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.expiresOn) || Number.isNaN(Date.parse(`${v.expiresOn}T00:00:00Z`))) {
      issues.push({ field: "expiresOn", message: "Enter a valid date." });
    } else if (Date.parse(`${v.expiresOn}T23:59:59Z`) <= now.getTime()) {
      issues.push({ field: "expiresOn", message: "Choose a date in the future." });
    } else expiresAt = `${v.expiresOn}T23:59:59Z`;
  }
  if (issues.length) return { issues, request: null };
  const request: CreateKeyRequest = { name, scopes: v.scopes, modelAllowlist: v.models };
  if (cap !== undefined) request.spendCapMicrousd = cap;
  if (expiresAt !== undefined) request.expiresAt = expiresAt;
  return { issues, request };
}

/**
 * One Idempotency-Key per logical attempt. Re-submitting the identical payload (for example after a timeout)
 * reuses the key so the server can replay instead of minting a second key; a changed payload gets a new key.
 */
export class AttemptKeys {
  private current: { payload: string; key: string } | null = null;
  constructor(private readonly mint: () => string = () => crypto.randomUUID()) {}
  keyFor(request: unknown): string {
    const payload = JSON.stringify(request);
    if (!this.current || this.current.payload !== payload) this.current = { payload, key: this.mint() };
    return this.current.key;
  }
  reset(): void {
    this.current = null;
  }
}

export type KeyStatus = "active" | "revoked" | "expired";
export function keyStatus(k: Pick<ApiKey, "revokedAt" | "expiresAt">, now: Date): KeyStatus {
  if (k.revokedAt) return "revoked";
  if (k.expiresAt && Date.parse(k.expiresAt) <= now.getTime()) return "expired";
  return "active";
}

export function activeKeyCount(keys: readonly ApiKey[], now: Date): number {
  return keys.filter((k) => keyStatus(k, now) === "active").length;
}

export type KeyErrorView = { kind: "step_up" } | { kind: "form"; message: string; fields: { field: string; message: string }[] } | { kind: "retry"; message: string } | { kind: "unauthenticated" };

export function describeCreateFailure(f: ApiFailure): KeyErrorView {
  if (f.kind === "network") return { kind: "retry", message: "The API could not be reached. Your form is kept; retry when you are back online." };
  if (f.kind === "invalid") return { kind: "retry", message: "The API answered with something unexpected. Retry; if it persists, contact support." };
  switch (f.code) {
    case "UNAUTHENTICATED": return { kind: "unauthenticated" };
    case "STEP_UP_REQUIRED": return { kind: "step_up" };
    case "FORBIDDEN": return { kind: "form", message: "Your role cannot manage API keys. Ask an owner or admin.", fields: [] };
    case "VALIDATION_FAILED": return { kind: "form", message: "Some values were not accepted.", fields: f.fieldErrors };
    case "IN_PROGRESS": return { kind: "retry", message: "This key is still being created. Wait a moment and retry; no second key will be made." };
    case "IDEMPOTENCY_CONFLICT": return { kind: "retry", message: "This attempt conflicts with an earlier one. Change nothing and retry, or close and reopen the form." };
    case "RATE_LIMITED": return { kind: "retry", message: f.retryAfterSeconds ? `Too many requests. Retry in ${f.retryAfterSeconds} seconds.` : "Too many requests. Retry shortly." };
    default: return { kind: "retry", message: f.status >= 500 ? "The service had a problem creating the key. Retry shortly." : "The key could not be created." };
  }
}
