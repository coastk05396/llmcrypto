/**
 * FAKE PROVIDER: deterministic, in-process test double. It is NOT a real model and talks to no network.
 * Output text is "tok0 tok1 ..." (one token per word); input tokens are ceil(utf8 bytes / 4) + 3 per message.
 *
 * Fault injection is driven by directives written anywhere in the message text, e.g. "[[fake:hang]]":
 *   output=N        produce N output tokens (default 12; truncated to the request cap, finish_reason "length")
 *   cached=N        report N of the input tokens as cached (non-overlapping with the uncached count)
 *   reject          refuse before accepting work (ProviderError rejected, no usage)
 *   hang            never answer until aborted (use with a short GATEWAY_PROVIDER_TIMEOUT_MS)
 *   no_usage        succeed but omit usage
 *   late_usage      omit usage now, but make it available later through lookupUsage()
 *   error_after=N   fail with an upstream error after N tokens, reporting usage so far (add no_usage to omit)
 *   slow            wait 20 ms between tokens so a client can disconnect mid-stream; aborting reports usage so far
 *   overrun         report more output tokens than the cap allows (provider-side overrun)
 *   tool_call       when the request declares tools, answer with ONE call to the first tool (arguments {"fake":true}) instead of text;
 *                   tool_choice "required" or a named tool forces it, "none" suppresses it
 * Design beta: when a message carries the design prompt marker (DESIGN_PROPOSAL_V1) the fake answers with a deterministic,
 * schema-valid design JSON built from the brief (and a revision instruction, if any) instead of "tokN" words. Extra directives:
 *   malformed      answer with prose that is not JSON
 *   bad_schema     answer with valid JSON of the wrong shape
 * The fake honours maxOutputTokens only; sampling parameters are accepted by the gateway but have no effect here.
 */
import { DESIGN_PROMPT_MARKER, inputTokenUpperBound, utf8Length, type TokenUsage } from "@llmcrypto/domain";
import {
  ProviderError,
  type ProviderToolCall,
  type FinishReason,
  type Provider,
  type ProviderCompletion,
  type ProviderRequest,
  type ProviderStreamEvent,
} from "./provider";

interface Directives {
  flags: Set<string>;
  values: Map<string, number>;
}
function parseDirectives(req: ProviderRequest): Directives {
  const flags = new Set<string>();
  const values = new Map<string, number>();
  for (const m of req.messages) {
    for (const d of m.text.matchAll(/\[\[fake:([a-z_]+)(?:=(\d{1,9}))?\]\]/g)) {
      const name = d[1] ?? "";
      if (d[2] !== undefined) values.set(name, Number(d[2]));
      else flags.add(name);
    }
  }
  return { flags, values };
}

const stripDirectives = (t: string): string => t.replace(/\[\[fake:[a-z_]+(?:=\d{1,9})?\]\]/g, "").trim();

/** Deterministic design reply for the design prompt, or null when this is not a design request. */
function designReply(req: ProviderRequest, d: Directives): string | null {
  const all = req.messages.map((m) => m.text).join("\n");
  if (!all.includes(DESIGN_PROMPT_MARKER)) return null;
  if (d.flags.has("malformed")) return "Sure! Here is my design: it is a great design with many parts.";
  if (d.flags.has("bad_schema")) return JSON.stringify({ proposal: "wrong shape", sections: "nope" });
  const title = /^Title: (.*)$/m.exec(all)?.[1] ?? "Untitled";
  const brief = stripDirectives(/<brief>\n([\s\S]*?)\n<\/brief>/.exec(all)?.[1] ?? "").slice(0, 300);
  const instruction = /<instruction>\n([\s\S]*?)\n<\/instruction>/.exec(all)?.[1];
  const sections = [{ heading: "Overview", body: `Fake provider proposal for: ${brief || "(empty brief)"}` }];
  if (instruction !== undefined) sections.push({ heading: "Revision", body: `Incorporated: ${stripDirectives(instruction).slice(0, 300)}` });
  return JSON.stringify({
    title: `Proposal: ${stripDirectives(title).slice(0, 100)}`,
    summary: "Deterministic output of the FakeProvider. Not a real model's design.",
    sections,
    components: [{ name: "Core service", purpose: "Placeholder component from the fake provider" }],
    risks: ["This text was produced by a test double, not a model"],
  });
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export class FakeProvider implements Provider {
  readonly id = "fake";
  readonly isFake = true;
  private readonly late = new Map<string, TokenUsage>();
  /** Calls observed by the fake (test assertions: no retries after possible acceptance). */
  readonly calls: { providerRequestId: string; model: string }[] = [];
  /** Requests exactly as received (test assertions about what the gateway really sent). In-memory only, last 500. */
  readonly requests: ProviderRequest[] = [];

  inputTokenUpperBound(_model: string, texts: readonly string[]): bigint {
    return inputTokenUpperBound(texts);
  }

  private toolCallFor(req: ProviderRequest, d: Directives): ProviderToolCall | null {
    const tools = req.tools ?? [];
    const choice = req.toolChoice;
    if (tools.length === 0 || choice === "none") return null;
    const named = typeof choice === "object" ? tools.find((t) => t.name === choice.name) : undefined;
    if (!(d.flags.has("tool_call") || choice === "required" || named)) return null;
    const tool = named ?? tools[0];
    return tool ? { id: `call_${req.providerRequestId}`, name: tool.name, arguments: '{"fake":true}' } : null;
  }

  private plan(req: ProviderRequest): { d: Directives; inputTotal: number; cached: number; wanted: number; produced: number; finish: FinishReason; tool: ProviderToolCall | null; reply: string | null } {
    const d = parseDirectives(req);
    const bytes = req.messages.reduce((n, m) => n + utf8Length(m.text), 0);
    const inputTotal = Math.ceil(bytes / 4) + 3 * req.messages.length;
    const cached = Math.min(d.values.get("cached") ?? 0, inputTotal);
    const tool = this.toolCallFor(req, d);
    const reply = tool ? null : designReply(req, d);
    const wanted = d.values.get("output") ?? (reply !== null ? Math.ceil(utf8Length(reply) / 4) : tool ? 8 : 12);
    const produced = Math.min(wanted, req.maxOutputTokens);
    return { d, inputTotal, cached, wanted, produced, tool, reply, finish: tool ? "tool_calls" : wanted > req.maxOutputTokens ? "length" : "stop" };
  }

  private usageFor(p: ReturnType<FakeProvider["plan"]>, outputTokens: number): TokenUsage {
    return { inputTokens: BigInt(p.inputTotal - p.cached), cachedInputTokens: BigInt(p.cached), outputTokens: BigInt(outputTokens) };
  }

  private async begin(req: ProviderRequest, signal: AbortSignal): Promise<ReturnType<FakeProvider["plan"]>> {
    this.calls.push({ providerRequestId: req.providerRequestId, model: req.model });
    this.requests.push(req);
    if (this.requests.length > 500) this.requests.shift();
    const p = this.plan(req);
    if (p.d.flags.has("reject")) throw new ProviderError("rejected", "fake provider rejected the request");
    if (p.d.flags.has("hang")) {
      await sleep(3_600_000, signal);
      throw new ProviderError("aborted", "fake provider call aborted");
    }
    return p;
  }

  private finalUsage(req: ProviderRequest, p: ReturnType<FakeProvider["plan"]>): TokenUsage | null {
    const out = p.d.flags.has("overrun") ? req.maxOutputTokens + 1000 : p.produced;
    const usage = this.usageFor(p, out);
    if (p.d.flags.has("late_usage")) {
      this.late.set(req.providerRequestId, usage);
      return null;
    }
    return p.d.flags.has("no_usage") ? null : usage;
  }

  async complete(req: ProviderRequest, signal: AbortSignal): Promise<ProviderCompletion> {
    const p = await this.begin(req, signal);
    const errorAfter = p.d.values.get("error_after");
    if (errorAfter !== undefined) {
      throw new ProviderError("upstream", "fake provider failed", p.d.flags.has("no_usage") ? null : this.usageFor(p, Math.min(errorAfter, p.produced)));
    }
    if (p.d.flags.has("slow")) {
      for (let i = 0; i < p.produced; i++) {
        await sleep(20, signal);
        if (signal.aborted) throw new ProviderError("aborted", "fake provider call aborted", this.usageFor(p, i));
      }
    }
    // A design reply is cut at 4 bytes per produced token, so a small output cap yields genuinely truncated (malformed) JSON.
    const text = p.tool ? "" : p.reply !== null ? Buffer.from(p.reply, "utf8").subarray(0, p.produced * 4).toString("utf8") : Array.from({ length: p.produced }, (_, i) => `tok${i}`).join(" ");
    return { text, ...(p.tool ? { toolCalls: [p.tool] } : {}), finishReason: p.finish, usage: this.finalUsage(req, p) };
  }

  async *stream(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderStreamEvent, void, void> {
    const p = await this.begin(req, signal);
    const errorAfter = p.d.values.get("error_after");
    const slow = p.d.flags.has("slow");
    for (let i = 0; i < p.produced; i++) {
      if (errorAfter !== undefined && i === errorAfter) {
        throw new ProviderError("upstream", "fake provider failed mid-stream", p.d.flags.has("no_usage") ? null : this.usageFor(p, i));
      }
      if (slow) await sleep(20, signal);
      if (signal.aborted) throw new ProviderError("aborted", "fake provider call aborted", this.usageFor(p, i));
      if (!p.tool) yield { type: "delta", text: i === 0 ? `tok${i}` : ` tok${i}` };
    }
    if (errorAfter !== undefined && errorAfter >= p.produced) {
      throw new ProviderError("upstream", "fake provider failed mid-stream", p.d.flags.has("no_usage") ? null : this.usageFor(p, p.produced));
    }
    if (p.tool) yield { type: "tool_call", call: p.tool };
    yield { type: "finish", finishReason: p.finish };
    const usage = this.finalUsage(req, p);
    if (usage) yield { type: "usage", usage };
  }

  async lookupUsage(providerRequestId: string): Promise<TokenUsage | null> {
    return this.late.get(providerRequestId) ?? null;
  }

  /** Test hook: make usage available to lookupUsage() as if the provider's usage API caught up. */
  recordLateUsage(providerRequestId: string, usage: TokenUsage): void {
    this.late.set(providerRequestId, usage);
  }
}
