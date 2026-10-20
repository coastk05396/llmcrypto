-- 007_optimization: per-account optimization policies (append-only versions) and applied/skipped evidence.
-- Additive. Rollback: drop optimization_evidence / optimization_policies and requests.policy_version
-- (no earlier table depends on them). Plain PostgreSQL (also runs on PGlite).
--
-- A policy change never edits a row: it appends version N+1 (a revert appends a copy of an old config), so the
-- full history stays inspectable and "reversible" means "append the previous config again". Version 0 is the
-- implicit default (every control off) and has no row.

create table optimization_policies (
  account_id          text not null references accounts (id),
  version             integer not null check (version >= 1),
  config              jsonb not null,
  reverted_from       integer,                     -- set when this version re-applies an older one
  note                text check (note is null or length(note) <= 200),
  created_by_user_id  text not null references users (id),
  created_at          timestamptz not null,
  primary key (account_id, version)
);
create trigger optimization_policies_immutable before update or delete on optimization_policies for each row execute function forbid_mutation();

-- Which policy version governed each gateway request (0 = defaults / no policy). Existing rows stay NULL = unknown.
alter table requests add column policy_version integer check (policy_version is null or policy_version >= 0);

-- One row per (request, enabled feature): applied, skipped (with the reason), advisory or blocked.
-- Never holds prompt text: only counts, reasons and (loop_guard only) a keyed digest of the request.
-- request_id has no foreign key because a loop_guard block happens before any request row exists.
create table optimization_evidence (
  id              text primary key,
  seq             bigint generated always as identity,   -- insertion order; breaks created_at ties deterministically
  account_id      text not null references accounts (id),
  request_id      text not null,
  policy_version  integer not null check (policy_version >= 0),
  feature         text not null check (feature in ('cache_accounting', 'concise_guidance', 'project_context', 'route_comparison', 'loop_guard')),
  status          text not null check (status in ('applied', 'skipped', 'advisory', 'blocked')),
  reason          text,
  detail          jsonb not null default '{}'::jsonb,
  fingerprint     text,                            -- loop_guard only: HMAC of the normalised messages
  scope_key       text,                            -- loop_guard only: run id, else key id
  created_at      timestamptz not null,
  unique (request_id, feature)
);
create index optimization_evidence_account_idx on optimization_evidence (account_id, created_at, seq);
create index optimization_evidence_loop_idx on optimization_evidence (account_id, scope_key, fingerprint, created_at) where fingerprint is not null;
create trigger optimization_evidence_immutable before update or delete on optimization_evidence for each row execute function forbid_mutation();
