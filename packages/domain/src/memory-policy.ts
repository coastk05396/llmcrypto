/** Project memory rules (pure). Roles, retention arithmetic and text normalisation. */
import type { MembershipRole } from "@llmcrypto/contracts";

/** Billing has no business reading or writing project notes; members work on projects. */
const MEMORY_ROLES: readonly MembershipRole[] = ["owner", "admin", "member"];
export const canUseMemory = (role: MembershipRole): boolean => MEMORY_ROLES.includes(role);
/** Project creation and retention/injection settings are account-management actions. */
export const canManageProjects = (role: MembershipRole): boolean => role === "owner" || role === "admin";

/** Absolute expiry for a note last edited at `updatedAt`, or null when retention keeps notes until deleted. */
export function memoryExpiry(updatedAt: Date, retentionDays: number | null): Date | null {
  return retentionDays === null ? null : new Date(updatedAt.getTime() + retentionDays * 86_400_000);
}
export function isMemoryExpired(updatedAt: Date, retentionDays: number | null, now: Date): boolean {
  const e = memoryExpiry(updatedAt, retentionDays);
  return e !== null && e.getTime() <= now.getTime();
}
