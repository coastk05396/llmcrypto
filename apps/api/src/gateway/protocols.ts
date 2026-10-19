/**
 * Wire adapters for the two supported compatible protocols. Each one validates a request into a
 * normalized shape and renders non-streaming bodies and SSE frames. Anything outside the supported
 * subset fails with 400 `unsupported_parameter` instead of being ignored or translated.
 */
import { z } from "zod";
import type { TokenUsage } from "@llmcrypto/domain";
import { GatewayError, gatewayErrorPayload, type GatewayProtocol } from "../http";
import { responsesAdapter } from "./responses";
import type { FinishReason, ProviderMessage, ProviderTool, ProviderToolCall, ProviderToolChoice } from "./provider";

export interface NormalizedRequest {
  model: string;
  messages: ProviderMessage[];
  /** null = the caller omitted it; the gateway applies its bounded default. */
  maxOutputTokens: number | null;
  stream: boolean;
  temperature?: number | undefined;
  topP?: number | undefined;
  stop?: string[] | undefined;
  includeUsage: boolean;
  tools?: ProviderTool[] | undefined;
  toolChoice?: ProviderToolChoice | undefined;
  /** Extra text counted in the input-token upper bound (tool definitions are sent to the model). */
  extraInputTexts?: string[] | undefined;
  /** Request fields echoed in the response body (Responses API). */
  echo?: Record<string, unknown> | undefined;
}

/** Per-request streaming state, owned by the adapter that renders the stream. */
export interface StreamState {
  seq: number;
  nextIndex: number;
  open: { index: number; id: string; text: string } | null;
  done: unknown[];
}

export interface RenderCtx {
  id: string;
  model: string;
  created: number;
  echo?: Record<string, unknown> | undefined;
  state: StreamState;
}

export interface ProtocolAdapter {
  protocol: GatewayProtocol;
  parse(raw: unknown): NormalizedRequest;
  body(ctx: RenderCtx, text: string, finish: FinishReason, usage: TokenUsage | null, toolCalls?: ProviderToolCall[]): unknown;
  /** Frames sent before the first provider event. */
  streamStart(ctx: RenderCtx, usageHint: TokenUsage | null): string[];
  streamDelta(ctx: RenderCtx, text: string): string[];
  /** Only adapters that accept `tools` implement this. */
  streamToolCall?(ctx: RenderCtx, call: ProviderToolCall): string[];
  /** Frames for a clean end; `usage` null = unknown (never invented). */
  streamEnd(ctx: RenderCtx, finish: FinishReason, usage: TokenUsage | null, includeUsage: boolean): string[];
  /** Protocol-compatible error event; the caller closes the stream afterwards. */
  streamError(status: number, code: string, message: string, ctx?: RenderCtx): string[];
}

export const unsupported = (name: string): GatewayError =>
  new GatewayError(400, "unsupported_parameter", `Parameter "${name}" is not supported by this gateway`, name);

export function checkKeys(raw: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new GatewayError(400, "invalid_request", "Request body must be a JSON object");
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw unsupported(k);
  return raw as Record<string, unknown>;
}

export function zodFail(e: z.ZodError): GatewayError {
  const i = e.issues[0];
  const param = i && i.path.length ? i.path.join(".") : null;
  return new GatewayError(400, "invalid_request", `${param ?? "request"}: ${i?.message ?? "invalid"}`, param);
}

export const sse = (data: unknown, event?: string): string => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
const textOf = (c: string | { text: string }[]): string => (typeof c === "string" ? c : c.map((p) => p.text).join(""));
const stopList = (s: string | string[] | undefined): string[] | undefined => (s === undefined ? undefined : typeof s === "string" ? [s] : s);

// ------------------------------------------------------------------ OpenAI chat completions

const OPENAI_KEYS = new Set(["model", "messages", "stream", "stream_options", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "n", "user"]);
const OpenAiBody = z.object({
  model: z.string().min(1).max(200),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "developer", "user", "assistant"]),
        content: z.union([z.string(), z.array(z.object({ type: z.literal("text"), text: z.string() }).strict())]),
      }).strict(),
    )
    .min(1)
    .max(1000),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().gt(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  n: z.number().int().optional(),
  user: z.string().max(256).optional(),
});

const openAiUsage = (u: TokenUsage): unknown => ({
  prompt_tokens: Number(u.inputTokens + u.cachedInputTokens),
  completion_tokens: Number(u.outputTokens),
  total_tokens: Number(u.inputTokens + u.cachedInputTokens + u.outputTokens),
  prompt_tokens_details: { cached_tokens: Number(u.cachedInputTokens) },
});

const chunk = (ctx: RenderCtx, delta: unknown, finish: string | null, usage?: unknown): string =>
  sse({ id: ctx.id, object: "chat.completion.chunk", created: ctx.created, model: ctx.model, choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) });

export const openAiAdapter: ProtocolAdapter = {
  protocol: "openai_chat",
  parse(raw) {
    const o = checkKeys(raw, OPENAI_KEYS);
    const r = OpenAiBody.safeParse(o);
    if (!r.success) throw zodFail(r.error);
    const b = r.data;
    if (b.n !== undefined && b.n !== 1) throw new GatewayError(400, "unsupported_value", 'Only n=1 is supported', "n");
    if (b.max_tokens !== undefined && b.max_completion_tokens !== undefined && b.max_tokens !== b.max_completion_tokens) {
      throw new GatewayError(400, "invalid_request", "max_tokens and max_completion_tokens disagree", "max_tokens");
    }
    return {
      model: b.model,
      messages: b.messages.map((m) => ({ role: m.role === "developer" ? "system" : m.role, text: textOf(m.content) })),
      maxOutputTokens: b.max_completion_tokens ?? b.max_tokens ?? null,
      stream: b.stream === true,
      temperature: b.temperature,
      topP: b.top_p,
      stop: stopList(b.stop),
      includeUsage: b.stream_options?.include_usage === true,
    };
  },
  body(ctx, text, finish, usage) {
    return {
      id: ctx.id, object: "chat.completion", created: ctx.created, model: ctx.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finish }],
      ...(usage ? { usage: openAiUsage(usage) } : {}),
    };
  },
  streamStart: (ctx) => [chunk(ctx, { role: "assistant", content: "" }, null)],
  streamDelta: (ctx, text) => [chunk(ctx, { content: text }, null)],
  streamEnd(ctx, finish, usage, includeUsage) {
    const frames = [chunk(ctx, {}, finish)];
    if (includeUsage && usage) frames.push(chunk(ctx, {}, null, openAiUsage(usage)));
    frames.push("data: [DONE]\n\n");
    return frames;
  },
  streamError: (status, code, message) => [sse(gatewayErrorPayload("openai_chat", status, code, message, null))],
};

// ------------------------------------------------------------------ Anthropic messages

const ANTHROPIC_KEYS = new Set(["model", "messages", "system", "max_tokens", "stream", "temperature", "top_p", "stop_sequences", "metadata"]);
const AnthText = z.union([z.string(), z.array(z.object({ type: z.literal("text"), text: z.string() }).strict())]);
const AnthropicBody = z.object({
  model: z.string().min(1).max(200),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: AnthText }).strict()).min(1).max(1000),
  system: AnthText.optional(),
  max_tokens: z.number().int().positive(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().gt(0).max(1).optional(),
  stop_sequences: z.array(z.string()).max(4).optional(),
  metadata: z.object({ user_id: z.string().max(256).optional() }).strict().optional(),
});
const stopReason = (f: FinishReason): string => (f === "length" ? "max_tokens" : "end_turn");
const anthUsage = (u: TokenUsage | null, inputOnly = false): unknown => ({
  input_tokens: Number(u?.inputTokens ?? 0n),
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: Number(u?.cachedInputTokens ?? 0n),
  output_tokens: inputOnly ? 0 : Number(u?.outputTokens ?? 0n),
});

export const anthropicAdapter: ProtocolAdapter = {
  protocol: "anthropic_messages",
  parse(raw) {
    const o = checkKeys(raw, ANTHROPIC_KEYS);
    const r = AnthropicBody.safeParse(o);
    if (!r.success) throw zodFail(r.error);
    const b = r.data;
    if (b.messages[0]?.role !== "user") throw new GatewayError(400, "invalid_request", "The first message must have role user", "messages.0.role");
    const messages: ProviderMessage[] = [];
    if (b.system !== undefined) messages.push({ role: "system", text: textOf(b.system) });
    for (const m of b.messages) messages.push({ role: m.role, text: textOf(m.content) });
    return { model: b.model, messages, maxOutputTokens: b.max_tokens, stream: b.stream === true, temperature: b.temperature, topP: b.top_p, stop: b.stop_sequences, includeUsage: true };
  },
  body(ctx, text, finish, usage) {
    return {
      id: ctx.id, type: "message", role: "assistant", model: ctx.model,
      content: [{ type: "text", text }], stop_reason: stopReason(finish), stop_sequence: null,
      usage: anthUsage(usage),
    };
  },
  streamStart: (ctx, usage) => [
    sse({ type: "message_start", message: { id: ctx.id, type: "message", role: "assistant", model: ctx.model, content: [], stop_reason: null, stop_sequence: null, usage: anthUsage(usage, true) } }, "message_start"),
    sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start"),
  ],
  streamDelta: (_ctx, text) => [sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, "content_block_delta")],
  streamEnd(_ctx, finish, usage) {
    return [
      sse({ type: "content_block_stop", index: 0 }, "content_block_stop"),
      sse({ type: "message_delta", delta: { stop_reason: stopReason(finish), stop_sequence: null }, usage: { input_tokens: Number(usage?.inputTokens ?? 0n), cache_read_input_tokens: Number(usage?.cachedInputTokens ?? 0n), output_tokens: Number(usage?.outputTokens ?? 0n) } }, "message_delta"),
      sse({ type: "message_stop" }, "message_stop"),
    ];
  },
  streamError: (status, code, message) => [sse(gatewayErrorPayload("anthropic_messages", status, code, message, null), "error")],
};

export const adapterFor = (p: GatewayProtocol): ProtocolAdapter => (p === "anthropic_messages" ? anthropicAdapter : p === "openai_responses" ? responsesAdapter : openAiAdapter);
