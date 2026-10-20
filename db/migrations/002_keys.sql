-- 002_keys: minimal projects (full project management arrives with its own slice) and scoped API keys.
-- Only a keyed digest of the secret is stored (HMAC-SHA256 with a server pepper); the plaintext never is.
-- Rollback: drop table api_keys, projects (api_keys first; requests/reservations from 003 reference both, so roll 003+ back first).

create table projects (
  id          text primary key,
  account_id  text not null references accounts (id),
  name        text not null,
  created_at  timestamptz not null
);
create index projects_account_idx on projects (account_id);

create table api_keys (
  id                    text primary key,
  account_id            text not null references accounts (id),
  project_id            text references projects (id),
  name                  text not null,
  prefix                text not null,                 -- non-secret display prefix
  key_hash              text not null unique,
  scopes                jsonb not null check (jsonb_typeof(scopes) = 'array' and jsonb_array_length(scopes) > 0),
  model_allowlist       jsonb not null check (jsonb_typeof(model_allowlist) = 'array'),  -- [] = every model
  spend_cap_microusd    numeric(30, 0) check (spend_cap_microusd is null or spend_cap_microusd > 0),
  expires_at            timestamptz,
  created_by_user_id    text not null references users (id),
  created_at            timestamptz not null,
  last_used_at          timestamptz,
  revoked_at            timestamptz,
  revoked_by_user_id    text references users (id)
);
create index api_keys_account_idx on api_keys (account_id, created_at, id);
