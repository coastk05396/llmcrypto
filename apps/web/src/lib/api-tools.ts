import {
  Adjustment, AdjustmentList, Design, DesignList, DesignRevisionAccepted, FeatureFlags, LedgerMismatchList,
  OperatorSession, PaymentAlert, PaymentAlertList, PaymentReviewList, ReconciliationSummary,
  RepositoryEdgeList, RepositoryExport, RepositoryFileList, RepositoryGraph, RepositoryImport,
  RepositoryImportAccepted, RepositoryImportList, StuckReservationList,
  type CreateDesignRequest, type CreateDesignRevisionRequest, type ProposeAdjustmentRequest,
} from "@llmcrypto/contracts";
import { call, callNoContent, type ApiResult } from "./api";
import { AuditEventList } from "@llmcrypto/contracts";
const enc = encodeURIComponent;
export const getFeatures = (signal?: AbortSignal) => call("GET", "/api/features", FeatureFlags, { signal });
export const repositoryPath = (project: string, id?: string) => `/api/projects/${enc(project)}/repository-imports${id ? `/${enc(id)}` : ""}`;
export const listImports = (project: string, cursor: string | null, signal: AbortSignal) => call("GET", `${repositoryPath(project)}?${pageQuery(cursor)}`, RepositoryImportList, { signal });
export const getImport = (project: string, id: string, signal: AbortSignal) => call("GET", repositoryPath(project, id), RepositoryImport, { signal });
export const uploadImport = (project: string, file: File, key: string) => call("POST", `${repositoryPath(project)}?name=${enc(file.name.slice(0, 100))}`, RepositoryImportAccepted, { rawBody: file, headers: { "Content-Type": file.name.toLowerCase().endsWith(".zip") ? "application/zip" : "application/gzip", "Idempotency-Key": key }, status: 202 });
export const deleteImport = (project: string, id: string) => callNoContent("DELETE", repositoryPath(project, id));
export const getGraph = (project: string, id: string, depth: number, signal: AbortSignal) => call("GET", `${repositoryPath(project, id)}/graph?depth=${depth}`, RepositoryGraph, { signal });
export const listRepositoryFiles = (project: string, id: string, cursor: string | null, signal: AbortSignal) => call("GET", `${repositoryPath(project, id)}/files?${pageQuery(cursor)}`, RepositoryFileList, { signal });
export const listRepositoryEdges = (project: string, id: string, cursor: string | null, signal: AbortSignal) => call("GET", `${repositoryPath(project, id)}/edges?${pageQuery(cursor)}`, RepositoryEdgeList, { signal });
export const exportRepository = (project: string, id: string) => call("GET", `${repositoryPath(project, id)}/export`, RepositoryExport);
export function pageQuery(cursor: string | null) { const q = new URLSearchParams({ limit: "50" }); if (cursor) q.set("cursor", cursor); return q.toString(); }
export const listDesigns = (project: string, cursor: string | null, signal: AbortSignal) => call("GET", `/api/projects/${enc(project)}/designs?${pageQuery(cursor)}`, DesignList, { signal });
export const createDesign = (project: string, body: ReturnType<typeof CreateDesignRequest.parse>, key: string) => call("POST", `/api/projects/${enc(project)}/designs`, DesignRevisionAccepted, { body, headers: { "Idempotency-Key": key }, status: 202 });
export const getDesign = (id: string, signal: AbortSignal) => call("GET", `/api/designs/${enc(id)}`, Design, { signal });
export const reviseDesign = (id: string, body: ReturnType<typeof CreateDesignRevisionRequest.parse>, key: string) => call("POST", `/api/designs/${enc(id)}/revisions`, DesignRevisionAccepted, { body, headers: { "Idempotency-Key": key }, status: 202 });
export const deleteDesign = (id: string) => callNoContent("DELETE", `/api/designs/${enc(id)}`);
export const getOperatorSession = (signal?: AbortSignal) => call("GET", "/api/operator/session", OperatorSession, { signal });
export const elevateOperator = () => call("POST", "/api/operator/session", OperatorSession);
export const endElevation = () => callNoContent("DELETE", "/api/operator/session");
export const getReconciliation = (signal: AbortSignal) => call("GET", "/api/operator/reconciliation", ReconciliationSummary, { signal });
export const getStuck = (signal: AbortSignal) => call("GET", "/api/operator/stuck-reservations", StuckReservationList, { signal });
export const getMismatches = (signal: AbortSignal) => call("GET", "/api/operator/ledger-mismatches", LedgerMismatchList, { signal });
export const listReviews = (cursor: string | null, signal: AbortSignal) => call("GET", `/api/operator/payment-reviews?${pageQuery(cursor)}`, PaymentReviewList, { signal });
export const listAlerts = (cursor: string | null, signal: AbortSignal) => call("GET", `/api/operator/payment-alerts?${pageQuery(cursor)}`, PaymentAlertList, { signal });
export const listAdjustments = (cursor: string | null, signal: AbortSignal) => call("GET", `/api/operator/adjustments?${pageQuery(cursor)}`, AdjustmentList, { signal });
export const proposeAdjustment = (body: ReturnType<typeof ProposeAdjustmentRequest.parse>, key: string) => call("POST", "/api/operator/adjustments", Adjustment, { body, headers: { "Idempotency-Key": key }, status: 201 });
export const decideAdjustment = (id: string, decision: "approve" | "reject", reason: string) => call("POST", `/api/operator/adjustments/${enc(id)}/${decision}`, Adjustment, { body: { reason } });
export const resolveAlert = (id: string, note: string) => call("POST", `/api/operator/payment-alerts/${enc(id)}/resolve`, PaymentAlert, { body: { note } });

/** The markdown export as plain text. It is only ever rendered as a text node, never as HTML. */
export async function fetchDesignMarkdown(id: string, revision: number): Promise<ApiResult<string>> {
  try {
    const res = await fetch(`/api/designs/${enc(id)}/export?format=markdown&revision=${revision}`, { credentials: "include", headers: { Accept: "text/markdown" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, error: { kind: "http", status: res.status, code: null, requestId: null, fieldErrors: [], retryAfterSeconds: null } };
    return { ok: true, data: await res.text() };
  } catch {
    return { ok: false, error: { kind: "network" } };
  }
}
export const listAudit = (source: "all" | "operator", cursor: string | null, signal: AbortSignal) =>
  call("GET", `/api/audit?source=${source}&${pageQuery(cursor)}`, AuditEventList, { signal });
