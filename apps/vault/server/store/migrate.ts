import type { SqlDriver } from './driver';
import { MIGRATIONS, type Migration } from './migrations';

// Identifies the vault's migration lock in the database.
const ADVISORY_LOCK_KEY = 7_238_104_561;

/**
 * Everything in one transaction. Postgres's transaction-level lock, unlike the session-level one, also
 * works behind a pooler, and serializes replicas that start at the same time. In SQLite, `BEGIN IMMEDIATE`
 * already does this.
 */
export async function migrate(driver: SqlDriver, migrations: Migration[] = MIGRATIONS): Promise<void> {
  await driver.transaction(async (tx) => {
    if (driver.dialect === 'postgres') await tx.query(`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`);
    await tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const { rows } = await tx.query<{ version: number }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((row) => Number(row.version)));
    // An older vault version must not touch a schema it does not know.
    const latest = Math.max(0, ...migrations.map((migration) => migration.version));
    if ([...applied].some((version) => version > latest)) throw new Error('The database schema is newer than this vault');
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await tx.exec(migration[driver.dialect]);
      await tx.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ]);
    }
  });
}
