import { describe, expect, it } from 'vitest';
import { translate } from '@/i18n';
import {
  handoverSummaryGroups,
  handoverSummaryLines,
  reasonLabel,
} from './handover-text';

const uz = (key: string, values?: Record<string, string | number>): string =>
  translate('uz-Latn', key, values);
const en = (key: string, values?: Record<string, string | number>): string =>
  translate('en', key, values);

// The codes of HANDOVER_REASONS in apps/api/src/core/locales/locale-pack.ts.
const REASONS = [
  'CUSTOMER_REQUEST',
  'COMPLAINT',
  'NEGOTIATION',
  'AUTH_REQUIRED',
  'NO_DATA',
  'GUARDRAIL',
  'BUDGET_EXCEEDED',
  'LLM_UNAVAILABLE',
  'CONNECTOR_UNAVAILABLE',
  'TOOL_LOOP_LIMIT',
  'LOW_LANG_CONFIDENCE',
  'STUCK',
  'HIGH_VALUE',
  'LEGAL_UNVERIFIED',
  'ACTION_FAILED',
  'ACTION_OUTCOME_UNKNOWN',
];

describe('handover reasons', () => {
  it('has words for every reason in every language', () => {
    for (const locale of ['uz-Latn', 'ru', 'en'] as const)
      for (const code of REASONS) {
        const text = reasonLabel(
          (key, values) => translate(locale, key, values),
          code,
        );
        expect(text, `${locale} ${code}`).not.toBe(code);
        expect(text).not.toMatch(/[A-Z]{2,}_[A-Z]/u);
      }
  });

  it('shows an unknown code as it is', () => {
    expect(reasonLabel(en, 'SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});

describe('handover summary', () => {
  const summary = {
    verifiedFacts: [],
    customerClaims: ['subject=Mathematics'],
    inferences: ['intent=greeting', 'locale=uz-Latn'],
    unknowns: ['reason=LOW_LANG_CONFIDENCE'],
  };

  it('reads as plain words and does not repeat the reason shown above it', () => {
    const lines = handoverSummaryLines(uz, summary, 'LOW_LANG_CONFIDENCE');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Fan: Mathematics');
    expect(lines.join('\n')).not.toMatch(
      /customerClaims|inferences|unknowns|intent=|locale=|LOW_LANG/u,
    );
  });

  it('names a different reason and marks technical details', () => {
    const lines = handoverSummaryLines(
      en,
      { ...summary, unknowns: ['reason=NO_DATA', 'llmFailure=TIMEOUT'] },
      'LOW_LANG_CONFIDENCE',
    );
    expect(lines.join('\n')).toContain(reasonLabel(en, 'NO_DATA'));
    expect(lines.some((line) => line.endsWith('llmFailure TIMEOUT'))).toBe(
      true,
    );
  });

  it('falls back to plain lines for any other shape', () => {
    expect(handoverSummaryLines(en, { note: 'call back' })).toEqual([
      'note: call back',
    ]);
    expect(handoverSummaryLines(en, null)).toEqual([]);
  });
});

describe('handover summary groups', () => {
  const summary = {
    customerClaims: ['subject=Mathematics', 'travelMonth=june'],
    inferences: ['intent=asks_operator', 'reason=NO_DATA'],
    unknowns: [],
    verifiedFacts: [],
  };
  it('names each group once and labels the slots in words, never as raw keys', () => {
    const groups = handoverSummaryGroups(uz, summary, 'NO_DATA');
    expect(groups.map((g) => g.title)).toEqual([
      uz('handover.group.customerClaims'),
      uz('handover.group.inferences'),
    ]);
    expect(groups[0]!.items).toEqual(['Fan: Mathematics', 'Sayohat oyi: june']);
    // The reason already shown above is not repeated; no raw key=value is left.
    expect(JSON.stringify(groups)).not.toMatch(
      /subject|travelMonth|reason=|=/u,
    );
  });
  it('is empty for a summary of another shape', () => {
    expect(handoverSummaryGroups(uz, { a: 1 })).toEqual([]);
    expect(handoverSummaryGroups(uz, null)).toEqual([]);
  });
});
