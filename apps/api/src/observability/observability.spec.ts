import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { processQueuedEvent } from '../channels/telegram/telegram-queue.runtime.js';
import { HandoverRuntime } from '../handover/handover-runtime.js';
import {
  currentLogContext,
  enrichLogContext,
  runWithLogContext,
} from './log-context.js';
import { StructuredLogger } from './structured-logger.js';
import { TRACE_HEADER, traceIdFrom, traceRequests } from './trace-requests.js';

const at = new Date('2026-10-28T10:00:00.000Z');

function capture(): { logger: StructuredLogger; lines: () => unknown[] } {
  const written: string[] = [];
  const logger = new StructuredLogger(
    'info',
    (line) => written.push(line),
    () => at,
  );
  return {
    logger,
    lines: () => written.map((line) => JSON.parse(line) as unknown),
  };
}

describe('log context', () => {
  it('keeps its fields across awaits and adds what becomes known later', async () => {
    await runWithLogContext({ traceId: 'trace-0001' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      enrichLogContext({ tenantId: 't-1', conversationId: undefined });
      await Promise.resolve();
      expect(currentLogContext()).toEqual({
        traceId: 'trace-0001',
        tenantId: 't-1',
      });
    });
    expect(currentLogContext()).toBeUndefined();
  });

  it('keeps concurrent runs apart and does nothing outside a run', async () => {
    enrichLogContext({ tenantId: 'nobody' });
    expect(currentLogContext()).toBeUndefined();
    const seen = await Promise.all(
      ['a', 'b'].map((name) =>
        runWithLogContext({ traceId: `trace-${name}-0001` }, async () => {
          enrichLogContext({ tenantId: `tenant-${name}` });
          await new Promise((resolve) => setTimeout(resolve, 1));
          return currentLogContext();
        }),
      ),
    );
    expect(seen).toEqual([
      { traceId: 'trace-a-0001', tenantId: 'tenant-a' },
      { traceId: 'trace-b-0001', tenantId: 'tenant-b' },
    ]);
  });
});

describe('structured logger', () => {
  it('adds the correlation fields of the current context to every line', () => {
    const { logger, lines } = capture();
    runWithLogContext({ traceId: 'trace-0002' }, () => {
      enrichLogContext({
        tenantId: 't-2',
        conversationId: 'c-2',
        language: 'uz-Latn',
      });
      logger.log('{"event":"x"}', 'Context');
      logger.error('failed', 'Error: boom\n    at here', 'Context');
    });
    expect(lines()).toEqual([
      {
        timestamp: at.toISOString(),
        level: 'info',
        message: '{"event":"x"}',
        context: 'Context',
        traceId: 'trace-0002',
        tenantId: 't-2',
        conversationId: 'c-2',
        language: 'uz-Latn',
      },
      expect.objectContaining({
        level: 'error',
        traceId: 'trace-0002',
        stack: 'Error: boom\n    at here',
      }),
    ]);
  });

  it('writes no correlation fields outside a context and respects the level', () => {
    const { logger, lines } = capture();
    logger.debug('hidden');
    logger.warn('shown');
    expect(lines()).toEqual([
      { timestamp: at.toISOString(), level: 'warn', message: 'shown' },
    ]);
  });
});

describe('request trace id', () => {
  it('reuses a plausible x-request-id and replaces anything else', () => {
    expect(traceIdFrom('req-1234abcd')).toBe('req-1234abcd');
    for (const bad of [
      undefined,
      ['req-1234abcd', 'req-5678efgh'],
      'short',
      'has space in it',
      'x'.repeat(129),
      'line\nbreak-1234',
    ])
      expect(traceIdFrom(bad)).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('runs the request in its own context and answers with the id', () => {
    const headers: Record<string, string> = {};
    const response = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    } as unknown as ServerResponse;
    let inside: unknown;
    traceRequests(
      {
        headers: { [TRACE_HEADER]: 'req-from-client-1' },
      } as unknown as IncomingMessage,
      response,
      () => {
        inside = currentLogContext();
      },
    );
    expect(inside).toEqual({ traceId: 'req-from-client-1' });
    expect(headers[TRACE_HEADER]).toBe('req-from-client-1');
    expect(currentLogContext()).toBeUndefined();
  });
});

describe('correlation in the workers', () => {
  it('runs a queued Telegram event under its outbox id and tenant', async () => {
    let seen: unknown;
    const result = await processQueuedEvent(
      {
        process: () => {
          seen = currentLogContext();
          return Promise.resolve(undefined);
        },
      },
      {
        outboxId: '0190f000-0000-7000-8000-000000000001',
        tenantId: 't-9',
        type: 'telegram.inbound',
        payload: {},
      },
    );
    expect(result).toBeUndefined();
    expect(seen).toEqual({
      traceId: '0190f000-0000-7000-8000-000000000001',
      tenantId: 't-9',
    });
    expect(currentLogContext()).toBeUndefined();
  });

  it('gives each scan pass one trace that every scan shares', async () => {
    const seen: unknown[] = [];
    const record = (): Promise<number> => {
      seen.push(currentLogContext());
      return Promise.resolve(0);
    };
    const runtime = new HandoverRuntime(
      { get: () => undefined } as never,
      { scan: record } as never,
      [{ scanDue: record }, { scanDue: record }],
    );
    await runtime.tick(at);
    await runtime.tick(at);
    expect(seen).toHaveLength(6);
    const first = (seen[0] as { traceId: string }).traceId;
    const second = (seen[3] as { traceId: string }).traceId;
    expect(seen.slice(0, 3)).toEqual(Array(3).fill({ traceId: first }));
    expect(seen.slice(3)).toEqual(Array(3).fill({ traceId: second }));
    expect(first).not.toBe(second);
  });
});
