import { describe, expect, it } from 'vitest';
import { messageFor } from '@/lib/messages';
import { parseTransactionForm } from '@/lib/transaction';

const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('transaction form', () => {
  it('converts the amount from native units to wei and drops empty data', () => {
    expect(parseTransactionForm({ to: TO, value: '0', data: '' })).toEqual({ to: TO, value: 0n });
    expect(parseTransactionForm({ to: TO, value: '0.001', data: '0x' })).toEqual({ to: TO, value: 1_000_000_000_000_000n });
    expect(parseTransactionForm({ to: ` ${TO} `, value: ' 1.5 ', data: '0xabcd' })).toEqual({ to: TO, value: 1_500_000_000_000_000_000n, data: '0xabcd' });
  });

  it('rejects an invalid recipient, amount or data', () => {
    for (const value of ['', '-1', '1e18', 'abc', '1,5', '0.0000000000000000001']) expect(parseTransactionForm({ to: TO, value, data: '' }), value).toBeNull();
    for (const data of ['abcd', '0xabc', '0xzz']) expect(parseTransactionForm({ to: TO, value: '0', data }), data).toBeNull();
    for (const to of ['', '0x1234', 'not an address']) expect(parseTransactionForm({ to, value: '0', data: '' }), to).toBeNull();
  });
});

describe('transaction messages', () => {
  it('every code the vault may return for a transaction has its own text', () => {
    const codes = [
      'WALLET_NOT_DEPLOYED',
      'INSUFFICIENT_FUNDS',
      'CALL_NOT_ALLOWED',
      'CALL_REVERTED',
      'SPONSORSHIP_REJECTED',
      'NONCE_CONFLICT',
      'TRANSACTION_FAILED',
      'TRANSACTION_REVERTED',
      'TRANSACTION_TIMEOUT',
      'TRANSACTION_EXPIRED',
      'TRANSACTION_IN_PROGRESS',
      'FEES_TOO_HIGH',
      'GAS_LIMIT_EXCEEDED',
      'RATE_LIMITED',
      'INVALID_REQUEST',
    ];
    for (const code of codes) expect(messageFor(code), code).not.toContain(code);
  });

  it('insufficient funds is not about deployment only', () => {
    expect(messageFor('INSUFFICIENT_FUNDS')).toBe('Your Safe does not have enough funds on this chain for this operation and its network fee.');
  });
});
