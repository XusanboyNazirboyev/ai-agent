import { describe, expect, it } from 'vitest';
import en from './en.json';
import ru from './ru.json';
import uz from './uz-Latn.json';

// Found by the 2026-11-14 English audit: an environment variable name shown to
// an admin, and straight quotes mixed with the typographic ones.
const catalogs: Array<[string, Record<string, string>]> = [
  ['en', en as Record<string, string>],
  ['ru', ru as Record<string, string>],
  ['uz-Latn', uz as Record<string, string>],
];

describe('catalog style', () => {
  for (const [name, catalog] of catalogs)
    it(`${name}: no environment variable name is shown to a user`, () => {
      expect(
        Object.entries(catalog)
          .filter(([, value]) => /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/u.test(value))
          .map(([key]) => key),
      ).toEqual([]);
    });

  it('en: quotes around a name are typographic, never straight', () => {
    expect(
      Object.entries(en as Record<string, string>)
        .filter(([, value]) => value.includes('"'))
        .map(([key]) => key),
    ).toEqual([]);
  });

  it('en: one spelling of "cancelled"', () => {
    expect(
      Object.values(en as Record<string, string>).filter((value) =>
        /\bcanceled\b/iu.test(value),
      ),
    ).toEqual([]);
  });
});
