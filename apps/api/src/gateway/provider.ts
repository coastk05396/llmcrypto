import type { TokenUsage } from "@llmcrypto/domain";

/** Provider boundary. Implementations translate to/from one upstream; the gateway owns billing and protocol shapes. */
export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  text: string;
}
export interface ProviderTool {
  name: string;
  description?: string | undefined;
  /** JSON Schema object, passed through untouched. */
  parameters?: unknown;
}
export type ProviderToolChoice = "auto" | "none" | "required" | { name: string };
export interface ProviderToolCall {
  id: string;
  name: string;
  /** JSON text, exactly as the model produced it. */
  arguments: string;
}
export interface ProviderRequest {
  /** Stable reference the gateway stores so usage can be looked up later. */
  providerRequestId: string;
  model: string;
  messages: ProviderMessage[];
  maxOutputTokens: number;
  temperature?: number | undefined;
  topP?: number | undefined;
  stop?: string[] | undefined;
  tools?: ProviderTool[] | undefined;
  toolChoice?: ProviderToolChoice | undefined;
}
export type FinishReason = "stop" | "length" | "tool_calls";
export interface ProviderCompletion {
  text: string;
  toolCalls?: ProviderToolCall[] | undefined;
  finishReason: FinishReason;
  /** null = the provider did not report usage (the request becomes USAGE_PENDING). */
  usage: TokenUsage | null;
}
export type ProviderStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; call: ProviderToolCall }
  | { type: "finish"; finishReason: FinishReason }
  | { type: "usage"; usage: TokenUsage };

/**
 * rejected: the provider refused before accepting work (safe to treat as not billed).
 * upstream: failed after possibly accepting work. aborted: the call was cancelled via its AbortSignal.
 * `usage`, when present, is verified partial/final usage the provider still reported.
 */
export class ProviderError extends Error {
  constructor(
    readonly kind: "rejected" | "upstream" | "aborted",
    message: string,
    readonly usage: TokenUsage | null = null,
  ) {
    super(message);
  }
}

export interface Provider {
  /** Short stable id, e.g. "fake". */
  readonly id: string;
  /** True for the deterministic test provider; surfaced so nothing can mistake it for a real upstream. */
  readonly isFake: boolean;
  /**
   * Provably-safe upper bound on input tokens for `model`, or null when the provider cannot give one
   * (the gateway then rejects the request: no guessing).
   */
  inputTokenUpperBound(model: string, texts: readonly string[]): bigint | null;
  complete(req: ProviderRequest, signal: AbortSignal): Promise<ProviderCompletion>;
  stream(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderStreamEvent, void, void>;
  /** Later-arriving usage for a request whose usage was missing; null = still unknown. */
  lookupUsage(providerRequestId: string): Promise<TokenUsage | null>;
}
