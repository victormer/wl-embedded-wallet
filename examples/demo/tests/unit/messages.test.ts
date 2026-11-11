import { describe, expect, it } from 'vitest';
import { deploymentNotice, messageFor } from '@/lib/messages';

describe('deployment notice', () => {
  it('an unknown state is shown as unknown, never as not deployed', () => {
    expect(deploymentNotice(null, null)).toEqual({ kind: 'info', text: 'Deployment status on this chain is unknown.' });
    expect(deploymentNotice(null, null).text).not.toMatch(/not deployed/i);
  });

  it('a chain error shows its message', () => {
    expect(deploymentNotice(null, 'CHAIN_UNAVAILABLE')).toEqual({ kind: 'error', text: messageFor('CHAIN_UNAVAILABLE') });
  });

  it('a known state is shown as such', () => {
    expect(deploymentNotice(true, null)).toEqual({ kind: 'ok', text: 'Deployed on this chain.' });
    expect(deploymentNotice(false, null)).toEqual({ kind: 'info', text: 'Not deployed on this chain.' });
  });
});
