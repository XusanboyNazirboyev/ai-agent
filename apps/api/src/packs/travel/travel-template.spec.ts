import { CrmTemplateSchema } from '@agentcore/shared';
import { describe, expect, it } from 'vitest';
import { TRAVEL_PACK } from './travel.pack.js';

const base = {
  key: 'demo',
  pipelineName: { en: 'Demo' },
  stages: [
    { code: 'NEW', kind: 'OPEN' },
    { code: 'LOST', kind: 'LOST' },
  ],
};

describe('ready CRM templates', () => {
  it('the travel pack offers the tourism template in all its languages', () => {
    const template = TRAVEL_PACK.crmTemplate!;
    expect(template.key).toBe('tourism');
    expect(template.stages.map((s) => s.kind)).toEqual([
      'OPEN',
      'OPEN',
      'OPEN',
      'OPEN',
      'WON',
      'WON',
      'LOST',
    ]);
    for (const locale of TRAVEL_PACK.locales) {
      expect(template.pipelineName[locale], locale).toBeTruthy();
      for (const field of template.leadFields)
        expect(field.label[locale], `${field.key} ${locale}`).toBeTruthy();
      for (const tag of template.tags)
        expect(tag.name[locale], locale).toBeTruthy();
    }
  });

  it('the travel month covers the whole year, not only the summer', () => {
    const month = TRAVEL_PACK.slots.find((s) => s.key === 'travelMonth')!;
    expect(month.options!.map((o) => o.value)).toEqual([
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december',
    ]);
    // Each month is recognised in Uzbek and Russian as customers write it.
    for (const option of month.options!)
      expect(option.synonyms.length, option.value).toBeGreaterThanOrEqual(3);
  });

  it('refuses a template a workspace could not use', () => {
    const bad = [
      {
        ...base,
        stages: [
          { code: 'LOST', kind: 'LOST' },
          { code: 'LOST', kind: 'OPEN' },
        ],
      },
      {
        ...base,
        stages: [
          { code: 'A', kind: 'WON' },
          { code: 'LOST', kind: 'LOST' },
        ],
      },
      {
        ...base,
        stages: [
          { code: 'NEW', kind: 'OPEN' },
          { code: 'NO', kind: 'WON' },
        ],
      },
      {
        ...base,
        stages: [
          { code: 'NEW', kind: 'OPEN' },
          { code: 'L1', kind: 'LOST' },
          { code: 'L2', kind: 'LOST' },
        ],
      },
      {
        ...base,
        stages: [
          { code: 'new', kind: 'OPEN' },
          { code: 'LOST', kind: 'LOST' },
        ],
      },
      {
        ...base,
        leadFields: [
          { key: 'a', type: 'TEXT', label: { en: 'A' } },
          { key: 'a', type: 'TEXT', label: { en: 'B' } },
        ],
      },
      {
        ...base,
        leadFields: [{ key: 'Bad Key', type: 'TEXT', label: { en: 'A' } }],
      },
      { ...base, tags: [{ name: { en: 'x'.repeat(41) } }] },
      { ...base, extra: true },
    ];
    for (const template of bad)
      expect(
        CrmTemplateSchema.safeParse(template).success,
        JSON.stringify(template),
      ).toBe(false);
    expect(CrmTemplateSchema.safeParse(base).success).toBe(true);
  });
});
