/**
 * Gateway request pipeline shared by /v1/chat/completions and /v1/messages.
 *
 *   auth -> validate -> price + bound -> reserve (VALIDATED->RESERVED) -> DISPATCHED -> provider
 *        -> settle (SUCCEEDED/FAILED/CANCELLED -> SETTLED) | USAGE_PENDING | release
 *
 * Rules enforced here:
 * - the hold is made before the provider is called; nothing is called when the hold is refused;
 * - exactly one provider call per request: no retry after possible acceptance, no model/route switch;
 * - a failure before dispatch (or a provider that definitively rejected) releases the hold immediately;
 * - a timeout, disconnect or error after dispatch is charged from verified usage when the provider reported it,
 *   otherwise it becomes USAGE_PENDING (never an assumed zero charge) for the worker to reconcile;
 * - a mid-stream failure emits a protocol-compatible SSE error event and closes the stream;
 * - only metadata is persisted, never prompt or completion text.
 */
import type { Hono } from "hono";
import {
  beginRequest, enqueueNotification, failWithoutCharge, getActiveRates, markDispatched, markUsagePending, recordRequestFinish, reservationUpperBound, settleRequest,
  type ReserveRefusal, type TokenUsage,
} from "@llmcrypto/domain";
import { findCatalogModel } from "../catalog/routes";
import type { AppConfig } from "../config";
import { randomId } from "../crypto";
import type { Db } from "../db";
import { GatewayError, RateLimiter, type AppEnv, type Ctx, type GatewayProtocol } from "../http";
import { authenticateApiKey, type KeyRow } from "../keys/service";
import { insertEvidence, insertMemoryUse, planOptimization } from "../optimization/service";
import { ensureSamplePriceVersion } from "./prices";
import { adapterFor, type NormalizedRequest, type ProtocolAdapter, type RenderCtx } from "./protocols";
import { ProviderError, type FinishReason, type Provider, type ProviderRequest, type ProviderStreamEvent } from "./provider";

export interface GatewayDeps {
  db: Db;
  config: AppConfig;
  /** null = no provider configured (the gateway answers 503). */
  provider: Provider | null;
}

export interface Gateway {
  handle(c: Ctx, protocol: GatewayProtocol): Promise<Response>;
  /** Resolves when every request's settlement/finalization work has finished (tests, graceful shutdown). */
  idle(): Promise<void>;
}

/** How long a provider may take to report usage after its call was aborted (timeout or disconnect). */
const ABORT_GRACE_MS = 1000;
const META = /^[A-Za-z0-9_.:-]{1,128}$/;
const encoder = new TextEncoder();

function metaHeader(c: Ctx, name: string): string | null {
  const v = c.req.header(name);
  if (v === undefined) return null;
  if (!META.test(v)) throw new GatewayError(400, "invalid_request", `Header ${name} must be 1-128 characters of [A-Za-z0-9_.:-]`);
  return v;
}

interface Failure {
  status: number;
  code: string;
  message: string;
}

export function createGateway({ db, config, provider }: GatewayDeps): Gateway {
  const gw = config.gateway;
  const limiter = new RateLimiter(gw.rate, config.now);
  const inFlightPerKey = new Map<string, number>();
  const pending = new Set<Promise<unknown>>();
  let pricesReady: Promise<void> | undefined;

  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p);
    const done = (): void => void pending.delete(p);
    p.then(done, done);
    return p;
  };
  const ensurePrices = (): Promise<void> => {
    pricesReady ??= ensureSamplePriceVersion(db, config.now()).catch((e: unknown) => {
      pricesReady = undefined;
      throw e;
    });
    return pricesReady;
  };

  /** Alert outbox row (only written when someone subscribed). Best effort: an alert problem never changes a request's outcome. */
  async function notify(accountId: string, kind: "insufficient_funds" | "key_cap_reached" | "loop_guard", ref: string, dedupeKey: string, at: Date): Promise<void> {
    try {
      await enqueueNotification(db, { id: randomId("nev"), accountId, kind, ref, dedupeKey, at });
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "notification enqueue failed", name: e instanceof Error ? e.name : "unknown" }));
    }
  }

  async function authenticate(c: Ctx): Promise<KeyRow> {
    if (!config.apiKeyPepper) throw new GatewayError(503, "service_unavailable", "Service not configured");
    const authz = c.req.header("Authorization");
    const bearer = authz ? /^Bearer (\S+)$/.exec(authz)?.[1] : undefined;
    const token = bearer ?? c.req.header("x-api-key");
    if (!token) throw new GatewayError(401, "invalid_api_key", "Missing API key");
    const r = await authenticateApiKey(db, config, token);
    // Unknown, revoked and expired keys are indistinguishable to the caller.
    if (!r.ok) throw new GatewayError(401, "invalid_api_key", "Invalid API key");
    if (!r.key.scopes.includes("gateway:invoke")) throw new GatewayError(403, "insufficient_scope", "Key lacks the gateway:invoke scope");
    return r.key;
  }

  async function readJson(c: Ctx): Promise<unknown> {
    const declared = Number(c.req.header("Content-Length") ?? "0");
    if (declared > gw.maxRequestBytes) throw new GatewayError(413, "request_too_large", "Request body is too large");
    const text = await c.req.text();
    if (encoder.encode(text).length > gw.maxRequestBytes) throw new GatewayError(413, "request_too_large", "Request body is too large");
    try {
      return JSON.parse(text);
    } catch {
      throw new GatewayError(400, "invalid_json", "Request body is not valid JSON");
    }
  }

  const refusal = (r: ReserveRefusal): GatewayError =>
    r === "INSUFFICIENT_FUNDS"
      ? new GatewayError(402, "insufficient_funds", "Insufficient available credit for this request's maximum cost")
      : r === "KEY_CAP_EXCEEDED"
        ? new GatewayError(402, "key_spend_cap_exceeded", "This API key's spend cap would be exceeded")
        : r === "PROJECT_CAP_EXCEEDED"
          ? new GatewayError(402, "project_spend_cap_exceeded", "The project's spend cap would be exceeded")
          : new GatewayError(401, "invalid_api_key", "Invalid API key");

  /** Resolves the settlement of a request whose provider call ended abnormally. Returns what the caller should report. */
  async function finishFailed(requestId: string, err: unknown, cause: "none" | "timeout" | "client"): Promise<Failure> {
    const at = config.now();
    await recordRequestFinish(db, requestId, null, at);
    const deadline = new Date(at.getTime() + gw.usagePendingSeconds * 1000);
    const pe = err instanceof ProviderError ? err : null;
    const settle = (usage: TokenUsage, outcome: "failed" | "cancelled", code: string): Promise<unknown> =>
      settleRequest(db, { requestId, usage, outcome, failureCode: code, at, newId: randomId });
    if (pe?.kind === "rejected") {
      await failWithoutCharge(db, requestId, { code: "PROVIDER_REJECTED", at });
      return { status: 502, code: "upstream_error", message: "The provider rejected the request; nothing was charged" };
    }
    if (cause === "client") {
      if (pe?.usage) await settle(pe.usage, "cancelled", "CLIENT_DISCONNECT");
      else await markUsagePending(db, requestId, { code: "CLIENT_DISCONNECT", deadline, at });
      return { status: 499, code: "client_closed_request", message: "Client disconnected" };
    }
    if (cause === "timeout") {
      if (pe?.usage) await settle(pe.usage, "failed", "PROVIDER_TIMEOUT");
      else await markUsagePending(db, requestId, { code: "PROVIDER_TIMEOUT", deadline, at });
      return { status: 504, code: "upstream_timeout", message: "The provider timed out; any usage will be reconciled" };
    }
    if (pe?.usage) await settle(pe.usage, "failed", "UPSTREAM_ERROR");
    else await markUsagePending(db, requestId, { code: "UPSTREAM_ERROR", deadline, at });
    return { status: 502, code: "upstream_error", message: "The provider failed; any usage will be reconciled" };
  }

  /** Success path: charge from verified usage, or hold pending. */
  async function finishSucceeded(requestId: string, usage: TokenUsage | null, reason: FinishReason | null): Promise<void> {
    const at = config.now();
    await recordRequestFinish(db, requestId, reason, at);
    if (usage) {
      await settleRequest(db, { requestId, usage, outcome: "succeeded", at, newId: randomId });
    } else {
      await markUsagePending(db, requestId, { code: "USAGE_MISSING", deadline: new Date(at.getTime() + gw.usagePendingSeconds * 1000), at });
    }
  }

  async function handle(c: Ctx, protocol: GatewayProtocol): Promise<Response> {
    const adapter: ProtocolAdapter = adapterFor(protocol);
    if (!provider) throw new GatewayError(503, "service_unavailable", "No provider is configured");
    const key = await authenticate(c);

    const wait = limiter.take(key.id);
    if (wait > 0) throw new GatewayError(429, "rate_limit_exceeded", "Too many requests", null, { "Retry-After": String(wait) });
    const open = inFlightPerKey.get(key.id) ?? 0;
    if (open >= gw.maxConcurrentPerKey) throw new GatewayError(429, "concurrency_limit_exceeded", "Too many concurrent requests for this key", null, { "Retry-After": "1" });
    inFlightPerKey.set(key.id, open + 1);
    let slotHeld = true;
    const releaseSlot = (): void => {
      if (!slotHeld) return;
      slotHeld = false;
      const n = (inFlightPerKey.get(key.id) ?? 1) - 1;
      if (n <= 0) inFlightPerKey.delete(key.id);
      else inFlightPerKey.set(key.id, n);
    };

    try {
      const norm: NormalizedRequest = adapter.parse(await readJson(c));
      const correlationId = metaHeader(c, "X-Correlation-Id");
      const runId = metaHeader(c, "X-Run-Id");
      const parentId = metaHeader(c, "X-Parent-Id");
      const requestedProject = metaHeader(c, "X-Project-Id");

      const model = findCatalogModel(norm.model);
      if (!model) throw new GatewayError(404, "model_not_found", `The model "${norm.model}" does not exist`, "model");
      if (!model.protocols.includes(protocol)) {
        throw new GatewayError(400, "model_protocol_unsupported", `The model "${norm.model}" is not offered on this endpoint; no translation is performed`, "model");
      }
      if (key.model_allowlist.length > 0 && !key.model_allowlist.includes(norm.model)) {
        throw new GatewayError(403, "model_not_allowed", `This API key may not use "${norm.model}"`, "model");
      }

      let projectId = key.project_id;
      if (requestedProject !== null) {
        if (key.project_id !== null && key.project_id !== requestedProject) throw new GatewayError(403, "project_not_permitted", "This API key is scoped to a different project");
        const [p] = await db.query("select 1 as x from projects where id=$1 and account_id=$2", [requestedProject, key.account_id]);
        if (!p) throw new GatewayError(403, "project_not_permitted", "Project not accessible to this API key");
        projectId = requestedProject;
      }

      // Optimization policy (all controls off unless the account opted in): may prepend the account's own guidance and
      // saved project notes, and an enforced LoopGuard may stop a repeated request before anything is reserved.
      const plan = await planOptimization(db, {
        accountId: key.account_id, projectId, model: norm.model, messages: norm.messages, optOut: c.req.header("X-Optimize")?.toLowerCase() === "off",
        loopScope: runId ?? key.id, digestSecret: config.apiKeyPepper ?? "", now: config.now(),
      });
      if (plan.blocked) {
        const at = config.now();
        await insertEvidence(db, randomId, key.account_id, c.get("requestId"), plan.policyVersion, [plan.blocked], at);
        await notify(key.account_id, "loop_guard", c.get("requestId"), `loop_guard:${runId ?? key.id}:${Math.floor(at.getTime() / 3_600_000)}`, at);
        throw new GatewayError(429, "loop_guard_blocked", "LoopGuard enforcement blocked a repeated identical request; nothing was charged", null, { "Retry-After": String(Math.max(1, Number(plan.blocked.detail["windowSeconds"] ?? 60))) });
      }
      if (plan.advisory) await notify(key.account_id, "loop_guard", c.get("requestId"), `loop_guard:${runId ?? key.id}:${Math.floor(config.now().getTime() / 3_600_000)}`, config.now());
      const messages = plan.messages.map((m) => ({ role: m.role, text: m.text }));

      const maxOut = norm.maxOutputTokens ?? gw.defaultMaxOutputTokens;
      if (maxOut > gw.maxOutputTokensCeiling) {
        throw new GatewayError(400, "max_tokens_too_large", `Output cap ${maxOut} exceeds the gateway ceiling of ${gw.maxOutputTokensCeiling}`, "max_tokens");
      }
      const inputBound = provider.inputTokenUpperBound(norm.model, [...messages.map((m) => m.text), ...(norm.extraInputTexts ?? [])]);
      if (inputBound === null) throw new GatewayError(422, "estimation_unavailable", "Cost cannot be bounded safely for this model", "model");
      if (inputBound + BigInt(maxOut) > BigInt(model.contextWindowTokens)) {
        throw new GatewayError(400, "context_length_exceeded", "Input plus output cap may exceed the model context window", "messages");
      }

      try {
        await ensurePrices();
      } catch (e) {
        // e.g. the stored price version differs from the code's: a deployment problem, not a per-request one. See ensureSamplePriceVersion.
        console.error(JSON.stringify({ level: "error", requestId: c.get("requestId"), msg: "price version unavailable", name: e instanceof Error ? e.name : "unknown" }));
        throw new GatewayError(503, "pricing_unavailable", "Pricing is unavailable");
      }
      const now = config.now();
      const rates = await getActiveRates(db, norm.model, now);
      if (!rates) throw new GatewayError(503, "pricing_unavailable", "No price is effective for this model");
      const reserved = reservationUpperBound(inputBound, BigInt(maxOut), rates);

      const requestId = c.get("requestId");
      const begin = await beginRequest(db, {
        id: requestId, accountId: key.account_id, keyId: key.id, projectId, runId, parentId, correlationId, protocol, model: norm.model,
        stream: norm.stream, rates, reservedMicrousd: reserved, at: now, newId: randomId, policyVersion: plan.policyVersion,
        afterReserve: async (q) => {
          // Evidence is written with the hold, so a refused or failed reservation leaves none.
          await insertEvidence(q, randomId, key.account_id, requestId, plan.policyVersion, plan.evidence, now);
          if (projectId) await insertMemoryUse(q, randomId, key.account_id, projectId, requestId, plan.memory, now);
        },
      });
      if (!begin.ok) {
        if (begin.reason === "INSUFFICIENT_FUNDS" || begin.reason === "KEY_CAP_EXCEEDED" || begin.reason === "PROJECT_CAP_EXCEEDED") {
          await notify(key.account_id, begin.reason === "INSUFFICIENT_FUNDS" ? "insufficient_funds" : "key_cap_reached", requestId, `${begin.reason}:${key.id}:${Math.floor(now.getTime() / 3_600_000)}`, now);
        }
        throw refusal(begin.reason);
      }

      const providerRequestId = `prov_${requestId}`;
      try {
        await markDispatched(db, requestId, providerRequestId, config.now());
      } catch (e) {
        // Nothing reached the provider: release the hold now (the worker sweep is only the backstop) and report a plain 500.
        await failWithoutCharge(db, requestId, { code: "DISPATCH_FAILED", at: config.now() }).catch((inner: unknown) =>
          console.error(JSON.stringify({ level: "error", requestId, msg: "hold release after failed dispatch also failed", name: inner instanceof Error ? inner.name : "unknown" })),
        );
        console.error(JSON.stringify({ level: "error", requestId, msg: "markDispatched failed", name: e instanceof Error ? e.name : "unknown" }));
        throw new GatewayError(500, "internal_error", "The request could not be dispatched; nothing was charged");
      }

      const preq: ProviderRequest = {
        providerRequestId, model: norm.model, messages, maxOutputTokens: maxOut,
        temperature: norm.temperature, topP: norm.topP, stop: norm.stop, tools: norm.tools, toolChoice: norm.toolChoice,
      };
      const ctl = new AbortController();
      let cause: "none" | "timeout" | "client" = "none";
      const abort = (why: "timeout" | "client"): void => {
        if (cause === "none") cause = why;
        ctl.abort();
      };
      // After an abort the provider gets a short grace period to report the usage it incurred; a provider that
      // ignores the signal cannot hold the request past that.
      const abortable = <T>(p: Promise<T>): Promise<T> => {
        p.catch(() => undefined);
        return Promise.race([
          p,
          new Promise<never>((_, reject) => {
            const giveUp = (): void => void setTimeout(() => reject(new ProviderError("aborted", "aborted")), ABORT_GRACE_MS).unref();
            if (ctl.signal.aborted) giveUp();
            else ctl.signal.addEventListener("abort", giveUp, { once: true });
          }),
        ]);
      };
      const timer = setTimeout(() => abort("timeout"), gw.providerTimeoutMs);
      const onClientAbort = (): void => abort("client");
      c.req.raw.signal.addEventListener("abort", onClientAbort, { once: true });
      const cleanup = (): void => {
        clearTimeout(timer);
        c.req.raw.signal.removeEventListener("abort", onClientAbort);
        releaseSlot();
      };
      const render: RenderCtx = {
        id: protocol === "anthropic_messages" ? `msg_${requestId}` : protocol === "openai_responses" ? `resp_${requestId}` : `chatcmpl-${requestId}`,
        model: norm.model,
        created: Math.floor(now.getTime() / 1000),
        echo: norm.echo,
        state: { seq: 0, nextIndex: 0, open: null, done: [] },
      };

      // Transparency headers: which policy governed the request, and an advisory LoopGuard trigger.
      const extra: Record<string, string> = {};
      if (plan.policyVersion > 0) extra["X-Optimization-Policy"] = String(plan.policyVersion);
      if (plan.advisory) extra["X-LoopGuard"] = `advisory; count=${String(plan.advisory.detail["count"])}; threshold=${String(plan.advisory.detail["threshold"])}`;
      for (const [k, v] of Object.entries(extra)) c.header(k, v);

      if (!norm.stream) {
        const work = (async (): Promise<Response> => {
          try {
            const done = await abortable(provider.complete(preq, ctl.signal));
            await finishSucceeded(requestId, done.usage, done.finishReason);
            // The charge is settled by now. A failure while rendering must not be reported as a provider failure (502): the
            // request succeeded and was billed once, so say exactly that.
            try {
              return c.json(adapter.body(render, done.text, done.finishReason, done.usage, done.toolCalls) as object);
            } catch (renderErr) {
              console.error(JSON.stringify({ level: "error", requestId, msg: "response render failed after settlement", name: renderErr instanceof Error ? renderErr.name : "unknown" }));
              throw new GatewayError(500, "internal_error", "The response could not be rendered; the request completed and was charged once", null, { "X-Request-Id": requestId });
            }
          } catch (e) {
            if (e instanceof GatewayError) throw e;
            const f = await finishFailed(requestId, e, cause);
            throw new GatewayError(f.status, f.code, f.message);
          } finally {
            cleanup();
          }
        })();
        return await track(work);
      }

      // Streaming: pull the first provider event before committing to SSE, so a failure before any output
      // is still an ordinary error response rather than a broken stream.
      const it = provider.stream(preq, ctl.signal)[Symbol.asyncIterator]();
      let first: IteratorResult<ProviderStreamEvent, void>;
      try {
        first = await abortable(it.next());
      } catch (e) {
        try {
          const f = await finishFailed(requestId, e, cause);
          throw new GatewayError(f.status, f.code, f.message);
        } finally {
          cleanup();
        }
      }

      let clientGone = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (frames: string[]): void => {
            if (clientGone) return;
            try {
              for (const f of frames) controller.enqueue(encoder.encode(f));
            } catch {
              clientGone = true;
            }
          };
          const close = (): void => {
            if (clientGone) return;
            clientGone = true;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          };
          track(
            (async () => {
              let usage: TokenUsage | null = null;
              let finish: FinishReason | null = null;
              try {
                send(adapter.streamStart(render, null));
                let ev = first;
                while (!ev.done) {
                  const v = ev.value;
                  if (v.type === "delta") send(adapter.streamDelta(render, v.text));
                  else if (v.type === "tool_call") send(adapter.streamToolCall?.(render, v.call) ?? []);
                  else if (v.type === "finish") finish = v.finishReason;
                  else usage = v.usage;
                  ev = await abortable(it.next());
                }
                // A stream cut by timeout/disconnect that the provider ended quietly is not a clean success.
                if (cause !== "none") throw new ProviderError("aborted", "aborted", usage);
                // Charge before the terminal frames so the usage chunk reflects what was billed.
                await finishSucceeded(requestId, usage, finish);
                send(adapter.streamEnd(render, finish ?? "stop", usage, norm.includeUsage));
              } catch (e) {
                try {
                  const f = await finishFailed(requestId, e, cause);
                  send(adapter.streamError(f.status, f.code, f.message, render));
                } catch (inner) {
                  console.error(JSON.stringify({ level: "error", requestId, msg: "stream finalization failed", name: inner instanceof Error ? inner.name : "unknown" }));
                  send(adapter.streamError(500, "internal_error", "Unexpected server error", render));
                }
              } finally {
                cleanup();
                close();
              }
            })(),
          );
        },
        cancel() {
          clientGone = true;
          abort("client");
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Request-Id": requestId, ...extra },
      });
    } catch (e) {
      releaseSlot();
      throw e;
    }
  }

  return {
    handle,
    idle: async () => {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}

export function gatewayRoutes(app: Hono<AppEnv>, gateway: Gateway): void {
  app.post("/v1/chat/completions", (c) => gateway.handle(c, "openai_chat"));
  app.post("/v1/messages", (c) => gateway.handle(c, "anthropic_messages"));
  app.post("/v1/responses", (c) => gateway.handle(c, "openai_responses"));
  // Gemini generateContent is NOT built. Answer loudly instead of a bare 404 so clients and the catalog mismatch are visible.
  app.post("/v1beta/models/:target{.+}", () => {
    throw new GatewayError(501, "protocol_not_implemented", "Gemini generateContent is not implemented by this gateway");
  });
}
