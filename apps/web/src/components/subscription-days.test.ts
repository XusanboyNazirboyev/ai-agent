import { describe, expect, it } from 'vitest';
import { daysLeft } from './subscription-page';

describe('daysLeft (owner 2026-11-23: how long until the next payment)', () => {
  const now = Date.parse('2026-11-23T10:00:00Z');
  it('counts whole days up, never below zero', () => {
    expect(daysLeft('2026-12-23T10:00:00Z', now)).toBe(30);
    expect(daysLeft('2026-11-23T11:00:00Z', now)).toBe(1);
    expect(daysLeft('2026-11-20T00:00:00Z', now)).toBe(0);
  });
});
