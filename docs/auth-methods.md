# Alternative sign-in methods (task 16, backend)

Wallet sign-in is documented in SPEC.md. This covers password, Telegram, API-key console sessions, recovery and step-up.
Code: `apps/api/src/auth/*`, migration `db/migrations/005_auth_methods.sql`, tests `tests/integration/auth-methods.test.ts`.

## Methods

| Method | Endpoints | Notes |
| --- | --- | --- |
| Password | `POST /api/auth/password/signup`, `/password/sessions`, `/password/recovery`; `POST|DELETE /api/auth/password` (link/unlink) | argon2id via `@node-rs/argon2@2.0.2` (OWASP minimum 19 MiB, t=2, p=1; configurable), 12-128 char passwords, case-insensitive usernames. Every sign-in failure is one generic 401. |
| Telegram one-time code | `POST /api/auth/telegram/codes`, `/telegram/sessions`, `/telegram/identities`; `DELETE /api/auth/telegram/identities/{id}` | Server-issued 8-char single-use code (10 min), stored only as a keyed digest, claimed through the `TelegramBot` port. |
| API-key console | `POST /api/auth/key-sessions` | Key needs `usage:read`. Restricted session, 1 h, renewable to 8 h. |

Linking is only ever from an existing, non-restricted session with a recent sign-in; identities owned by anyone are 409 (never merged).
`GET /api/auth/methods` lists all methods; removing one is blocked (`LAST_AUTH_METHOD`) if it is the user's last, counted across wallets, Telegram and password.
Removing a method (or a wallet) revokes every session established with it, including the caller's own if it used it.

## Abuse limits (persisted in `auth_attempts`)

Each attempt is written first, then counted: per account 10 / 15 min, per account+IP 5 / 15 min, per IP 30 / 15 min
(`config.auth.attempts`). Over a limit: 429 + `Retry-After`, even for a correct secret. Unknown accounts are counted identically. Success clears only the account+IP bucket.
Applies to password sign-in, recovery, step-up and API-key sign-in. Telegram codes are limited per code (30 unconfirmed tries burn it) and by the in-memory per-IP limiters.
`clientKey` is the socket address; `X-Forwarded-For` is ignored until a trusted-proxy setting exists.

## Recovery

Single-use, time-limited (90 days) recovery codes (8 x 50 bits) are issued at password setup and on regeneration (`POST /api/auth/recovery-codes`, recent sign-in), shown once, digest-only at rest.
`POST /api/auth/password/recovery` spends one code, sets a new password and revokes all sessions.
**Email recovery is BLOCKED: no email provider exists.** Users who lose both password and codes cannot recover a password-only account.
A Telegram-linked account can still sign in through Telegram.

## Sessions

`sessions.kind` is `wallet | password | telegram | api_key`. `requireSession` denies `api_key` sessions by default; only routes that opt in with `"key_scope"` (session view/logout/renew, `/api/usage`, `/api/usage/agent-runs`) are reachable, and they are narrowed to the key's own requests.
So a key session cannot reveal or create secrets, link identities, change security, create keys, read balance/ledger/deposits or export. It ends when the key is revoked or expires.
`POST /api/session/renew` rotates the cookie token and slides expiry up to an absolute ceiling (7 d; key sessions 8 h) and does not refresh step-up.
Step-up for privileged mutations: `POST /api/session/step-up` with `{password}` or a Telegram `step_up` code `{codeId}` from one of the user's own Telegram accounts. Wallet sessions still sign in again.

## Telegram: BLOCKED / limitations

- The real Telegram Bot API adapter is **BLOCKED: no bot token**. Only `FakeTelegramBot` exists; without an injected bot all Telegram endpoints answer 503.
- Login fixation: whoever sends the code to the bot first claims it. A code shown on a shared screen could sign the waiting browser into the claimant's account. Mitigation (showing the claiming handle for confirmation) is not built.

## Not built

Password change while signed in (use recovery codes), password reset by email, TOTP/WebAuthn, account deletion.
