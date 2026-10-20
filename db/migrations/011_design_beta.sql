-- 011_design_beta (BETA, behind FEATURE_DESIGN_BETA): brief -> metered proposal -> revisions -> exportable artifact.
-- Additive. Rollback: drop design_revisions, designs. Generation cost lives in the existing requests / reservations /
-- usage_records / ledger tables (each revision points at its gateway-path request), never duplicated here.
-- Briefs, instructions and generated documents are user content stored until the design is deleted (delete is a real delete).

create table designs (
  id                  text primary key,
  seq                 bigint generated always as identity,
  account_id          text not null references accounts (id),
  project_id          text not null references projects (id),
  created_by_user_id  text not null references users (id),
  title               text not null check (length(title) between 1 and 120),
  brief               text not null check (length(brief) between 1 and 8000),
  model               text not null,
  created_at          timestamptz not null,
  updated_at          timestamptz not null
);
create index designs_project_idx on designs (project_id, created_at, id);

create table design_revisions (
  id                text primary key,
  design_id         text not null references designs (id) on delete cascade,
  account_id        text not null references accounts (id),
  number            integer not null check (number >= 1),
  kind              text not null check (kind in ('proposal', 'revision')),
  instruction       text check (instruction is null or length(instruction) <= 4000),
  status            text not null check (status in ('queued', 'generating', 'succeeded', 'failed')),
  model             text not null,
  request_id        text references requests (id),   -- the metered gateway-path request; null until generation begins
  max_cost_microusd numeric(30, 0) not null,          -- quote shown at creation (generic upper bound)
  lease_until       timestamptz,
  document          jsonb,
  failure_code      text,
  failure_message   text,
  created_at        timestamptz not null,
  started_at        timestamptz,
  finished_at       timestamptz,
  unique (design_id, number),
  check (status <> 'succeeded' or document is not null)
);
create index design_revisions_queue_idx on design_revisions (created_at, id) where status in ('queued', 'generating');
create index design_revisions_request_idx on design_revisions (request_id) where request_id is not null;
