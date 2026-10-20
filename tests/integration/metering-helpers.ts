/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers parse untyped JSON */
import { createApp } from "../../apps/api/src/app";
import { randomId } from "../../apps/api/src/crypto";
import { devCreditAccount } from "../../apps/api/src/dev/credit";
import { createGateway, type Gateway } from "../../apps/api/src/gateway/dispatch";
import { FakeProvider } from "../../apps/api/src/gateway/fake-provider";
import { call, login, makeHarness, type Harness, type LoggedIn } from "./helpers";

export interface GatewayHarness extends Harness {
  fake: FakeProvider;
  gateway: Gateway;
  gwApp: ReturnType<typeof createApp>;
}

/** Harness whose app uses the FakeProvider; gateway limits can be overridden per test file. */
export async function makeGatewayHarness(gatewayOverrides: Partial<Harness["config"]["gateway"]> = {}): Promise<GatewayHarness> {
  const h = await makeHarness({}, { GATEWAY_PROVIDER: "fake" });
  const config = { ...h.config, gateway: { ...h.config.gateway, ...gatewayOverrides } };
  const fake = new FakeProvider();
  const gateway = createGateway({ db: h.db, config, provider: fake });
  return { ...h, config, fake, gateway, gwApp: createApp({ db: h.db, config, gateway }) };
}

let n = 0;
export const idemKey = (): string => `idem-key-${Date.now()}-${++n}`;

export const fund = (h: Harness, accountId: string, microusd: bigint) =>
  devCreditAccount(h.db, { accountId, amountMicrousd: microusd, at: h.config.now(), note: "test" });

export async function createKey(h: Harness, s: LoggedIn, over: Record<string, unknown> = {}): Promise<{ id: string; secret: string }> {
  const r = await call<any>(h.app, "POST", "/api/keys", {
    cookie: s.cookie,
    body: { name: "t", scopes: ["gateway:invoke"], modelAllowlist: [], ...over },
    headers: { "Idempotency-Key": idemKey() },
  });
  if (r.status !== 201) throw new Error(`key create failed ${r.status} ${JSON.stringify(r.json)}`);
  return { id: r.json.key.id, secret: r.json.secret };
}

export async function funded(h: Harness, micro: bigint, keyOver: Record<string, unknown> = {}) {
  const s = await login(h.app);
  await fund(h, s.accountId, micro);
  const key = await createKey(h, s, keyOver);
  return { s, key };
}

export const newId = randomId;
