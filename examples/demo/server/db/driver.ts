export type SqlValue = string | number | null;

/** The same SQL text runs on both backends: parameters are written as `?`, flags are `INTEGER` 0/1. */
export interface SqlDriver {
  readonly dialect: 'sqlite' | 'postgres';
  query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<{ rows: T[]; rowCount: number }>;
  close(): Promise<void>;
}
