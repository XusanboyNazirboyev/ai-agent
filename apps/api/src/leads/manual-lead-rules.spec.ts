import { describe, expect, it } from 'vitest';
import {
  chooseStage,
  isManualChannelType,
  manualExternalAccountId,
  manualIdentifiers,
  parseManualLeadBody,
} from './manual-lead-rules.js';

const ID = '3b241101-e2bb-4255-8caf-4136c566a962';
const ID2 = '9a7f2d3e-0b1c-4d5e-8f60-7a8b9c0d1e2f';

describe('manual lead rules', () => {
  it('recognises only the internal channel type', () => {
    expect(isManualChannelType('manual')).toBe(true);
    expect(isManualChannelType('telegram')).toBe(false);
  });

  it('puts the tenant into the internal account id and one uuid into the row ids', () => {
    expect(manualExternalAccountId(ID)).toBe(`manual:${ID}`);
    expect(manualIdentifiers(ID)).toEqual({
      providerUserId: `manual:${ID}`,
      providerChatId: `manual:${ID}`,
      idempotencyKey: `manual:${ID}`,
    });
  });

  it('parses a minimal body with defaults', () => {
    const r = parseManualLeadBody({ name: '  Ali ' });
    expect(r).toMatchObject({
      ok: true,
      input: { name: 'Ali', source: 'manual', note: '', tagIds: [] },
    });
  });

  it('normalises the phone and rejects an invalid one', () => {
    // Digits only, a leading + kept; nothing is completed (leads/phone.ts).
    const ok = parseManualLeadBody({ name: 'A', phone: '+998 (90) 123-45-67' });
    expect(ok.ok && ok.input.phone).toBe('+998901234567');
    const local = parseManualLeadBody({ name: 'A', phone: '90 123 45 67' });
    expect(local.ok && local.input.phone).toBe('901234567');
    expect(parseManualLeadBody({ name: 'A', phone: 'nope' })).toEqual({
      ok: false,
      code: 'INVALID_VALUE',
    });
    const blank = parseManualLeadBody({ name: 'A', phone: '   ' });
    expect(blank.ok && blank.input.phone).toBeUndefined();
  });

  it('is strict and bounded', () => {
    expect(parseManualLeadBody({ name: '' })).toMatchObject({ ok: false });
    expect(parseManualLeadBody({ name: 'x'.repeat(201) })).toMatchObject({
      ok: false,
    });
    expect(
      parseManualLeadBody({ name: 'A', note: 'x'.repeat(1001) }),
    ).toMatchObject({
      ok: false,
    });
    expect(parseManualLeadBody({ name: 'A', other: 1 })).toEqual({
      ok: false,
      code: 'INVALID_BODY',
    });
    expect(parseManualLeadBody({ name: 'A', pipelineId: 'x' })).toMatchObject({
      ok: false,
    });
  });

  it('wants amount and currency together, decimal and listed', () => {
    expect(parseManualLeadBody({ name: 'A', amount: '5' })).toEqual({
      ok: false,
      code: 'INVALID_VALUE',
    });
    expect(parseManualLeadBody({ name: 'A', currency: 'UZS' })).toEqual({
      ok: false,
      code: 'INVALID_VALUE',
    });
    expect(
      parseManualLeadBody({ name: 'A', amount: '1.234', currency: 'UZS' }),
    ).toMatchObject({ ok: false });
    expect(
      parseManualLeadBody({ name: 'A', amount: '10.50', currency: 'UZS' }),
    ).toMatchObject({ ok: true, input: { amount: '10.50', currency: 'UZS' } });
  });

  it('trims the source, falls back to manual, dedupes tags', () => {
    const r = parseManualLeadBody({
      name: 'A',
      source: '   ',
      tagIds: [ID, ID, ID2],
    });
    expect(r.ok && r.input.source).toBe('manual');
    expect(r.ok && r.input.tagIds).toEqual([ID, ID2]);
  });

  it('chooses the stage: open only, in the named pipeline', () => {
    const open = { id: ID, pipelineId: ID2, kind: 'OPEN' as const };
    expect(chooseStage(open, undefined)).toEqual({
      ok: true,
      stageId: ID,
      pipelineId: ID2,
    });
    expect(chooseStage(open, ID2)).toMatchObject({ ok: true });
    expect(chooseStage(open, ID)).toEqual({ ok: false, code: 'INVALID_VALUE' });
    expect(chooseStage(null, undefined)).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    for (const kind of ['WON', 'LOST'] as const)
      expect(chooseStage({ ...open, kind }, undefined)).toEqual({
        ok: false,
        code: 'STAGE_NOT_OPEN',
      });
  });
});
