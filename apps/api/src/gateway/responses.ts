/**
 * OpenAI Responses API adapter (POST /v1/responses).
 *
 * Supported: `model`, `input` (string, or message / function_call / function_call_output items with text content),
 * `instructions`, `max_output_tokens`, `stream`, `temperature`, `top_p`, `user`, function `tools`, `tool_choice`
 * (auto | none | required | {type:"function", name}), `parallel_tool_calls` (echoed; at most one call is produced per
 * response by the only provider that exists), and `store` only as false. Tool definitions and calls are passed through
 * untouched. Everything else (previous_response_id, reasoning, text.format, include, background, conversation,
 * built-in tools, image/file inputs, ...) fails with 400 `unsupported_parameter` / `unsupported_value` naming the field.
 * Responses are never stored, so there is no GET /v1/responses/{id}.
 */
import { z } from "zod";
import type { TokenUsage } from "@llmcrypto/domain";
import { GatewayError, gatewayErrorPayload } from "../http";
import type { FinishReason, ProviderMessage, ProviderTool, ProviderToolCall, ProviderToolChoice } from "./provider";
import { checkKeys, sse, zodFail, type NormalizedRequest, type ProtocolAdapter, type RenderCtx } from "./protocols";

const KEYS = new Set(["model", "input", "instructions", "max_output_tokens", "stream", "temperature", "top_p", "user", "tools", "tool_choice", "parallel_tool_calls", "store"]);

const badValue = (param: string, msg: string): GatewayError => new GatewayError(400, "unsupported_value", msg, param);

const Tool = z.object({
  type: z.literal("function"),
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  description: z.string().max(4096).optional(),
  parameters: z.record(z.string(), z.unknown()).nullable().optional(),
  strict: z.boolean().nullable().optional(),
}).strict();

const Body = z.object({
  model: z.string().min(1).max(200),
  input: z.union([z.string(), z.array(z.record(z.string(), z.unknown())).min(1).max(1000)]),
  instructions: z.string().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().gt(0).max(1).optional(),
  user: z.string().max(256).optional(),
  tools: z.array(z.record(z.string(), z.unknown())).max(128).optional(),
  tool_choice: z.union([z.enum(["auto", "none", "required"]), z.record(z.string(), z.unknown())]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  store: z.boolean().optional(),
});

function contentText(content: unknown, at: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new GatewayError(400, "invalid_request", `${at}: content must be a string or an array of text parts`, at);
  return content
    .map((p, j) => {
      const part = p as { type?: unknown; text?: unknown };
      if ((part.type !== "input_text" && part.type !== "output_text") || typeof part.text !== "string") {
        throw badValue(`${at}.${j}.type`, `Content part type "${String(part.type)}" is not supported; only input_text and output_text`);
      }
      return part.text;
    })
    .join("");
}

function parseInput(input: string | Record<string, unknown>[]): ProviderMessage[] {
  if (typeof input === "string") return [{ role: "user", text: input }];
  return input.map((item, i): ProviderMessage => {
    const at = `input.${i}`;
    const type = item["type"] ?? (item["role"] !== undefined ? "message" : undefined);
    if (type === "message") {
      const role = item["role"];
      if (role !== "user" && role !== "assistant" && role !== "system" && role !== "developer") throw badValue(`${at}.role`, `Role "${String(role)}" is not supported`);
      return { role: role === "developer" ? "system" : role, text: contentText(item["content"], `${at}.content`) };
    }
    if (type === "function_call") {
      if (typeof item["call_id"] !== "string" || typeof item["name"] !== "string" || typeof item["arguments"] !== "string") {
        throw new GatewayError(400, "invalid_request", `${at}: function_call needs string call_id, name and arguments`, at);
      }
      return { role: "assistant", text: JSON.stringify({ call_id: item["call_id"], name: item["name"], arguments: item["arguments"] }) };
    }
    if (type === "function_call_output") {
      if (typeof item["call_id"] !== "string" || typeof item["output"] !== "string") {
        throw new GatewayError(400, "invalid_request", `${at}: function_call_output needs string call_id and output`, at);
      }
      return { role: "tool", text: item["output"] };
    }
    throw badValue(`${at}.type`, `Input item type "${String(type)}" is not supported`);
  });
}

function parseTools(raw: Record<string, unknown>[] | undefined): ProviderTool[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((t, i) => {
    if (t["type"] !== "function") throw badValue(`tools.${i}.type`, `Tool type "${String(t["type"])}" is not supported; only function tools are passed through`);
    const r = Tool.safeParse(t);
    if (!r.success) throw zodFail(r.error);
    return { name: r.data.name, description: r.data.description, ...(r.data.parameters ? { parameters: r.data.parameters } : {}) };
  });
}

function parseChoice(raw: z.infer<typeof Body>["tool_choice"], tools: ProviderTool[] | undefined): ProviderToolChoice | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return raw;
  if (raw["type"] !== "function" || typeof raw["name"] !== "string") throw badValue("tool_choice", 'Only "auto", "none", "required" or {"type":"function","name":...} are supported');
  const name = raw["name"];
  if (!tools?.some((t) => t.name === name)) throw new GatewayError(400, "invalid_request", `tool_choice names "${name}", which is not in tools`, "tool_choice");
  return { name };
}

// ------------------------------------------------------------------ rendering

const usageOf = (u: TokenUsage | null): unknown =>
  u
    ? {
        input_tokens: Number(u.inputTokens + u.cachedInputTokens),
        input_tokens_details: { cached_tokens: Number(u.cachedInputTokens) },
        output_tokens: Number(u.outputTokens),
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: Number(u.inputTokens + u.cachedInputTokens + u.outputTokens),
      }
    : null;

const messageItem = (id: string, text: string, status: "in_progress" | "completed"): unknown => ({
  id, type: "message", status, role: "assistant",
  content: status === "completed" ? [{ type: "output_text", text, annotations: [] }] : [],
});
const callItem = (ctx: RenderCtx, n: number, c: ProviderToolCall, status: "in_progress" | "completed"): unknown => ({
  id: `fc_${ctx.id}_${n}`, type: "function_call", status, call_id: c.id, name: c.name, arguments: status === "completed" ? c.arguments : "",
});

function responseObject(ctx: RenderCtx, status: "in_progress" | "completed" | "incomplete", output: unknown[], usage: TokenUsage | null): unknown {
  return {
    id: ctx.id, object: "response", created_at: ctx.created, status, error: null,
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    model: ctx.model, output, store: false, parallel_tool_calls: true, tool_choice: "auto", tools: [], metadata: {},
    ...(ctx.echo ?? {}),
    usage: status === "in_progress" ? null : usageOf(usage),
  };
}
const finalStatus = (f: FinishReason): "completed" | "incomplete" => (f === "length" ? "incomplete" : "completed");

/** Emits one typed, sequence-numbered event. */
function ev(ctx: RenderCtx, type: string, data: Record<string, unknown>): string {
  return sse({ type, sequence_number: ctx.state.seq++, ...data }, type);
}

function closeText(ctx: RenderCtx): string[] {
  const o = ctx.state.open;
  if (!o) return [];
  ctx.state.open = null;
  const part = { type: "output_text", text: o.text, annotations: [] };
  ctx.state.done.push(messageItem(o.id, o.text, "completed"));
  return [
    ev(ctx, "response.output_text.done", { item_id: o.id, output_index: o.index, content_index: 0, text: o.text }),
    ev(ctx, "response.content_part.done", { item_id: o.id, output_index: o.index, content_index: 0, part }),
    ev(ctx, "response.output_item.done", { output_index: o.index, item: messageItem(o.id, o.text, "completed") }),
  ];
}

export const responsesAdapter: ProtocolAdapter = {
  protocol: "openai_responses",
  parse(raw): NormalizedRequest {
    const o = checkKeys(raw, KEYS);
    const r = Body.safeParse(o);
    if (!r.success) throw zodFail(r.error);
    const b = r.data;
    if (b.store === true) throw badValue("store", "store=true is not supported: responses are not stored; send store=false or omit it");
    const tools = parseTools(b.tools);
    const toolChoice = parseChoice(b.tool_choice, tools);
    if (toolChoice !== undefined && toolChoice !== "none" && !tools) throw new GatewayError(400, "invalid_request", "tool_choice requires tools", "tool_choice");
    const messages: ProviderMessage[] = [];
    if (b.instructions !== undefined) messages.push({ role: "system", text: b.instructions });
    messages.push(...parseInput(b.input));
    return {
      model: b.model,
      messages,
      maxOutputTokens: b.max_output_tokens ?? null,
      stream: b.stream === true,
      temperature: b.temperature,
      topP: b.top_p,
      includeUsage: true,
      tools,
      toolChoice,
      extraInputTexts: tools ? [JSON.stringify(tools)] : undefined,
      echo: {
        ...(b.instructions !== undefined ? { instructions: b.instructions } : {}),
        ...(b.max_output_tokens !== undefined ? { max_output_tokens: b.max_output_tokens } : {}),
        ...(b.temperature !== undefined ? { temperature: b.temperature } : {}),
        ...(b.top_p !== undefined ? { top_p: b.top_p } : {}),
        tools: b.tools ?? [],
        tool_choice: b.tool_choice ?? "auto",
        parallel_tool_calls: b.parallel_tool_calls ?? true,
      },
    };
  },

  body(ctx, text, finish, usage, toolCalls = []) {
    const output: unknown[] = [];
    if (text !== "" || toolCalls.length === 0) output.push(messageItem(`msg_${ctx.id}`, text, "completed"));
    toolCalls.forEach((c, i) => output.push(callItem(ctx, i, c, "completed")));
    return responseObject(ctx, finalStatus(finish), output, usage);
  },

  streamStart: (ctx) => [
    ev(ctx, "response.created", { response: responseObject(ctx, "in_progress", [], null) }),
    ev(ctx, "response.in_progress", { response: responseObject(ctx, "in_progress", [], null) }),
  ],

  streamDelta(ctx, text) {
    const frames: string[] = [];
    if (!ctx.state.open) {
      const index = ctx.state.nextIndex++;
      const id = `msg_${ctx.id}_${index}`;
      ctx.state.open = { index, id, text: "" };
      frames.push(
        ev(ctx, "response.output_item.added", { output_index: index, item: messageItem(id, "", "in_progress") }),
        ev(ctx, "response.content_part.added", { item_id: id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
      );
    }
    const o = ctx.state.open;
    o.text += text;
    frames.push(ev(ctx, "response.output_text.delta", { item_id: o.id, output_index: o.index, content_index: 0, delta: text }));
    return frames;
  },

  streamToolCall(ctx, call) {
    const frames = closeText(ctx);
    const index = ctx.state.nextIndex++;
    const item = callItem(ctx, index, call, "completed") as { id: string };
    ctx.state.done.push(item);
    frames.push(
      ev(ctx, "response.output_item.added", { output_index: index, item: callItem(ctx, index, call, "in_progress") }),
      ev(ctx, "response.function_call_arguments.delta", { item_id: item.id, output_index: index, delta: call.arguments }),
      ev(ctx, "response.function_call_arguments.done", { item_id: item.id, output_index: index, arguments: call.arguments }),
      ev(ctx, "response.output_item.done", { output_index: index, item }),
    );
    return frames;
  },

  streamEnd(ctx, finish, usage) {
    const frames = closeText(ctx);
    const status = finalStatus(finish);
    frames.push(ev(ctx, status === "completed" ? "response.completed" : "response.incomplete", { response: responseObject(ctx, status, ctx.state.done, usage) }));
    return frames;
  },

  streamError: (status, code, message, ctx) => {
    const payload = gatewayErrorPayload("openai_responses", status, code, message, null) as { error: Record<string, unknown> };
    return [sse({ type: "error", sequence_number: ctx ? ctx.state.seq++ : 0, code, message, param: null, ...payload }, "error")];
  },
};
