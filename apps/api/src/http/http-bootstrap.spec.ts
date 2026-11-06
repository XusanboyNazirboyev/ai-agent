import 'reflect-metadata';
import { Body, Controller, Module, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureHttp, JSON_BODY_LIMIT } from './security-headers.js';

@Controller('echo')
class EchoController {
  @Post()
  echo(
    @Body() body: { text?: string },
    @Req() request: RawBodyRequest<Request>,
  ): { text: string | undefined; rawLength: number | undefined } {
    return { text: body.text, rawLength: request.rawBody?.length };
  }
}

@Module({ controllers: [EchoController] })
class EchoModule {}

describe('HTTP bootstrap shared by main.ts', () => {
  let app: NestExpressApplication;
  let base = '';

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(EchoModule, {
      logger: false,
      rawBody: true,
    });
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app.close();
  });

  const post = (body: string): Promise<Response> =>
    fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

  it('keeps the raw bytes for signature checks and adds the headers', async () => {
    const body = JSON.stringify({ text: 'salom' });
    const response = await post(body);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      text: 'salom',
      rawLength: Buffer.byteLength(body),
    });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('accepts a body above the framework default of 100kb, up to the limit', async () => {
    const response = await post(JSON.stringify({ text: 'x'.repeat(150_000) }));
    expect(response.status).toBe(201);
  });

  it(`refuses a JSON body above ${JSON_BODY_LIMIT} with 413`, async () => {
    const response = await post(JSON.stringify({ text: 'x'.repeat(300_000) }));
    expect(response.status).toBe(413);
  });
});
