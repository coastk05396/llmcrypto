/**
 * Worker entrypoint. The export job runner (./export) polls the `jobs` outbox table; embed it with startJobRunner() in a host process. Chain observation (./chain-observer) and payment reconciliation (./reconcile-payments) exist behind the ChainClient interface; only the FakeChainClient is implemented and no loop is scheduled here (no real adapter or shared DB driver yet). The USAGE_PENDING
 * reconciliation job lives in ./reconcile-usage; it needs a shared database, and the only driver wired so far is
 * embedded PGlite, which a second process cannot share with the API. Until a networked PostgreSQL driver exists
 * the job runs in tests and can be embedded by a host process; this entrypoint does not poll.
 */
export { reconcileUsage, NO_USAGE_SOURCE } from "./reconcile-usage";
export type { ChainClient, TransferRef } from "./chain-client";
export { observeOnce } from "./chain-observer";
export { reconcilePayments } from "./reconcile-payments";
export { FakeChainClient } from "./fake-chain-client";
export { runPendingJobs, startJobRunner } from "./export";
export type { ExportParams, JobRunnerOptions, RunReport } from "./export";
export { csvCell } from "./csv";
export { runNotificationDelivery } from "./notifications";
export type { DeliveryReport, DeliveryRunnerOptions } from "./notifications";
export { purgeExpiredMemories } from "./memory-retention";
export { runRepositoryImports, analyzeEntries } from "./repository-import";
export type { RepoImportOptions, RepoImportReport } from "./repository-import";
export { runDesignGenerations, designRequestId } from "./design-generation";
export type { DesignGenerationOptions, DesignGenerationReport } from "./design-generation";
export { startBetaRunners } from "./beta-runner";
export type { BetaRunnerOptions } from "./beta-runner";
export { meteredComplete } from "./metered-completion";
export type { CompletionProvider } from "./metered-completion";
console.log("worker started: no database driver for a shared deployment yet, reconcile loop not scheduled");
setInterval(() => undefined, 60_000);
