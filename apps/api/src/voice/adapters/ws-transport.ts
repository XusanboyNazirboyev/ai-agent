/**
 * Minimal WebSocket seam for the speech adapters, so unit tests can inject a
 * scripted socket. The production factory uses the `ws` package because the
 * vendor endpoints authenticate with a request header (`xi-api-key`), which
 * the WHATWG WebSocket constructor cannot send.
 */
import WebSocket from 'ws';

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly isOpen: boolean;
  onOpen(handler: () => void): void;
  onMessage(handler: (text: string) => void): void;
  /** `code`/`reason` as given by the peer; `error` set when the socket failed. */
  onClose(handler: (code: number, reason: string, error?: Error) => void): void;
}

export interface SocketRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type SocketFactory = (request: SocketRequest) => SocketLike;

/** Opens a real WebSocket. Errors and refused upgrades surface as a close. */
export const wsSocketFactory: SocketFactory = (request) => {
  const ws = new WebSocket(request.url, { headers: { ...request.headers } });
  let failure: Error | undefined;
  ws.on('error', (error) => {
    failure = error;
  });
  ws.on('unexpected-response', (_req, res) => {
    // Status only: the body may echo request details.
    failure = new Error(`HTTP ${res.statusCode ?? 0} on upgrade`);
    ws.terminate();
  });
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code ?? 1000, reason),
    get isOpen(): boolean {
      return ws.readyState === WebSocket.OPEN;
    },
    onOpen: (handler) => ws.on('open', handler),
    onMessage: (handler) =>
      ws.on('message', (data: WebSocket.RawData) => {
        handler(
          Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Array.isArray(data)
              ? Buffer.concat(data).toString('utf8')
              : Buffer.from(data).toString('utf8'),
        );
      }),
    onClose: (handler) =>
      ws.on('close', (code: number, reason: Buffer) =>
        handler(code, reason.toString('utf8'), failure),
      ),
  };
};

/** Resolves when the socket opens; rejects when it closes first. */
export function waitForOpen(
  socket: SocketLike,
  timeoutMs: number,
): Promise<void> {
  if (socket.isOpen) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`socket did not open within ${timeoutMs} ms`));
      socket.close(1000, 'open timeout');
    }, timeoutMs);
    socket.onOpen(() => {
      clearTimeout(timer);
      resolve();
    });
    socket.onClose((code, _reason, error) => {
      clearTimeout(timer);
      reject(error ?? new Error(`socket closed before open (${code})`));
    });
  });
}
