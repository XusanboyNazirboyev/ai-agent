import { describe, expect, it } from 'vitest';
import { accessNotice } from './access-notice';

const NOW = Date.parse('2026-11-17T09:00:00Z');
const at = (days: number): string =>
  new Date(NOW + days * 86_400_000).toISOString();

describe('accessNotice', () => {
  it('shows expired and past due to everyone', () => {
    expect(
      accessNotice(
        {
          state: 'SUBSCRIPTION_EXPIRED',
          periodEnd: at(-5),
          graceUntil: at(-1),
        },
        false,
        NOW,
      ),
    ).toBe('expired');
    expect(
      accessNotice(
        { state: 'ok', periodEnd: at(-1), graceUntil: at(2) },
        false,
        NOW,
      ),
    ).toBe('past-due');
  });

  it('reminds managers in the last five days of a running period', () => {
    const soon = { state: 'ok' as const, periodEnd: at(4.5), graceUntil: null };
    expect(accessNotice(soon, true, NOW)).toBe('ending-soon');
    expect(accessNotice(soon, false, NOW)).toBeNull();
    expect(accessNotice({ ...soon, periodEnd: at(5.5) }, true, NOW)).toBeNull();
    // Past the end the daily scan moves it to past due; nothing until then.
    expect(
      accessNotice({ ...soon, periodEnd: at(-0.1) }, true, NOW),
    ).toBeNull();
    expect(accessNotice({ ...soon, periodEnd: null }, true, NOW)).toBeNull();
    expect(accessNotice(undefined, true, NOW)).toBeNull();
  });
});
