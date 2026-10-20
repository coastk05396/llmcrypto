# Local performance evidence

These are local lab observations from 2026-10-19, not production SLOs or field Core Web Vitals. Chromium ran headless under Linux/WSL against the production Vite build and a local API using PGlite and fake integrations, without CPU/network throttling.

Sixteen captures covered Home, Repository, Design and Operations at 390 and 1440 pixels, in light and dark themes. Reduced motion was enabled and keyboard Tab focus was checked. Every capture had equal document/client widths and no page errors. Observed LCP ranged from 100 to 360 ms; CLS ranged from 0 to 0.04875. INP was not measured. These one-run samples are insufficient to predict real devices, provider latency, concurrent users or production performance.

The initial JavaScript bundle is approximately 611 kB (172 kB gzip); Vite reports its 500 kB chunk warning. Route splitting and representative mobile measurements remain optimization work before production, rather than an inferred pass from fast loopback loading.

The ephemeral source record is `/tmp/llmcrypto-visual-20261019/results.json`, alongside the sixteen screenshots. Browser regressions in `tests/e2e` retain automated responsive, theme, accessibility, keyboard and reduced-motion checks. Capture artifacts are local review evidence and are not deployed assets.

Database contention evidence belongs to `tests/integration/pg-real.test.ts`: a genuine local PostgreSQL server exercises migration ownership, concurrent reservation limits, duplicate settlement, and settlement versus unrecoverable-usage races. The application itself still uses PGlite. No production load, shared worker throughput, provider/chain lag, sustained memory benchmark, staging recovery objective or real-device performance result is claimed.
