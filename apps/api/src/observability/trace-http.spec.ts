import { Controller, Get, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { StructuredLogger } from './structured-logger.js';
import { TRACE_HEADER, traceRequests } from './trace-requests.js';

@Controller('probe')
class ProbeController {
  private readonly logger = new Logger('Probe');

  @Get()
  async probe(): Promise<{ ok: true }> {
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.logger.log(JSON.stringify({ event: 'probe.handled' }));
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('trace ids through a real Nest HTTP app', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('answers with the request id and logs the handler under it', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = new StructuredLogger('info', (line) =>
      lines.push(JSON.parse(line) as Record<string, unknown>),
    );
    app = await NestFactory.create(ProbeModule, { logger });
    app.use(traceRequests);
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();

    const given = await fetch(`${base}/probe`, {
      headers: { [TRACE_HEADER]: 'client-req-0001' },
    });
    expect(given.status).toBe(200);
    expect(given.headers.get(TRACE_HEADER)).toBe('client-req-0001');

    const fresh = await fetch(`${base}/probe`, {
      headers: { [TRACE_HEADER]: 'bad id with spaces' },
    });
    const freshId = fresh.headers.get(TRACE_HEADER);
    expect(freshId).toMatch(/^[0-9a-f-]{36}$/u);

    const handled = lines.filter((line) =>
      String(line.message).includes('probe.handled'),
    );
    expect(handled.map((line) => line.traceId)).toEqual([
      'client-req-0001',
      freshId,
    ]);
  });
});
