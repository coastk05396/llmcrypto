import type { RequestState, UsageFilters, UsageRecord } from "@llmcrypto/contracts";
import type { BadgeTone } from "./tone";
import { dayToInstant } from "./format";

export const REQUEST_STATUS: Record<RequestState, { label: string; tone: BadgeTone; what: string }> = {
  VALIDATED: { label: "Validated", tone: "neutral", what: "Accepted but no credit was reserved yet." },
  RESERVED: { label: "Credit reserved", tone: "pending", what: "Credit is held; the request has not been sent upstream." },
  DISPATCHED: { label: "In flight", tone: "pending", what: "Sent upstream; the answer or its usage is not final." },
  SUCCEEDED: { label: "Succeeded", tone: "info", what: "The provider answered; settlement is not final yet." },
  SETTLED: { label: "Settled", tone: "success", what: "Usage is final and was charged once." },
  USAGE_PENDING: { label: "Awaiting provider usage", tone: "warning", what: "The provider has not reported final usage. The hold stays until it does or the policy window ends." },
  FAILED: { label: "Failed", tone: "danger", what: "The request failed." },
  CANCELLED: { label: "Cancelled", tone: "warning", what: "The client or server ended the request early. Only recorded usage is charged." },
};

export const REQUEST_STATES = Object.keys(REQUEST_STATUS) as RequestState[];

export interface UsageFormValues {
  from: string;
  to: string;
  model: string;
  status: "" | RequestState;
  runId: string;
}
export const EMPTY_FILTERS: UsageFormValues = { from: "", to: "", model: "", status: "", runId: "" };

/** Form text to API filters. Issues name the field; blank fields are omitted. */
export function toFilters(v: UsageFormValues): { filters: UsageFilters; issues: { field: keyof UsageFormValues; message: string }[] } {
  const filters: UsageFilters = {};
  const issues: { field: keyof UsageFormValues; message: string }[] = [];
  if (v.from) {
    const t = dayToInstant(v.from, false);
    if (t) filters.from = t; else issues.push({ field: "from", message: "Enter a valid start date." });
  }
  if (v.to) {
    const t = dayToInstant(v.to, true);
    if (t) filters.to = t; else issues.push({ field: "to", message: "Enter a valid end date." });
  }
  if (filters.from && filters.to && filters.from > filters.to) issues.push({ field: "to", message: "The end date must not be before the start date." });
  if (v.model.trim()) filters.model = v.model.trim();
  if (v.status) filters.status = v.status;
  if (v.runId.trim()) filters.runId = v.runId.trim();
  return { filters, issues };
}

export function toQuery(filters: Record<string, string | number | undefined>, cursor?: string | null, limit = 50): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== "") p.set(k, String(v));
  if (cursor) p.set("cursor", cursor);
  p.set("limit", String(limit));
  return p.toString();
}

/** Input tokens exclude cached tokens (contract), so the total is their sum. */
export const totalInputTokens = (r: Pick<UsageRecord, "inputTokens" | "cachedInputTokens">): bigint => BigInt(r.inputTokens) + BigInt(r.cachedInputTokens);
