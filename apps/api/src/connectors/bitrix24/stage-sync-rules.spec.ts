import { describe, expect, it } from 'vitest';
import { assertAllowed } from './bitrix24-client.js';
import {
  advanceCursor,
  CURSOR_OVERLAP_MS,
  defaultTarget,
  lostReasonFor,
  normalizeSemantics,
  parseChanges,
  parseStages,
  scanSince,
} from './stage-sync-rules.js';
import { statusListResponse } from './testing/bitrix24-fixtures.js';

describe('crm.status.list allow-list guard', () => {
  it('allows only the lead stage dictionary', () => {
    expect(() =>
      assertAllowed('crm.status.list', { filter: { ENTITY_ID: 'STATUS' } }),
    ).not.toThrow();
    for (const params of [
      {},
      undefined,
      { filter: { ENTITY_ID: 'DEAL_STAGE' } },
      { filter: { ENTITY_ID: 'SOURCE' } },
    ])
      expect(() => assertAllowed('crm.status.list', params)).toThrow(
        /not allowed/u,
      );
  });
});

describe('stage parsing and defaults', () => {
  it('normalizes semantics from words and short codes', () => {
    expect(normalizeSemantics('success')).toBe('success');
    expect(normalizeSemantics('S')).toBe('success');
    expect(normalizeSemantics('failure')).toBe('failure');
    expect(normalizeSemantics('F')).toBe('failure');
    expect(normalizeSemantics('apology')).toBe('apology');
    expect(normalizeSemantics(null)).toBe('process');
    expect(normalizeSemantics('process')).toBe('process');
  });

  it('parses the docs shape, drops malformed rows and orders by SORT', () => {
    const body = statusListResponse([
      { statusId: 'B', name: 'Second', sort: 20 },
      { statusId: 'A', name: 'First', sort: 10 },
      { statusId: 'X', name: 'Lost', sort: 30, semantics: 'failure' },
    ]);
    const stages = parseStages([...body.result, { NAME: 'no id' }, null, 7]);
    expect(stages.map((s) => s.id)).toEqual(['A', 'B', 'X']);
    expect(stages[2]?.semantics).toBe('failure');
    expect(parseStages('nope')).toEqual([]);
  });

  it('maps success to WON, failure and apology to LOST, process to nothing', () => {
    const ours = [
      { id: 'o', kind: 'OPEN' as const },
      { id: 'w', kind: 'WON' as const },
      { id: 'l', kind: 'LOST' as const },
    ];
    expect(defaultTarget('success', ours)).toBe('w');
    expect(defaultTarget('failure', ours)).toBe('l');
    expect(defaultTarget('apology', ours)).toBe('l');
    expect(defaultTarget('process', ours)).toBeNull();
    expect(defaultTarget('success', [ours[0]!])).toBeNull();
  });

  it('builds a capped LOST reason', () => {
    expect(lostReasonFor('Junk lead')).toBe('Bitrix24: Junk lead');
    expect(lostReasonFor('x'.repeat(500)).length).toBe(200);
  });
});

describe('cursor', () => {
  const t = (iso: string): Date => new Date(iso);

  it('parses items and drops malformed ones', () => {
    const changes = parseChanges({
      items: [
        { id: 5, stageId: 'NEW', updatedTime: '2026-11-19T10:00:00+03:00' },
        { id: 'x', stageId: 'NEW', updatedTime: '2026-11-19T10:00:00Z' },
        { id: 6, stageId: '', updatedTime: '2026-11-19T10:00:00Z' },
        { id: 7, stageId: 'NEW', updatedTime: 'garbage' },
      ],
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.updatedAt.toISOString()).toBe('2026-11-19T07:00:00.000Z');
    expect(parseChanges(null)).toEqual([]);
  });

  it('reads one minute before the cursor', () => {
    expect(scanSince(t('2026-11-19T10:00:00Z')).getTime()).toBe(
      t('2026-11-19T10:00:00Z').getTime() - CURSOR_OVERLAP_MS,
    );
  });

  it('advances only to the newest processed item and never backwards', () => {
    const cursor = t('2026-11-19T10:00:00Z');
    const items = [
      { id: 1, stageId: 'A', updatedAt: t('2026-11-19T09:59:30Z') },
      { id: 2, stageId: 'A', updatedAt: t('2026-11-19T10:01:00Z') },
    ];
    expect(advanceCursor(cursor, items.slice(0, 1))).toEqual(cursor);
    expect(advanceCursor(cursor, items)).toEqual(items[1]?.updatedAt);
    expect(advanceCursor(cursor, [])).toEqual(cursor);
  });
});
