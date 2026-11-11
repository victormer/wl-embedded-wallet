import { describe, expect, it } from 'vitest';
import { normalizePostgresUrl } from '../../server/store/postgres-url';

// Same rules as the demo's copy (`examples/demo/server/db/postgres-url.ts`).
describe('Postgres URL normalisation', () => {
  const base = 'postgres://demo:p%40ss@ep-cool-name-123.eu-central-1.aws.neon.tech/neondb';

  it('maps sslmode aliases of verify-full to verify-full', () => {
    for (const mode of ['require', 'prefer', 'verify-ca']) {
      expect(normalizePostgresUrl(`${base}?sslmode=${mode}`)).toEqual({ connectionString: `${base}?sslmode=verify-full`, enableChannelBinding: false });
    }
    for (const mode of ['disable', 'verify-full', 'no-verify', 'allow']) {
      expect(normalizePostgresUrl(`${base}?sslmode=${mode}`).connectionString).toBe(`${base}?sslmode=${mode}`);
    }
  });

  it('turns channel_binding=require into the Pool option and drops the parameter', () => {
    expect(normalizePostgresUrl(`${base}?sslmode=require&channel_binding=require`)).toEqual({ connectionString: `${base}?sslmode=verify-full`, enableChannelBinding: true });
    expect(normalizePostgresUrl(`${base}?channel_binding=require&sslmode=require`)).toEqual({ connectionString: `${base}?sslmode=verify-full`, enableChannelBinding: true });
    for (const value of ['disable', 'prefer']) {
      expect(normalizePostgresUrl(`${base}?channel_binding=${value}`)).toEqual({ connectionString: base, enableChannelBinding: false });
    }
  });

  it('keeps everything else verbatim', () => {
    expect(normalizePostgresUrl(base)).toEqual({ connectionString: base, enableChannelBinding: false });
    const extra = 'options=-c%20search_path%3Ddemo&application_name=demo+app';
    expect(normalizePostgresUrl(`${base}?${extra}&sslmode=require`).connectionString).toBe(`${base}?${extra}&sslmode=verify-full`);
    expect(normalizePostgresUrl(`postgresql://u:p@localhost:5432/db?sslmode=require`).connectionString).toBe('postgresql://u:p@localhost:5432/db?sslmode=verify-full');
  });

  it('an unparsable URL fails without echoing it', () => {
    expect(() => normalizePostgresUrl('postgres://demo:secret-password@[bad')).toThrow('DATABASE_URL is not a valid URL');
    try {
      normalizePostgresUrl('postgres://demo:secret-password@[bad');
    } catch (error) {
      expect((error as Error).cause).toBeUndefined();
      expect(String((error as Error).stack)).not.toContain('secret-password');
    }
  });
});
