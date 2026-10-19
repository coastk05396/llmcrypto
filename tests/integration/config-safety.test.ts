/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect untyped JSON bodies */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/api/src/config";
import { devCreditAccount } from "../../apps/api/src/dev/credit";
import { TestAddressProvider } from "../../apps/api/src/payments/address-provider";
import { call, makeHarness } from "./helpers";

const SECRET = "s".repeat(32);
const good = { SESSION_SECRET: SECRET, API_KEY_HASH_PEPPER: SECRET, KEY_REPLAY_ENCRYPTION_SECRET: SECRET };

describe("fail-closed configuration", () => {
  it("test doubles need ALLOW_TEST_COMPONENTS=true, whatever NODE_ENV is", () => {
    for (const env of [{ GATEWAY_PROVIDER: "fake" }, { PAYMENT_ADDRESS_SOURCE: "test" }, { GATEWAY_PROVIDER: "fake", NODE_ENV: "development" }]) {
      expect(() => loadConfig({ ...good, ...env })).toThrow(/ALLOW_TEST_COMPONENTS/);
    }
    expect(loadConfig({ ...good, GATEWAY_PROVIDER: "fake", PAYMENT_ADDRESS_SOURCE: "test", ALLOW_TEST_COMPONENTS: "true" })).toMatchObject({ testComponents: true });
    expect(loadConfig(good)).toMatchObject({ testComponents: false, gateway: { provider: "none" } });
  });

  it("the dev credit helper and the test address provider refuse to run without the flag", async () => {
    const prior = process.env["ALLOW_TEST_COMPONENTS"];
    delete process.env["ALLOW_TEST_COMPONENTS"];
    try {
      await expect(devCreditAccount(undefined as any, { accountId: "a", amountMicrousd: 1n, at: new Date() })).rejects.toThrow(/ALLOW_TEST_COMPONENTS/);
      await expect(new TestAddressProvider().addressFor({ intentId: "i", network: "n", asset: "a" })).rejects.toThrow(/ALLOW_TEST_COMPONENTS/);
    } finally {
      if (prior !== undefined) process.env["ALLOW_TEST_COMPONENTS"] = prior;
    }
  });

  it("secrets shorter than 32 characters abort startup; 32 is accepted; unset stays 'not configured'", () => {
    for (const k of ["SESSION_SECRET", "API_KEY_HASH_PEPPER", "KEY_REPLAY_ENCRYPTION_SECRET"]) {
      expect(() => loadConfig({ ...good, [k]: "x".repeat(31) })).toThrow(/shorter than 32/);
      expect(() => loadConfig({ ...good, [k]: "x".repeat(32) })).not.toThrow();
    }
    expect(loadConfig({}).sessionSecret).toBeUndefined();
  });

  it("an unconfigured secret answers 503 without naming the setting", async () => {
    const h = await makeHarness({ sessionSecret: undefined });
    try {
      const r = await call<any>(h.app, "GET", "/api/session", {});
      expect(r.status).toBe(503);
      expect(JSON.stringify(r.json)).not.toMatch(/SESSION_SECRET|PEPPER|REPLAY/);
    } finally {
      await h.db.close();
    }
  });
});
