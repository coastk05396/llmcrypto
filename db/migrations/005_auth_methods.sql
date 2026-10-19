-- 005_auth_methods: password, Telegram one-time-code and API-key console sessions, recovery codes,
-- persisted sign-in attempt counters. Plain PostgreSQL (also runs on PGlite). Additive only: existing
-- sessions become kind 'wallet'. Rollback: drop the new tables and sessions.kind/method_ref (no data of
-- earlier migrations depends on them).

-- How a session was established. 'api_key' sessions are restricted (enforced centrally in the API).
-- method_ref = the linked identity / credential / API key id the session came from, so unlinking
-- or revoking that method can revoke exactly its sessions.
alter table sessions add column kind text not null default 'wallet' check (kind in ('wallet', 'password', 'telegram', 'api_key'));
alter table sessions add column method_ref text;
create index sessions_method_idx on sessions (method_ref) where method_ref is not null;

-- One password credential per user. username is stored normalised (lowercase) and is globally unique.
-- password_hash is a PHC string (argon2id with its own salt and parameters).
create table password_credentials (
  id             text primary key,
  user_id        text not null unique references users (id),
  username       text not null unique,
  password_hash  text not null,
  created_at     timestamptz not null,
  changed_at     timestamptz not null
);

-- Single-use, time-limited recovery codes. Only a keyed digest is stored; the plaintext is shown once at setup.
create table recovery_codes (
  id          text primary key,
  user_id     text not null references users (id),
  code_hash   text not null unique,
  created_at  timestamptz not null,
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index recovery_codes_user_idx on recovery_codes (user_id) where used_at is null;

create table telegram_identities (
  id                text primary key,
  user_id           text not null references users (id),
  telegram_user_id  text not null,
  created_at        timestamptz not null,
  unlinked_at       timestamptz
);
create unique index telegram_identities_active_uq on telegram_identities (telegram_user_id) where unlinked_at is null;
create index telegram_identities_user_idx on telegram_identities (user_id) where unlinked_at is null;

-- Server-issued one-time codes the user sends to the Telegram bot (only a keyed digest is stored).
-- consumed_at is set by one conditional UPDATE.
-- attempts counts verification tries; a code that reaches the cap is burned.
create table telegram_codes (
  id           text primary key,
  code_hash    text not null unique,
  purpose      text not null check (purpose in ('login', 'link', 'step_up')),
  user_id      text references users (id),
  session_id   text references sessions (id),
  created_at   timestamptz not null,
  expires_at   timestamptz not null,
  -- Set when the Telegram bot reported a message containing the code; the first claimer wins.
  claimed_telegram_user_id  text,
  claimed_at   timestamptz,
  consumed_at  timestamptz,
  attempts     integer not null default 0,
  check ((purpose = 'login') = (user_id is null and session_id is null))
);

-- Failed sign-in / recovery attempts, keyed by a keyed digest of (scope, subject) so no username or IP is stored.
create table auth_attempts (
  id        bigint generated always as identity primary key,
  scope     text not null,
  key_hash  text not null,
  at        timestamptz not null
);
create index auth_attempts_key_idx on auth_attempts (scope, key_hash, at);
