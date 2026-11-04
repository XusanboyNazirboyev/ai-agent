import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTyping } from './typing-indicator.js';

describe('typing indicator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends at once, repeats until stopped, and never throws', async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('blocked'))
      .mockResolvedValue(true);
    const stop = startTyping(send, { everyMs: 4_000 });
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(send).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('stops by itself after the maximum time', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(true);
    startTyping(send, { everyMs: 4_000, maxMs: 10_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
