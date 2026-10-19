import { registerPriceVersion } from "@llmcrypto/domain";
import type { Db } from "../db";
import { SAMPLE_CATALOG, SAMPLE_PRICING_VERSION, SAMPLE_SOURCE } from "../catalog/seed";

/**
 * Registers the sample catalog as an immutable price version (idempotent). SAMPLE DATA ONLY: the prices are
 * fabricated, so every charge made against them is a test charge.
 *
 * Safety: registering an existing version id with different rates throws (price versions are immutable; a change needs a new
 * id). The API entrypoint calls this at startup and refuses to start; during requests the gateway answers 503 pricing_unavailable
 * (logged) instead of a 500 with internals.
 */
export async function ensureSamplePriceVersion(db: Db, now: Date): Promise<void> {
  const first = SAMPLE_CATALOG[0];
  if (!first) return;
  await db.tx((q) =>
    registerPriceVersion(
      q,
      {
        id: SAMPLE_PRICING_VERSION,
        source: SAMPLE_SOURCE,
        effectiveAt: new Date(first.updatedAt),
        rates: SAMPLE_CATALOG.map((m) => ({
          model: m.id,
          inputMicrousdPerMtok: BigInt(m.inputMicrousdPerMtok),
          cachedInputMicrousdPerMtok: m.cachedInputMicrousdPerMtok === null ? null : BigInt(m.cachedInputMicrousdPerMtok),
          outputMicrousdPerMtok: BigInt(m.outputMicrousdPerMtok),
        })),
      },
      now,
    ).then(() => undefined),
  );
}
