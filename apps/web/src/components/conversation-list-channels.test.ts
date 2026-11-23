import { describe, expect, it } from 'vitest';
import type { ChannelAccount } from '@/lib/types';
import { chipsFor } from './conversation-list';

const account = (
  id: string,
  channelType: string,
  displayName: string | null = null,
): ChannelAccount => ({ id, channelType, displayName }) as ChannelAccount;

describe('inbox channel chips (owner 2026-11-23)', () => {
  it('offers all chats, then each connected messenger', () => {
    expect(
      chipsFor([account('t1', 'telegram'), account('i1', 'instagram')]).map(
        (c) => [c.key, c.type, c.accountId],
      ),
    ).toEqual([
      ['all', undefined, undefined],
      ['telegram', 'telegram', undefined],
      ['instagram', 'instagram', undefined],
    ]);
  });

  it('adds one chip per account when a messenger has several; skips manual leads', () => {
    const chips = chipsFor([
      account('t1', 'telegram', 'SM TRAVEL'),
      account('t2', 'telegram'),
      account('m1', 'manual'),
    ]);
    expect(chips.map((c) => [c.key, c.label, c.accountId])).toEqual([
      ['all', undefined, undefined],
      ['telegram', 'Telegram', undefined],
      ['t1', 'SM TRAVEL', 't1'],
      ['t2', 'Telegram 2', 't2'],
    ]);
  });
});
