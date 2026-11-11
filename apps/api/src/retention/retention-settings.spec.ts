import { describe, expect, it } from 'vitest';
import {
  inboundEventExpiresAt,
  parseRetentionSettings,
} from './retention-settings.js';

describe('parseRetentionSettings (P0.6)', () => {
  it('returns keep-all for empty/missing/invalid settings', () => {
    expect(parseRetentionSettings({})).toEqual({
      inboundEventMinutes: null,
      messageDays: null,
      conversationDays: null,
    });
    expect(parseRetentionSettings(undefined)).toEqual({
      inboundEventMinutes: null,
      messageDays: null,
      conversationDays: null,
    });
    expect(parseRetentionSettings({ inboundEventMinutes: -1 })).toEqual({
      inboundEventMinutes: null,
      messageDays: null,
      conversationDays: null,
    });
    expect(parseRetentionSettings({ messageDays: '30' })).toEqual({
      inboundEventMinutes: null,
      messageDays: null,
      conversationDays: null,
    });
  });

  it('reads configured positive integer values', () => {
    expect(
      parseRetentionSettings({
        inboundEventMinutes: 60,
        messageDays: 30,
        conversationDays: 90,
      }),
    ).toEqual({
      inboundEventMinutes: 60,
      messageDays: 30,
      conversationDays: 90,
    });
  });
});

describe('inboundEventExpiresAt (P0.6)', () => {
  it('returns null when inbound event retention is not configured', () => {
    expect(
      inboundEventExpiresAt(
        {
          inboundEventMinutes: null,
          messageDays: null,
          conversationDays: null,
        },
        new Date('2026-11-11T00:00:00Z'),
      ),
    ).toBeNull();
  });

  it('adds configured minutes to receivedAt', () => {
    expect(
      inboundEventExpiresAt(
        { inboundEventMinutes: 15, messageDays: null, conversationDays: null },
        new Date('2026-11-11T00:00:00Z'),
      ),
    ).toEqual(new Date('2026-11-11T00:15:00Z'));
  });
});
