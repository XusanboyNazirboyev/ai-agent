import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Dispatcher } from 'undici';
import {
  createPinnedDispatcher,
  type PinnedDispatcherFactory,
} from '../generic-rest/dns-pinning.js';

/**
 * Test-only helpers: loopback HTTP(S) servers that record what they receive
 * and how many sockets are open, plus a dispatcher factory that records every
 * dispatcher the client creates so tests can assert it was released.
 */

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

export type TestHandler = (
  request: IncomingMessage & { readonly bodyText: string },
  response: ServerResponse,
) => void | Promise<void>;

export interface LocalServer {
  readonly port: number;
  readonly requests: RecordedRequest[];
  openSockets(): number;
  totalConnections(): number;
  close(): Promise<void>;
}

async function listen(
  server: Server,
  handler: TestHandler,
): Promise<LocalServer> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;

  server.on('connection', (socket: Socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: bodyText,
      });
      void Promise.resolve(
        handler(Object.assign(request, { bodyText }), response),
      ).catch(() => response.destroy());
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    requests,
    openSockets: () => sockets.size,
    totalConnections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export function startHttpServer(handler: TestHandler): Promise<LocalServer> {
  return listen(createHttpServer(), handler);
}

export function startHttpsServer(
  handler: TestHandler,
  tls: { key: string; cert: string },
): Promise<LocalServer> {
  return listen(createHttpsServer({ key: tls.key, cert: tls.cert }), handler);
}

export function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

/** Polls until `predicate` holds; sockets close asynchronously on the server. */
export async function eventually(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

export interface RecordingFactory {
  readonly factory: PinnedDispatcherFactory;
  readonly dispatchers: Dispatcher[];
  allReleased(): boolean;
}

export function recordingDispatcherFactory(
  wrap?: (dispatcher: Dispatcher) => Dispatcher,
): RecordingFactory {
  const dispatchers: Dispatcher[] = [];
  return {
    dispatchers,
    factory: (addresses, options): Dispatcher => {
      const dispatcher = createPinnedDispatcher(addresses, options);
      dispatchers.push(dispatcher);
      return wrap ? wrap(dispatcher) : dispatcher;
    },
    allReleased: () =>
      dispatchers.every(
        (dispatcher) =>
          (dispatcher as unknown as { destroyed: boolean }).destroyed,
      ),
  };
}

export interface TestCertificates {
  readonly ca: string;
  readonly key: string;
  readonly cert: string;
  readonly hostname: string;
}

export function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generates a throwaway CA and a server certificate for `hostname` (SAN) in a
 * temporary directory. Nothing is committed to the repository.
 */
export function generateTestCertificates(hostname: string): TestCertificates {
  const dir = mkdtempSync(join(tmpdir(), 'agentcore-tls-'));
  const file = (name: string): string => join(dir, name);
  const run = (args: string[]): void => {
    execFileSync('openssl', args, { stdio: 'ignore' });
  };
  try {
    const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'];
    run([
      'req',
      '-x509',
      ...ec,
      '-nodes',
      '-days',
      '2',
      '-keyout',
      file('ca.key'),
      '-out',
      file('ca.crt'),
      '-subj',
      '/CN=AgentCore Test CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign',
    ]);
    run([
      'req',
      ...ec,
      '-nodes',
      '-keyout',
      file('server.key'),
      '-out',
      file('server.csr'),
      '-subj',
      `/CN=${hostname}`,
    ]);
    writeFileSync(
      file('ext.cnf'),
      [
        `subjectAltName=DNS:${hostname}`,
        'basicConstraints=CA:FALSE',
        'keyUsage=digitalSignature',
        'extendedKeyUsage=serverAuth',
      ].join('\n'),
    );
    run([
      'x509',
      '-req',
      '-in',
      file('server.csr'),
      '-CA',
      file('ca.crt'),
      '-CAkey',
      file('ca.key'),
      '-CAcreateserial',
      '-days',
      '2',
      '-out',
      file('server.crt'),
      '-extfile',
      file('ext.cnf'),
    ]);
    return {
      ca: readFileSync(file('ca.crt'), 'utf8'),
      key: readFileSync(file('server.key'), 'utf8'),
      cert: readFileSync(file('server.crt'), 'utf8'),
      hostname,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
