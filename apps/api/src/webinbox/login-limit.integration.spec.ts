import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT_IP_HEADER, PROXY_AUTH_HEADER } from './client-address.js';

/**
 * HTTP-level test of the login limiter's trust boundary (ADR 021) on the
 * real application: real sockets, real headers, the real AppModule.
 */
loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Login limit test requires agentcore_test');
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
const SECRET = 'test-proxy-secret-'.padEnd(48, 'x');
process.env.NODE_ENV = 'test';
process.env.WEB_PROXY_SECRET = SECRET;
process.env.LOGIN_RATE_LIMIT_PER_MINUTE = '3';

let app: INestApplication;
let url = '';

beforeAll(async () => {
  const { AppModule } = await import('../app.module.js');
  app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });
  await app.listen(0, '127.0.0.1');
  url = `${await app.getUrl()}/api/v1/auth/login`;
});
afterAll(async () => {
  await app?.close();
});

async function attempt(headers: Record<string, string>): Promise<number> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong' }),
  });
  await response.arrayBuffer();
  return response.status;
}

const fromWeb = (client: string): Record<string, string> => ({
  [PROXY_AUTH_HEADER]: SECRET,
  [CLIENT_IP_HEADER]: client,
});

describe('login rate limit behind the web server', () => {
  it('gives independent clients independent budgets', async () => {
    const a = [];
    for (let i = 0; i < 4; i += 1)
      a.push(await attempt(fromWeb('198.51.100.1')));
    expect(a).toEqual([401, 401, 401, 429]);
    // Another client behind the same web server is unaffected.
    expect(await attempt(fromWeb('198.51.100.2'))).toBe(401);
  });

  it('ignores a client address without the proxy credential or with a wrong one', async () => {
    // All of these come from the same TCP peer (127.0.0.1) and share its budget,
    // however the client rotates the headers it controls.
    const statuses = [];
    for (let i = 0; i < 4; i += 1)
      statuses.push(
        await attempt({
          [CLIENT_IP_HEADER]: `203.0.113.${i}`,
          [PROXY_AUTH_HEADER]: i % 2 ? 'wrong-secret' : '',
          'x-forwarded-for': `192.0.2.${i}`,
          'x-real-ip': `192.0.2.${i}`,
        }),
      );
    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  it('never reads X-Forwarded-For, even from the web server', async () => {
    const statuses = [];
    for (let i = 0; i < 4; i += 1)
      statuses.push(
        await attempt({
          ...fromWeb('198.51.100.3'),
          'x-forwarded-for': `192.0.2.${100 + i}`,
        }),
      );
    expect(statuses).toEqual([401, 401, 401, 429]);
  });
});
