import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appModuleEnvironment } from '../../persistence/testing/test-clients.js';
import { VoiceMediaStore } from './voice-media.js';

/**
 * Instagram voice replies (owner 2026-11-23): the real AppModule serves the
 * stored audio from real Redis at the public path Meta fetches.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Voice media test requires agentcore_test');
}
for (const key of [
  'HOST',
  'PORT',
  'DATABASE',
  'USER',
  'PASSWORD',
  'SSL_MODE',
]) {
  const value = process.env[`TEST_POSTGRES_${key}`];
  if (value !== undefined) process.env[`POSTGRES_${key}`] = value;
}
Object.assign(process.env, appModuleEnvironment());
process.env.NODE_ENV = 'test';
process.env.PUBLIC_BASE_URL = 'https://tezda.example';

let app: INestApplication;
let origin = '';

beforeAll(async () => {
  const { AppModule } = await import('../../app.module.js');
  app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });
  await app.listen(0, '127.0.0.1');
  origin = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
});

describe('voice media over HTTP', () => {
  it('serves a stored voice reply as audio/aac, and 404 for anything else', async () => {
    const audio = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 1, 2, 3]);
    const url = await app.get(VoiceMediaStore).put(audio);
    expect(url).toMatch(
      /^https:\/\/tezda\.example\/webhooks\/instagram\/voice\//u,
    );
    const path = new URL(url!).pathname;
    const ok = await fetch(origin + path);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('audio/aac');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(audio);
    for (const bad of [
      `/webhooks/instagram/voice/${'a'.repeat(32)}.aac`,
      '/webhooks/instagram/voice/short.aac',
    ]) {
      const response = await fetch(origin + bad);
      await response.arrayBuffer();
      expect(response.status).toBe(404);
    }
  });
});
