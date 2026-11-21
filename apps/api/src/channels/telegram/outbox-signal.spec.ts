import { describe, expect, it, vi } from 'vitest';
import { onOutboxWritten, outboxWritten } from './outbox-signal.js';

describe('outbox signal', () => {
  it('wakes every listener until it unsubscribes', () => {
    const relay = vi.fn();
    const stop = onOutboxWritten(relay);
    outboxWritten();
    expect(relay).toHaveBeenCalledTimes(1);
    stop();
    outboxWritten();
    expect(relay).toHaveBeenCalledTimes(1);
  });
});
