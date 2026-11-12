import { describe, expect, it } from 'vitest';
import {
  checkLimits,
  clientIpSource,
  DEFAULT_AA_FEE_MULTIPLIER_PERCENT,
  DEFAULT_AA_MAX_FEE_PER_GAS,
  DEFAULT_AA_MAX_VERIFICATION_GAS_LIMIT,
  rateLimitRule,
  recoveryChallengeMaxLive,
  shareALimits,
  sponsorshipLimits,
  trustedProxies,
} from '../../server/limits';

describe('rateLimitRule', () => {
  it('has a 60 s window with the default limits', () => {
    expect(rateLimitRule('handoff', {})).toEqual({ windowMs: 60_000, ip: 30, sub: 10 });
    expect(rateLimitRule('recovery-challenge', {})).toEqual({ windowMs: 60_000, ip: 10, sub: null });
    expect(rateLimitRule('s2s', {})).toEqual({ windowMs: 60_000, ip: 600, sub: 60 });
  });

  it('RATE_LIMITS overrides field by field', () => {
    const env = { RATE_LIMITS: JSON.stringify({ handoff: { sub: 3 }, aa: { ip: 5, windowSeconds: 10 } }) };
    expect(rateLimitRule('handoff', env)).toEqual({ windowMs: 60_000, ip: 30, sub: 3 });
    expect(rateLimitRule('aa', env)).toEqual({ windowMs: 10_000, ip: 5, sub: 120 });
    expect(rateLimitRule('relink', env)).toEqual({ windowMs: 60_000, ip: 10, sub: 5 });
  });

  it('transaction: its own budget, smaller than aa, and overridable', () => {
    expect(rateLimitRule('transaction', {})).toEqual({ windowMs: 60_000, ip: 30, sub: 10 });
    const env = { RATE_LIMITS: JSON.stringify({ transaction: { sub: 3, windowSeconds: 600 }, aa: { sub: 1 } }) };
    expect(rateLimitRule('transaction', env)).toEqual({ windowMs: 600_000, ip: 30, sub: 3 });
    expect(rateLimitRule('aa', env)).toEqual({ windowMs: 60_000, ip: 240, sub: 1 });
    expect(checkLimits({ RATE_LIMITS: JSON.stringify({ transaction: { ip: 5, sub: 2 } }) })).toEqual([]);
    expect(checkLimits({ RATE_LIMITS: JSON.stringify({ transaction: { sub: 0 } }) })).toEqual([{ variable: 'RATE_LIMITS.transaction.sub', reason: 'must be a positive integer' }]);
  });

  it('an invalid value falls back to the default', () => {
    expect(rateLimitRule('handoff', { RATE_LIMITS: '{not json' })).toEqual({ windowMs: 60_000, ip: 30, sub: 10 });
    expect(rateLimitRule('handoff', { RATE_LIMITS: '[1]' })).toEqual({ windowMs: 60_000, ip: 30, sub: 10 });
    expect(rateLimitRule('handoff', { RATE_LIMITS: JSON.stringify({ handoff: { ip: 0, sub: 1.5, windowSeconds: '-1' } }) })).toEqual({ windowMs: 60_000, ip: 30, sub: 10 });
  });
});

describe('budgets', () => {
  it('share A: defaults and overrides', () => {
    expect(shareALimits({})).toEqual({ windowMs: 3_600_000, perSession: 5, perUser: 30 });
    expect(shareALimits({ SHARE_A_WINDOW_SECONDS: '60', SHARE_A_MAX_PER_SESSION: '2', SHARE_A_MAX_PER_USER: 'many' })).toEqual({ windowMs: 60_000, perSession: 2, perUser: 30 });
  });

  it('recovery challenges: default and override', () => {
    expect(recoveryChallengeMaxLive({})).toBe(1000);
    expect(recoveryChallengeMaxLive({ RECOVERY_CHALLENGE_MAX_LIVE: '7' })).toBe(7);
    expect(recoveryChallengeMaxLive({ RECOVERY_CHALLENGE_MAX_LIVE: '0' })).toBe(1000);
  });
});

describe('sponsorshipLimits', () => {
  it('has the defaults', () => {
    expect(sponsorshipLimits(1, {})).toEqual({
      maxVerificationGasLimit: 3_000_000n,
      maxCallGasLimit: 500_000n,
      maxPreVerificationGas: 500_000n,
      maxPaymasterVerificationGasLimit: 500_000n,
      maxPaymasterPostOpGasLimit: 200_000n,
      maxFeePerGas: 500_000_000_000n,
      feeMultiplierPercent: 200n,
      priorityFeeMultiplierPercent: 120n,
      deploymentRetryMs: 900_000,
    });
  });

  it('per chain, then the env variable, then the default', () => {
    const env = {
      AA_MAX_FEE_PER_GAS: '1000',
      AA_MAX_CALL_GAS_LIMIT: '42',
      AA_FEE_MULTIPLIER_PERCENT: '150',
      AA_DEPLOYMENT_RETRY_SECONDS: '30',
      AA_CHAINS: JSON.stringify({ 10: { limits: { maxFeePerGas: '99999999999999999999999', maxCallGasLimit: 7, feeMultiplierPercent: 1000 } } }),
    };
    expect(sponsorshipLimits(10, env)).toMatchObject({ maxFeePerGas: 99999999999999999999999n, maxCallGasLimit: 7n, feeMultiplierPercent: 1000n, deploymentRetryMs: 30_000 });
    expect(sponsorshipLimits(1, env)).toMatchObject({ maxFeePerGas: 1000n, maxCallGasLimit: 42n, feeMultiplierPercent: 150n, maxVerificationGasLimit: DEFAULT_AA_MAX_VERIFICATION_GAS_LIMIT });
  });

  it('an invalid value falls back', () => {
    const env = {
      AA_MAX_FEE_PER_GAS: '1e9',
      AA_FEE_MULTIPLIER_PERCENT: '99',
      AA_CHAINS: JSON.stringify({ 1: { limits: { maxFeePerGas: -1, feeMultiplierPercent: '1001', maxVerificationGasLimit: 1.5 } } }),
    };
    expect(sponsorshipLimits(1, env)).toMatchObject({ maxFeePerGas: DEFAULT_AA_MAX_FEE_PER_GAS, feeMultiplierPercent: DEFAULT_AA_FEE_MULTIPLIER_PERCENT, maxVerificationGasLimit: DEFAULT_AA_MAX_VERIFICATION_GAS_LIMIT });
    expect(sponsorshipLimits(1, { AA_CHAINS: '{oops' }).maxFeePerGas).toBe(DEFAULT_AA_MAX_FEE_PER_GAS);
  });
});

describe('trustedProxies', () => {
  it('unset or empty: none', () => {
    expect(trustedProxies({})).toBeNull();
    expect(trustedProxies({ TRUSTED_PROXIES: ' , ' })).toBeNull();
  });

  it('addresses and CIDRs, IPv4 and IPv6', () => {
    const list = trustedProxies({ TRUSTED_PROXIES: '10.0.0.0/8, 192.168.1.5, fd00::/8, ::1' });
    expect(list?.check('10.20.30.40', 'ipv4')).toBe(true);
    expect(list?.check('192.168.1.5', 'ipv4')).toBe(true);
    expect(list?.check('192.168.1.6', 'ipv4')).toBe(false);
    expect(list?.check('fd12::1', 'ipv6')).toBe(true);
    expect(list?.check('::1', 'ipv6')).toBe(true);
    expect(list?.check('2001:db8::1', 'ipv6')).toBe(false);
  });

  it('with any invalid entry, trusts none', () => {
    expect(trustedProxies({ TRUSTED_PROXIES: '10.0.0.1, proxy.internal' })).toBeNull();
    expect(trustedProxies({ TRUSTED_PROXIES: '10.0.0.0/33' })).toBeNull();
    expect(trustedProxies({ TRUSTED_PROXIES: '10.0.0.0/8/1' })).toBeNull();
  });
});

describe('clientIpSource', () => {
  const VERCEL = { VERCEL: '1', VERCEL_REGION: 'fra1' };

  it('socket by default; vercel only inside a Vercel runtime', () => {
    expect(clientIpSource({})).toBe('socket');
    expect(clientIpSource({ CLIENT_IP_SOURCE: ' socket ' })).toBe('socket');
    expect(clientIpSource({ CLIENT_IP_SOURCE: 'vercel', ...VERCEL })).toBe('vercel');
    // `vercel env pull` writes VERCEL=1, never VERCEL_REGION: a copied .env does not make a laptop look like Vercel.
    expect(clientIpSource({ CLIENT_IP_SOURCE: 'vercel', VERCEL: '1' })).toBeNull();
    expect(clientIpSource({ CLIENT_IP_SOURCE: 'vercel' })).toBeNull();
    expect(clientIpSource({ CLIENT_IP_SOURCE: 'x-forwarded-for' })).toBeNull();
  });

  it('startup refuses the ambiguous combinations, without echoing values', () => {
    const issues = (env: Record<string, string>) => checkLimits(env);
    expect(issues({ CLIENT_IP_SOURCE: 'cloudflare-secret' })).toEqual([{ variable: 'CLIENT_IP_SOURCE', reason: 'must be socket or vercel' }]);
    expect(JSON.stringify(issues({ CLIENT_IP_SOURCE: 'cloudflare-secret' }))).not.toContain('cloudflare-secret');
    expect(issues({ CLIENT_IP_SOURCE: 'vercel' }).map((issue) => issue.variable)).toEqual(['CLIENT_IP_SOURCE']);
    expect(issues({ CLIENT_IP_SOURCE: 'vercel', VERCEL: '1' }).map((issue) => issue.variable)).toEqual(['CLIENT_IP_SOURCE']);
    expect(issues({ CLIENT_IP_SOURCE: 'vercel', ...VERCEL, TRUSTED_PROXIES: '10.0.0.0/8' }).map((issue) => issue.variable)).toEqual(['TRUSTED_PROXIES']);
    // On Vercel the preload cannot run: the default source is refused there with a message that says what to set.
    expect(issues(VERCEL)).toEqual([{ variable: 'CLIENT_IP_SOURCE', reason: 'must be vercel on Vercel, where the peer-address preload cannot run' }]);
    expect(issues({ CLIENT_IP_SOURCE: 'vercel', ...VERCEL })).toEqual([]);
    expect(issues({ TRUSTED_PROXIES: '10.0.0.0/8' })).toEqual([]);
  });
});
