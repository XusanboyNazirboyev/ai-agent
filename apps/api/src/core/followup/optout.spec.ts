import { describe, expect, it } from 'vitest';
import { isOptOutMessage } from './optout.js';

const packs = [
  { optOutPhrases: ['/stop', 'stop', "to'xtat"] },
  { optOutPhrases: ['стоп', 'хватит'] },
  { optOutPhrases: ['to‘xtat', 'bas'] },
] as const;

describe('isOptOutMessage', () => {
  it('matches exact whole-message opt-out phrases after normalization', () => {
    expect(isOptOutMessage('/stop', packs)).toBe(true);
    expect(isOptOutMessage(' STOP ', packs)).toBe(true);
    expect(isOptOutMessage('Стоп', packs)).toBe(true);
    expect(isOptOutMessage("to'xtat", packs)).toBe(true);
    expect(isOptOutMessage('to‘xtat', packs)).toBe(true);
  });

  it('ignores surrounding punctuation/spacing on the whole message', () => {
    expect(isOptOutMessage('stop.', packs)).toBe(true);
    expect(isOptOutMessage('  /stop!  ', packs)).toBe(true);
  });

  it('does not match when the word appears inside a sentence', () => {
    expect(isOptOutMessage('please stop sending', packs)).toBe(false);
    expect(isOptOutMessage('men stop demadim', packs)).toBe(false);
    expect(isOptOutMessage('стоп пожалуйста позже', packs)).toBe(false);
  });

  it('returns false for empty or non-matching messages', () => {
    expect(isOptOutMessage('', packs)).toBe(false);
    expect(isOptOutMessage('   ', packs)).toBe(false);
    expect(isOptOutMessage('hello', packs)).toBe(false);
  });
});
