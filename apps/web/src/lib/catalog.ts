import type { CatalogModel, ProtocolId } from "@llmcrypto/contracts";
import { formatUsd } from "@llmcrypto/domain";

export interface CatalogFilter {
  /** Exact provider ID, or "" for all providers. */
  provider: string;
  search: string;
}

export type SortKey = "name" | "input" | "output" | "context";

export const SORT_LABELS: Record<SortKey, string> = {
  name: "Name",
  input: "Input price, low to high",
  output: "Output price, low to high",
  context: "Context window, high to low",
};

export const PROTOCOL_LABELS: Record<ProtocolId, string> = {
  openai_chat: "OpenAI Chat",
  openai_responses: "OpenAI Responses",
  anthropic_messages: "Anthropic Messages",
  gemini_generate_content: "Gemini generateContent",
};

/** Case-insensitive match of the search text against display name, model ID and provider. */
export function filterCatalog(items: readonly CatalogModel[], filter: CatalogFilter): CatalogModel[] {
  const q = filter.search.trim().toLowerCase();
  return items.filter((m) => {
    if (filter.provider !== "" && m.provider !== filter.provider) return false;
    if (q === "") return true;
    return m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q);
  });
}

export function providersOf(items: readonly CatalogModel[]): string[] {
  return [...new Set(items.map((m) => m.provider))].sort((a, b) => a.localeCompare(b));
}

const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

export function sortCatalog(items: readonly CatalogModel[], key: SortKey): CatalogModel[] {
  const out = [...items];
  const byName = (a: CatalogModel, b: CatalogModel) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id);
  out.sort((a, b) => {
    switch (key) {
      case "input":
        return cmpBig(BigInt(a.inputMicrousdPerMtok), BigInt(b.inputMicrousdPerMtok)) || byName(a, b);
      case "output":
        return cmpBig(BigInt(a.outputMicrousdPerMtok), BigInt(b.outputMicrousdPerMtok)) || byName(a, b);
      case "context":
        return cmpBig(BigInt(b.contextWindowTokens), BigInt(a.contextWindowTokens)) || byName(a, b);
      default:
        return byName(a, b);
    }
  });
  return out;
}

/** "$3.00" or "$0.075": micro-USD per million tokens, at least two and at most six decimals. */
export function formatRate(microusdPerMtok: string): string {
  const [whole, frac = ""] = formatUsd(BigInt(microusdPerMtok)).split(".");
  const trimmed = frac.replace(/0+$/, "").padEnd(2, "0");
  return `$${whole}.${trimmed}`;
}

/** "200K", "1M", or the grouped exact number when not a round K or M. */
export function formatContext(tokens: string): string {
  const n = BigInt(tokens);
  if (n >= 1_000_000n && n % 1_000_000n === 0n) return `${n / 1_000_000n}M`;
  if (n >= 1_000n && n % 1_000n === 0n) return `${n / 1_000n}K`;
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function resultCountText(shown: number, total: number): string {
  if (total === 0) return "No models available";
  return shown === total ? `Showing all ${total} models` : `Showing ${shown} of ${total} models`;
}

export type CopyOutcome = "copied" | "failed";
export interface CopyDeps {
  writeText?: (text: string) => Promise<void>;
  /** Synchronous legacy path (for example a hidden textarea and execCommand). */
  legacyCopy?: (text: string) => boolean;
}

/** Copies exactly `text`; tries the async clipboard first, then the legacy path. Never throws. */
export async function copyText(text: string, deps: CopyDeps): Promise<CopyOutcome> {
  if (deps.writeText) {
    try {
      await deps.writeText(text);
      return "copied";
    } catch {
      /* fall through to the legacy path */
    }
  }
  if (deps.legacyCopy) {
    try {
      return deps.legacyCopy(text) ? "copied" : "failed";
    } catch {
      return "failed";
    }
  }
  return "failed";
}
