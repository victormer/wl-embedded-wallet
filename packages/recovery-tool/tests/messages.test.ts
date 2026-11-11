import { describe, expect, it } from 'vitest';
import { offlineErrorText } from '../src/messages';

describe('tool texts', () => {
  it('an old kit says so clearly', () => {
    expect(offlineErrorText('NO_SEED_BACKUP')).toContain('kit is old');
  });
});
