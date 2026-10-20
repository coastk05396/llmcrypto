# Repository graph: import limits and safety (task 22, backend, BETA)

Code: `apps/api/src/imports/routes.ts`, `apps/worker/src/{repository-import,repository-archive,beta-runner}.ts`,
`packages/domain/src/{repository-policy,repository-graph}.ts`, migration `db/migrations/010_repository_graph.sql`.
Tests: `tests/integration/{repository,repository-archive}.test.ts`, `packages/domain/src/repository-graph.test.ts`.

**Status and honesty.** The behaviour is the *proposal* in SPEC.md ("Repository graph proposal") and is **unconfirmed by the user**.
The reference product's hidden behaviour is unknown. The routes are behind `FEATURE_REPOSITORY_GRAPH` (default **off**; off answers
404 `FEATURE_DISABLED`). A deployment with the flag off has **not** delivered the product scope: it only has the feature unavailable.
`GET /api/features` reports the flags. External URL cloning is deliberately absent (needs an SSRF and credential design first).

## What it does

1. `POST /api/projects/{id}/repository-imports` with the **raw archive as the body** (ZIP or tar.gz, detected by magic bytes) and an
   `Idempotency-Key`. The API checks size and magic, stores the bytes in `repo_import_uploads`, queues a `repo_imports` row (202).
2. The worker (`runRepositoryImports`, claim with a lease, one runner per import) reads the archive **in memory**, applies the limits
   and exclusions below, scans imports, resolves them against the imported files and writes `repo_files`, `repo_skipped`, `repo_edges`.
   The stored archive is deleted when the job ends, whether it succeeded or failed.
3. Read: `GET .../repository-imports[/{id}]`, `/files`, `/edges` (filter by importing file, target path, target kind), `/graph?depth=1..4`
   (directory roll-up with up to three evidence lines per edge), `/export` (whole derived graph as JSON, attachment).
4. `DELETE .../repository-imports/{id}` is a real delete of the import and everything derived from it (foreign keys cascade), including a
   still-queued archive. Verified by test: no row in any `repo_*` table and none of the distinctive paths/snippets left anywhere in the database.
   Audit entries (`repository.*`) keep ids and counts only.

**No code is executed, ever.** Nothing is extracted to disk, no package manager or build runs, scripts inside the repository
(`postinstall`, `require(...)` bodies, Python `open(...)`) are text to a scanner. A test plants such code and asserts no side effect.
**Isolation:** every query is scoped by account, project and import; a foreign id is 404. Billing role has no access; delete needs
owner/admin or the uploader.

## Limits (defaults; env names in `.env.example`; hard ceilings in `HARD_IMPORT_LIMITS` cannot be raised by configuration)

| Limit | Default | Breach |
| --- | --- | --- |
| Upload size (compressed) | 25 MiB (`REPOSITORY_MAX_ARCHIVE_BYTES`, ceiling 100 MiB) | 413 `PAYLOAD_TOO_LARGE` at upload, stops reading the body at the limit |
| Archive entries (files + dirs + links) | 20 000 | whole import fails `ARCHIVE_TOO_MANY_ENTRIES` (ZIP: checked from the central directory before anything is read) |
| Decompressed total | 100 MiB (`REPOSITORY_MAX_TOTAL_BYTES`) | `ARCHIVE_EXPANDS_TOO_MUCH` (ZIP: declared sizes summed up front; tar.gz: decompression itself is capped, so a bomb never materialises) |
| Compression ratio | 100x (above a 256 KiB floor) | `ARCHIVE_EXPANDS_TOO_MUCH` (per ZIP entry and for the whole tar.gz) |
| One file | 1 MiB | that file is skipped, reason `too_large` |
| Files imported | 5 000 (`REPOSITORY_MAX_FILES`) | surplus skipped, reason `file_limit` |
| Path | 512 bytes, 32 levels | `ARCHIVE_UNSAFE_PATH` |
| Edges per import / per file | 50 000 / 5 000 | later edges dropped; `stats.edgesTruncated = true` |
| Scan time / lines | 20 s total (`maxParseMs`) / 100 000 lines per file (`maxParseLines`) | the file is left out of the graph, reason `parse_budget` |
| Imports in progress per project | 3 | 429 + `Retry-After` |
| Imports kept per project | 10 | 422; delete one first |

## Whole-archive rejections (import `failed`, code in `error.code`, nothing stored)

`ARCHIVE_UNSAFE_PATH` (`..` segments in any spelling incl. `\`, absolute, drive-letter, NUL/control characters, too long/deep),
`ARCHIVE_UNSAFE_LINK` (symlink or hardlink whose target is absolute or escapes the root; ZIP symlinks are recognised by their Unix mode),
`ARCHIVE_DUPLICATE_PATH` (case-insensitive, NFC), `ARCHIVE_MALFORMED` (truncated/corrupt data, size or CRC that disagrees with the header,
local vs central name mismatch, overlapping entries, bad tar checksum), `ARCHIVE_EXPANDS_TOO_MUCH`, `ARCHIVE_TOO_MANY_ENTRIES`,
`ARCHIVE_TOO_LARGE`, `ARCHIVE_FORMAT`, `ARCHIVE_UNSUPPORTED` (ZIP64, multi-disk, base-256 tar sizes).

In-root symlinks/hardlinks, devices and fifos are **not followed or read**; they are skipped (`symlink`, `link`, `special`). Encrypted ZIP entries
and unsupported compression are skipped (`encrypted`, `unsupported_compression`).

Scanner cost is bounded by construction (every look-ahead is capped: Go import blocks 20 000 characters, Python continuations 50 lines, lines over 4 000 characters are not scanned) and regression-tested with 256 KB crafted inputs (< 1 s). Analysis still runs on the worker's event loop; a `worker_thread` with a hard CPU deadline is NOT implemented (the time budget is checked between files, so a single pathological file is bounded only by the caps above).

## What is excluded (always reported with a reason; path and reason only)

* `vendor`: `node_modules`, `vendor`, `third_party`, `.git`, `.venv`, `__pycache__`, `dist`, `build`, `out`, `.next`, `target`, `coverage`, ...
* `generated`: lock files, `*.min.js`, `*.map`, `*.pb.go`, `*_pb2.py`, `*.generated.*`, snapshots.
* `secret` (by name): `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.netrc`, `credentials*`, `*.tfvars`, `terraform.tfstate*`, `.aws/`, `.ssh/`, ...
* `secret_content`: high-confidence shapes only (private key blocks, cloud access key ids, GitHub/Slack/Stripe-style tokens). The whole file is dropped.
  A generic "password = ..." rule is deliberately not used (it would drop half of all test files); **this is not a secret scanner** and a secret in
  an unrecognised shape inside an imported source file is not detected. Only the *import line* of a source file is ever stored, with URL credentials redacted in both evidence and specifiers. Evidence lines longer than 1,000 characters are omitted with an explicit marker rather than truncated through potentially sensitive URL userinfo; the sanitized specifier and source line number remain.
* `binary`: by extension, NUL byte in the first 8 KiB, or invalid UTF-8.

## What the graph is (and is not)

Static, lexical import scanning for JS/TS (`import`/`export ... from`, side-effect imports, `import()`, `require()`), Python (`import`, `from ... import`,
relative imports) and Go (single and grouped imports, `go.mod` module paths). Every edge has the importing file, the **1-based line of the statement**
(the first line of a multi-line statement) and that line's text. Targets are `file`, `directory` (Go packages, Python namespace packages), `external`
(package name) or `unresolved` (relative import to a file that is not in the import). Comments and string contents are masked so they are not read as imports.

Not resolved: TypeScript path aliases/`baseUrl`, bundler aliases, `package.json` `exports`, Python `sys.path` tricks, computed dynamic imports,
conditional compilation, Go build tags and `replace` directives, other languages. A regex literal containing a quote can hide the rest of its line.
The result is a navigation aid, not a verified dependency graph.

## Operations notes

* The job needs a runner. `startBetaRunners` (`apps/worker/src/beta-runner.ts`) is embedded in the dev API server only, because the sole
  database driver is embedded PGlite which a second process cannot share. No networked worker is scheduled (same limitation as exports).
* Memory: an import holds the upload and the decompressed archive in memory (bounded by the limits: worst case about 100 MiB plus the upload).
* Rollback: drop the five `repo_*` tables; nothing else references them.
