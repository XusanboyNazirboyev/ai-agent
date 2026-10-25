/**
 * Development only: a tiny forwarding proxy that lets a public tunnel reach
 * exactly one route, POST /webhooks/telegram/<channelAccountId>, and nothing
 * else. Listens on 127.0.0.1 only. Logs only a counter and status codes: never
 * headers, bodies, paths or secrets.
 *
 *   TELEGRAM_CHANNEL_ACCOUNT_ID=<uuid> pnpm telegram:proxy
 */
import { resolve } from 'node:path';
import { createServer, request } from 'node:http';
import { config as loadEnv } from 'dotenv';
import {
  assertLocalDevelopment,
  declaredBodyTooLarge,
  isAllowedWebhookRequest,
  MAX_WEBHOOK_BODY_BYTES,
} from '../src/dev/dev-guards.js';

loadEnv({ path: resolve(process.cwd(), '../../.env') });
assertLocalDevelopment(process.env);

const accountId = process.env.TELEGRAM_CHANNEL_ACCOUNT_ID;
if (!accountId) {
  console.log('Missing environment variable: TELEGRAM_CHANNEL_ACCOUNT_ID');
  process.exit(2);
}
const upstreamPort = Number(process.env.PORT ?? 4000);
const proxyPort = Number(process.env.TELEGRAM_PROXY_PORT ?? 4100);
let forwarded = 0;
let refused = 0;

const server = createServer((incoming, outgoing) => {
  if (!isAllowedWebhookRequest(incoming.method, incoming.url, accountId)) {
    refused += 1;
    outgoing.writeHead(404).end();
    return;
  }
  if (declaredBodyTooLarge(incoming.headers['content-length'])) {
    refused += 1;
    outgoing.writeHead(413).end();
    return;
  }
  const upstream = request(
    {
      host: '127.0.0.1',
      port: upstreamPort,
      method: 'POST',
      path: incoming.url,
      headers: incoming.headers,
      timeout: 15_000,
    },
    (response) => {
      forwarded += 1;
      outgoing.writeHead(response.statusCode ?? 502);
      response.pipe(outgoing);
    },
  );
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  // Chunked bodies carry no length up front: count bytes and cut the request.
  let received = 0;
  incoming.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_WEBHOOK_BODY_BYTES) {
      refused += 1;
      upstream.destroy();
      outgoing.writeHead(413).end();
      incoming.destroy();
    }
  });
  incoming.pipe(upstream);
});
server.listen(proxyPort, '127.0.0.1', () =>
  console.log(`proxy listening on 127.0.0.1:${proxyPort}`),
);

const stop = (): void => {
  console.log(`proxy stopping: forwarded=${forwarded} refused=${refused}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
