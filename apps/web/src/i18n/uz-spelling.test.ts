import { describe, expect, it } from 'vitest';
import uz from './uz-Latn.json';

const entries = Object.entries(uz as Record<string, string>);

describe('Uzbek (Latin) spelling guard', () => {
  it('writes o‘ and g‘ with the typographic marks the file uses, never an ASCII apostrophe', () => {
    // The sign in words like ma’lumot and CRM’da is ’, the letters o‘ and g‘
    // use ‘: an ASCII ' is a typing slip and renders differently.
    expect(
      entries.filter(([, value]) => value.includes("'")).map(([key]) => key),
    ).toEqual([]);
  });

  it('has none of the misspellings found by the owner and the review', () => {
    // Each pattern is a real mistake that reached a screen: "bo‘lsha" (bo‘lsa),
    // "takhmil" (not a word; qo‘llab-quvvatlamaydi), "Lead manba" (a lead
    // sink is where leads go, not their source) and "lead" for "lid".
    const mistakes =
      /bo‘lsha|takhmil|qodir connector|Lead manba|\b[Ll]ead(lar|ni|ga|dan)?\b/u;
    expect(
      entries
        .filter(([, value]) => mistakes.test(value))
        .map(([key, value]) => `${key}: ${value}`),
    ).toEqual([]);
  });

  it('uses "yordamchi" for the assistant in the screens that name it, not "bot"', () => {
    const keys = [
      'state.BOT_ACTIVE',
      'confirm.returnTitle',
      'confirm.returnBody',
    ];
    for (const key of keys)
      expect((uz as Record<string, string>)[key]).not.toMatch(/\b[Bb]ot/u);
  });
});
