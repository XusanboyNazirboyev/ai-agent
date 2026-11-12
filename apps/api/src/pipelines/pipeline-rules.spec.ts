import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  amountCurrencyPaired,
  checkLostReason,
  CURRENCIES,
  fromDateOnly,
  isAmount,
  isCalendarDate,
  isCurrency,
  parseOpportunityPatch,
  toDateOnly,
  validateStageOrder,
} from './pipeline-rules.js';

describe('amount and currency', () => {
  it('accepts decimal strings with at most 2 decimals and 12 integer digits', () => {
    for (const ok of ['0', '1500', '1500.5', '1500.50', '999999999999.99'])
      expect(isAmount(ok)).toBe(true);
  });

  it('rejects numbers, signs, exponents, separators and too many digits', () => {
    for (const bad of [
      1500,
      '-1',
      '+1',
      '1e3',
      '1,5',
      '1.',
      '.5',
      '1.555',
      '1234567890123',
      ' 1',
      '',
    ])
      expect(isAmount(bad)).toBe(false);
  });

  it('knows the listed currencies only', () => {
    for (const c of CURRENCIES) expect(isCurrency(c)).toBe(true);
    for (const bad of ['usd', 'XXX', 'US', 'USDT', '', null, 5])
      expect(isCurrency(bad)).toBe(false);
  });

  it('requires both or neither', () => {
    expect(amountCurrencyPaired(null, null)).toBe(true);
    expect(amountCurrencyPaired(undefined, null)).toBe(true);
    expect(amountCurrencyPaired('5', 'USD')).toBe(true);
    expect(amountCurrencyPaired('5', null)).toBe(false);
    expect(amountCurrencyPaired(null, 'USD')).toBe(false);
  });
});

describe('calendar dates', () => {
  it('accepts real dates, including 29 February of a leap year', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-12-31')).toBe(true);
  });

  it('rejects impossible and malformed dates', () => {
    for (const bad of [
      '2026-02-30',
      '2027-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-1-1',
      '26-01-01',
      '2026-01-01T00:00:00Z',
      '',
      null,
    ])
      expect(isCalendarDate(bad)).toBe(false);
  });

  it('round-trips a date without a timezone shift', () => {
    expect(fromDateOnly(toDateOnly('2026-03-01'))).toBe('2026-03-01');
    expect(fromDateOnly(null)).toBeNull();
  });
});

describe('lost reason', () => {
  it('is required with LOST and refused with every other status', () => {
    expect(checkLostReason('LOST', null)).toBe('REQUIRED');
    expect(checkLostReason('LOST', '')).toBe('REQUIRED');
    expect(checkLostReason('LOST', 'too expensive')).toBeUndefined();
    expect(checkLostReason('NEW', 'too expensive')).toBe('NOT_ALLOWED');
    expect(checkLostReason('WON', 'x')).toBe('NOT_ALLOWED');
    expect(checkLostReason('IN_PROGRESS', null)).toBeUndefined();
  });
});

describe('stage order', () => {
  const active = ['a', 'b', 'c'];
  it('accepts any permutation of exactly the active stages', () => {
    expect(validateStageOrder(['c', 'a', 'b'], active)).toBe(true);
  });
  it('rejects missing, extra, foreign and duplicated ids', () => {
    expect(validateStageOrder(['a', 'b'], active)).toBe(false);
    expect(validateStageOrder(['a', 'b', 'c', 'd'], active)).toBe(false);
    expect(validateStageOrder(['a', 'b', 'x'], active)).toBe(false);
    expect(validateStageOrder(['a', 'a', 'b'], active)).toBe(false);
  });
});

describe('opportunity patch', () => {
  it('normalises a valid patch', () => {
    const parsed = parseOpportunityPatch({
      ownerOperatorId: '01a1cf3d-2795-76b8-9bc1-1168a63b3b92',
      amount: '1500.50',
      currency: 'USD',
      source: '  telegram ',
      expectedCloseDate: '2026-12-01',
    });
    expect(parsed).toMatchObject({
      ok: true,
      patch: { amount: '1500.50', currency: 'USD', source: 'telegram' },
    });
  });

  it('clears fields with null and turns an empty source into null', () => {
    expect(
      parseOpportunityPatch({
        amount: null,
        currency: null,
        source: '  ',
        lostReason: null,
      }),
    ).toEqual({
      ok: true,
      patch: { amount: null, currency: null, source: null, lostReason: null },
    });
  });

  it('refuses an amount without its currency, in either direction', () => {
    for (const body of [
      { amount: '5' },
      { currency: 'USD' },
      { amount: '5', currency: null },
      { amount: null, currency: 'USD' },
    ])
      expect(parseOpportunityPatch(body)).toEqual({
        ok: false,
        code: 'INVALID_VALUE',
      });
  });

  it('refuses a number amount, an unknown currency, a bad date and a long reason', () => {
    for (const body of [
      { amount: 5, currency: 'USD' },
      { amount: '5', currency: 'XXX' },
      { expectedCloseDate: '2026-02-30' },
      { source: 'x'.repeat(61) },
      { lostReason: 'x'.repeat(201) },
    ])
      expect(parseOpportunityPatch(body).ok).toBe(false);
  });

  it('refuses unknown keys and a non-uuid owner as INVALID_BODY', () => {
    expect(parseOpportunityPatch({ score: 'HOT' })).toEqual({
      ok: false,
      code: 'INVALID_BODY',
    });
    expect(parseOpportunityPatch({ ownerOperatorId: 'nope' })).toEqual({
      ok: false,
      code: 'INVALID_BODY',
    });
  });
});

describe('the agent never reads the opportunity amount (ADR 057, AGENTS.md rule 2)', () => {
  const dir = resolve(process.cwd(), 'src/core/agent');
  const files = readdirSync(dir).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
  );

  it('has files to scan', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)(
    '%s imports no lead or pipeline module and reads no lead money',
    (name) => {
      const source = readFileSync(resolve(dir, name), 'utf8');
      expect(source).not.toMatch(/from\s+['"][^'"]*\/(leads|pipelines)\//);
      expect(source).not.toMatch(/\b(tx|prisma|db)\.lead\b/);
      expect(source).not.toMatch(
        /\blead\w*\s*[.?]+\s*(amount|currency|expectedCloseDate|lostReason|ownerOperatorId)\b/i,
      );
      expect(source).not.toMatch(/["']leads["'][^\n]*\bamount\b/i);
    },
  );
});
