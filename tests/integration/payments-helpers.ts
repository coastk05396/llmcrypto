/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers parse untyped JSON */
import type { PaymentRoute } from "@llmcrypto/domain";
import { observeOnce } from "../../apps/worker/src/chain-observer";
import { FakeChainClient } from "../../apps/worker/src/fake-chain-client";
import { reconcilePayments } from "../../apps/worker/src/reconcile-payments";
import { randomId } from "../../apps/api/src/crypto";
import { call, makeHarness, type Harness, type LoggedIn } from "./helpers";
import { idemKey } from "./metering-helpers";

export const TOKEN_A = "0x" + "a1".repeat(20);
export const TOKEN_B = "0x" + "b2".repeat(20);
export const TOKEN_OTHER = "0x" + "c3".repeat(20);

/** Fixture routes: synthetic test chains, not real networks. Values mirror what an operator would have to approve. */
export const ROUTE_A: PaymentRoute = {
  network: "testnet-a", asset: "TUSD", chainId: "1001", assetContract: TOKEN_A, decimals: 6, confirmations: 3, expirySeconds: 3600, graceSeconds: 600,
  microusdPerToken: 1_000_000n, overpayment: "review", minAmountAtomic: 1_000_000n, maxAmountAtomic: 1_000_000_000n,
};
export const ROUTE_B: PaymentRoute = {
  network: "testnet-b", asset: "TUSD", chainId: "2002", assetContract: TOKEN_B, decimals: 18, confirmations: 2, expirySeconds: 3600, graceSeconds: 0,
  microusdPerToken: 1_000_000n, overpayment: "credit_full", minAmountAtomic: 10n ** 15n, maxAmountAtomic: null,
};

export interface PaymentsHarness extends Harness {
  chain: FakeChainClient;
  observe(extra?: { scanNetworks?: string[] }): ReturnType<typeof observeOnce>;
  reconcile(extra?: { scanNetworks?: string[] }): ReturnType<typeof reconcilePayments>;
}

export async function makePaymentsHarness(routes: PaymentRoute[] = [ROUTE_A, ROUTE_B], addressSource: "none" | "test" = "test"): Promise<PaymentsHarness> {
  const h = await makeHarness({ payments: { routes, addressSource, maxOpenIntents: 10 } });
  const chain = new FakeChainClient({ "testnet-a": "1001", "testnet-b": "2002" }, () => new Date(h.clock.now));
  const common = () => ({ db: h.db, client: chain, now: () => new Date(h.clock.now), newId: randomId });
  return {
    ...h, chain,
    observe: (extra = {}) => observeOnce({ ...common(), ...extra }),
    reconcile: (extra = {}) => reconcilePayments({ ...common(), ...extra }),
  };
}

export async function createDeposit(h: Harness, s: Pick<LoggedIn, "cookie">, body: Record<string, unknown>, key: string = idemKey()) {
  return call<any>(h.app, "POST", "/api/deposits", { cookie: s.cookie, body, headers: { "Idempotency-Key": key } });
}
export const getDeposit = (h: Harness, s: Pick<LoggedIn, "cookie">, id: string) => call<any>(h.app, "GET", `/api/deposits/${id}`, { cookie: s.cookie });

export const balanceOf = async (h: Harness, s: Pick<LoggedIn, "cookie">): Promise<string> =>
  (await call<any>(h.app, "GET", "/api/accounts/current/balance", { cookie: s.cookie })).json.postedMicrousd;

let tx = 0;
export const txHash = (): string => `0x${(++tx).toString(16).padStart(64, "0")}`;
