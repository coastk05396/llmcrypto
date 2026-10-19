-- 008_project_memory: explicit, versioned project notes, per-project retention and usage evidence.
-- Additive. Rollback: drop the three tables. Notes hold only text the user typed with storageConsent=true;
-- nothing is ingested automatically.

create table project_memories (
  id                  text primary key,
  seq                 bigint generated always as identity,   -- insertion order; breaks created_at ties deterministically
  account_id          text not null references accounts (id),
  project_id          text not null references projects (id),
  text                text not null check (length(text) between 1 and 10000),
  version             integer not null default 1 check (version >= 1),
  inject              boolean not null default false,       -- eligible for scoped injection (still needs the policy opt-in)
  created_by_user_id  text not null references users (id),
  updated_by_user_id  text not null references users (id),
  created_at          timestamptz not null,
  updated_at          timestamptz not null
);
create index project_memories_project_idx on project_memories (project_id, created_at, seq);

-- Retention: a note expires retention_days after its last edit; NULL keeps notes until the user deletes them.
-- Expired notes are invisible and never injected; the worker deletes them for real.
create table project_memory_settings (
  project_id          text primary key references projects (id),
  account_id          text not null references accounts (id),
  retention_days      integer check (retention_days is null or retention_days between 1 and 365),
  version             integer not null default 1,
  updated_by_user_id  text not null references users (id),
  updated_at          timestamptz not null
);

-- "Note N version V used in request R". Keeps ids and versions only (no text), and deliberately no foreign key
-- to project_memories so the evidence survives deleting the note.
create table memory_usage (
  id          text primary key,
  seq         bigint generated always as identity,
  account_id  text not null references accounts (id),
  project_id  text not null references projects (id),
  memory_id   text not null,
  version     integer not null,
  request_id  text not null,
  status      text not null check (status in ('injected', 'skipped')),
  reason      text,
  created_at  timestamptz not null
);
create index memory_usage_project_idx on memory_usage (project_id, created_at, seq);
create index memory_usage_request_idx on memory_usage (request_id);
create trigger memory_usage_immutable before update or delete on memory_usage for each row execute function forbid_mutation();
