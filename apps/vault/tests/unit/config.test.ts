import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { hexEncode } from '@wl-embedded-wallet/core/encoding';
import { normalizeOrigin, publicRuntimeConfig, validateConfig } from '../../server/config';

const manifest = ed25519.keygen();
const handoff = ed25519.keygen();

const VALID = {
  MASTER_KEY: 'ab'.repeat(32),
  MANIFEST_SIGNING_KEY: hexEncode(manifest.secretKey),
  HANDOFF_JWKS_URL: 'https://app.example.test/.well-known/jwks.json',
  HANDOFF_ISSUER: 'https://app.example.test',
  VAULT_SERVICE_TOKEN: 'cd'.repeat(32),
  ORIGIN: 'https://vault.example.test',
  RP_ID: 'vault.example.test',
  ALLOWED_APP_ORIGINS: 'https://app.example.test, https://other.example.test',
  DATABASE_URL: 'postgres://vault:secret-password@db.example.test/vault?sslmode=require',
};

const variables = (env: Record<string, string | undefined>, production = true) => validateConfig(env, production).map((issue) => issue.variable);

describe('normalizeOrigin', () => {
  it('keeps scheme, host and port', () => {
    expect(normalizeOrigin('https://App.Example.test')).toBe('https://app.example.test');
    expect(normalizeOrigin('https://app.example.test/')).toBe('https://app.example.test');
    expect(normalizeOrigin('https://app.example.test:8443')).toBe('https://app.example.test:8443');
    expect(normalizeOrigin('https://app.example.test:443')).toBe('https://app.example.test');
  });

  it.each(['https://app.test/path', 'https://app.test/?a=1', 'https://app.test/#x', 'https://u:p@app.test', 'ftp://app.test', 'null', '', 5, null])('rejects %j', (value) => {
    expect(normalizeOrigin(value, true)).toBeNull();
  });

  it('requires HTTPS except on local hosts with the exception enabled', () => {
    expect(normalizeOrigin('http://app.test', true)).toBeNull();
    expect(normalizeOrigin('http://app.localhost:3200', true)).toBe('http://app.localhost:3200');
    expect(normalizeOrigin('http://app.localhost:3200', false)).toBeNull();
  });
});

describe('validateConfig', () => {
  it('ALLOWED_APP_ORIGINS is optional, and is validated when set', () => {
    expect(validateConfig({ ...VALID, ALLOWED_APP_ORIGINS: undefined }, true)).toEqual([]);
    expect(variables({ ...VALID, ALLOWED_APP_ORIGINS: 'http://app.example.test' })).toEqual(['ALLOWED_APP_ORIGINS']);
  });

  describe('integrator token verification', () => {
    const withKey = { ...VALID, HANDOFF_JWKS_URL: undefined, HANDOFF_PUBLIC_KEY: hexEncode(handoff.publicKey) };

    it('accepts JWKS or, alternatively, a fixed key, but not both and not neither', () => {
      expect(validateConfig(VALID, true)).toEqual([]);
      expect(validateConfig(withKey, true)).toEqual([]);
      expect(variables({ ...withKey, HANDOFF_JWKS_URL: VALID.HANDOFF_JWKS_URL })).toEqual(['HANDOFF_JWKS_URL']);
      expect(variables({ ...VALID, HANDOFF_JWKS_URL: undefined })).toEqual(['HANDOFF_JWKS_URL']);
      expect(variables({ ...VALID, HANDOFF_JWKS_URL: '' })).toEqual(['HANDOFF_JWKS_URL']);
    });

    it('a JWKS over http is only accepted on local hosts with ALLOW_INSECURE_LOCAL', () => {
      const local = 'http://app.localhost:3200/.well-known/jwks.json';
      expect(variables({ ...VALID, HANDOFF_JWKS_URL: local })).toEqual(['HANDOFF_JWKS_URL']);
      expect(variables({ ...VALID, HANDOFF_JWKS_URL: local, ALLOW_INSECURE_LOCAL: '1' })).toEqual([]);
      expect(variables({ ...VALID, HANDOFF_JWKS_URL: 'http://app.example.test/jwks.json', ALLOW_INSECURE_LOCAL: '1' })).toEqual(['HANDOFF_JWKS_URL']);
      expect(variables({ ...VALID, HANDOFF_JWKS_URL: 'not-a-url' })).toEqual(['HANDOFF_JWKS_URL']);
    });

    it('requires the issuer, a valid fixed key and positive durations', () => {
      expect(variables({ ...VALID, HANDOFF_ISSUER: undefined })).toEqual(['HANDOFF_ISSUER']);
      expect(variables({ ...withKey, HANDOFF_PUBLIC_KEY: 'a1b2c3' })).toEqual(['HANDOFF_PUBLIC_KEY']);
      for (const variable of ['HANDOFF_JWKS_CACHE_SECONDS', 'HANDOFF_JWKS_COOLDOWN_SECONDS', 'HANDOFF_JWKS_MAX_STALE_SECONDS']) {
        expect(variables({ ...VALID, [variable]: '0' })).toEqual([variable]);
        expect(variables({ ...VALID, [variable]: '60' })).toEqual([]);
      }
    });
  });

  it('accepts a complete production configuration', () => {
    expect(validateConfig(VALID, true)).toEqual([]);
    expect(validateConfig({ ...VALID, AA_CHAINS: JSON.stringify({ 1: { rpcUrl: 'https://rpc.test', bundlerUrl: 'https://b.test', bundlerHeaders: { a: 'b' }, paymasterUrl: 'https://p.test', paymasterContext: { x: 1 } } }) }, true)).toEqual([]);
  });

  it('names each missing required variable', () => {
    expect(variables({})).toEqual(['MASTER_KEY', 'MANIFEST_SIGNING_KEY', 'HANDOFF_JWKS_URL', 'HANDOFF_ISSUER', 'VAULT_SERVICE_TOKEN', 'ORIGIN', 'RP_ID', 'DATABASE_URL']);
  });

  it.each([
    ['MASTER_KEY', 'abcd'],
    ['MASTER_KEY', 'zz'.repeat(32)],
    ['MANIFEST_SIGNING_KEY', 'a1b2c3'],
    ['VAULT_SERVICE_TOKEN', 'tiny'],
    ['ORIGIN', 'http://vault.example.test'],
    ['ORIGIN', 'https://vault.example.test/ruta'],
    ['ORIGIN', 'garbage'],
    ['RP_ID', 'example.test'],
    ['RP_ID', 'https://vault.example.test'],
    ['ALLOWED_APP_ORIGINS', 'http://app.example.test'],
    ['ALLOWED_APP_ORIGINS', '*'],
    ['DATABASE_URL', 'sqlite:data/vault.db'],
    ['DATABASE_URL', 'mysql://x'],
    ['DATABASE_POOL_SIZE', '-5'],
    ['DATABASE_POOL_SIZE', 'plenty'],
    ['RPC_ALLOWED_HOSTS', 'https://rpc.test/'],
    ['VAULT_BRAND_NAME', 'a\nb'],
  ])('rejects an invalid %s without revealing its value', (variable, value) => {
    const issues = validateConfig({ ...VALID, [variable]: value }, true);
    expect(issues.map((issue) => issue.variable)).toContain(variable);
    expect(JSON.stringify(issues)).not.toContain(value);
  });

  it.each([
    ['not JSON', 'AA_CHAINS', '{topsecret'],
    ['an array', 'AA_CHAINS', '[]'],
    ['key that is not a chainId', 'AA_CHAINS.?', '{"mainnet":{}}'],
    ['http URL', 'AA_CHAINS.1.bundlerUrl', '{"1":{"bundlerUrl":"http://topsecret.test"}}'],
    ['non-string headers', 'AA_CHAINS.1.bundlerHeaders', '{"1":{"bundlerUrl":"https://b.test","bundlerHeaders":{"a":1}}}'],
    ['paymaster without bundler', 'AA_CHAINS.1.bundlerUrl', '{"1":{"paymasterUrl":"https://p.test"}}'],
  ])('AA_CHAINS: rejects %s', (_, variable, value) => {
    const issues = validateConfig({ ...VALID, AA_CHAINS: value }, true);
    expect(issues.map((issue) => issue.variable)).toContain(variable);
    expect(JSON.stringify(issues)).not.toContain('topsecret');
  });

  it('accepts a complete Vercel production configuration, and requires sslmode there', () => {
    const vercel = { ...VALID, CLIENT_IP_SOURCE: 'vercel', VERCEL: '1', VERCEL_REGION: 'fra1' };
    expect(validateConfig(vercel, true)).toEqual([]);
    expect(validateConfig({ ...vercel, DATABASE_URL: 'postgresql://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/db?sslmode=require&channel_binding=require' }, true)).toEqual([]);
    const plain = validateConfig({ ...vercel, DATABASE_URL: 'postgres://u:topsecret@ep-x.neon.tech/db' }, true);
    expect(plain).toEqual([{ variable: 'DATABASE_URL', reason: 'must set sslmode=require or verify-full on Vercel' }]);
    expect(JSON.stringify(plain)).not.toContain('topsecret');
    expect(variables({ ...vercel, DATABASE_URL: 'postgres://u:p@db.test/db?sslmode=prefer' })).toEqual(['DATABASE_URL']);
    // Outside Vercel (compose, an internal network) it is not required.
    expect(validateConfig({ ...VALID, DATABASE_URL: 'postgres://u:p@postgres:5432/vault' }, true)).toEqual([]);
    // On Vercel without CLIENT_IP_SOURCE=vercel: refused, the preload cannot run there.
    expect(variables({ ...VALID, VERCEL: '1', VERCEL_REGION: 'fra1' })).toEqual(['CLIENT_IP_SOURCE']);
  });

  it('AA_CHAINS nativeCurrency is a short symbol', () => {
    const chains = (nativeCurrency: unknown) => ({ ...VALID, AA_CHAINS: JSON.stringify({ 80002: { nativeCurrency } }) });
    expect(validateConfig(chains('POL'), true)).toEqual([]);
    expect(variables(chains('<b>POL</b>'))).toEqual(['AA_CHAINS.80002.nativeCurrency']);
    expect(variables(chains('TWELVECHARSX'))).toEqual(['AA_CHAINS.80002.nativeCurrency']);
    expect(variables(chains(1))).toEqual(['AA_CHAINS.80002.nativeCurrency']);
  });

  it('AA_CHAINS sponsorTransactions is a boolean, and true requires a paymaster', () => {
    const chains = (config: Record<string, unknown>) => ({ ...VALID, AA_CHAINS: JSON.stringify({ 80002: { bundlerUrl: 'https://b.test', ...config } }) });
    expect(validateConfig(chains({ paymasterUrl: 'https://p.test', sponsorTransactions: true }), true)).toEqual([]);
    expect(validateConfig(chains({ paymasterUrl: 'https://p.test', sponsorTransactions: false }), true)).toEqual([]);
    expect(validateConfig(chains({ sponsorTransactions: false }), true)).toEqual([]);
    expect(variables(chains({ paymasterUrl: 'https://p.test', sponsorTransactions: 'true' }))).toEqual(['AA_CHAINS.80002.sponsorTransactions']);
    expect(variables(chains({ paymasterUrl: 'https://p.test', sponsorTransactions: 1 }))).toEqual(['AA_CHAINS.80002.sponsorTransactions']);
    expect(variables(chains({ paymasterUrl: 'https://p.test', sponsorTransactions: null }))).toEqual(['AA_CHAINS.80002.sponsorTransactions']);
    expect(variables(chains({ sponsorTransactions: true }))).toEqual(['AA_CHAINS.80002.paymasterUrl']);
  });

  it('a message never contains the secrets or the database URL', () => {
    const issues = validateConfig({ ...VALID, MASTER_KEY: 'topsecret', DATABASE_URL: 'mysql://user:topsecret@db', ORIGIN: 'http://topsecret.test' }, true);
    expect(issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(issues)).not.toContain('topsecret');
  });

  it('ALLOW_INSECURE_LOCAL allows http on local hosts and SQLite, and nothing else', () => {
    const local = { ...VALID, ORIGIN: 'http://vault.localhost:3201', RP_ID: 'vault.localhost', ALLOWED_APP_ORIGINS: 'http://app.localhost:3200', DATABASE_URL: 'sqlite:data/vault.db', AA_CHAINS: '{"1":{"bundlerUrl":"http://127.0.0.1:1"}}' };
    expect(variables(local).sort()).toEqual(['AA_CHAINS.1.bundlerUrl', 'ALLOWED_APP_ORIGINS', 'DATABASE_URL', 'ORIGIN']);
    expect(validateConfig({ ...local, ALLOW_INSECURE_LOCAL: '1' }, true)).toEqual([]);
    expect(variables({ ...local, ALLOW_INSECURE_LOCAL: '1', ORIGIN: 'http://vault.example.test', RP_ID: 'vault.example.test' })).toEqual(['ORIGIN']);
    expect(variables({ ...local, ALLOW_INSECURE_LOCAL: 'true' })).toContain('ORIGIN');
  });

  describe('limits', () => {
    const LIMITS = {
      TRUSTED_PROXIES: '10.0.0.0/8, 192.168.1.5, fd00::/8',
      RATE_LIMITS: JSON.stringify({ handoff: { ip: 100, sub: 20, windowSeconds: 30 }, aa: { ip: 1000 } }),
      SHARE_A_WINDOW_SECONDS: '3600',
      SHARE_A_MAX_PER_SESSION: '5',
      SHARE_A_MAX_PER_USER: '30',
      RECOVERY_CHALLENGE_MAX_LIVE: '1000',
      AA_MAX_VERIFICATION_GAS_LIMIT: '2000000',
      AA_MAX_CALL_GAS_LIMIT: '500000',
      AA_MAX_PRE_VERIFICATION_GAS: '500000',
      AA_MAX_PAYMASTER_VERIFICATION_GAS_LIMIT: '500000',
      AA_MAX_PAYMASTER_POST_OP_GAS_LIMIT: '200000',
      AA_MAX_FEE_PER_GAS: '500000000000',
      AA_FEE_MULTIPLIER_PERCENT: '200',
      AA_PRIORITY_FEE_MULTIPLIER_PERCENT: '120',
      AA_DEPLOYMENT_RETRY_SECONDS: '900',
      AA_CHAINS: JSON.stringify({ 1: { bundlerUrl: 'https://b.test', limits: { maxFeePerGas: '100000000000000000000000', maxCallGasLimit: 300000, feeMultiplierPercent: '150' } } }),
    };

    it('accepts valid values, and all of them are optional', () => {
      expect(validateConfig({ ...VALID, ...LIMITS }, true)).toEqual([]);
      expect(validateConfig({ ...VALID, ...Object.fromEntries(Object.keys(LIMITS).map((key) => [key, ''])) }, true)).toEqual([]);
    });

    it.each([
      ['TRUSTED_PROXIES', 'TRUSTED_PROXIES', '10.0.0.1, topsecret.internal'],
      ['TRUSTED_PROXIES', 'TRUSTED_PROXIES', '10.0.0.0/99'],
      ['RATE_LIMITS', 'RATE_LIMITS', '{topsecret'],
      ['RATE_LIMITS', 'RATE_LIMITS', '["topsecret"]'],
      ['RATE_LIMITS', 'RATE_LIMITS.?', '{"topsecret":{"ip":1}}'],
      ['RATE_LIMITS', 'RATE_LIMITS.handoff', '{"handoff":"topsecret"}'],
      ['RATE_LIMITS', 'RATE_LIMITS.handoff.?', '{"handoff":{"topsecret":1}}'],
      ['RATE_LIMITS', 'RATE_LIMITS.handoff.ip', '{"handoff":{"ip":0}}'],
      ['RATE_LIMITS', 'RATE_LIMITS.aa.sub', '{"aa":{"sub":"topsecret"}}'],
      ['RATE_LIMITS', 'RATE_LIMITS.s2s.windowSeconds', '{"s2s":{"windowSeconds":1.5}}'],
      ['SHARE_A_WINDOW_SECONDS', 'SHARE_A_WINDOW_SECONDS', '0'],
      ['SHARE_A_MAX_PER_SESSION', 'SHARE_A_MAX_PER_SESSION', 'topsecret'],
      ['SHARE_A_MAX_PER_USER', 'SHARE_A_MAX_PER_USER', '-3'],
      ['RECOVERY_CHALLENGE_MAX_LIVE', 'RECOVERY_CHALLENGE_MAX_LIVE', '1e3'],
      ['AA_MAX_VERIFICATION_GAS_LIMIT', 'AA_MAX_VERIFICATION_GAS_LIMIT', '0'],
      ['AA_MAX_CALL_GAS_LIMIT', 'AA_MAX_CALL_GAS_LIMIT', 'topsecret'],
      ['AA_MAX_PRE_VERIFICATION_GAS', 'AA_MAX_PRE_VERIFICATION_GAS', '1.5'],
      ['AA_MAX_PAYMASTER_VERIFICATION_GAS_LIMIT', 'AA_MAX_PAYMASTER_VERIFICATION_GAS_LIMIT', '0x10'],
      ['AA_MAX_PAYMASTER_POST_OP_GAS_LIMIT', 'AA_MAX_PAYMASTER_POST_OP_GAS_LIMIT', '-1'],
      ['AA_MAX_FEE_PER_GAS', 'AA_MAX_FEE_PER_GAS', '1'.repeat(80)],
      ['AA_FEE_MULTIPLIER_PERCENT', 'AA_FEE_MULTIPLIER_PERCENT', '99'],
      ['AA_FEE_MULTIPLIER_PERCENT', 'AA_FEE_MULTIPLIER_PERCENT', '1001'],
      ['AA_DEPLOYMENT_RETRY_SECONDS', 'AA_DEPLOYMENT_RETRY_SECONDS', '0'],
      ['AA_CHAINS', 'AA_CHAINS.1.limits', '{"1":{"limits":"topsecret"}}'],
      ['AA_CHAINS', 'AA_CHAINS.1.limits.?', '{"1":{"limits":{"topsecret":1}}}'],
      ['AA_CHAINS', 'AA_CHAINS.1.limits.maxFeePerGas', '{"1":{"limits":{"maxFeePerGas":"topsecret"}}}'],
      ['AA_CHAINS', 'AA_CHAINS.1.limits.maxCallGasLimit', '{"1":{"limits":{"maxCallGasLimit":-5}}}'],
      ['AA_CHAINS', 'AA_CHAINS.1.limits.feeMultiplierPercent', '{"1":{"limits":{"feeMultiplierPercent":5000}}}'],
    ])('rejects an invalid %s (%s) without revealing its value', (env, variable, value) => {
      const issues = validateConfig({ ...VALID, [env]: value }, true);
      expect(issues.map((issue) => issue.variable)).toEqual([variable]);
      expect(JSON.stringify(issues)).not.toContain('topsecret');
      expect(JSON.stringify(issues)).not.toContain(value);
    });

    it('reports every invalid limit at once', () => {
      const issues = validateConfig({ ...VALID, TRUSTED_PROXIES: 'x', SHARE_A_MAX_PER_USER: '0', RATE_LIMITS: '{"aa":{"ip":0,"sub":0}}' }, true);
      expect(issues.map((issue) => issue.variable).sort()).toEqual(['RATE_LIMITS.aa.ip', 'RATE_LIMITS.aa.sub', 'SHARE_A_MAX_PER_USER', 'TRUSTED_PROXIES']);
    });
  });

  it('outside production the database is optional', () => {
    const { DATABASE_URL: _, ...withoutDatabase } = VALID;
    expect(validateConfig(withoutDatabase, false)).toEqual([]);
  });
});

describe('publicRuntimeConfig', () => {
  it('derives the manifest public key and hands out no secret', () => {
    const before = { ...process.env };
    Object.assign(process.env, VALID, { VAULT_BRAND_NAME: 'My Brand' });
    try {
      const config = publicRuntimeConfig();
      expect(config).toEqual({ rpId: VALID.RP_ID, manifestPubKey: hexEncode(manifest.publicKey), brand: 'My Brand' });
      delete process.env.VAULT_BRAND_NAME;
      expect(publicRuntimeConfig().brand).toBe('Vault');
      expect(JSON.stringify(config)).not.toContain(VALID.MANIFEST_SIGNING_KEY);
    } finally {
      process.env = before;
    }
  });
});
