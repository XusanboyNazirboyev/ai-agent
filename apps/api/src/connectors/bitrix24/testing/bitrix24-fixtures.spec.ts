import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Synthetic numbers used by the tests and the contract probe. */
const SYNTHETIC_PHONES = new Set([
  '+998900000017',
  '+998900000999',
  '998900000017',
  '900000017',
  '00998900000017',
]);

/**
 * Fixture lint: CI must never carry a real webhook path, portal host or phone.
 * Every file next to this one (and the Bitrix24 tests) is scanned.
 */
describe('Bitrix24 fixtures are scrubbed', () => {
  const dirs = [import.meta.dirname, join(import.meta.dirname, '..')];
  const files = dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(dir, name)),
  );

  it.each(files)('%s', (file) => {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\/rest\/\d+\/([A-Za-z0-9]+)/gu)) {
      expect(match[1], 'webhook code').toMatch(/^REDACTED/u);
    }
    for (const match of text.matchAll(
      /https?:\/\/(?:[^@\s/'"]+@)?([a-z0-9.-]+)/giu,
    )) {
      expect(['portal.example.test', 'apidocs.bitrix24.com'], 'host').toContain(
        match[1],
      );
    }
    for (const match of text.matchAll(/\+?\d[\d ()-]{8,}\d/gu)) {
      const digits = match[0].replace(/\D/gu, '');
      if (digits.length < 9 || digits.length > 15) continue;
      if (/^1793\d+|^\d{13}$/u.test(digits)) continue; // epoch timestamps
      expect(
        [...SYNTHETIC_PHONES].some(
          (phone) => phone.replace(/\D/gu, '') === digits,
        ),
        `unexpected phone-like number in ${file}`,
      ).toBe(true);
    }
  });
});
