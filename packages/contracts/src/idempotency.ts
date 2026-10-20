import { z } from "zod";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/** Operations where Idempotency-Key is mandatory (400 IDEMPOTENCY_KEY_REQUIRED if absent). */
export const IDEMPOTENT_OPERATIONS = ["createKey", "createDeposit", "createExport", "createRepositoryImport", "createDesign", "createDesignRevision", "proposeAdjustment", "ledgerMutation"] as const;
export type IdempotentOperation = (typeof IDEMPOTENT_OPERATIONS)[number];

export const IdempotencyKey = z
  .string()
  .min(8)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, "printable ASCII without spaces");

/** Window during which a secret-bearing response may be replayed to the same session. Proposed default. */
export const SECRET_REPLAY_WINDOW_SECONDS = 300;

export type IdempotencyRecord =
  | { state: "in_flight"; payloadHash: string }
  | { state: "completed"; payloadHash: string; result: unknown };

export type IdempotencyDecision =
  | { action: "execute" }
  | { action: "replay"; result: unknown }
  | { action: "reject"; code: "IDEMPOTENCY_CONFLICT" | "IN_PROGRESS" };

/** Persisted key is (account, operation, key). Same payload+completed replays; changed payload 409; in-flight 409. */
export function decideIdempotency(existing: IdempotencyRecord | undefined, payloadHash: string): IdempotencyDecision {
  if (!existing) return { action: "execute" };
  if (existing.payloadHash !== payloadHash) return { action: "reject", code: "IDEMPOTENCY_CONFLICT" };
  if (existing.state === "in_flight") return { action: "reject", code: "IN_PROGRESS" };
  return { action: "replay", result: existing.result };
}
