import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { migrate, openPglite } from "./db";
import { randomId } from "./crypto";
import { findCatalogModel } from "./catalog/routes";
import { FakeProvider } from "./gateway/fake-provider";
import { ensureSamplePriceVersion } from "./gateway/prices";
import { syncConfiguredOperators } from "./operator/service";
import { startBetaRunners } from "../../worker/src/beta-runner";

/**
 * Dev/test entrypoint. DATABASE_URL: empty = in-memory PGlite (data lost on exit); "pglite:<dir>" = persistent
 * embedded PostgreSQL. A networked PostgreSQL driver is not wired yet.
 */
const env = process.env;
const config = loadConfig(env);
const url = env["DATABASE_URL"] ?? "";
if (url && !url.startsWith("pglite:")) throw new Error('DATABASE_URL must be empty or "pglite:<dir>" until a PostgreSQL driver is added');
const db = await openPglite(url ? url.slice("pglite:".length) : undefined);
const { applied } = await migrate(db, config.migrationsDir);
const port = Number(env["API_PORT"] ?? 3001);
const missing = (["sessionSecret", "apiKeyPepper", "keyReplaySecret"] as const).filter((k) => !config[k]);
if (missing.length) console.warn(`secrets not configured (features fail closed): ${missing.join(", ")}`);
// Registering the sample price version fails (by design) when a version with this id already exists with DIFFERENT rates: a price
// change needs a new version id. Fail the deploy here instead of answering every gateway call with an error.
try {
  await ensureSamplePriceVersion(db, new Date());
} catch (e) {
  console.error(`price version check failed, refusing to start: ${e instanceof Error ? e.message : "unknown"}`);
  process.exit(1);
}
const ops = await syncConfiguredOperators(db, config);
if (ops.unknown.length) console.warn(`OPERATOR_USER_IDS names unknown users (ignored): ${ops.unknown.length}`);
// Embedded beta runners (repository import, design generation). Dev embedding only: the database is embedded PGlite, which a
// separate worker process cannot share. Design generation needs a provider; only the FakeProvider exists, so without
// GATEWAY_PROVIDER=fake design revisions stay queued.
const fake = config.gateway.provider === "fake" ? new FakeProvider() : null;
startBetaRunners({
  db, now: () => new Date(), newId: randomId, onError: (e) => console.error("beta runner", e),
  ...(fake && config.features.designBeta
    ? { design: { provider: fake, ensurePrices: () => ensureSamplePriceVersion(db, new Date()), contextWindowOf: (m: string) => { const x = findCatalogModel(m); return x ? Number(x.contextWindowTokens) : null; }, maxOutputTokens: config.design.maxOutputTokens, timeoutMs: config.gateway.providerTimeoutMs, usagePendingSeconds: config.gateway.usagePendingSeconds } }
    : {}),
});
serve({ fetch: createApp({ db, config }).fetch, port }, () => {
  console.log(`api listening on :${port}; migrations applied: ${applied.length}`);
});
