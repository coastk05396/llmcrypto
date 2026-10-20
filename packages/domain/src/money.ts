/** Money is a non-negative bigint count of micro-USD (1 USD = 1_000_000). Never use floats. */
export type Microusd = bigint;

export const MICROS_PER_USD = 1_000_000n;
export const TOKENS_PER_MILLION = 1_000_000n;

const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;

export function parseMicrousd(s: string): Microusd {
  if (!CANONICAL_UINT.test(s)) throw new RangeError(`Invalid micro-USD integer string: ${JSON.stringify(s)}`);
  return BigInt(s);
}

export function formatMicrousd(m: Microusd): string {
  if (m < 0n) throw new RangeError("Negative micro-USD amount");
  return m.toString();
}

/** ceil(amount * numerator / denominator) for non-negative operands; rounding happens once. */
export function mulCeilDiv(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  if (amount < 0n || numerator < 0n) throw new RangeError("Operands must be non-negative");
  if (denominator <= 0n) throw new RangeError("Denominator must be positive");
  const product = amount * numerator;
  return (product + denominator - 1n) / denominator;
}

/** Charge for `tokens` at `ratePerMillionTokens` micro-USD per 1M tokens, rounded up to a whole micro-USD. */
export function tokenCharge(tokens: bigint, ratePerMillionTokens: Microusd): Microusd {
  return mulCeilDiv(tokens, ratePerMillionTokens, TOKENS_PER_MILLION);
}

/** Display string with exactly six fractional digits, e.g. "12.340000". */
export function formatUsd(m: Microusd): string {
  if (m < 0n) throw new RangeError("Negative micro-USD amount");
  const whole = m / MICROS_PER_USD;
  const frac = (m % MICROS_PER_USD).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}
