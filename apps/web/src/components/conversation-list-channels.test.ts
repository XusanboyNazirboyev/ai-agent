import { describe, expect, it } from 'vitest';
import type { ChannelAccount } from '@/lib/types';
import { chipsFor, waitingCounts } from './conversation-list';

const account = (
  id: string,
  channelType: string,
  displayName: string | null = null,
): ChannelAccount => ({ id, channelType, displayName }) as ChannelAccount;

describe('inbox channel chips (owner 2026-11-23)', () => {
  it('offers all chats, then each connected messenger', () => {
    expect(
      chipsFor([account('t1', 'telegram'), account('i1', 'instagram')]).map(
        (c) => [c.key, c.type],
      ),
    ).toEqual([
      ['all', undefined],
      ['telegram', 'telegram'],
      ['instagram', 'instagram'],
    ]);
  });

  it('keeps every bot of a messenger in its one chip; no per-account or manual chips', () => {
    const chips = chipsFor([
      account('t1', 'telegram', 'SM TRAVEL'),
      account('t2', 'telegram'),
      account('m1', 'manual'),
      account('f1', 'facebook'),
    ]);
    expect(chips.map((c) => [c.key, c.label])).toEqual([
      ['all', undefined],
      ['telegram', 'Telegram'],
    ]);
  });
});

describe('waiting counts per messenger (owner 2026-11-23)', () => {
  it('counts waiting chats in all and per messenger', () => {
    expect(
      waitingCounts([
        { channelType: 'telegram' },
        { channelType: 'telegram' },
        { channelType: 'instagram' },
      ]),
    ).toEqual({ all: 3, telegram: 2, instagram: 1 });
    expect(waitingCounts([])).toEqual({ all: 0 });
  });
});
