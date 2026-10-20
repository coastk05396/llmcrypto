/** Structural database interfaces so the domain SQL stores run on any driver (apps/api Db satisfies them). */
export interface SqlExecutor {
  query<T extends object = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}
export interface SqlDb extends SqlExecutor {
  /** One transaction; any throw rolls back. The callback must use only the executor it is given. */
  tx<T>(fn: (q: SqlExecutor) => Promise<T>): Promise<T>;
}
