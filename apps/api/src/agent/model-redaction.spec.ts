import { describe, expect, it } from 'vitest';
import { redactForModel } from '../core/agent/redaction.js';
import { sanitize } from '../core/agent/prompts.js';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import { extraction, runTurn } from './testing/agent-harness.js';

/**
 * ChatLab research item 1 (owner 2026-11-18, every tenant): card and
 * identity document numbers never reach the model; phones, prices and dates
 * do, unchanged.
 */
describe('model-bound redaction', () => {
  it('hides card numbers in the usual spellings', () => {
    for (const card of [
      '8600 1234 5678 9012',
      '8600123456789012',
      '9860-1234-5678-9012',
      '4111 1111 1111 1111 123',
      '378282246310005', // 15 digits, Luhn-valid
    ])
      expect(redactForModel(`karta: ${card}.`), card).toBe('karta: [card].');
  });

  it('hides passport, ID card and PINFL numbers', () => {
    expect(redactForModel('pasport AB1234567')).toBe('pasport [document]');
    expect(redactForModel('ID AD 1234567,')).toBe('ID [document],');
    expect(redactForModel('JSHSHIR 31234567890123')).toBe('JSHSHIR [id]');
  });

  it('keeps phones, prices, dates and ordinary codes', () => {
    for (const text of [
      '+998 90 123 45 67',
      '998901234567',
      '90 123 45 67',
      '+79161234567',
      '00998901234567',
      '+998901234567890',
      '15 000 000 so‘m',
      '1 500 000 sum, 2 ta',
      '18.11.2026 soat 10:30',
      '2026-11-18',
      'IELTS 7.5, B2 level',
      'AB12345678',
      'ab1234567',
      '1234567890123', // 13 digits, not Luhn-valid
    ])
      expect(redactForModel(text), text).toBe(text);
  });

  it('applies to everything sanitized for a prompt', () => {
    expect(sanitize('mana karta 8600 1234 5678 9012 <b>')).toBe(
      'mana karta [card] ‹b›',
    );
  });

  it('the extraction request never carries the number; the turn still works', async () => {
    const provider = new ScriptedLlmProvider([
      extraction({ subject: 'IELTS' }, 'search'),
      { kind: 'tools', text: '{{F1}} bor.' },
    ]);
    const card = '8600 1234 5678 9012';
    await runTurn({
      provider,
      text: `IELTS bormi, kartam ${card}`,
      input: {
        history: [
          { role: 'customer', text: 'pasportim AB1234567' },
          { role: 'agent', text: 'Rahmat!' },
        ],
      },
    });
    const sent = JSON.stringify(provider.calls);
    expect(sent).not.toContain(card);
    expect(sent).not.toContain('AB1234567');
    expect(sent).toContain('[card]');
    expect(sent).toContain('never ask for it again');
  });
});
