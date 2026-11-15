import { describe, expect, it } from 'vitest';
import en from '@/i18n/en.json';
import { timelineLine, type TimelineEntry } from './lead-timeline';

const t = (key: string, values: Record<string, string | number> = {}): string =>
  ((en as Record<string, string>)[key] ?? key).replace(
    /\{(\w+)\}/gu,
    (_, name: string) => String(values[name] ?? `{${name}}`),
  );

const base: TimelineEntry = {
  id: 'x',
  at: '2026-01-01T00:00:00Z',
  kind: 'lead.created',
  actor: 'assistant',
  actorName: null,
  text: null,
  from: null,
  to: null,
  reasonCode: null,
};

describe('timeline lines', () => {
  it('spells every kind in words, never a raw key', () => {
    const kinds: TimelineEntry['kind'][] = [
      'lead.created',
      'stage.moved',
      'lead.updated',
      'lead.archived',
      'task.created',
      'task.done',
      'note',
      'handover.opened',
      'handover.taken',
      'handover.resolved',
      'message',
    ];
    for (const kind of kinds) {
      const line = timelineLine(t, { ...base, kind, text: 'hi' });
      expect(line, kind).not.toMatch(/timeline\.|\{/u);
    }
  });

  it('names stages, the handover reason and who wrote a message', () => {
    expect(
      timelineLine(t, {
        ...base,
        kind: 'stage.moved',
        from: { id: 'a', code: null, name: 'New', kind: 'OPEN' },
        to: { id: 'b', code: null, name: 'Paid', kind: 'WON' },
      }),
    ).toBe('Stage: New → Paid');
    expect(timelineLine(t, { ...base, kind: 'stage.moved', to: null })).toBe(
      'Stage: — → —',
    );
    expect(
      timelineLine(t, {
        ...base,
        kind: 'handover.opened',
        reasonCode: 'COMPLAINT',
      }),
    ).toBe('Handed to a person: The customer has a complaint');
    expect(
      timelineLine(t, {
        ...base,
        kind: 'message',
        actor: 'customer',
        text: 'Price?',
      }),
    ).toBe('Customer: Price?');
    expect(
      timelineLine(t, {
        ...base,
        kind: 'message',
        actor: 'assistant',
        text: null,
      }),
    ).toBe('Assistant: (voice or file)');
  });
});
