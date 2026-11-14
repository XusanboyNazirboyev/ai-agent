import { describe, expect, it } from 'vitest';
import {
  assistantLight,
  greetingPart,
  hourIn,
  setupItems,
  type TodaySummary,
} from './today';

const account = (
  status: 'ACTIVE' | 'DISABLED',
  agentMode: 'OFF' | 'SHADOW' | 'LIVE',
  effectiveMode: 'OFF' | 'SHADOW' | 'LIVE' | 'HOLD',
) => ({ status, agentMode, effectiveMode }) as const;

describe('assistantLight', () => {
  it('is "none" with no channel', () => {
    expect(assistantLight([])).toBe('none');
  });
  it('says "live" only when an active account really answers', () => {
    expect(assistantLight([account('ACTIVE', 'LIVE', 'LIVE')])).toBe('live');
    // Asked for LIVE but the server holds it back: not live.
    expect(assistantLight([account('ACTIVE', 'LIVE', 'HOLD')])).toBe('hold');
    expect(assistantLight([account('ACTIVE', 'LIVE', 'SHADOW')])).toBe(
      'drafts',
    );
  });
  it('ignores a switched-off account, whatever its mode', () => {
    expect(assistantLight([account('DISABLED', 'LIVE', 'LIVE')])).toBe('off');
  });
  it('takes the best state of several accounts', () => {
    expect(
      assistantLight([
        account('ACTIVE', 'OFF', 'OFF'),
        account('ACTIVE', 'SHADOW', 'SHADOW'),
        account('ACTIVE', 'LIVE', 'LIVE'),
      ]),
    ).toBe('live');
    expect(assistantLight([account('ACTIVE', 'OFF', 'OFF')])).toBe('off');
  });
});

describe('setupItems', () => {
  const none: NonNullable<TodaySummary['checklist']> = {
    channelConnected: false,
    hasContent: false,
    teamInvited: false,
    operatorGroup: false,
  };
  it('lists the five steps in order, each with a place to do it', () => {
    const items = setupItems(none, 'none');
    expect(items.map((i) => i.key)).toEqual([
      'channel',
      'content',
      'assistant',
      'team',
      'group',
    ]);
    expect(items.every((i) => !i.done && i.href.startsWith('/'))).toBe(true);
  });
  it('marks the assistant step done only when it is live', () => {
    const done = (light: Parameters<typeof setupItems>[1]): boolean =>
      setupItems(none, light).find((i) => i.key === 'assistant')!.done;
    expect(done('live')).toBe(true);
    for (const light of ['drafts', 'hold', 'off', 'none'] as const)
      expect(done(light)).toBe(false);
  });
});

describe('greeting', () => {
  it('splits the day', () => {
    expect(greetingPart(5)).toBe('morning');
    expect(greetingPart(11)).toBe('morning');
    expect(greetingPart(12)).toBe('afternoon');
    expect(greetingPart(17)).toBe('afternoon');
    expect(greetingPart(18)).toBe('evening');
    expect(greetingPart(4)).toBe('evening');
  });
  it('reads the hour in the workspace time zone', () => {
    const noonUtc = new Date('2026-11-14T12:00:00Z');
    expect(hourIn(noonUtc, 'UTC')).toBe(12);
    expect(hourIn(noonUtc, 'Asia/Tashkent')).toBe(17);
    expect(hourIn(new Date('2026-11-14T19:30:00Z'), 'Asia/Tashkent')).toBe(0);
  });
});
