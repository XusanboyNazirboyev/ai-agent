/** Scripted socket for adapter unit tests (no network). */
import type {
  SocketFactory,
  SocketLike,
  SocketRequest,
} from './ws-transport.js';

export class FakeSocket implements SocketLike {
  readonly sent: Record<string, unknown>[] = [];
  isOpen = false;
  closedWith: { code: number; reason: string } | undefined;
  private openHandlers: (() => void)[] = [];
  private messageHandlers: ((text: string) => void)[] = [];
  private closeHandlers: ((
    code: number,
    reason: string,
    error?: Error,
  ) => void)[] = [];

  constructor(readonly request: SocketRequest) {}

  send(data: string): void {
    if (!this.isOpen) throw new Error('send on a closed socket');
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, reason = ''): void {
    if (this.closedWith) return;
    this.isOpen = false;
    this.closedWith = { code, reason };
    for (const h of this.closeHandlers) h(code, reason);
  }

  onOpen(handler: () => void): void {
    this.openHandlers.push(handler);
  }

  onMessage(handler: (text: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(
    handler: (code: number, reason: string, error?: Error) => void,
  ): void {
    this.closeHandlers.push(handler);
  }

  // test controls
  open(): void {
    this.isOpen = true;
    for (const h of this.openHandlers) h();
  }

  receive(message: Record<string, unknown>): void {
    for (const h of this.messageHandlers) h(JSON.stringify(message));
  }

  fail(code: number, error: Error): void {
    this.isOpen = false;
    this.closedWith = { code, reason: '' };
    for (const h of this.closeHandlers) h(code, '', error);
  }
}

/** Factory that records every socket; `autoOpen` opens on the next tick. */
export function fakeSocketFactory(autoOpen = true): {
  factory: SocketFactory;
  sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: (request): SocketLike => {
      const socket = new FakeSocket(request);
      sockets.push(socket);
      if (autoOpen) queueMicrotask(() => socket.open());
      return socket;
    },
  };
}
