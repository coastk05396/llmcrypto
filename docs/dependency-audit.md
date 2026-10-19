# Dependency audit — 2026-10-19

The native audit uses the workspace's pinned manager: `npx --yes pnpm@10.18.3 audit --prod --json` and `npx --yes pnpm@10.18.3 audit --json`. These are advisory checks, not proof that dependencies contain no unknown vulnerabilities.

Production dependency audit after maintenance: **zero reported vulnerabilities**. The full development graph retains one high and one low advisory with the bounded deferrals below. No forced audit remediation was used. Dependency installation scripts were disabled during upgrades.

Updated direct packages: React Router 7.18.2, Vite 7.3.5, Vitest 4.1.11, Ajv 8.18.0 and YAML 2.8.3. React Router remains in declarative browser mode; framework/SSR/RSC advisory paths are not evidence of an exploit in this SPA. Vitest's major update is verified with the existing unit, contract and integration suites; final results belong in [acceptance.md](acceptance.md).

| Remaining advisory | Reachability and reason for deferral | Owner and next review |
| --- | --- | --- |
| [braces stack exhaustion, high](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `typescript-eslint → typescript-estree → fast-glob → micromatch → braces@3.0.3`, development lint tooling only. The advisory lists no patched version. `eslint.config.js` uses fixed repository-owned globs; no uploaded archive, prompt or API input reaches this glob parser. Run lint only on trusted repository configuration; do not build a service that accepts arbitrary lint glob patterns. The production dependency audit does not include it. | Maintainer; 2026-11-02, or immediately when a patch or a reachable input path appears. |
| [esbuild Windows development server file read, low](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | Vite's `esbuild@0.27.7`; fixed upstream in 0.28.1. Current local verification runs under Linux/WSL and does not start esbuild's own development server. Vite's transformer dependency is not a deployed application server. Keep local development on loopback; review Vite's supported esbuild update rather than overriding a pre-1.0 dependency across its compatibility range during the application release. | Maintainer; 2026-11-02, before native Windows development-server use, or with the next compatible Vite patch. |

The release checklist must retain these exceptions until rechecked. A changed lockfile, deployment mode, untrusted lint configuration, or native Windows toolchain invalidates the reachability assessment.

Upgrade references: [React Router release](https://github.com/remix-run/react-router/releases/tag/react-router%407.18.2), [Vite release](https://github.com/vitejs/vite/releases/tag/v7.3.5), [Vitest 4 migration guide](https://v4.vitest.dev/guide/migration.html). Node must satisfy the selected Vite version (`>=22.12.0` for this project's Node 22+ baseline).
