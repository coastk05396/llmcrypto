/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountBalance } from "@llmcrypto/domain";
import { BASE_TIME } from "./helpers";
import { funded, makeGatewayHarness, type GatewayHarness } from "./metering-helpers";

let h: GatewayHarness;
beforeAll(async () => {
  h = await makeGatewayHarness();
});
afterAll(async () => {
  await h.db.close();
});
beforeEach(() => {
  h.clock.now = new Date(BASE_TIME);
});

const post = (secret: string | null, body: unknown, path = "/v1/responses"): Promise<Response> =>
  Promise.resolve(h.gwApp.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify(body),
  }));
const resp = (secret: string | null, extra: Record<string, unknown> = {}) => post(secret, { model: "sample-fast-1", input: "hello", max_output_tokens: 50, ...extra });
const FN = { type: "function", name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } };

async function events(res: Response): Promise<{ event: string; data: any }[]> {
  const raw = await res.text();
  return raw.split("\n\n").filter(Boolean).map((f) => {
    const lines = f.split("\n");
    return { event: lines.find((l) => l.startsWith("event: "))!.slice(7), data: JSON.parse(lines.find((l) => l.startsWith("data: "))!.slice(6)) };
  });
}
const row = async (id: string) => (await h.db.query<any>("select r.protocol, r.state, u.charge_microusd::text ch, u.input_tokens::text i, u.cached_input_tokens::text c, u.output_tokens::text o from requests r join usage_records u on u.request_id=r.id where r.id=$1", [id]))[0];

describe("POST /v1/responses", () => {
  it("non-streaming: Responses-shaped body, billed once, protocol recorded", async () => {
    const { s, key } = await funded(h, 5_000_000n);
    const res = await resp(key.secret, { instructions: "be brief", input: [{ role: "user", content: [{ type: "input_text", text: "hi [[fake:output=7]]" }] }] });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    await h.gateway.idle();
    expect(j).toMatchObject({ object: "response", status: "completed", model: "sample-fast-1", error: null, incomplete_details: null, instructions: "be brief" });
    expect(j.id).toBe(`resp_${res.headers.get("x-request-id")}`);
    expect(j.output).toHaveLength(1);
    expect(j.output[0]).toMatchObject({ type: "message", role: "assistant", status: "completed" });
    expect(j.output[0].content[0]).toEqual({ type: "output_text", text: "tok0 tok1 tok2 tok3 tok4 tok5 tok6", annotations: [] });
    expect(j.usage.output_tokens).toBe(7);
    expect(j.usage.total_tokens).toBe(j.usage.input_tokens + 7);
    const r = await row(res.headers.get("x-request-id")!);
    expect(r).toMatchObject({ protocol: "openai_responses", state: "SETTLED", o: "7" });
    expect(BigInt(r.ch)).toBeGreaterThan(0n);
    expect((await accountBalance(h.db, s.accountId)).posted).toBe(5_000_000n - BigInt(r.ch));
  });

  it("length cap -> status incomplete with max_output_tokens", async () => {
    const { key } = await funded(h, 5_000_000n);
    const j: any = await (await resp(key.secret, { input: "x [[fake:output=40]]", max_output_tokens: 5 })).json();
    expect(j.status).toBe("incomplete");
    expect(j.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("streaming: typed, ordered, sequence-numbered events; completed carries the billed usage; no [DONE]", async () => {
    const { key } = await funded(h, 5_000_000n);
    const res = await resp(key.secret, { stream: true, input: "go [[fake:output=3]]" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const evs = await events(res);
    await h.gateway.idle();
    expect(evs.map((e) => e.event)).toEqual([
      "response.created", "response.in_progress", "response.output_item.added", "response.content_part.added",
      "response.output_text.delta", "response.output_text.delta", "response.output_text.delta",
      "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed",
    ]);
    expect(evs.every((e, i) => e.data.type === e.event && e.data.sequence_number === i)).toBe(true);
    expect(evs.filter((e) => e.event === "response.output_text.delta").map((e) => e.data.delta).join("")).toBe("tok0 tok1 tok2");
    const done = evs.at(-1)!.data.response;
    expect(done.status).toBe("completed");
    expect(done.output[0].content[0].text).toBe("tok0 tok1 tok2");
    expect(evs[0]!.data.response.status).toBe("in_progress");
    const r = await row(res.headers.get("x-request-id")!);
    expect(r.state).toBe("SETTLED");
    expect(done.usage).toMatchObject({ output_tokens: 3, input_tokens: Number(r.i) + Number(r.c) });
  });

  it("tool call passthrough, non-streaming: function_call item with the declared name; tools echoed; billed", async () => {
    const { key } = await funded(h, 5_000_000n);
    const res = await resp(key.secret, { input: "weather? [[fake:tool_call]]", tools: [FN], tool_choice: "auto" });
    const j: any = await res.json();
    await h.gateway.idle();
    expect(res.status).toBe(200);
    expect(j.output).toHaveLength(1);
    expect(j.output[0]).toMatchObject({ type: "function_call", name: "get_weather", status: "completed", arguments: '{"fake":true}' });
    expect(j.output[0].call_id).toMatch(/^call_prov_/);
    expect(j.tools).toEqual([FN]);
    expect((await row(res.headers.get("x-request-id")!)).state).toBe("SETTLED");
  });

  it("tool call passthrough, streaming: argument events then a completed response whose output is the call", async () => {
    const { key } = await funded(h, 5_000_000n);
    const evs = await events(await resp(key.secret, { stream: true, input: "w [[fake:tool_call]]", tools: [FN] }));
    await h.gateway.idle();
    expect(evs.map((e) => e.event)).toEqual([
      "response.created", "response.in_progress", "response.output_item.added", "response.function_call_arguments.delta",
      "response.function_call_arguments.done", "response.output_item.done", "response.completed",
    ]);
    expect(evs[2]!.data.item).toMatchObject({ type: "function_call", name: "get_weather", status: "in_progress" });
    expect(evs.at(-1)!.data.response.output[0]).toMatchObject({ type: "function_call", name: "get_weather", arguments: '{"fake":true}' });
  });

  it("tool_choice none suppresses the call; a named choice forces it; the tool result can be sent back", async () => {
    const { key } = await funded(h, 5_000_000n);
    const none: any = await (await resp(key.secret, { input: "[[fake:tool_call]]", tools: [FN], tool_choice: "none" })).json();
    expect(none.output[0].type).toBe("message");
    const forced: any = await (await resp(key.secret, { input: "plain", tools: [FN], tool_choice: { type: "function", name: "get_weather" } })).json();
    expect(forced.output[0].type).toBe("function_call");
    const follow = await resp(key.secret, {
      tools: [FN],
      input: [
        { role: "user", content: "weather?" },
        { type: "function_call", call_id: forced.output[0].call_id, name: "get_weather", arguments: "{}" },
        { type: "function_call_output", call_id: forced.output[0].call_id, output: "sunny" },
      ],
    });
    expect(follow.status).toBe(200);
    expect(((await follow.json()) as any).output[0].type).toBe("message");
  });

  it.each([
    ["previous_response_id", { previous_response_id: "resp_1" }, "unsupported_parameter", "previous_response_id"],
    ["reasoning", { reasoning: { effort: "high" } }, "unsupported_parameter", "reasoning"],
    ["text.format", { text: { format: { type: "json_object" } } }, "unsupported_parameter", "text"],
    ["include", { include: ["x"] }, "unsupported_parameter", "include"],
    ["background", { background: true }, "unsupported_parameter", "background"],
    ["store=true", { store: true }, "unsupported_value", "store"],
    ["built-in tool", { tools: [{ type: "web_search" }] }, "unsupported_value", "tools.0.type"],
    ["image input", { input: [{ role: "user", content: [{ type: "input_image", image_url: "http://x" }] }] }, "unsupported_value", "input.0.content.0.type"],
    ["unknown item", { input: [{ type: "reasoning", id: "r1" }] }, "unsupported_value", "input.0.type"],
    ["tool_choice without tools", { tool_choice: "required" }, "invalid_request", "tool_choice"],
    ["tool_choice names missing tool", { tools: [FN], tool_choice: { type: "function", name: "nope" } }, "invalid_request", "tool_choice"],
  ])("fails clearly: %s", async (_n, extra, code, param) => {
    const { key } = await funded(h, 1_000_000n);
    const res = await resp(key.secret, extra);
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.error.code).toBe(code);
    expect(j.error.param).toBe(param);
    expect(j.error.type).toBe("invalid_request_error");
  });

  it("enforces auth, catalog protocol support, funds and the Gemini non-implementation", async () => {
    const { key } = await funded(h, 5_000_000n);
    expect((await resp(null)).status).toBe(401);
    const wrong = await post(key.secret, { model: "sample-frontier-1", input: "x" });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as any).error.code).toBe("model_protocol_unsupported");
    const broke = await funded(h, 1n);
    const r = await resp(broke.key.secret);
    expect(r.status).toBe(402);
    expect(((await r.json()) as any).error.type).toBe("insufficient_quota");
    const g = await post(key.secret, { contents: [] }, "/v1beta/models/sample-long-context-1:generateContent");
    expect(g.status).toBe(501);
    expect(((await g.json()) as any).error.code).toBe("protocol_not_implemented");
  });

  it("a mid-stream provider failure ends with an error event, still settling from reported usage", async () => {
    const { key } = await funded(h, 5_000_000n);
    const res = await resp(key.secret, { stream: true, input: "x [[fake:error_after=2]]" });
    const evs = await events(res);
    await h.gateway.idle();
    expect(evs.at(-1)!.event).toBe("error");
    expect(evs.some((e) => e.event === "response.completed")).toBe(false);
    expect((await row(res.headers.get("x-request-id")!)).state).toBe("SETTLED");
  });
});
