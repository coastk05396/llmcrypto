/**
 * Pricing: immutable rate snapshots and exact charge arithmetic.
 *
 * - Rates are micro-USD per one million tokens (bigint). No floats anywhere.
 * - A charge multiplies every token category by its rate EXACTLY, sums the exact products, and rounds
 *   UP to a whole micro-USD once (not once per category).
 * - Token categories do not overlap: inputTokens excludes cachedInputTokens.
 * - A model without a cached rate bills cached tokens at its input rate (never cheaper by omission).
 * - Long-context tiered rates are not modelled yet (the catalog has no thresholds); see docs/provider-matrix.md.
 */
import { TOKENS_PER_MILLION } from "./money";
import type { SqlExecutor } from "./sql";

export interface RateSnapshot {
  priceVersion: string;
  model: string;
  inputMicrousdPerMtok: bigint;
  /** null = the model has no cached-input price. */
  cachedInputMicrousdPerMtok: bigint | null;
  outputMicrousdPerMtok: bigint;
}

export interface TokenUsage {
  /** Uncached input tokens (excludes cachedInputTokens). */
  inputTokens: bigint;
  cachedInputTokens: bigint;
  outputTokens: bigint;
}

export const effectiveCachedRate = (r: Pick<RateSnapshot, "inputMicrousdPerMtok" | "cachedInputMicrousdPerMtok">): bigint =>
  r.cachedInputMicrousdPerMtok ?? r.inputMicrousdPerMtok;

function assertNonNegative(u: TokenUsage): void {
  if (u.inputTokens < 0n || u.cachedInputTokens < 0n || u.outputTokens < 0n) throw new RangeError("Token counts must be non-negative");
}

/** ceil(numerator / 1_000_000), numerator >= 0. */
export function ceilPerMillion(numerator: bigint): bigint {
  if (numerator < 0n) throw new RangeError("numerator must be non-negative");
  return (numerator + TOKENS_PER_MILLION - 1n) / TOKENS_PER_MILLION;
}

/** Charge in micro-USD for the given usage at the given snapshot, rounded up once. */
export function chargeFor(usage: TokenUsage, rates: RateSnapshot): bigint {
  assertNonNegative(usage);
  const exact =
    usage.inputTokens * rates.inputMicrousdPerMtok +
    usage.cachedInputTokens * effectiveCachedRate(rates) +
    usage.outputTokens * rates.outputMicrousdPerMtok;
  return ceilPerMillion(exact);
}

/**
 * Maximum cost to hold before dispatch: every input token at the dearer of the input/cached rates plus the
 * full requested output cap at the output rate.
 */
export function reservationUpperBound(inputTokenUpperBound: bigint, maxOutputTokens: bigint, rates: RateSnapshot): bigint {
  if (inputTokenUpperBound < 0n || maxOutputTokens < 0n) throw new RangeError("Token bounds must be non-negative");
  const inRate = rates.inputMicrousdPerMtok > effectiveCachedRate(rates) ? rates.inputMicrousdPerMtok : effectiveCachedRate(rates);
  return ceilPerMillion(inputTokenUpperBound * inRate + maxOutputTokens * rates.outputMicrousdPerMtok);
}

/** UTF-8 byte length without TextEncoder (this package has no DOM/node lib). */
export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Per-message framing allowance and request constant used by the conservative input bound. */
export const INPUT_BOUND_PER_MESSAGE = 8;
export const INPUT_BOUND_CONSTANT = 16;

/**
 * Safe upper bound on input tokens when no exact tokenizer is available: no tokenizer emits a token for
 * less than one byte of UTF-8 text, so bytes + framing allowance can never be undercounted. It overestimates
 * (typically 3-4x for English); the surplus hold is released at settlement. A route without a proven bound
 * must be rejected rather than guessed at (only the fake provider's bound exists today).
 */
export function inputTokenUpperBound(texts: readonly string[]): bigint {
  let total = INPUT_BOUND_CONSTANT;
  for (const t of texts) total += utf8Length(t) + INPUT_BOUND_PER_MESSAGE;
  return BigInt(total);
}

// ---------------------------------------------------------------- price versions (SQL)

export interface PriceRateInput {
  model: string;
  inputMicrousdPerMtok: bigint;
  cachedInputMicrousdPerMtok: bigint | null;
  outputMicrousdPerMtok: bigint;
}
export interface PriceVersionInput {
  id: string;
  source: string;
  effectiveAt: Date;
  rates: readonly PriceRateInput[];
}

interface RateRow {
  price_version_id: string;
  model_id: string;
  input: string;
  cached: string | null;
  output: string;
}
const RATE_SELECT = `r.price_version_id, r.model_id, r.input_microusd_per_mtok::text as input,
  r.cached_input_microusd_per_mtok::text as cached, r.output_microusd_per_mtok::text as output`;
const toSnapshot = (r: RateRow): RateSnapshot => ({
  priceVersion: r.price_version_id,
  model: r.model_id,
  inputMicrousdPerMtok: BigInt(r.input),
  cachedInputMicrousdPerMtok: r.cached === null ? null : BigInt(r.cached),
  outputMicrousdPerMtok: BigInt(r.output),
});

/**
 * Registers an immutable price version. Re-registering the same id with identical rates is a no-op;
 * with different rates it throws (a price change needs a new version id).
 */
export async function registerPriceVersion(q: SqlExecutor, v: PriceVersionInput, now: Date): Promise<"created" | "exists"> {
  const inserted = await q.query<{ id: string }>(
    "insert into price_versions (id, source, effective_at, created_at) values ($1,$2,$3,$4) on conflict (id) do nothing returning id",
    [v.id, v.source, v.effectiveAt, now],
  );
  if (inserted.length === 0) {
    const existing = await q.query<RateRow>(`select ${RATE_SELECT} from price_rates r where r.price_version_id=$1`, [v.id]);
    const have = new Map(existing.map((r) => [r.model_id, toSnapshot(r)]));
    const same =
      have.size === v.rates.length &&
      v.rates.every((x) => {
        const h = have.get(x.model);
        return h !== undefined && h.inputMicrousdPerMtok === x.inputMicrousdPerMtok && h.cachedInputMicrousdPerMtok === x.cachedInputMicrousdPerMtok && h.outputMicrousdPerMtok === x.outputMicrousdPerMtok;
      });
    if (!same) throw new Error(`price version ${v.id} already exists with different rates; register a new version instead`);
    return "exists";
  }
  for (const r of v.rates) {
    await q.query(
      `insert into price_rates (price_version_id, model_id, input_microusd_per_mtok, cached_input_microusd_per_mtok, output_microusd_per_mtok)
       values ($1,$2,$3,$4,$5)`,
      [v.id, r.model, r.inputMicrousdPerMtok.toString(), r.cachedInputMicrousdPerMtok === null ? null : r.cachedInputMicrousdPerMtok.toString(), r.outputMicrousdPerMtok.toString()],
    );
  }
  return "created";
}

/** Rate snapshot of `model` in the newest price version effective at `now` that prices it. */
export async function getActiveRates(q: SqlExecutor, model: string, now: Date): Promise<RateSnapshot | undefined> {
  const [r] = await q.query<RateRow>(
    `select ${RATE_SELECT} from price_rates r join price_versions v on v.id = r.price_version_id
     where r.model_id=$1 and v.effective_at <= $2 order by v.effective_at desc, v.created_at desc, v.id desc limit 1`,
    [model, now],
  );
  return r ? toSnapshot(r) : undefined;
}
