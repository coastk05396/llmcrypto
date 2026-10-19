import {
  AgentRunPage, Balance, CatalogResponse, CreateKeyResponse, Deposit, DepositList, ErrorEnvelope, ExportAccepted, IDEMPOTENCY_HEADER, IdentityList, Job,
  KeyList, LedgerPage, LinkedIdentity, PaymentNetworkList, SessionView, UsagePage, WalletChallenge,
  type CreateDepositRequest, type CreateExportRequest, type CreateKeyRequest, type FieldError, type WalletChallengeRequest, type WalletSessionRequest,
} from "@llmcrypto/contracts";

/** Structural subset of a zod schema; keeps zod out of the web package's direct dependencies. */
interface Parser<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
}

/** Why a console API call produced no usable data. `invalid` covers non-JSON, wrong content type or schema mismatch. */
export type ApiFailure =
  | { kind: "network" }
  | { kind: "invalid" }
  | { kind: "http"; status: number; code: string | null; requestId: string | null; fieldErrors: FieldError[]; retryAfterSeconds: number | null };

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

const TIMEOUT_MS = 8000;

async function request(path: string, init: RequestInit, signal?: AbortSignal): Promise<
  { ok: true; res: Response } | { ok: false; error: ApiFailure }
> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      credentials: "include",
      ...init,
      headers: { Accept: "application/json", ...init.headers },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return { ok: true, res };
  } catch {
    return { ok: false, error: { kind: "network" } };
  }
}

async function readJson(res: Response): Promise<unknown> {
  if (!(res.headers.get("content-type") ?? "").includes("json")) return undefined;
  try {
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
}

async function httpFailure(res: Response): Promise<ApiFailure> {
  const body = ErrorEnvelope.safeParse(await readJson(res));
  const ra = Number(res.headers.get("retry-after"));
  const retryAfterSeconds = Number.isFinite(ra) && ra > 0 ? ra : null;
  return body.success
    ? { kind: "http", status: res.status, code: body.data.error.code, requestId: body.data.error.requestId, fieldErrors: body.data.error.fieldErrors ?? [], retryAfterSeconds }
    : { kind: "http", status: res.status, code: null, requestId: null, fieldErrors: [], retryAfterSeconds };
}

export async function getCatalog(signal?: AbortSignal): Promise<ApiResult<CatalogResponse>> {
  const r = await request("/api/catalog", { method: "GET" }, signal);
  if (!r.ok) return r;
  if (!r.res.ok) return { ok: false, error: await httpFailure(r.res) };
  const parsed = CatalogResponse.safeParse(await readJson(r.res));
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: { kind: "invalid" } };
}

/** `data: null` means the API answered and there is no signed-in session (401 UNAUTHENTICATED). */
export async function getSession(signal?: AbortSignal): Promise<ApiResult<SessionView | null>> {
  const r = await request("/api/session", { method: "GET" }, signal);
  if (!r.ok) return r;
  if (r.res.status === 401) {
    const body = ErrorEnvelope.safeParse(await readJson(r.res));
    return body.success ? { ok: true, data: null } : { ok: false, error: { kind: "invalid" } };
  }
  if (!r.res.ok) return { ok: false, error: await httpFailure(r.res) };
  const parsed = SessionView.safeParse(await readJson(r.res));
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: { kind: "invalid" } };
}

/** DELETE /api/session returns 204. State-changing calls rely on the server's origin/CSRF checks. */
export async function deleteSession(): Promise<ApiResult<null>> {
  const r = await request("/api/session", { method: "DELETE" });
  if (!r.ok) return r;
  if (r.res.status === 204) return { ok: true, data: null };
  return { ok: false, error: r.res.ok ? { kind: "invalid" } : await httpFailure(r.res) };
}

interface CallOptions {
  rawBody?: Blob;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
  /** Expected success status; others that are `ok` are treated as invalid. Default: any 2xx with a JSON body. */
  status?: number;
}

/** Sends JSON, validates a 2xx JSON body with `schema`; failures never throw. */
export async function call<T>(method: string, path: string, schema: Parser<T>, o: CallOptions = {}): Promise<ApiResult<T>> {
  const init: RequestInit = { method };
  const headers: Record<string, string> = { ...o.headers };
  if (o.body !== undefined) {
    init.body = JSON.stringify(o.body);
    headers["Content-Type"] = "application/json";
  }
  if (o.rawBody !== undefined) init.body = o.rawBody;
  init.headers = headers;
  const r = await request(path, init, o.signal);
  if (!r.ok) return r;
  if (!r.res.ok) return { ok: false, error: await httpFailure(r.res) };
  if (o.status !== undefined && r.res.status !== o.status) return { ok: false, error: { kind: "invalid" } };
  const parsed = schema.safeParse(await readJson(r.res));
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: { kind: "invalid" } };
}

export async function callNoContent(method: string, path: string, signal?: AbortSignal, body?: unknown): Promise<ApiResult<null>> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const r = await request(path, init, signal);
  if (!r.ok) return r;
  if (r.res.status === 204) return { ok: true, data: null };
  return { ok: false, error: r.res.ok ? { kind: "invalid" } : await httpFailure(r.res) };
}

export const requestWalletChallenge = (body: WalletChallengeRequest, signal?: AbortSignal) =>
  call("POST", "/api/auth/wallet/challenges", WalletChallenge, { body, signal, status: 201 });
export const createWalletSession = (body: WalletSessionRequest, signal?: AbortSignal) =>
  call("POST", "/api/auth/wallet/sessions", SessionView, { body, signal, status: 200 });
export const linkWalletIdentity = (body: WalletSessionRequest, signal?: AbortSignal) =>
  call("POST", "/api/identities", LinkedIdentity, { body, signal, status: 201 });
export const listIdentities = (signal?: AbortSignal) => call("GET", "/api/identities", IdentityList, { signal });
export const unlinkIdentity = (id: string) => callNoContent("DELETE", `/api/identities/${encodeURIComponent(id)}`);
export const getBalance = (signal?: AbortSignal) => call("GET", "/api/accounts/current/balance", Balance, { signal });
export const listKeys = (signal?: AbortSignal) => call("GET", "/api/keys?limit=200", KeyList, { signal });
export const revokeKey = (id: string) => callNoContent("DELETE", `/api/keys/${encodeURIComponent(id)}`);
/** The Idempotency-Key header is mandatory; the caller owns key lifetime (same key only for a retry of the same payload). */
export const createKey = (body: CreateKeyRequest, idempotencyKey: string, signal?: AbortSignal) =>
  call("POST", "/api/keys", CreateKeyResponse, { body, signal, status: 201, headers: { [IDEMPOTENCY_HEADER]: idempotencyKey } });


const idem = (key: string) => ({ [IDEMPOTENCY_HEADER]: key });
/** `query` is a ready URLSearchParams string (see usage-view.toQuery). */
export const listUsage = (query: string, signal?: AbortSignal) => call("GET", `/api/usage?${query}`, UsagePage, { signal });
export const listAgentRuns = (query: string, signal?: AbortSignal) => call("GET", `/api/usage/agent-runs?${query}`, AgentRunPage, { signal });
export const listLedger = (query: string, signal?: AbortSignal) => call("GET", `/api/ledger?${query}`, LedgerPage, { signal });
/** 503 means no payment networks are configured (or no address source); the page treats it as the empty state. */
export const getPaymentNetworks = (signal?: AbortSignal) => call("GET", "/api/deposits/networks", PaymentNetworkList, { signal });
export const listDeposits = (query: string, signal?: AbortSignal) => call("GET", `/api/deposits?${query}`, DepositList, { signal });
export const getDeposit = (id: string, signal?: AbortSignal) => call("GET", `/api/deposits/${encodeURIComponent(id)}`, Deposit, { signal });
/** Idempotency-Key is mandatory; reuse it only for a retry of the identical request. */
export const createDeposit = (body: CreateDepositRequest, key: string, signal?: AbortSignal) =>
  call("POST", "/api/deposits", Deposit, { body, signal, headers: idem(key) });
export const createExport = (body: CreateExportRequest, key: string, signal?: AbortSignal) =>
  call("POST", "/api/exports", ExportAccepted, { body, signal, status: 202, headers: idem(key) });
export const getJob = (id: string, signal?: AbortSignal) => call("GET", `/api/jobs/${encodeURIComponent(id)}`, Job, { signal });

export function describeFailure(f: ApiFailure): string {
  switch (f.kind) {
    case "network":
      return "The API could not be reached.";
    case "invalid":
      return "The API answered with something this page does not understand.";
    case "http":
      return `The API returned HTTP ${f.status}${f.code ? ` (${f.code})` : ""}.`;
  }
}
