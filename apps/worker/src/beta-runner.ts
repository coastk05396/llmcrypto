/**
 * In-process polling loop for the beta job runners (repository import, design generation). Same embedding model as the
 * export runner: a host process that owns the database (the dev API server today) starts it. No separate worker process can
 * share the embedded PGlite database, so none is scheduled; see apps/worker/src/index.ts.
 */
import type { SqlDb } from "@llmcrypto/domain";
import { runDesignGenerations, type DesignGenerationOptions } from "./design-generation";
import { runRepositoryImports } from "./repository-import";

export interface BetaRunnerOptions {
  db: SqlDb;
  now: () => Date;
  newId: (prefix: string) => string;
  /** Present only when a provider is configured; without it design revisions stay queued (no silent success). */
  design?: Omit<DesignGenerationOptions, "db" | "now" | "newId">;
  intervalMs?: number;
  onError?: (e: unknown) => void;
}

export function startBetaRunners(o: BetaRunnerOptions): { stop(): Promise<void>; kick(): Promise<void> } {
  let active: Promise<void> = Promise.resolve();
  let stopped = false;
  const tick = (): Promise<void> => {
    active = active
      .then(async () => {
        await runRepositoryImports({ db: o.db, now: o.now, newId: o.newId });
        if (o.design) await runDesignGenerations({ db: o.db, now: o.now, newId: o.newId, ...o.design });
      })
      .catch((e: unknown) => o.onError?.(e));
    return active;
  };
  const timer = setInterval(() => {
    if (!stopped) void tick();
  }, o.intervalMs ?? 2000);
  timer.unref();
  return {
    kick: tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
