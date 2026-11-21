import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLiveEvent, useLiveUpdates } from './live-updates';

const c = '11111111-1111-4111-8111-111111111111';
const h = '22222222-2222-4222-8222-222222222222';
const m = '33333333-3333-4333-8333-333333333333';

describe('parseLiveEvent', () => {
  it('accepts the payload every event type really carries', () => {
    expect(
      parseLiveEvent('conversation.updated', {
        conversationId: c,
        handoverId: null,
        messageId: null,
      }),
    ).toEqual({
      type: 'conversation.updated',
      conversationId: c,
      handoverId: null,
    });
    expect(
      parseLiveEvent('message.created', {
        conversationId: c,
        handoverId: null,
        messageId: m,
      }),
    ).toEqual({ type: 'message.created', conversationId: c, handoverId: null });
    expect(
      parseLiveEvent('handover.created', {
        conversationId: c,
        handoverId: h,
        messageId: null,
      }),
    ).toEqual({ type: 'handover.created', conversationId: c, handoverId: h });
    expect(
      parseLiveEvent('subscription.past_due', {
        conversationId: null,
        handoverId: null,
        messageId: null,
      }),
    ).toEqual({
      type: 'subscription.past_due',
      conversationId: null,
      handoverId: null,
    });
    expect(
      parseLiveEvent('subscription.bot_paused', {
        conversationId: c,
        handoverId: null,
        messageId: null,
      }),
    ).not.toBeNull();
  });

  it('rejects wrong shapes: missing ids, bad uuids, extra keys, non-objects', () => {
    const ok = { conversationId: c, handoverId: null, messageId: null };
    expect(parseLiveEvent('message.created', ok)).toBeNull();
    expect(parseLiveEvent('handover.sla_breached', ok)).toBeNull();
    expect(
      parseLiveEvent('conversation.updated', { ...ok, conversationId: 'x' }),
    ).toBeNull();
    expect(
      parseLiveEvent('conversation.updated', { ...ok, conversationId: null }),
    ).toBeNull();
    expect(
      parseLiveEvent('conversation.updated', { ...ok, text: 'secret' }),
    ).toBeNull();
    expect(
      parseLiveEvent('conversation.updated', {
        conversationId: c,
        handoverId: null,
      }),
    ).toBeNull();
    for (const raw of [null, 'x', 7, [], undefined])
      expect(parseLiveEvent('conversation.updated', raw)).toBeNull();
  });
});

describe('parseLiveEvent task.due (ADR 068)', () => {
  const base = { conversationId: c, handoverId: null, messageId: null };
  it('accepts an old payload without a title and a new one with it', () => {
    expect(parseLiveEvent('task.due', base)).toEqual({
      type: 'task.due',
      conversationId: c,
      handoverId: null,
    });
    expect(
      parseLiveEvent('task.due', { ...base, taskTitle: 'Call' }),
    ).toMatchObject({
      taskTitle: 'Call',
    });
    expect(
      parseLiveEvent('task.due', { ...base, taskTitle: null }),
    ).not.toBeNull();
  });
  it('rejects a title on other types, a non-text title and unknown keys', () => {
    expect(
      parseLiveEvent('message.created', {
        ...base,
        messageId: m,
        taskTitle: 'x',
      }),
    ).toBeNull();
    expect(parseLiveEvent('task.due', { ...base, taskTitle: 5 })).toBeNull();
    expect(parseLiveEvent('task.due', { ...base, extra: 1 })).toBeNull();
  });
});

describe('useLiveUpdates with a bad event (AUD-12)', () => {
  class FakeEventSource {
    static last: FakeEventSource | undefined;
    listeners = new Map<string, (message: MessageEvent) => void>();
    readyState = 1;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      FakeEventSource.last = this;
    }
    addEventListener(type: string, listener: (m: MessageEvent) => void): void {
      this.listeners.set(type, listener);
    }
    close(): void {}
    emit(type: string, data: string): void {
      this.listeners.get(type)?.({ data } as MessageEvent);
    }
  }
  afterEach(() => vi.unstubAllGlobals());

  it('refetches on malformed JSON or a bad payload and keeps handling later events', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const onEvent = vi.fn();
    renderHook(() => useLiveUpdates(true, onEvent), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });
    const stream = FakeEventSource.last!;
    const refetchedAll = (): boolean =>
      invalidate.mock.calls.some(
        ([filters]) =>
          JSON.stringify(filters?.queryKey) ===
          JSON.stringify(['conversation']),
      );

    stream.emit('message.created', '{not json');
    expect(refetchedAll()).toBe(true);
    invalidate.mockClear();
    stream.emit(
      'message.created',
      JSON.stringify({ conversationId: c, handoverId: null, messageId: 'x' }),
    );
    expect(refetchedAll()).toBe(true);
    // An event type the client does not know is never listened to.
    expect(stream.listeners.has('tenant.deleted')).toBe(false);
    expect(onEvent).not.toHaveBeenCalled();

    stream.emit(
      'message.created',
      JSON.stringify({ conversationId: c, handoverId: null, messageId: m }),
    );
    expect(onEvent).toHaveBeenCalledWith({
      type: 'message.created',
      conversationId: c,
      handoverId: null,
    });
  });
});
