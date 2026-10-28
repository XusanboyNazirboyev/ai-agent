import { afterEach, describe, expect, it } from 'vitest';
import type { HostResolver } from '../generic-rest/dns-pinning.js';
import { startHttpServer, type LocalServer } from '../testing/local-http.js';
import { restTransport } from './bitrix24-client.js';

/**
 * The real transport (RestHttpClient, pinned DNS, real socket) against a
 * loopback server. `portal.example.test` cannot resolve through system DNS,
 * so a request that arrives proves the pinned address was used.
 */
const loopback: HostResolver = async () => [
  { address: '127.0.0.1', family: 4 },
];
const CODE = 'REDACTED0000test';
const servers: LocalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('Bitrix24 transport and redirects', () => {
  it('refuses a 307 to another method and sends no second request', async () => {
    const server = await startHttpServer((_request, response) => {
      response.statusCode = 307;
      response.setHeader('location', `/rest/1/${CODE}/crm.lead.delete.json`);
      response.end();
    });
    servers.push(server);
    const transport = restTransport({
      resolve: loopback,
      exemptLoopbackAddresses: ['127.0.0.1'],
      defaultTimeoutMs: 2_000,
    });
    const error = (await transport(
      `http://portal.example.test:${server.port}/rest/1/${CODE}/crm.item.add.json`,
      { entityTypeId: 1, fields: { title: 'Synthetic' } },
    ).catch((caught: unknown) => caught)) as Error & {
      code?: string;
      executed?: string;
    };
    expect(error).toMatchObject({
      code: 'BITRIX24_REDIRECT_REFUSED',
      executed: 'no',
    });
    expect(error.message).not.toContain(CODE);
    expect(error.message).not.toContain('portal.example.test');
    expect(error.cause).toBeUndefined();
    expect(server.requests.map((request) => request.url)).toEqual([
      `/rest/1/${CODE}/crm.item.add.json`,
    ]);
  });
});
