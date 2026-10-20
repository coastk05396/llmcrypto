-- 010_repository_graph (BETA, behind FEATURE_REPOSITORY_GRAPH): uploaded repository archives, the import job queue,
-- and the derived dependency graph. Additive. Rollback: drop repo_edges, repo_skipped, repo_files, repo_import_uploads, repo_imports.
-- No source file CONTENT is stored: only paths, sizes, hashes, import edges and the single import line as evidence.
-- The uploaded archive itself lives in repo_import_uploads only until the worker finishes (success or failure).
-- Everything hangs off repo_imports with ON DELETE CASCADE, so deleting an import removes every row derived from it.

create table repo_imports (
  id                  text primary key,
  account_id          text not null references accounts (id),
  project_id          text not null references projects (id),
  created_by_user_id  text not null references users (id),
  name                text not null,
  format              text not null check (format in ('zip', 'tar.gz')),
  upload_bytes        bigint not null check (upload_bytes > 0),
  upload_sha256       text not null,
  status              text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
  attempts            integer not null default 0,
  lease_until         timestamptz,
  limits              jsonb not null,            -- limits in force when the upload was accepted
  stats               jsonb,
  error_code          text,
  error_message       text,
  created_at          timestamptz not null,
  started_at          timestamptz,
  finished_at         timestamptz
);
create index repo_imports_project_idx on repo_imports (project_id, created_at, id);
create index repo_imports_queue_idx on repo_imports (created_at, id) where status in ('queued', 'running');

create table repo_import_uploads (
  import_id  text primary key references repo_imports (id) on delete cascade,
  body       bytea not null
);

create table repo_files (
  id          text primary key,
  seq         bigint generated always as identity,
  import_id   text not null references repo_imports (id) on delete cascade,
  account_id  text not null references accounts (id),
  project_id  text not null references projects (id),
  path        text not null,
  language    text,
  size_bytes  integer not null,
  line_count  integer not null,
  sha256      text not null,
  unique (import_id, path)
);
create index repo_files_import_idx on repo_files (import_id, seq);

-- Entries that were NOT imported and why (vendor, generated, secret, binary, too_large, symlink, ...). Path and reason only.
create table repo_skipped (
  import_id  text not null references repo_imports (id) on delete cascade,
  path       text not null,
  reason     text not null,
  primary key (import_id, path)
);

create table repo_edges (
  id             text primary key,
  seq            bigint generated always as identity,
  import_id      text not null references repo_imports (id) on delete cascade,
  account_id     text not null references accounts (id),
  project_id     text not null references projects (id),
  from_path      text not null,
  line           integer not null check (line >= 1),
  kind           text not null check (kind in ('import')),
  specifier      text not null,
  to_kind        text not null check (to_kind in ('file', 'directory', 'external', 'unresolved')),
  to_path        text,
  external_name  text,
  snippet        text not null,
  language       text not null
);
create index repo_edges_import_idx on repo_edges (import_id, seq);
create index repo_edges_from_idx on repo_edges (import_id, from_path);
create index repo_edges_to_idx on repo_edges (import_id, to_path) where to_path is not null;
