import { UsageDetail } from "@llmcrypto/contracts";
import { call, type ApiResult } from "./api";

/** Direct, authorized lookup includes the request's frozen rates and ledger evidence. */
export async function findRequest(requestId: string, signal: AbortSignal): Promise<ApiResult<{ record: UsageDetail | null }>> {
  const result = await call("GET", `/api/usage/${encodeURIComponent(requestId)}`, UsageDetail, { signal });
  if (result.ok) return { ok: true, data: { record: result.data } };
  if (result.error.kind === "http" && result.error.status === 404) return { ok: true, data: { record: null } };
  return result;
}
