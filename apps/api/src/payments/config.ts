import { z } from "zod";
import type { PaymentRoute } from "@llmcrypto/domain";

export interface PaymentsConfig {
  /** Approved (network, asset) pairs. Empty = payments disabled; the deposit endpoint answers 503. */
  routes: readonly PaymentRoute[];
  /** "none": no AddressProvider (disabled). "test": the deterministic TEST-ONLY provider (refused in production). */
  addressSource: "none" | "test";
  /** Open (CREATED) intents allowed per account. */
  maxOpenIntents: number;
}

export const EMPTY_PAYMENTS: PaymentsConfig = { routes: [], addressSource: "none", maxOpenIntents: 10 };

const bigintStr = z.string().regex(/^(0|[1-9][0-9]*)$/, "must be a non-negative integer decimal string");
const RouteJson = z.object({
  network: z.string().min(1).max(32),
  asset: z.string().min(1).max(32),
  chainId: z.string().min(1).max(64),
  /** Token contract address, or null for a native asset. */
  assetContract: z.string().min(1).nullable(),
  decimals: z.number().int().min(0).max(36),
  confirmations: z.number().int().min(1).max(10_000),
  expirySeconds: z.number().int().min(60).max(30 * 86_400),
  graceSeconds: z.number().int().min(0).max(30 * 86_400),
  /** Micro-USD credited per whole token. A business decision: there is no default. */
  microusdPerToken: bigintStr,
  overpayment: z.enum(["review", "credit_full"]),
  minAmountAtomic: bigintStr.default("1"),
  maxAmountAtomic: bigintStr.nullable().default(null),
}).strict();
const ConfigJson = z.object({ routes: z.array(RouteJson) }).strict();

/**
 * Parses PAYMENT_NETWORKS_CONFIG (JSON `{"routes":[...]}`). Unset/blank = no networks. Malformed config throws so a
 * misconfigured deployment fails at startup instead of silently accepting or rejecting payments.
 */
export function parsePaymentRoutes(raw: string | undefined): PaymentRoute[] {
  if (raw === undefined || raw.trim() === "") return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("PAYMENT_NETWORKS_CONFIG is not valid JSON");
  }
  const parsed = ConfigJson.safeParse(json);
  if (!parsed.success) throw new Error(`PAYMENT_NETWORKS_CONFIG invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const seen = new Set<string>();
  return parsed.data.routes.map((r) => {
    const k = `${r.network}\u0000${r.asset}`;
    if (seen.has(k)) throw new Error(`PAYMENT_NETWORKS_CONFIG: duplicate pair ${r.network}/${r.asset}`);
    seen.add(k);
    const min = BigInt(r.minAmountAtomic);
    const max = r.maxAmountAtomic === null ? null : BigInt(r.maxAmountAtomic);
    if (min < 1n || (max !== null && max < min)) throw new Error(`PAYMENT_NETWORKS_CONFIG: bad amount bounds for ${r.network}/${r.asset}`);
    const perToken = BigInt(r.microusdPerToken);
    if (perToken < 1n) throw new Error(`PAYMENT_NETWORKS_CONFIG: microusdPerToken must be positive for ${r.network}/${r.asset}`);
    return {
      network: r.network, asset: r.asset, chainId: r.chainId, assetContract: r.assetContract ?? "", decimals: r.decimals, confirmations: r.confirmations,
      expirySeconds: r.expirySeconds, graceSeconds: r.graceSeconds, microusdPerToken: perToken, overpayment: r.overpayment, minAmountAtomic: min, maxAmountAtomic: max,
    };
  });
}
