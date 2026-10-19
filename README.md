# llmcrypto

A local LLM gateway and account console workspace: React/Vite web, Hono API, typed contracts, SQL ledger and worker functions. The implemented runtime uses **embedded PGlite and deterministic test integrations**. Catalog entries/prices are samples; gateway output is from `FakeProvider`, chain observations use `FakeChainClient`, and test deposit addresses have no usable custody. Never send funds to them.

Product requirements are in [SPEC.md](SPEC.md); implementation evidence and remaining work are in [tasks/todo.md](tasks/todo.md). Some specification status text predates the authorized build. Local checks do not establish live integration or production readiness. Production deployment, paid resources and real funds remain unauthorized.

## Local setup

Prerequisites: Node.js ^22.12.0 or >=24.0.0, pnpm **10.18.3** (see `packageManager`), and a supported local browser. Run from the repository root:

```sh
pnpm install --frozen-lockfile
```

Create a private local `.env` with runtime-generated secrets. This refuses to overwrite an existing file; preserve existing values if you already have one. `.env` is ignored by Git. The API reads process environment; it does **not** automatically load this file.

```sh
node --input-type=module <<'NODE'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const env = {
  SESSION_SECRET: randomBytes(32).toString('hex'),
  API_KEY_HASH_PEPPER: randomBytes(32).toString('hex'),
  KEY_REPLAY_ENCRYPTION_SECRET: randomBytes(32).toString('hex'),
  WEB_ORIGIN: 'http://localhost:5173',
  API_PORT: '3001',
  COOKIE_SECURE: 'false', // Plain HTTP local development only.
  ALLOW_TEST_COMPONENTS: 'true', // Explicit local test adapters only.
  GATEWAY_PROVIDER: 'fake',
  FEATURE_REPOSITORY_GRAPH: 'false',
  FEATURE_DESIGN_BETA: 'false',
};
writeFileSync('.env', Object.entries(env).map(([k,v]) => `${k}=${v}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
NODE
set -a
source .env
set +a
export DATABASE_URL="pglite:$HOME/.local/share/llmcrypto/dev-db"
mkdir -p "$HOME/.local/share/llmcrypto"
pnpm --filter @llmcrypto/api start
```

Migrations apply at API startup with recorded SHA-256 checksums. Empty `DATABASE_URL` instead selects volatile memory storage; `postgres://` and `postgresql://` URLs are rejected. Only one process may open a persistent PGlite directory. Keep the three secrets stable across restarts; changing them affects sessions, key verification and encrypted idempotent replay respectively.

In another terminal, from the repository root:

```sh
pnpm --filter @llmcrypto/web dev --host localhost --port 5173 --strictPort
```

Open `http://localhost:5173` (the exact `WEB_ORIGIN`). Vite proxies `/api` and `/v1` to `http://127.0.0.1:3001`; use `API_PROXY_TARGET` when changing the API port. Check API liveness directly at `http://127.0.0.1:3001/healthz` and sample catalog at `/v1/models`. The liveness response is not a database/provider/worker readiness probe. The API entrypoint does not restrict its bind address to loopback: keep this setup on a trusted local machine with inbound access blocked.

Create/sign in to an account through `/app`. Gateway calls need an API key with `gateway:invoke` and test credit. To seed synthetic credit, stop the API, load the same environment in that terminal, then run:

```sh
ALLOW_DEV_CREDIT=true pnpm --filter @llmcrypto/api credit:dev <accountId> 10000000
pnpm --filter @llmcrypto/api start
```

The amount is integer micro-USD (10,000,000 = 10 synthetic USD); the CLI refuses `NODE_ENV=production`. Never run the CLI concurrently with the API on the same directory. Deposits are disabled without an approved network configuration and address source. Optional beta flags enable repository analysis and fake design generation; disabled means unavailable, not accepted/completed. See [integration limits](docs/integrations.md), [authentication](docs/auth-methods.md), [payments](docs/operations/payments.md) and [imports](docs/import-limits.md).

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:contract
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
```

These are commands to run, not a declaration that this checkout passed. E2E starts its own in-memory API and Vite preview on ports 3101/3102/4173; its loopback control server and fake funding/chain fixtures are test-only. `build` produces `apps/web/dist`; API and worker builds currently typecheck without emitting deployable server artifacts. `pnpm dev` starts all app dev scripts, including a worker entrypoint that stays alive but does not schedule reconciliation/export/notification jobs. API startup embeds only the repository/design beta runners.

## Release and recovery

Start with the [release checklist](docs/release-checklist.md), [deployment preparation](docs/operations/deployment.md), [backup drill](docs/operations/backup.md), [rollback](docs/operations/rollback.md) and [alerts](docs/operations/alerts.md). Live providers, custody/real chains, a networked PostgreSQL application runtime, production performance, off-site recovery and staging rollback are **blocked / unverified**. No cloud, hosting or database deployment is provisioned by these instructions.
