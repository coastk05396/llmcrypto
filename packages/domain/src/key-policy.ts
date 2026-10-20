import type { KeyScope, MembershipRole } from "@llmcrypto/contracts";

/** Pure API-key policy. No I/O, no secrets, no floats: money is bigint-parsed micro-USD. */

export const KEY_SECRET_PREFIX = "sk_";
/** Characters of the secret shown as the non-secret prefix (includes "sk_"). */
export const KEY_DISPLAY_PREFIX_LENGTH = 8;
/** A "recent sign-in" for privileged mutations. */
export const STEP_UP_WINDOW_SECONDS = 900;

const KEY_MANAGER_ROLES: readonly MembershipRole[] = ["owner", "admin"];

/** Key management (create/list/revoke): owner/admin. Explicit delegation is not implemented yet. */
export function canManageKeys(role: MembershipRole): boolean {
  return KEY_MANAGER_ROLES.includes(role);
}

export function keyDisplayPrefix(secret: string): string {
  return secret.slice(0, KEY_DISPLAY_PREFIX_LENGTH);
}

export interface FieldIssue {
  field: string;
  message: string;
}

export interface KeyRequestInput {
  scopes: readonly KeyScope[];
  modelAllowlist: readonly string[];
  spendCapMicrousd?: string | undefined;
  expiresAt?: string | undefined;
}

/** Semantic checks beyond shape validation. knownModelIds comes from the catalog. */
export function validateKeyRequest(input: KeyRequestInput, knownModelIds: ReadonlySet<string>, now: Date): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (new Set(input.scopes).size !== input.scopes.length) issues.push({ field: "scopes", message: "scopes must not repeat" });
  if (new Set(input.modelAllowlist).size !== input.modelAllowlist.length) {
    issues.push({ field: "modelAllowlist", message: "modelAllowlist must not repeat" });
  }
  input.modelAllowlist.forEach((m, i) => {
    if (!knownModelIds.has(m)) issues.push({ field: `modelAllowlist[${i}]`, message: `unknown model "${m}"` });
  });
  if (input.spendCapMicrousd !== undefined && BigInt(input.spendCapMicrousd) <= 0n) {
    issues.push({ field: "spendCapMicrousd", message: "must be greater than zero" });
  }
  if (input.expiresAt !== undefined && Date.parse(input.expiresAt) <= now.getTime()) {
    issues.push({ field: "expiresAt", message: "must be in the future" });
  }
  return issues;
}

/** Empty allowlist means every model. */
export function isModelAllowed(allowlist: readonly string[], model: string): boolean {
  return allowlist.length === 0 || allowlist.includes(model);
}

export type KeyUnusableReason = "revoked" | "expired";

export function keyUnusableReason(key: { revokedAt: Date | null; expiresAt: Date | null }, now: Date): KeyUnusableReason | null {
  if (key.revokedAt) return "revoked";
  if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) return "expired";
  return null;
}

/** True when charging `addMicrousd` on top of `spentMicrousd` would exceed the cap (null cap = unlimited). */
export function wouldExceedSpendCap(capMicrousd: string | null, spentMicrousd: string, addMicrousd: string): boolean {
  if (capMicrousd === null) return false;
  return BigInt(spentMicrousd) + BigInt(addMicrousd) > BigInt(capMicrousd);
}

export function isRecentSignIn(authenticatedAt: Date, now: Date): boolean {
  return now.getTime() - authenticatedAt.getTime() <= STEP_UP_WINDOW_SECONDS * 1000;
}
