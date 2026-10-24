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
] as const;

const POLL_MS = 10_000;
const RETRY_STREAM_MS = 15_000;

export interface LiveEvent {
  type: (typeof EVENT_TYPES)[number];
  conversationId: string | null;
  handoverId: string | null;
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
          const data = JSON.parse((message as MessageEvent<string>).data) as {
            conversationId?: string | null;
            handoverId?: string | null;
          };
          void queryClient.invalidateQueries({ queryKey: ['conversations'] });
          if (data.conversationId)
            void queryClient.invalidateQueries({
              queryKey: ['conversation', data.conversationId],
            });
          handler.current?.({
            type,
            conversationId: data.conversationId ?? null,
            handoverId: data.handoverId ?? null,
          });
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
