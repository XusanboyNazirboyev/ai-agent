import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import { Agent, type Dispatcher } from 'undici';
import {
  assertAddressesArePublic,
  bareHostname,
  normalizeResolvedAddresses,
  OutboundUrlPolicy,
  resolveHostnameAddresses,
  type ResolvedAddress,
} from './ssrf-protection.js';

/**
 * Host resolution function used by the pinning layer.
 *
 * Injectable so tests can drive the SSRF logic deterministically without a
 * live DNS resolver. Its answer is treated as untrusted and normalised (IP
 * syntax and family) before it is validated and pinned.
 */
export type HostResolver = (
  hostname: string,
  options: { source?: string },
) => Promise<ReadonlyArray<{ address: unknown; family: unknown }>>;

/**
 * Builds a lookup function that always answers with the supplied addresses.
 *
 * This is the DNS-pinning primitive: the HTTP client resolves the hostname
 * once, validates every answer against the SSRF policy, and then hands the
 * socket a lookup that returns exactly those addresses. A second DNS answer
 * (the classic DNS-rebinding trick) can therefore never influence the
 * connection. Node calls it with `all: true` when happy-eyeballs is enabled
 * and with a specific `family` otherwise; both are honoured, and a family the
 * pinned list cannot satisfy fails the connection instead of falling back to
 * the system resolver.
 */
export function createPinnedLookup(
  addresses: readonly ResolvedAddress[],
): LookupFunction {
  const pinned = addresses.map((entry) => ({
    address: entry.address,
    family: entry.family,
  }));

  return (hostname, options, callback) => {
    const family = options?.family;
    const candidates =
      family === 4 || family === 6 || family === 'IPv4' || family === 'IPv6'
        ? pinned.filter(
            (entry) =>
              entry.family === (family === 'IPv4' || family === 4 ? 4 : 6),
          )
        : pinned;

    if (candidates.length === 0) {
      const error: NodeJS.ErrnoException = new Error(
        `No pinned address available for ${hostname}`,
      );
      error.code = 'ENOTFOUND';
      callback(error, '', 0);
      return;
    }

    if (options?.all) {
      callback(null, candidates);
      return;
    }

    const [first] = candidates;
    callback(null, first.address, first.family);
  };
}

/** Limits applied to the single connection a pinned dispatcher may open. */
export interface PinnedDispatcherOptions {
  readonly connectTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly bodyTimeoutMs: number;
  readonly maxResponseBytes: number;
  /**
   * Trust anchors that REPLACE the default CA store. Test-only: the HTTP
   * client refuses this in production. Hostname verification is unchanged.
   */
  readonly trustedCertificates?: readonly string[];
}

export type PinnedDispatcherFactory = (
  addresses: readonly ResolvedAddress[],
  options: PinnedDispatcherOptions,
) => Dispatcher;

/**
 * Creates an undici dispatcher whose sockets can only reach `addresses`.
 *
 * Ownership: the caller creates exactly one dispatcher per request hop and
 * must release it with `releaseDispatcher` after the hop's response body has
 * been fully consumed or discarded. undici's `close()` waits for in-flight
 * requests, and a request is in flight until its body ends, so closing first
 * would wait on a body nobody reads.
 *
 * TLS: undici passes `host: <original hostname>` to `tls.connect`, so SNI and
 * certificate verification use the hostname from the URL while the socket
 * connects to the pinned IP. `rejectUnauthorized` is forced on so a stray
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` cannot silently disable verification.
 */
export const createPinnedDispatcher: PinnedDispatcherFactory = (
  addresses,
  options,
) =>
  new Agent({
    connect: {
      lookup: createPinnedLookup(addresses),
      timeout: options.connectTimeoutMs,
      rejectUnauthorized: true,
      ...(options.trustedCertificates
        ? { ca: [...options.trustedCertificates] }
        : {}),
    },
    connections: 1,
    headersTimeout: options.headersTimeoutMs,
    bodyTimeout: options.bodyTimeoutMs,
    maxResponseSize: options.maxResponseBytes,
  });

/**
 * Resolves a hostname, validates every answer and returns the address list
 * that the connection must be pinned to.
 *
 * IP-literal hosts are never sent to the resolver: Node does not consult the
 * lookup function for them, so the literal itself is what gets validated. On
 * the STRICT policy a host that resolves to any restricted address is
 * rejected before a socket is opened; there is no unpinned fallback.
 */
export async function resolvePinnedAddresses(
  hostname: string,
  options: {
    policy: OutboundUrlPolicy;
    source?: string;
    resolve?: HostResolver;
    exemptAddresses?: ReadonlySet<string>;
  },
): Promise<ResolvedAddress[]> {
  const host = bareHostname(hostname);
  const raw =
    isIP(host) !== 0 || options.resolve === undefined
      ? await resolveHostnameAddresses(host, { source: options.source })
      : await options.resolve(host, { source: options.source });
  const addresses = normalizeResolvedAddresses(host, raw, {
    source: options.source,
  });

  assertAddressesArePublic(host, addresses, options);
  return addresses;
}

/**
 * Releases a dispatcher exactly once.
 *
 * `graceful` (after the body was consumed) closes idle sockets; otherwise the
 * dispatcher is destroyed, which aborts anything still in flight. A failure
 * here is reported to `onError` and never thrown, so cleanup cannot replace
 * the request's own outcome.
 */
export async function releaseDispatcher(
  dispatcher: Dispatcher,
  options: { graceful: boolean; onError?: (error: unknown) => void },
): Promise<void> {
  try {
    if (options.graceful) {
      await dispatcher.close();
    } else {
      await dispatcher.destroy();
    }
  } catch (error: unknown) {
    options.onError?.(error);
    if (options.graceful) {
      await dispatcher.destroy().catch((destroyError: unknown) => {
        options.onError?.(destroyError);
      });
    }
  }
}
