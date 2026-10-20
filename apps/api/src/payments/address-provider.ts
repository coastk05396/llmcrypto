import { createHash } from "node:crypto";

/**
 * Source of per-intent receiving addresses. This is the custody boundary and it is BLOCKED on a product decision
 * (treasury/custody model, HD derivation vs. deposit contracts vs. exchange sub-accounts). The contract:
 *  - the returned address is unique per intent (the matcher correlates transfers to intents by destination);
 *  - the wallet keys are never handled by the frontend or stored in the application database;
 *  - it is deterministic for one intent (idempotent retries must not mint a second address).
 * Only the TEST provider exists.
 */
export interface AddressProvider {
  readonly kind: string;
  addressFor(req: { intentId: string; accountId: string; network: string; asset: string }): Promise<string>;
}

/**
 * TEST ONLY. Derives a syntactically valid 0x address from a hash of the intent. NOBODY holds a key for it, so any
 * real funds sent there are lost. It exists so the intent/observation/credit pipeline can be exercised end to end.
 * Refuses to run when NODE_ENV=production.
 */
export class TestAddressProvider implements AddressProvider {
  readonly kind = "test";
  async addressFor(req: { intentId: string; network: string; asset: string }): Promise<string> {
    if (process.env["NODE_ENV"] === "production") throw new Error("TestAddressProvider is disabled when NODE_ENV=production");
    if (process.env["ALLOW_TEST_COMPONENTS"] !== "true") throw new Error("TestAddressProvider needs ALLOW_TEST_COMPONENTS=true");
    return `0x${createHash("sha256").update(`test-address|${req.network}|${req.asset}|${req.intentId}`).digest("hex").slice(0, 40)}`;
  }
}
