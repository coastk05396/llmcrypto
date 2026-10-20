import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CatalogResponse } from "@llmcrypto/contracts";
import { describeFailure, getCatalog } from "../lib/api";
import { SAMPLE_CATALOG, SAMPLE_CATALOG_DATE } from "../lib/sample-catalog";

export type CatalogState =
  | { status: "loading" }
  | { status: "ready"; source: "api"; data: CatalogResponse; asOf: string }
  | { status: "ready"; source: "sample"; data: CatalogResponse; asOf: string; reason: string };

interface Ctx {
  state: CatalogState;
  reload: () => void;
}
const CatalogContext = createContext<Ctx | null>(null);

export function useCatalog(): Ctx {
  const ctx = useContext(CatalogContext);
  if (!ctx) throw new Error("CatalogProvider missing");
  return ctx;
}

/** Newest per-model `updatedAt` as a date; the contract carries the date per entry, not per response. */
function latestUpdate(data: CatalogResponse): string {
  const newest = data.items.map((m) => m.updatedAt).sort().at(-1);
  return newest ? newest.slice(0, 10) : "unknown";
}

/** One catalog fetch shared by Home and Diagnostics. Falls back to labelled sample data, never to silence. */
export function CatalogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CatalogState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setState({ status: "loading" });
    void getCatalog(ac.signal).then((r) => {
      if (ac.signal.aborted) return;
      if (r.ok) setState({ status: "ready", source: "api", data: r.data, asOf: latestUpdate(r.data) });
      else setState({ status: "ready", source: "sample", data: SAMPLE_CATALOG, asOf: SAMPLE_CATALOG_DATE, reason: describeFailure(r.error) });
    });
    return () => ac.abort();
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const value = useMemo(() => ({ state, reload }), [state, reload]);
  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}
