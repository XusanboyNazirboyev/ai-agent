// Production and e2e web server: Next.js behind a thin Node HTTP server that
// owns the client-address trust boundary (ADR 021). Next's own server cannot:
// it forwards client-supplied X-Forwarded-For unchanged and exposes no socket
// address to proxy code.
import { createServer } from 'node:http';
import next from 'next';
import { applyTrustBoundary } from './trust-boundary.mjs';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? '127.0.0.1';
const trustedHops = Number(process.env.TRUSTED_PROXY_HOPS ?? 0);
const secret = process.env.WEB_PROXY_SECRET;

if (!dev && (!secret || secret.length < 32)) {
  console.error(
    'WEB_PROXY_SECRET (32+ characters, same value as the API) is required',
  );
  process.exit(2);
}

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
await app.prepare();

createServer((request, response) => {
  applyTrustBoundary(request.headers, {
    peer: request.socket.remoteAddress,
    isApi: (request.url ?? '').startsWith('/api/'),
    trustedHops,
    secret,
  });
  void handle(request, response);
}).listen(port, hostname, () => {
  console.log(`web listening on http://${hostname}:${port}`);
});
