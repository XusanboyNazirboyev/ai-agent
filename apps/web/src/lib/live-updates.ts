'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export type ConnectionState =
  'connecting' | 'live' | 'reconnecting' | 'polling';

const EVENT_TYPES = [
  'conversation.updated',
  'message.created',
  'handover.created',
  'handover.sla_breached',
  // ADR 047: the bot did not answer (expired), or the subscription changed.
  'subscription.bot_paused',
  'subscription.past_due',
  'subscription.expired',
] as const;

const POLL_MS = 10_000;
const RETRY_STREAM_MS = 15_000;

export interface LiveEvent {
  type: (typeof EVENT_TYPES)[number];
  conversationId: string | null;
  handoverId: string | null;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Runtime check of one SSE payload (AUD-12). Mirrors the API's
 * `InboxEventDataSchema` in `@agentcore/shared` without importing it (the web
 * app does not depend on that package): exactly the keys `conversationId`,
 * `handoverId`, `messageId`, with the identifiers each event type carries.
 * Returns `null` for anything else.
 */
export function parseLiveEvent(
  type: LiveEvent['type'],
  raw: unknown,
): LiveEvent | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return null;
  const keys = Object.keys(raw);
  const allowed = ['conversationId', 'handoverId', 'messageId'];
  if (keys.length !== 3 || !keys.every((key) => allowed.includes(key)))
    return null;
  const { conversationId, handoverId, messageId } = raw as Record<
    string,
    unknown
  >;
  const isId = (value: unknown): value is string =>
    typeof value === 'string' && UUID.test(value);
  const subscription = type.startsWith('subscription.');
  const conversationOk = subscription
    ? conversationId === null || isId(conversationId)
    : isId(conversationId);
  const handoverNeeded =
    type === 'handover.created' || type === 'handover.sla_breached';
  const handoverOk = handoverNeeded ? isId(handoverId) : handoverId === null;
  const messageOk =
    type === 'message.created' ? isId(messageId) : messageId === null;
  if (!conversationOk || !handoverOk || !messageOk) return null;
  return {
    type,
    conversationId: conversationId as string | null,
    handoverId: handoverId as string | null,
  };
}

/**
 * Subscribes to the SSE stream. The browser reconnects by itself and sends
 * Last-Event-ID; after any reconnect or a `resync` we also refetch over REST,
 * so a lost event can never leave stale data. If the stream cannot be kept
 * (closed by the server, e.g. 401/429) we fall back to periodic refetching and
 * try to open the stream again later.
 */
export function useLiveUpdates(
  enabled: boolean,
  onEvent?: (event: LiveEvent) => void,
): ConnectionState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ConnectionState>('connecting');
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });

  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let wasDown = false;

    const refetchAll = (): void => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['conversation'] });
    };

    const open = (): void => {
      if (disposed) return;
      source = new EventSource('/api/v1/events');
      source.onopen = (): void => {
        if (poll) clearInterval(poll);
        poll = undefined;
        setState('live');
        if (wasDown) refetchAll();
        wasDown = false;
      };
      source.addEventListener('resync', refetchAll);
      for (const type of EVENT_TYPES) {
        source.addEventListener(type, (message) => {
          let raw: unknown;
          try {
            raw = JSON.parse((message as MessageEvent<string>).data);
          } catch {
            refetchAll();
            return;
          }
          const data = parseLiveEvent(type, raw);
          if (!data) {
            // The stream is not trusted merely because the event name
            // matched: refetch the authoritative state and ignore the payload.
            refetchAll();
            return;
          }
          void queryClient.invalidateQueries({ queryKey: ['conversations'] });
          if (data.conversationId)
            void queryClient.invalidateQueries({
              queryKey: ['conversation', data.conversationId],
            });
          handler.current?.(data);
        });
      }
      source.onerror = (): void => {
        wasDown = true;
        if (source?.readyState === EventSource.CLOSED) {
          // The server refused or closed the stream: poll, and try again later.
          setState('polling');
          source.close();
          poll ??= setInterval(refetchAll, POLL_MS);
          retry = setTimeout(open, RETRY_STREAM_MS);
        } else {
          setState('reconnecting');
        }
      };
    };
    open();
    return (): void => {
      disposed = true;
      source?.close();
      if (poll) clearInterval(poll);
      if (retry) clearTimeout(retry);
    };
  }, [enabled, queryClient]);

  return state;
}
