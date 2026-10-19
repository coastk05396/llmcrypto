# Deployment preparation

Status: **local development only; production deployment unauthorized and blocked**. No paid service, provider account, treasury, chain transfer or infrastructure provisioning is authorized. The [README](../../README.md) contains the reproducible local setup.

## Existing runtime

| Component | Entrypoint / artifact | Operational limit |
| --- | --- | --- |
| API | `apps/api/src/index.ts`, `pnpm --filter @llmcrypto/api start` | Runs TypeScript via tsx; PGlite memory or `pglite:<dir>` only; migrates on startup. |
| Web | `apps/web`, Vite; `apps/web/dist` from build | Local dev/preview proxies `/api` and `/v1`; no production proxy/TLS/static hosting configured. |
| Worker | `apps/worker/src/index.ts` | Keeps process alive; schedules no payment/usage reconciliation, export, notification or retention work. |
| Embedded beta jobs | API calls `startBetaRunners` | Repository polling and, when configured, fake design generation; not a separate shared worker deployment. |
| Database | `apps/api/src/db.ts`, `db/migrations/*.sql` | One embedded owner; no networked PostgreSQL driver/pool. |

`/healthz` returns `{ "ok": true }`; it does not test dependencies. `pnpm build` typechecks API/worker without emitting server binaries. No container image, deployment automation, migration-only/down CLI, readiness probe, or graceful shutdown/DB-close handler exists in the current API entrypoint. A local run is not a production artifact.

## Configuration review before any authorized staging run

- Preserve and privately back up `SESSION_SECRET`, `API_KEY_HASH_PEPPER`, `KEY_REPLAY_ENCRYPTION_SECRET`. Each must be at least 32 characters to enable dependent features; use random generated values and a reviewed secret store. No rotation procedure has been exercised.
- Match `WEB_ORIGIN` exactly to the browser origin; review `AUTH_DOMAIN`, allowed EVM chain IDs and TRON networks. Use secure cookies and TLS outside plain-HTTP local development. Review bind address and trusted-proxy/client-IP handling before exposure.
- Keep `PAYMENT_ADDRESS_SOURCE` unset and networks empty until custody and network policy are approved. Test addresses are unusable, and their provider requires explicit `ALLOW_TEST_COMPONENTS=true`. Setting provider/RPC variable names in `.env.example` does not implement real adapters.
- `GATEWAY_PROVIDER=fake` selects only the test double and requires `ALLOW_TEST_COMPONENTS=true`. Default/unrecognized values disable the gateway. Review sample catalog/pricing, quota/timeout settings and the unresolved-usage loss policy before a commercial release.
- `FEATURE_REPOSITORY_GRAPH` / `FEATURE_DESIGN_BETA` default off. Verify both enabled workflows separately; disabling them is not full product acceptance and does not prove queued jobs stopped.
- Review `OPERATOR_USER_IDS` as user IDs, not customer roles; use two distinct approved operators for adjustments. Freshness/elevation exists; a separate mandatory second factor is not implemented.

## Required future work (blocked, not delivered)

1. Implement networked PostgreSQL and a shared worker host. Verify multi-connection transactions/row locks, overspend races, duplicate settlement, migration ownership and worker claiming. PGlite serializes transactions; its concurrent Promise tests cannot prove PostgreSQL concurrency behavior. `tests/integration/pg-real.test.ts` separately exercises a genuine multi-connection PostgreSQL server for migration, reservation and settlement races; this test adapter is not connected to the application runtime.
2. Select and approve real LLM adapters, model/pricing truth, provider streaming/cancel/usage reconciliation, and bounded sandbox credentials. Select custody/address derivation and real EVM/TRON RPC adapters; approve chains/assets/contracts/finality/conversion/overpayment policy. No funds may move under current authorization.
3. Package immutable server/worker/web artifacts and pin runtime/dependencies; add reviewed TLS/proxy, readiness, graceful drain/close, single migration runner, schedules, secret management and least-privilege access. Do not scale API replicas against one PGlite directory.
4. Provision staging only after authorization. Run the release checks against the exact candidate, review findings, exercise [backup](backup.md), [rollback](rollback.md) and [paging](alerts.md), and measure representative load, chain lag, jobs and browser performance.
5. Record candidate/previous artifact IDs, migration manifest, configuration revision, approver and evidence. Obtain explicit production authorization last. No deployment or production smoke result is claimed here.
