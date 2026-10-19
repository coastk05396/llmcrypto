import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";

const WEB_PORT = 4173;
const API_PORT = 3101;
const CONTROL_PORT = 3102;
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

/** Test-only secrets, generated fresh for each run of the e2e command and passed to the API process only. */
const secret = () => randomBytes(32).toString("hex");

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../../node_modules/.cache/playwright-results",
  use: { baseURL: WEB_ORIGIN, trace: "off" },
  webServer: [
    {
      // The real API on in-memory PGlite (no network DB). Console specs hit it through the web origin's proxy.
      command: "pnpm --filter @llmcrypto/api exec tsx ../../tests/e2e/api-server.ts",
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        API_PORT: String(API_PORT),
        WEB_ORIGIN,
        E2E_CONTROL_PORT: String(CONTROL_PORT), // test-only funding / fake-chain control, loopback
        FEATURE_REPOSITORY_GRAPH: process.env["E2E_BETA_FLAGS"] ?? "true", // explicit test configuration only; production defaults remain off
        FEATURE_DESIGN_BETA: process.env["E2E_BETA_FLAGS"] ?? "true",
        ALLOW_TEST_COMPONENTS: "true", // required by the API for any test double below (FakeProvider, TestAddressProvider, dev credit helper)
        GATEWAY_PROVIDER: "fake", // deterministic FakeProvider: no real provider exists
        PAYMENT_ADDRESS_SOURCE: "test", // TestAddressProvider: addresses nobody holds keys for
        PAYMENT_NETWORKS_CONFIG: JSON.stringify({ routes: [
          { network: "testnet-a", asset: "TUSD", chainId: "1001", assetContract: "0x00000000000000000000000000000000000000a1", decimals: 6, confirmations: 3, expirySeconds: 3600, graceSeconds: 600, microusdPerToken: "1000000", overpayment: "review", minAmountAtomic: "1000000", maxAmountAtomic: "1000000000" },
          { network: "testnet-b", asset: "TUSD", chainId: "2002", assetContract: "0x00000000000000000000000000000000000000b2", decimals: 18, confirmations: 2, expirySeconds: 3600, graceSeconds: 0, microusdPerToken: "1000000", overpayment: "credit_full", minAmountAtomic: "1000000000000000", maxAmountAtomic: null },
        ] }),
        COOKIE_SECURE: "false", // plain-http loopback
        AUTH_EVM_CHAIN_IDS: "1",
        AUTH_TRON_NETWORKS: "mainnet,nile",
        SESSION_SECRET: secret(),
        API_KEY_HASH_PEPPER: secret(),
        KEY_REPLAY_ENCRYPTION_SECRET: secret(),
      },
    },
    {
      // Production build served by vite preview, proxying /api and /v1 to the API above. Public specs still mock /api explicitly.
      command: `pnpm --filter @llmcrypto/web build && pnpm --filter @llmcrypto/web exec vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
