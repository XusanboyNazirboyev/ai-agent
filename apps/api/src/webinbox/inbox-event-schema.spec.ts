import { describe, expect, it } from 'vitest';
import {
  InboxEventDataSchema,
  InboxEventRecordSchema,
} from '@agentcore/shared';

const conversationId = '11111111-1111-4111-8111-111111111111';
const handoverId = '22222222-2222-4222-8222-222222222222';
const messageId = '33333333-3333-4333-8333-333333333333';

const base = { handoverId: null, messageId: null } as const;

describe('inbox SSE event schemas', () => {
  it('accepts every supported event type with its expected identifier shape', () => {
    const cases = [
      { type: 'conversation.updated', conversationId, ...base },
      { type: 'message.created', conversationId, handoverId: null, messageId },
      {
        type: 'handover.created',
        conversationId,
        handoverId,
        messageId: null,
      },
      {
        type: 'handover.sla_breached',
        conversationId,
        handoverId,
        messageId: null,
      },
      { type: 'subscription.bot_paused', conversationId: null, ...base },
      { type: 'subscription.bot_paused', conversationId, ...base },
      { type: 'subscription.past_due', conversationId: null, ...base },
      { type: 'subscription.expired', conversationId: null, ...base },
    ] as const;
    for (const event of cases)
      expect(InboxEventDataSchema.safeParse(event).success).toBe(true);
  });

  it('requires valid event-specific identifiers', () => {
    expect(
      InboxEventDataSchema.safeParse({
        type: 'message.created',
        conversationId,
        ...base,
      }).success,
    ).toBe(false);
    expect(
      InboxEventDataSchema.safeParse({
        type: 'conversation.updated',
        conversationId: 'not-a-uuid',
        ...base,
      }).success,
    ).toBe(false);
    expect(
      InboxEventDataSchema.safeParse({
        type: 'handover.created',
        conversationId,
        handoverId: null,
        messageId: null,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown event types and unexpected payload fields', () => {
    expect(
      InboxEventDataSchema.safeParse({
        type: 'conversation.deleted',
        conversationId,
        ...base,
      }).success,
    ).toBe(false);
    expect(
      InboxEventDataSchema.safeParse({
        type: 'conversation.updated',
        conversationId,
        ...base,
        text: 'must never be part of an event',
      }).success,
    ).toBe(false);
  });

  it('validates the numeric resume cursor on persisted event records', () => {
    const record = { type: 'conversation.updated', conversationId, ...base };
    expect(
      InboxEventRecordSchema.safeParse({ id: '123', ...record }).success,
    ).toBe(true);
    for (const id of ['1\nid: forged', '', 'abc', '1234567890123456789'])
      expect(InboxEventRecordSchema.safeParse({ id, ...record }).success).toBe(
        false,
      );
  });
});
