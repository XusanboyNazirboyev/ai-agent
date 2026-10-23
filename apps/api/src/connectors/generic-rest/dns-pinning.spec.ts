import type { LookupAddress } from 'node:dns';
import type { Dispatcher } from 'undici';
import { describe, expect, it, vi } from 'vitest';
import {
  createPinnedLookup,
  releaseDispatcher,
  resolvePinnedAddresses,
} from './dns-pinning.js';
import {
  OutboundUrlPolicy,
  parseLoopbackExemptions,
} from './ssrf-protection.js';

type LookupResult = {
  error: NodeJS.ErrnoException | null;
  address: string | LookupAddress[];
  family?: number;
};

function callLookup(
  lookup: ReturnType<typeof createPinnedLookup>,
  options: { all?: boolean; family?: number },
): Promise<LookupResult> {
  return new Promise((resolve) => {
    lookup('crm.example.com', options, (error, address, family) =>
      resolve({ error, address, family }),
    );
  });
}

const pinned = [
  { address: '93.184.216.34', family: 4 as const },
  { address: '2606:2800:220:1::1', family: 6 as const },
];

describe('createPinnedLookup', () => {
  it('answers happy-eyeballs lookups with exactly the pinned list', async () => {
    await expect(
      callLookup(createPinnedLookup(pinned), { all: true }),
    ).resolves.toEqual({ error: null, address: pinned, family: undefined });
  });

  it('honours a requested address family', async () => {
    await expect(
      callLookup(createPinnedLookup(pinned), { family: 6 }),
    ).resolves.toEqual({
      error: null,
      address: '2606:2800:220:1::1',
      family: 6,
    });
  });

  it('fails instead of falling back to system DNS when no pinned address fits', async () => {
    const result = await callLookup(createPinnedLookup([pinned[0]]), {
      family: 6,
    });
    expect(result.error?.code).toBe('ENOTFOUND');
  });
});

describe('resolvePinnedAddresses', () => {
  const strict = { policy: OutboundUrlPolicy.STRICT };

  it('rejects a hostname whose answer includes a private address', async () => {
    await expect(
      resolvePinnedAddresses('crm.example.com', {
        ...strict,
        resolve: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '192.168.0.10', family: 4 },
        ],
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'CONNECTOR_SSRF_BLOCKED_HOST' }),
    );
  });

  it('validates the injected resolver answer like a real DNS answer', async () => {
    await expect(
      resolvePinnedAddresses('crm.example.com', {
        ...strict,
        resolve: async () => [{ address: 'evil.example', family: 4 }],
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'CONNECTOR_DNS_UNEXPECTED_ADDRESS' }),
    );
  });

  it('validates IP-literal hosts directly and never asks the resolver', async () => {
    const resolve = vi.fn();
    await expect(
      resolvePinnedAddresses('93.184.216.34', { ...strict, resolve }),
    ).resolves.toEqual([{ address: '93.184.216.34', family: 4 }]);
    await expect(
      resolvePinnedAddresses('[::1]', { ...strict, resolve }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'CONNECTOR_SSRF_BLOCKED_HOST' }),
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('allows an explicitly exempted loopback answer', async () => {
    await expect(
      resolvePinnedAddresses('crm.test', {
        ...strict,
        exemptAddresses: parseLoopbackExemptions(['127.0.0.1']),
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    ).resolves.toEqual([{ address: '127.0.0.1', family: 4 }]);
  });
});

describe('releaseDispatcher', () => {
  function fakeDispatcher(overrides: {
    close?: () => Promise<void>;
    destroy?: () => Promise<void>;
  }): Dispatcher & {
    close: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  } {
    return {
      close: vi.fn(overrides.close ?? (async (): Promise<void> => undefined)),
      destroy: vi.fn(
        overrides.destroy ?? (async (): Promise<void> => undefined),
      ),
    } as unknown as Dispatcher & {
      close: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
  }

  it('closes gracefully after the body was consumed', async () => {
    const dispatcher = fakeDispatcher({});
    await releaseDispatcher(dispatcher, { graceful: true });
    expect(dispatcher.close).toHaveBeenCalledOnce();
    expect(dispatcher.destroy).not.toHaveBeenCalled();
  });

  it('destroys when the hop failed', async () => {
    const dispatcher = fakeDispatcher({});
    await releaseDispatcher(dispatcher, { graceful: false });
    expect(dispatcher.destroy).toHaveBeenCalledOnce();
    expect(dispatcher.close).not.toHaveBeenCalled();
  });

  it('reports and recovers from a failed close without throwing', async () => {
    const onError = vi.fn();
    const failure = new Error('close failed');
    const dispatcher = fakeDispatcher({
      close: async () => {
        throw failure;
      },
    });
    await expect(
      releaseDispatcher(dispatcher, { graceful: true, onError }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(dispatcher.destroy).toHaveBeenCalledOnce();
  });

  it('reports a failed destroy without throwing', async () => {
    const onError = vi.fn();
    const dispatcher = fakeDispatcher({
      destroy: async () => {
        throw new Error('destroy failed');
      },
    });
    await expect(
      releaseDispatcher(dispatcher, { graceful: false, onError }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});
