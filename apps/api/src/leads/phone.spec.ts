import { describe, expect, it } from 'vitest';
import { extractPhone, phoneFromCustomerText } from './phone.js';

describe('extractPhone', () => {
  it('takes a typed number and ignores a sentence with a number in it', () => {
    expect(extractPhone('+998 90 123 45 67')).toBe('+998901234567');
    expect(extractPhone('tel: 90 123 45 67')).toBe('901234567');
    expect(
      extractPhone('Matematika kursiga yozilmoqchiman, telefonim 90 123 45 67'),
    ).toBeUndefined();
  });
});

describe('phoneFromCustomerText (ADR 042: digits heard by a machine)', () => {
  it('takes a typed number as before', () => {
    expect(
      phoneFromCustomerText('90 123 45 67', {
        fromSpeech: false,
        speechDigits: 'typed',
      }),
    ).toBe('901234567');
  });

  it('does not take a number from a speech transcript until the customer types it', () => {
    expect(
      phoneFromCustomerText('77 025 07 14', {
        fromSpeech: true,
        speechDigits: 'typed',
      }),
    ).toBeUndefined();
  });

  it('takes a number from a transcript only when the owner chose to accept speech digits', () => {
    expect(
      phoneFromCustomerText('77 025 07 14', {
        fromSpeech: true,
        speechDigits: 'accept',
      }),
    ).toBe('770250714');
  });
});

describe('phoneFromCustomerText fail-safe', () => {
  it('treats an unknown policy value as typed', () => {
    expect(
      phoneFromCustomerText('77 025 07 14', {
        fromSpeech: true,
        speechDigits: undefined as unknown as 'typed',
      }),
    ).toBeUndefined();
  });
});
