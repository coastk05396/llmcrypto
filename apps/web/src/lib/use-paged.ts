import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFailure, ApiResult } from "./api";
import { useSession } from "./session";

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export type PagedState<T> =
  | { status: "loading" }
  | { status: "error"; failure: ApiFailure }
  | { status: "ready"; items: T[]; nextCursor: string | null; loadingMore: boolean; moreError: ApiFailure | null };

/**
 * Cursor paging: the first page loads when `fetchPage` changes (identity = the filters), "load more" appends the next page.
 * A 401 goes to the session (sign-in screen). Pages are never merged across different filters.
 */
export function usePaged<T>(fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<ApiResult<Page<T>>>) {
  const { handleFailure } = useSession();
  const [state, setState] = useState<PagedState<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const ac = new AbortController();
    const gen = ++generation.current;
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    void fetchPage(null, ac.signal).then((r) => {
      if (ac.signal.aborted || gen !== generation.current) return;
      if (r.ok) setState({ status: "ready", items: r.data.items, nextCursor: r.data.nextCursor, loadingMore: false, moreError: null });
      else if (!handleFailure(r.error)) setState({ status: "error", failure: r.error });
    });
    return () => ac.abort();
  }, [fetchPage, tick, handleFailure]);

  const loadMore = useCallback(() => {
    setState((s) => (s.status === "ready" && s.nextCursor && !s.loadingMore ? { ...s, loadingMore: true, moreError: null } : s));
    const gen = generation.current;
    const cur = stateRef.current;
    if (cur.status !== "ready" || !cur.nextCursor) return;
    void fetchPage(cur.nextCursor, new AbortController().signal).then((r) => {
      if (gen !== generation.current) return;
      setState((s) => {
        if (s.status !== "ready") return s;
        if (r.ok) return { status: "ready", items: [...s.items, ...r.data.items], nextCursor: r.data.nextCursor, loadingMore: false, moreError: null };
        if (handleFailure(r.error)) return s;
        return { ...s, loadingMore: false, moreError: r.error };
      });
    });
  }, [fetchPage, handleFailure]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const patch = useCallback((fn: (items: T[]) => T[]) => setState((s) => (s.status === "ready" ? { ...s, items: fn(s.items) } : s)), []);
  return { state, loadMore, reload, patch };
}
