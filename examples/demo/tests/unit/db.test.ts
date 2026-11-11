import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeDb,
  confirmTotp,
  consumeTotpStep,
  createSession,
  createUser,
  deleteSession,
  getUserByEmail,
  getUserById,
  getUserByPendingSession,
  getUserBySession,
  hitRateLimit,
  normalizePostgresUrl,
  SESSION_TTL_MS,
  setTotpSecret,
} from '@/server/db';
import { poolSize } from '@/server/db/postgres';
import { postgresUrl, useTestDatabase, type TestDatabase } from './test-database';

let database: TestDatabase;
let counter = 0;

const PARAMS = { N: 2, r: 1, p: 1 };
const user = async () => (await createUser({ email: `db${++counter}@example.com`, passwordHash: 'hash', passwordSalt: 'salt', params: PARAMS }))!;

beforeAll(() => {
  database = useTestDatabase();
});

afterAll(async () => {
  await database.dispose();
});

beforeEach(async () => {
  await database.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe(`database (${postgresUrl ? 'Postgres' : 'SQLite'})`, () => {
  describe('users', () => {
    it('creates a user and reads it back by id and by email', async () => {
      const created = await user();
      expect(created).toMatchObject({ passwordHash: 'hash', passwordSalt: 'salt', params: PARAMS, totpSecretEnc: null, totpConfirmed: false, totpLastStep: null });
      expect(await getUserById(created.id)).toEqual(created);
      expect(await getUserByEmail(created.email)).toEqual(created);
      expect(await getUserByEmail('nobody@example.com')).toBeNull();
      expect(await getUserById('00000000-0000-0000-0000-000000000000')).toBeNull();
    });

    it('a duplicate email returns null and keeps the first account', async () => {
      const first = await user();
      expect(await createUser({ email: first.email, passwordHash: 'other', passwordSalt: 'other', params: PARAMS })).toBeNull();
      expect((await getUserByEmail(first.email))?.passwordHash).toBe('hash');
    });
  });

  describe('second factor', () => {
    it('the secret can be replaced until it is confirmed, never after', async () => {
      const { id } = await user();
      expect(await setTotpSecret(id, 'sealed-a')).toBe(true);
      expect(await setTotpSecret(id, 'sealed-b')).toBe(true);
      // Only the secret currently stored can be confirmed.
      expect(await confirmTotp(id, 'sealed-a')).toBe(false);
      expect(await confirmTotp(id, 'sealed-b')).toBe(true);
      expect(await setTotpSecret(id, 'sealed-c')).toBe(false);
      expect(await getUserById(id)).toMatchObject({ totpSecretEnc: 'sealed-b', totpConfirmed: true });
    });

    it('a step is accepted once, and never one before it', async () => {
      const { id } = await user();
      const step = 59_000_000;
      expect(await consumeTotpStep(id, step)).toBe(true);
      expect(await consumeTotpStep(id, step)).toBe(false);
      expect(await consumeTotpStep(id, step - 1)).toBe(false);
      expect(await consumeTotpStep(id, step + 1)).toBe(true);
      expect((await getUserById(id))?.totpLastStep).toBe(step + 1);
    });

    it('concurrent requests with the same step: exactly one is accepted', async () => {
      const { id } = await user();
      const results = await Promise.all(Array.from({ length: 8 }, () => consumeTotpStep(id, 59_000_000)));
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('sessions', () => {
    it('pending and complete sessions are not interchangeable', async () => {
      const { id } = await user();
      const pending = await createSession(id, { secondFactorDone: false });
      const complete = await createSession(id, { secondFactorDone: true });
      expect(await getUserBySession(pending)).toBeNull();
      expect((await getUserByPendingSession(pending))?.id).toBe(id);
      expect((await getUserBySession(complete))?.id).toBe(id);
      expect(await getUserByPendingSession(complete)).toBeNull();
      expect(await getUserBySession('not-a-token')).toBeNull();
    });

    it('stores only the token hash, and deleting a session ends it', async () => {
      const { id } = await user();
      const token = await createSession(id, { secondFactorDone: true });
      expect(JSON.stringify(await database.rows('SELECT * FROM sessions'))).not.toContain(token);
      await deleteSession(token);
      expect(await getUserBySession(token)).toBeNull();
    });

    it('an expired session is not returned, and the next login purges it', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
      const { id } = await user();
      const expired = await createSession(id, { secondFactorDone: true });
      vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1);
      expect(await getUserBySession(expired)).toBeNull();
      expect(await database.rows('SELECT token_hash FROM sessions')).toHaveLength(1);
      const fresh = await createSession(id, { secondFactorDone: true });
      expect(await database.rows('SELECT token_hash FROM sessions')).toHaveLength(1);
      expect((await getUserBySession(fresh))?.id).toBe(id);
    });
  });

  describe('rate limits', () => {
    const WINDOW_MS = 60_000;

    it('counts hits per bucket and starts again in the next window', async () => {
      const start = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
      vi.useFakeTimers({ toFake: ['Date'], now: start + 1000 });
      expect(await hitRateLimit('login:ip:a', WINDOW_MS)).toEqual({ hits: 1, resetAt: start + WINDOW_MS });
      expect((await hitRateLimit('login:ip:a', WINDOW_MS)).hits).toBe(2);
      expect((await hitRateLimit('login:ip:b', WINDOW_MS)).hits).toBe(1);
      vi.setSystemTime(start + WINDOW_MS);
      expect(await hitRateLimit('login:ip:a', WINDOW_MS)).toEqual({ hits: 1, resetAt: start + 2 * WINDOW_MS });
    });

    it('an instance whose clock lags behind adds to the newer window instead of resetting it', async () => {
      const start = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
      vi.useFakeTimers({ toFake: ['Date'], now: start + WINDOW_MS });
      await hitRateLimit('lag', WINDOW_MS);
      vi.setSystemTime(start + 1000);
      expect(await hitRateLimit('lag', WINDOW_MS)).toEqual({ hits: 2, resetAt: start + 2 * WINDOW_MS });
    });

    it('concurrent hits each get a distinct count', async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => hitRateLimit('concurrent', WINDOW_MS)));
      expect(results.map(({ hits }) => hits).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('expired buckets are purged', async () => {
      const start = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
      // Far enough ahead that the purge interval has elapsed whatever ran before in this process.
      vi.useFakeTimers({ toFake: ['Date'], now: start + 10 * WINDOW_MS });
      await hitRateLimit('old', WINDOW_MS);
      vi.setSystemTime(start + 20 * WINDOW_MS);
      await hitRateLimit('new', WINDOW_MS);
      expect((await database.rows('SELECT bucket FROM rate_limits')).map(({ bucket }) => bucket)).toEqual(['new']);
    });
  });

  describe('backend selection', () => {
    const saved = { DATABASE_URL: process.env.DATABASE_URL, VERCEL: process.env.VERCEL };

    afterEach(() => {
      process.env.DATABASE_URL = saved.DATABASE_URL ?? '';
      if (saved.VERCEL === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = saved.VERCEL;
    });

    beforeAll(() => {
      saved.DATABASE_URL = process.env.DATABASE_URL;
      saved.VERCEL = process.env.VERCEL;
    });

    it('a DATABASE_URL that is not postgres:// fails without echoing it', async () => {
      for (const url of ['mysql://demo:secret-password@db.example.test/demo', 'sqlite:secret-password.db', 'secret-password']) {
        process.env.DATABASE_URL = url;
        const error = await getUserById('x').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('DATABASE_URL must start with postgres:// or postgresql://');
        expect(String((error as Error).stack)).not.toContain('secret-password');
      }
    });

    it('on Vercel a database URL is required: no silent SQLite file', async () => {
      process.env.VERCEL = '1';
      process.env.DATABASE_URL = '';
      await expect(getUserById('x')).rejects.toThrow('DATABASE_URL is required on Vercel');
      delete process.env.DATABASE_URL;
      await expect(getUserById('x')).rejects.toThrow('DATABASE_URL is required on Vercel');
    });

    it('a failed open is not cached', async () => {
      if (!postgresUrl) return;
      await closeDb();
      // Nothing listens on port 1: the open fails, and the next call with the right URL opens normally.
      process.env.DATABASE_URL = 'postgres://demo:secret-password@127.0.0.1:1/demo';
      const error = await getUserById('x').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain('secret-password');
      process.env.DATABASE_URL = postgresUrl;
      expect(await getUserById('x')).toBeNull();
    });
  });
});

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

describe('DATABASE_POOL_SIZE', () => {
  it('defaults to 5 and accepts 1 to 200', () => {
    expect(poolSize(undefined)).toBe(5);
    expect(poolSize('')).toBe(5);
    expect(poolSize('1')).toBe(1);
    expect(poolSize('200')).toBe(200);
  });

  it('rejects anything else without echoing it', () => {
    for (const value of ['0', '201', '1.5', '-1', ' 5', '5x', 'secret']) {
      expect(() => poolSize(value)).toThrow('DATABASE_POOL_SIZE must be an integer from 1 to 200');
    }
  });
});
