import {
  Controller,
  Get,
  Headers,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';
import { InboxEventBus } from './inbox-event-bus.js';
import { InboxEventsService, parseEventId } from './inbox-events.service.js';

interface StreamResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): boolean;
  end(): void;
  on(event: 'close', listener: () => void): void;
}

/** Safety net in case a bus signal is missed (the database stays the truth). */
const FALLBACK_POLL_MS = 5000;
const HEARTBEAT_MS = 15_000;
const MAX_STREAMS_PER_OPERATOR = 5;

/** Opens streams per operator; a plain counter, one process (ADR 020). */
const open = new Map<string, number>();

/** Open streams of one operator in this process (tests, metrics). */
export function openStreams(tenantId: string, operatorId: string): number {
  return open.get(`${tenantId}:${operatorId}`) ?? 0;
}

@Controller('api/v1/events')
@UseGuards(SessionGuard)
export class EventsController {
  constructor(
    private readonly events: InboxEventsService,
    private readonly bus: InboxEventBus,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  /**
   * Server-sent events for the operator's tenant. A reconnect sends
   * Last-Event-ID (or ?lastEventId) and receives everything after it; if
   * pruned events cannot be replayed the stream sends `resync` and the
   * client refetches over REST.
   */
  @Get()
  async stream(
    @Req() request: InboxRequest,
    @Res() response: StreamResponse,
    @Headers('last-event-id') header: string | undefined,
    @Query('lastEventId') query: string | undefined,
  ): Promise<void> {
    const principal = request.principal!;
    const key = `${principal.tenantId}:${principal.operatorId}`;
    if ((open.get(key) ?? 0) >= MAX_STREAMS_PER_OPERATOR) {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.write(JSON.stringify({ code: 'TOO_MANY_STREAMS' }));
      response.end();
      return;
    }
    open.set(key, (open.get(key) ?? 0) + 1);
    // Cleanup is registered before any await: a client that disconnects while
    // the stream is being set up must still release its slot, its bus
    // subscription and its timers (they are created only if still open).
    let closed = false;
    const subscription: { off?: () => void } = {};
    const timers: ReturnType<typeof setInterval>[] = [];
    let released = false;
    const release = (): void => {
      closed = true;
      if (released) return;
      released = true;
      subscription.off?.();
      for (const timer of timers) clearInterval(timer);
      const left = (open.get(key) ?? 1) - 1;
      if (left <= 0) open.delete(key);
      else open.set(key, left);
    };
    response.on('close', release);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const resume = parseEventId(header) ?? parseEventId(query);
    let cursor = resume ?? (await this.events.latestId(principal.tenantId));
    if (closed) return;
    let busy = false;
    const send = (frame: string): void => {
      if (!closed) response.write(frame);
    };
    send('retry: 3000\n\n');

    const poll = async (): Promise<void> => {
      if (closed || busy) return;
      busy = true;
      try {
        const { events, gap } = await this.events.after(
          principal.tenantId,
          cursor,
        );
        if (gap) send(`event: resync\ndata: {}\n\n`);
        for (const event of events) {
          const { id, type, ...ids } = event;
          send(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(ids)}\n\n`);
          cursor = BigInt(id);
        }
      } catch {
        // A failed poll is retried on the next tick; the client keeps its cursor.
      } finally {
        busy = false;
      }
    };
    // The bus wakes this stream when its tenant has new events; the stream
    // always reads the events themselves from its own cursor in the database.
    let again = false;
    const wake = (): void => {
      if (busy) again = true;
      else
        void poll().then(() => (again ? ((again = false), poll()) : undefined));
    };
    const off = await this.bus.subscribe(principal.tenantId, wake);
    if (closed) {
      off();
      return;
    }
    subscription.off = off;
    timers.push(setInterval(() => void poll(), FALLBACK_POLL_MS));
    timers.push(setInterval(() => send(': keep-alive\n\n'), HEARTBEAT_MS));
    // Recycle the connection (with jitter) so no proxy holds it forever.
    const maxMs = this.config.get('INBOX_STREAM_MAX_MS', { infer: true });
    timers.push(
      setTimeout(
        () => {
          if (!closed) response.end();
        },
        maxMs + Math.floor(Math.random() * Math.min(maxMs / 10, 30_000)),
      ),
    );
    // Catch up from the cursor now that the bus is listening.
    await poll();
  }
}
