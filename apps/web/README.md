# apps/web

React 19 + Vite 7 SPA: public catalog/setup/docs pages and the signed-in console (`/app`: Overview, Usage and logs, Request detail, Agent runs, Credits, API keys, Security).

## Run locally (same-origin API through the Vite proxy)

The browser only talks to the web origin. Vite forwards `/api` (cookie session, console API) and `/v1` (gateway) to the API process, so session cookies stay same-origin and no CORS is involved.

```sh
# 1. API (in-memory PGlite). Secrets are placeholders you generate locally; never commit them.
export WEB_ORIGIN=http://localhost:5173   # must equal the origin you open in the browser
export COOKIE_SECURE=false                # plain-http localhost only
export SESSION_SECRET=$(openssl rand -hex 32)
export API_KEY_HASH_PEPPER=$(openssl rand -hex 32)
export KEY_REPLAY_ENCRYPTION_SECRET=$(openssl rand -hex 32)
npx --yes pnpm@10.18.3 --filter @llmcrypto/api start        # listens on :3001 (API_PORT)

# 2. Web (second terminal)
npx --yes pnpm@10.18.3 --filter @llmcrypto/web dev          # http://localhost:5173
```

- `API_PROXY_TARGET` overrides the proxy target (default `http://127.0.0.1:3001`); it applies to `vite` and `vite preview`.
- Wallet sign-in signs a message whose domain is the host of `WEB_ORIGIN` (`AUTH_DOMAIN` can override); open the app on exactly that origin or the server rejects the signature.
- EVM chains accepted for sign-in default to `1` (`AUTH_EVM_CHAIN_IDS`), TRON to `mainnet` (`AUTH_TRON_NETWORKS`).

## Browser e2e

`pnpm test:e2e` starts the real API (`tests/e2e/api-server.ts`, in-memory PGlite, run-time generated test secrets, raised rate limits) and the built web app via `vite preview` with the same proxy, then drives an injected mock wallet. Console specs hit the real API; `public.spec.ts` and `diagnostics.spec.ts` mock `/api` explicitly.
