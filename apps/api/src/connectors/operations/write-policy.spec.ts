import { describe, expect, it } from 'vitest';
import { afterFailure, beforeAttempt } from './write-policy.js';

const delay = (attempts: number): number => attempts * 1000;

describe('beforeAttempt', () => {
  const clean = {
    lastExecution: null,
    abandoned: false,
    attemptMode: null,
  } as const;

  it('attempts normally when nothing is unclear', () => {
    for (const mode of ['native', 'lookup', 'none'] as const) {
      expect(beforeAttempt(clean, mode)).toBe('ATTEMPT');
      expect(
        beforeAttempt(
          { ...clean, lastExecution: 'NOT_EXECUTED', attemptMode: mode },
          mode,
        ),
      ).toBe('ATTEMPT');
    }
  });

  it.each([
    ['native', 'native', 'ATTEMPT'],
    ['lookup', 'lookup', 'LOOKUP_THEN_ATTEMPT'],
    ['none', 'none', 'STOP_UNCERTAIN'],
    // Changing the mode does not make an earlier unprotected attempt safe.
    ['none', 'native', 'STOP_UNCERTAIN'],
    ['none', 'lookup', 'STOP_UNCERTAIN'],
    ['lookup', 'native', 'STOP_UNCERTAIN'],
    ['native', 'lookup', 'STOP_UNCERTAIN'],
    ['native', 'none', 'STOP_UNCERTAIN'],
    [null, 'native', 'STOP_UNCERTAIN'],
  ] as const)(
    'after an unclear attempt under %s, now %s -> %s',
    (before, now, expected) => {
      expect(
        beforeAttempt(
          { lastExecution: 'UNCERTAIN', abandoned: false, attemptMode: before },
          now,
        ),
      ).toBe(expected);
      expect(
        beforeAttempt(
          { lastExecution: null, abandoned: true, attemptMode: before },
          now,
        ),
      ).toBe(expected);
    },
  );
});

describe('afterFailure', () => {
  it('retries a provably unapplied write until the bound, then fails', () => {
    expect(afterFailure('NOT_EXECUTED', 'none', 1, 3, delay)).toEqual({
      status: 'RETRY_WAIT',
      delayMs: 1000,
    });
    expect(afterFailure('NOT_EXECUTED', 'none', 3, 3, delay)).toEqual({
      status: 'FAILED',
    });
  });

  it('never retries an unclear write without protection', () => {
    expect(afterFailure('UNCERTAIN', 'none', 1, 8, delay)).toEqual({
      status: 'UNCERTAIN',
    });
  });

  it('retries an unclear write under native or lookup, and gives up as UNCERTAIN, not FAILED', () => {
    for (const mode of ['native', 'lookup'] as const) {
      expect(afterFailure('UNCERTAIN', mode, 2, 8, delay)).toEqual({
        status: 'RETRY_WAIT',
        delayMs: 2000,
      });
      expect(afterFailure('UNCERTAIN', mode, 8, 8, delay)).toEqual({
        status: 'UNCERTAIN',
      });
    }
  });
});
