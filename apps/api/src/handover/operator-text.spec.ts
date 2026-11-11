import { describe, expect, it } from 'vitest';
import { operatorStrings, parseRef, refLine } from './operator-text.js';

describe('operator-text', () => {
  it('selects locale strings for en/ru/uz with fallbacks', () => {
    expect(operatorStrings('en').handover).toBe('Handover');
    expect(operatorStrings('ru').take).toBe('Взять');
    expect(operatorStrings('uz-Latn').take).toBe('Olish');
    expect(operatorStrings('uz-Cyrl').take).toBe('Olish');
    expect(operatorStrings('fr').take).toBe('Take over'); // default en
  });

  it('formats dynamic strings', () => {
    const en = operatorStrings('en');
    expect(en.taken('Ada')).toBe('Taken by Ada');
    expect(en.slaAlert(15)).toContain('15');
    expect(en.digestTitle('2026-11-11')).toContain('2026-11-11');
    expect(en.digestWaiting(3)).toContain('3');
    expect(en.alertBudget(80, '2026-11')).toContain('80');
    expect(en.alertCrmFailures(2)).toContain('2');
  });

  it('builds and parses handover ref markers', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(refLine(id)).toBe(`ref:${id}`);
    expect(parseRef(`some text\nref:${id}\nmore`)).toBe(id);
    expect(parseRef('no ref here')).toBeUndefined();
    expect(parseRef(undefined)).toBeUndefined();
    expect(parseRef('ref:not-a-uuid')).toBeUndefined();
  });
});
