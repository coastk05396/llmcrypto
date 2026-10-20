import { useCallback, useEffect, useState } from "react";
import type { ApiFailure, ApiResult } from "./api";
import { useSession } from "./session";

export type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; failure: ApiFailure };

/**
 * Loads once per mount and on reload(). Earlier data stays visible while refreshing. A 401 is handed to the
 * session (sign-in screen) instead of being shown as a region error.
 */
export function useLoad<T>(fetcher: (signal: AbortSignal) => Promise<ApiResult<T>>) {
  const { handleFailure } = useSession();
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    void fetcher(ac.signal).then((r) => {
      if (ac.signal.aborted) return;
      if (r.ok) setState({ status: "ready", data: r.data });
      else if (!handleFailure(r.error)) setState({ status: "error", failure: r.error });
    });
    return () => ac.abort();
  }, [fetcher, tick, handleFailure]);
  return [state, useCallback(() => setTick((t) => t + 1), [])] as const;
}
