import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bitrix24TestTransport } from './bitrix24-test-transport.js';

let server: Server;
let base = '';
const seen: { path: string; body: string }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      seen.push({ path: request.url ?? '', body });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ result: 1 }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

describe('Bitrix24 test transport (BITRIX24_TEST_BASE_URL)', () => {
  it('sends the call to the local fake portal, keeping the method path', async () => {
    const transport = bitrix24TestTransport(base);
    const reply = await transport(
      'https://portal.bitrix24.test/rest/1/code123abc/crm.settings.mode.get.json',
      {},
    );
    expect(reply).toEqual({ status: 200, body: { result: 1 } });
    expect(seen).toEqual([
      { path: '/rest/1/code123abc/crm.settings.mode.get.json', body: '{}' },
    ]);
  });
});
