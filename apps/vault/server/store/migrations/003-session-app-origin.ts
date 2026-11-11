import type { Migration } from './index';

const sql = 'ALTER TABLE sessions ADD COLUMN app_origin TEXT;';

export const sessionAppOrigin: Migration = {
  version: 3,
  name: 'session-app-origin',
  sqlite: sql,
  postgres: sql,
};
