export type SqlValue = string | number | null;

export interface SqlExecutor {
  /** Parameters are written as `?` in both dialects. */
  query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<{ rows: T[]; rowCount: number }>;
  /** Several statements without parameters. */
  exec(sql: string): Promise<void>;
}

export interface SqlDriver extends SqlExecutor {
  readonly dialect: 'sqlite' | 'postgres';
  transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
