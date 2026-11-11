import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SqlDriver, SqlExecutor, SqlValue } from './driver';

const BUSY_TIMEOUT_MS = 5000;
const READS = /^\s*(SELECT|PRAGMA)\b/i;
// A write with `RETURNING` hands back its rows, like a read.
const RETURNING = /\bRETURNING\b/i;

// Per file: within the same process, another connection cannot wait for an open transaction without blocking
// the thread that must finish it. Across processes, `busy_timeout` already waits.
const queues = new Map<string, Promise<unknown>>();

export function openSqlite(path: string): SqlDriver {
  // `turbopackIgnore`: without it, a dynamic path makes Next include the whole project in the output.
  mkdirSync(/*turbopackIgnore: true*/ dirname(path), { recursive: true });
  closeSync(openSync(/*turbopackIgnore: true*/ path, 'a', 0o600));
  chmodSync(/*turbopackIgnore: true*/ path, 0o600);
  const database = new DatabaseSync(path);
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);
  const queue = resolve(path);

  const direct: SqlExecutor = {
    async query<T>(sql: string, params: SqlValue[] = []) {
      const statement = database.prepare(sql);
      if (READS.test(sql) || RETURNING.test(sql)) {
        const rows = statement.all(...params) as T[];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: Number(statement.run(...params).changes) };
    },
    async exec(sql: string) {
      database.exec(sql);
    },
  };

  // A transaction cannot interleave with other operations on the connection.
  function serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = (queues.get(queue) ?? Promise.resolve()).then(run, run);
    queues.set(queue, next.catch(() => undefined));
    return next;
  }

  return {
    dialect: 'sqlite',
    query: (sql, params) => serialized(() => direct.query(sql, params)),
    exec: (sql) => serialized(() => direct.exec(sql)),
    transaction: (run) =>
      serialized(async () => {
        database.exec('BEGIN IMMEDIATE');
        try {
          const result = await run(direct);
          database.exec('COMMIT');
          return result;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      }),
    close: () =>
      serialized(async () => {
        database.close();
      }),
  };
}
