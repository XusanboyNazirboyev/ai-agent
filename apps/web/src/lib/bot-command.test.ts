import { describe, expect, it } from 'vitest';
import { isStartCommand } from './bot-command';

describe('isStartCommand', () => {
  it('matches /start with or without a deep-link code or bot name', () => {
    expect(isStartCommand('/start')).toBe(true);
    expect(
      isStartCommand('/start AaGqGP0HdJiHvSuo47tXyZ_-0123456789abcdefghijklm'),
    ).toBe(true);
    expect(isStartCommand('/start@tezda_bot')).toBe(true);
    expect(isStartCommand(' /start abc ')).toBe(true);
  });

  it('leaves real messages alone', () => {
    expect(isStartCommand('/start qilsam nima bo‘ladi?')).toBe(false);
    expect(isStartCommand('start')).toBe(false);
    expect(isStartCommand('/stop')).toBe(false);
    expect(isStartCommand(null)).toBe(false);
  });
});
