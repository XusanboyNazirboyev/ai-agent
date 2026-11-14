import { describe, expect, it } from 'vitest';
import {
  missingSheetFields,
  sheetConfigQuery,
  withMapping,
} from './sheet-catalog';

describe('sheet catalog helpers', () => {
  it('needs a price and a name, destination or hotel', () => {
    expect(missingSheetFields({})).toEqual(['price', 'title']);
    expect(missingSheetFields({ price: 3 })).toEqual(['title']);
    expect(missingSheetFields({ price: 3, hotel: 1 })).toEqual([]);
    expect(missingSheetFields({ hotel: 1 })).toEqual(['price']);
  });

  it('gives a column to one field only', () => {
    const start = { price: 2, hotel: 1 };
    expect(withMapping(start, 'title', 1)).toEqual({ price: 2, title: 1 });
    expect(withMapping(start, 'hotel', null)).toEqual({ price: 2 });
    expect(withMapping(start, 'price', 5)).toEqual({ hotel: 1, price: 5 });
  });

  it('builds the config query without empty values', () => {
    const json = JSON.parse(
      sheetConfigQuery({
        mapping: { price: 2, hotel: 1 },
        defaultCurrency: '',
        freshnessDays: 5,
      }),
    ) as Record<string, unknown>;
    expect(json).toEqual({ mapping: { price: 2, hotel: 1 }, freshnessDays: 5 });
    expect(
      JSON.parse(
        sheetConfigQuery({
          mapping: {},
          defaultCurrency: 'USD',
          freshnessDays: 3,
        }),
      ),
    ).toMatchObject({ defaultCurrency: 'USD' });
  });

  it('keeps a Google Sheets link and the auto refresh choice only together', () => {
    const base = { mapping: {}, defaultCurrency: '', freshnessDays: 3 };
    expect(
      JSON.parse(
        sheetConfigQuery({
          ...base,
          sourceUrl: 'https://docs.google.com/spreadsheets/d/x/edit',
          autoRefresh: true,
        }),
      ),
    ).toMatchObject({
      sourceUrl: 'https://docs.google.com/spreadsheets/d/x/edit',
      autoRefresh: true,
    });
    // No link: the choice is not sent at all.
    expect(
      JSON.parse(sheetConfigQuery({ ...base, autoRefresh: true })),
    ).not.toHaveProperty('autoRefresh');
  });
});
