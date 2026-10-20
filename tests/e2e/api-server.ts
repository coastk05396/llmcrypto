import { grantOperator } from "../../apps/api/src/operator/service";
import { startBetaRunners } from "../../apps/worker/src/beta-runner";
import { FakeProvider } from "../../apps/api/src/gateway/fake-provider";
import { findCatalogModel } from "../../apps/api/src/catalog/routes";
import { ensureSamplePriceVersion } from "../../apps/api/src/gateway/prices";
/**
 * Starts the REAL apps/api (same createApp, migrations and routes) on in-memory PGlite for browser e2e.
 * The only deviation from apps/api/src/index.ts: console rate limits are raised so many sign-ins in one
 * minute do not 429. Secrets and origin come from the environment set by playwright.config.ts (runtime-generated,
 * never committed). The control surface (E2E_CONTROL_PORT) is test-only. Run with: pnpm --filter @llmcrypto/api exec tsx ../../tests/e2e/api-server.ts
 */
import { createServer } from "node:http";
import { serve } from "../../apps/api/node_modules/@hono/node-server/dist/index.mjs";
import { randomId } from "../../apps/api/src/crypto";
import { devCreditAccount } from "../../apps/api/src/dev/credit";
import { observeOnce } from "../../apps/worker/src/chain-observer";
import { FakeChainClient } from "../../apps/worker/src/fake-chain-client";
import { startJobRunner } from "../../apps/worker/src/export";
import { ChannelError, FakeChannelProvider } from "@llmcrypto/domain";
import { FakeTelegramBot } from "../../apps/api/src/auth/telegram";
import { runNotificationDelivery } from "../../apps/worker/src/notifications";
import { createApp } from "../../apps/api/src/app";
import { loadConfig } from "../../apps/api/src/config";
import { migrate, openPglite } from "../../apps/api/src/db";

const env = process.env;
for (const k of ["SESSION_SECRET", "API_KEY_HASH_PEPPER", "KEY_REPLAY_ENCRYPTION_SECRET", "WEB_ORIGIN", "API_PORT"]) {
  if (!env[k]) throw new Error(`${k} must be set by the e2e config`);
}
const high = { limit: 100_000, windowSeconds: 60 };
// Many specs share one loopback IP, so the per-IP attempt bucket is raised; the per-account and per-account+IP limits stay at their
// real values so a spec can reach the 429 + Retry-After path with a handful of wrong passwords.
const defaults = loadConfig(env);
const config = loadConfig(env, {
  rateLimits: { challenge: high, session: high, keys: high },
  auth: { ...defaults.auth, attempts: { ...defaults.auth.attempts, ip: { limit: 100_000, windowSeconds: 900 } } },
});
const db = await openPglite();
await migrate(db, config.migrationsDir);
const port = Number(env["API_PORT"]);
// Same beta workers as the dev entrypoint; all generation uses the explicit FakeProvider.
startBetaRunners({
  db, now: () => new Date(), newId: randomId, intervalMs: 200, onError: (e) => console.error("beta runner", e),
  ...(config.features.designBeta ? { design: {
    provider: new FakeProvider(), ensurePrices: () => ensureSamplePriceVersion(db, new Date()),
    contextWindowOf: (model: string) => { const m = findCatalogModel(model); return m ? Number(m.contextWindowTokens) : null; },
    maxOutputTokens: config.design.maxOutputTokens, timeoutMs: config.gateway.providerTimeoutMs,
    usagePendingSeconds: config.gateway.usagePendingSeconds,
  } } : {}),
});

// Export jobs are produced by the worker's job runner; embed it so POST /api/exports completes (same code the worker ships).
startJobRunner({ db, now: () => new Date(), newId: randomId, intervalMs: 200, onError: (e) => console.error("job runner", e) });

// Fake channel adapters. No Telegram bot token / WhatsApp credentials exist, so these in-process doubles are the only providers:
//  - telegramBot: Telegram sign-in, link and step-up (specs play the human through the control surface below)
//  - channels.telegram: notification channel (Connectivity); whatsapp is deliberately NOT registered so the UI shows "not configured".
const telegramBot = new FakeTelegramBot();
const telegramChannel = new FakeChannelProvider("telegram");
const channels = { telegram: telegramChannel };
// Notification deliveries are produced by the worker's runner (same code the worker ships); embed it like the export runner.
let delivering = false;
setInterval(() => {
  if (delivering) return;
  delivering = true;
  runNotificationDelivery({ db, channels, now: () => new Date(), newId: randomId, backoffSeconds: 1 })
    .catch((e: unknown) => console.error("notification runner", e))
    .finally(() => { delivering = false; });
}, 300).unref();

// TEST-ONLY control surface, loopback and a separate port from the API. It exists so specs can (a) fund an account through
// the dev credit helper and (b) move the FakeChainClient. None of this is reachable through the web origin or the API.
const chain = new FakeChainClient({ "testnet-a": "1001", "testnet-b": "2002" }, () => new Date());
const controlPort = Number(env["E2E_CONTROL_PORT"] ?? 0);
if (controlPort) {
  createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => {
      void (async () => {
        try {
          const body = raw ? (JSON.parse(raw) as Record<string, string | number>) : {};
          if (req.method === "POST" && req.url === "/operators/grant") {
            // Test-only out-of-band grant: never a product HTTP endpoint.
            const [u] = await db.query<{ user_id: string }>("select user_id from memberships where account_id=$1", [String(body["accountId"])]);
            if (!u) throw new Error("unknown test account");
            await grantOperator(db, { userId: u.user_id, grantedBy: "cli", at: new Date(), note: "e2e setup" });
          } else if (req.method === "POST" && req.url === "/credit") {
            await devCreditAccount(db, { accountId: String(body["accountId"]), amountMicrousd: BigInt(String(body["amountMicrousd"])), at: new Date(), note: "e2e setup" });
          } else if (req.method === "POST" && req.url === "/chain/pay") {
            const network = String(body["network"]);
            chain.send({ network, txHash: `0x${randomId("tx").replace(/\W/g, "").padEnd(64, "0").slice(0, 64)}`, assetContract: body["assetContract"] ? String(body["assetContract"]) : null, to: String(body["address"]), amountAtomic: BigInt(String(body["amountAtomic"])) });
            chain.mine(network, Number(body["blocks"] ?? 0));
            await observeOnce({ db, client: chain, now: () => new Date(), newId: randomId });
          } else if (req.method === "POST" && req.url === "/chain/advance") {
            chain.mine(String(body["network"]), Number(body["blocks"] ?? 1));
            await observeOnce({ db, client: chain, now: () => new Date(), newId: randomId });
          } else if (req.method === "POST" && req.url === "/telegram/send") {
            // plays the human sending a message to the sign-in bot
            telegramBot.userSends(String(body["senderId"]), String(body["text"]));
          } else if (req.method === "POST" && req.url === "/channel/send") {
            if (body["channel"] !== "telegram") throw new Error("only the telegram channel has a provider in this harness");
            telegramChannel.userSends(String(body["senderId"]), String(body["text"]));
          } else if (req.method === "POST" && req.url === "/channel/fail-next") {
            // the next send() fails permanently, so a failed delivery is visible in the UI
            telegramChannel.failNext(new ChannelError("permanent", "chat_not_found", "e2e injected permanent failure"));
          } else if (req.method === "GET" && req.url === "/channel/sent") {
            res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(telegramChannel.sent));
            return;
          } else if (req.method === "POST" && req.url === "/sessions/age") {
            // makes every session of the account look signed in long ago, so the next privileged call answers STEP_UP_REQUIRED
            await db.query("update sessions set authenticated_at = now() - interval '2 days' where account_id = $1", [String(body["accountId"])]);
          } else if (req.method === "POST" && req.url === "/sessions/shorten") {
            await db.query("update sessions set expires_at = now() + ($2::int * interval '1 second') where account_id = $1 and revoked_at is null", [String(body["accountId"]), Number(body["seconds"])]);
          } else {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
        }
      })();
    });
  }).listen(controlPort, "127.0.0.1");
}

serve({ fetch: createApp({ db, config, telegramBot, channels }).fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`e2e api on 127.0.0.1:${port}, origin ${config.allowedOrigins.join(",")}, domain ${config.authDomain}`);
});
