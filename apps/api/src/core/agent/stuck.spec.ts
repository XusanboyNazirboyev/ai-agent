import { describe, expect, it } from 'vitest';
import { detectStuck, selectEpisode } from './stuck.js';

const minute = 60_000;
const now = new Date('2026-10-26T10:00:00Z');
const ago = (minutes: number): Date =>
  new Date(now.getTime() - minutes * minute);
const turn = (
  minutes: number,
  outcome = 'ASKED_SLOT',
): {
  completedAt: Date;
  outcome: string;
  askedSlot: string;
  slotsFilled: number;
  textFingerprint: string;
} => ({
  completedAt: ago(minutes),
  outcome,
  askedSlot: 'subject',
  slotsFilled: 0,
  textFingerprint: `f${minutes}`,
});
const WINDOW = 30 * minute;

describe('selectEpisode', () => {
  it('keeps an unbroken recent run, oldest first', () => {
    const run = selectEpisode([turn(2), turn(10), turn(25)], now, WINDOW);
    expect(run.map((t) => t.textFingerprint)).toEqual(['f25', 'f10', 'f2']);
  });

  it('drops turns from an earlier visit (a long silence breaks the run)', () => {
    const day = 24 * 60;
    expect(selectEpisode([turn(day), turn(day + 1)], now, WINDOW)).toEqual([]);
    // A gap between two turns also ends the run, even if the newer ones are recent.
    const run = selectEpisode([turn(5), turn(50)], now, WINDOW);
    expect(run.map((t) => t.textFingerprint)).toEqual(['f5']);
  });

  it('drops turns at or before the end of a human handover', () => {
    const boundary = ago(8);
    const run = selectEpisode(
      [turn(3), turn(8), turn(12)],
      now,
      WINDOW,
      boundary,
    );
    expect(run.map((t) => t.textFingerprint)).toEqual(['f3']);
  });

  it('stops at a turn that never completed', () => {
    expect(
      selectEpisode([{ completedAt: null }, turn(3)], now, WINDOW),
    ).toEqual([]);
  });
});

describe('STUCK needs a live dialogue', () => {
  const current = {
    outcome: 'ASKED_SLOT',
    askedSlot: 'subject',
    slotsFilled: 0,
    textFingerprint: 'new',
  };

  it('fires for the same unanswered question inside one dialogue', () => {
    const prior = selectEpisode([turn(2), turn(5)], now, WINDOW);
    expect(detectStuck(prior, current)).toBe('SAME_QUESTION_REPEATED');
  });

  it('does not fire for a greeting after days of silence, or right after a handover', () => {
    const old = selectEpisode(
      [turn(2 * 24 * 60), turn(2 * 24 * 60 + 3)],
      now,
      WINDOW,
    );
    expect(detectStuck(old, current)).toBeUndefined();
    const afterHandover = selectEpisode(
      [turn(2), turn(5)],
      now,
      WINDOW,
      ago(1),
    );
    expect(detectStuck(afterHandover, current)).toBeUndefined();
  });
});
