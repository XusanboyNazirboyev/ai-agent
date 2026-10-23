import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { URL } from 'node:url';
import {
  ConnectorConfigurationError,
  ConnectorUnavailableError,
} from '../interfaces/errors.js';

/**
 * Hostnames that must not be reached from production outbound connector
 * requests, plus suffixes that only ever resolve inside a private network.
 */
const BLOCKED_HOSTS = [
  'localhost',
  'localhost.localdomain',
  'local',
  'ip6-localhost',
  'ip6-loopback',
];

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
];

/** Cloud instance-metadata endpoints reachable from a compromised workload. */
const METADATA_HOSTS = [
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.azure.com',
  'metadata.goog',
];

/**
 * A single address a hostname resolved to, normalised for connection reuse.
 */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Parses a numeric IPv4 literal (decimal, hex, octal or short form).
 *
 * Browsers and `net` accept `2130706433`, `0x7f000001` and `127.1` as
 * `127.0.0.1`; the WHATWG URL parser already normalises those, but the parser
 * is not applied to every string we receive, so the literal is parsed here too.
 */
export function parseIpv4Literal(host: string): number | undefined {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return undefined;

  const numbers: number[] = [];
  for (const part of parts) {
    if (part.length === 0) return undefined;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      value = parseInt(part.slice(2), 16);
    } else if (/^0[0-7]+$/.test(part)) {
      value = parseInt(part.slice(1), 8);
    } else if (/^\d+$/.test(part)) {
      value = parseInt(part, 10);
    } else {
      return undefined;
    }
    if (!Number.isInteger(value) || value < 0) return undefined;
    numbers.push(value);
  }

  // The final part absorbs the remaining bytes (e.g. `127.1` => `127.0.0.1`).
  const last = numbers[numbers.length - 1];
  const maxLast = 256 ** (4 - numbers.length + 1) - 1;
  if (last > maxLast) return undefined;
  for (const value of numbers.slice(0, -1)) {
    if (value > 255) return undefined;
  }

  let address = last;
  for (let index = 0; index < numbers.length - 1; index++) {
    address += numbers[index] * 256 ** (3 - index);
  }
  return address >>> 0;
}

/** Expands an IPv6 literal into its eight 16-bit groups. */
export function parseIpv6Literal(host: string): number[] | undefined {
  let value = host;
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (!value.includes(':')) return undefined;

  const separator = value.indexOf('::');
  const hasCompression = separator !== -1;
  if (hasCompression && separator !== value.lastIndexOf('::')) {
    return undefined;
  }

  const parseGroups = (segment: string): number[] | undefined => {
    if (segment === '') return [];
    const groups: number[] = [];
    const chunks = segment.split(':');
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      if (chunk.includes('.')) {
        // Trailing IPv4 form (e.g. `::ffff:127.0.0.1`).
        if (index !== chunks.length - 1) return undefined;
        const v4 = parseIpv4Literal(chunk);
        if (v4 === undefined) return undefined;
        groups.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(chunk)) return undefined;
      groups.push(parseInt(chunk, 16));
    }
    return groups;
  };

  const head = hasCompression ? value.slice(0, separator) : value;
  const tail = hasCompression ? value.slice(separator + 2) : '';
  const headGroups = parseGroups(head);
  const tailGroups = parseGroups(tail);
  if (!headGroups || !tailGroups) return undefined;

  if (!hasCompression) {
    return headGroups.length === 8 ? headGroups : undefined;
  }

  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) return undefined;
  return [...headGroups, ...new Array<number>(missing).fill(0), ...tailGroups];
}

/**
 * True when the address belongs to a range that must never be reached from a
 * production connector request.
 *
 * Covers: unspecified/this-network (0.0.0.0/8), loopback (127/8),
 * carrier-grade NAT (100.64/10), private networks (10/8, 172.16/12, 192.168/16),
 * link-local and cloud metadata (169.254/16), IETF protocol assignments
 * (192.0.0/24), documentation ranges (192.0.2/24, 198.51.100/24, 203.0.113/24),
 * the deprecated 6to4 relay anycast range (192.88.99/24), benchmarking
 * (198.18/15), multicast and reserved space (224/4 and above).
 */
export function isBlockedIpv4(address: number): boolean {
  const octet = (shift: number): number => (address >>> shift) & 0xff;
  const a = octet(24);
  const b = octet(16);
  const c = octet(8);

  if (a === 0) return true; // "this network" / unspecified
  if (a === 10) return true; // RFC 1918 private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918 private
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // RFC 1918 private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // documentation
  if (a === 203 && b === 0 && c === 113) return true; // documentation
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * True when the IPv6 groups belong to a restricted range.
 *
 * Ranges that embed an IPv4 address (IPv4-mapped `::ffff:0:0/96`, NAT64
 * `64:ff9b::/96`, 6to4 `2002::/16`) delegate the embedded address to the IPv4
 * rules, so `::ffff:127.0.0.1` or `2002:7f00:1::` cannot be used to reach
 * loopback. The rest of the IETF-reserved `::/8` is blocked outright: it holds
 * unspecified (`::`), loopback (`::1`), the deprecated IPv4-compatible and
 * IPv4-translated forms, none of which is a legitimate public destination.
 * Also blocks local-use NAT64 (64:ff9b:1::/48), discard-only (100::/64),
 * Teredo (2001::/32, whose embedded client address is obfuscated),
 * documentation (2001:db8::/32), link-local (fe80::/10), site-local
 * (fec0::/10), unique-local (fc00::/7) and all multicast (ff00::/8).
 */
export function isBlockedIpv6(groups: readonly number[]): boolean {
  const embeddedLow = (((groups[6] ?? 0) << 16) | (groups[7] ?? 0)) >>> 0;

  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    return isBlockedIpv4(embeddedLow); // IPv4-mapped
  }
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
    return isBlockedIpv4(embeddedLow); // NAT64 well-known prefix
  }
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0x0001) {
    return true; // local-use NAT64
  }
  if (groups[0] < 0x0100) return true; // reserved ::/8
  if (groups[0] === 0x2002) {
    const embedded = (((groups[1] ?? 0) << 16) | (groups[2] ?? 0)) >>> 0;
    return isBlockedIpv4(embedded); // 6to4
  }
  if (groups[0] === 0x0100 && groups.slice(1, 4).every((g) => g === 0)) {
    return true; // discard-only 100::/64
  }
  if (groups[0] === 0x2001 && groups[1] === 0x0000) return true; // Teredo
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // docs
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((groups[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((groups[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

function isMetadataHost(host: string): boolean {
  const lower = host.toLowerCase();
  return METADATA_HOSTS.includes(lower);
}

/**
 * Deployment-level outbound policy. `STRICT` is the only policy allowed in
 * production (enforced by environment validation); `PERMISSIVE` exists for a
 * developer pointing a connector at a CRM on their own machine. Tenant
 * configuration can never select the policy.
 */
export enum OutboundUrlPolicy {
  STRICT = 'strict',
  PERMISSIVE = 'permissive',
}

/**
 * True when the hostname itself (not its resolved addresses) is restricted.
 */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTS.includes(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }
  if (isMetadataHost(host)) return true;
  return false;
}

/**
 * True when the hostname is an IP literal that falls into a restricted range.
 *
 * Handles the alternative numeric encodings that the WHATWG URL parser does
 * not normalise in every code path (`2130706433`, `0x7f000001`, `127.1`).
 * An IPv6-looking string that cannot be parsed is treated as blocked.
 */
export function isBlockedIpLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host.includes(':')) {
    const groups = parseIpv6Literal(host);
    return groups ? isBlockedIpv6(groups) : true;
  }

  const address = parseIpv4Literal(host);
  if (address === undefined) return false;
  return isBlockedIpv4(address);
}

/** Strips IPv6 URL brackets and a trailing root dot from a URL hostname. */
export function bareHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/**
 * Validates the *shape* of an outbound URL without touching the network.
 *
 * Rejects non-HTTP(S) protocols, malformed URLs, embedded credentials,
 * restricted hostnames and restricted IP literals. DNS resolution is
 * intentionally not performed here: the DNS-pinning layer resolves, validates
 * and connects to the same addresses in one step.
 */
export function validateOutboundUrl(
  input: string,
  options: { policy: OutboundUrlPolicy; source?: string },
): { href: string; hostname: string; protocol: string } {
  const { policy, source } = options;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ConnectorConfigurationError({
      message: 'Invalid connector URL',
      code: 'CONNECTOR_INVALID_URL',
      source,
    });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConnectorConfigurationError({
      message: `Connector URL must use http or https, got ${url.protocol}`,
      code: 'CONNECTOR_INVALID_PROTOCOL',
      source,
    });
  }

  if (url.username !== '' || url.password !== '') {
    // Credentials belong in secret references, never in a URL that can end up
    // in logs, error messages or a redirect chain.
    throw new ConnectorConfigurationError({
      message: 'Connector URL must not embed credentials',
      code: 'CONNECTOR_URL_CREDENTIALS',
      source,
    });
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname.length === 0) {
    throw new ConnectorConfigurationError({
      message: 'Connector URL must include a hostname',
      code: 'CONNECTOR_INVALID_HOST',
      source,
    });
  }

  if (policy === OutboundUrlPolicy.STRICT) {
    if (isBlockedHostname(hostname) || isBlockedIpLiteral(hostname)) {
      throw new ConnectorConfigurationError({
        message: `Connector URL targets a restricted host: ${url.origin}`,
        code: 'CONNECTOR_SSRF_BLOCKED_HOST',
        source,
      });
    }
  }

  return { href: url.href, hostname, protocol: url.protocol };
}

/**
 * Validates and normalises a resolver answer.
 *
 * Every entry must be a syntactically valid IP address whose declared family
 * matches its syntax. An empty answer or an unexpected family is rejected so
 * the pinning layer never hands the socket something it did not check.
 */
export function normalizeResolvedAddresses(
  hostname: string,
  entries: ReadonlyArray<{ address: unknown; family: unknown }>,
  options: { source?: string } = {},
): ResolvedAddress[] {
  if (entries.length === 0) {
    throw new ConnectorConfigurationError({
      message: `Connector host did not resolve to any address: ${hostname}`,
      code: 'CONNECTOR_DNS_EMPTY',
      source: options.source,
    });
  }

  return entries.map((entry) => {
    const address =
      typeof entry.address === 'string' ? entry.address.toLowerCase() : '';
    const syntaxFamily = isIP(address);
    if (
      syntaxFamily === 0 ||
      (entry.family !== 4 && entry.family !== 6) ||
      entry.family !== syntaxFamily
    ) {
      throw new ConnectorUnavailableError({
        message: `Connector host resolved to an unexpected address: ${hostname}`,
        code: 'CONNECTOR_DNS_UNEXPECTED_ADDRESS',
        source: options.source,
        retryable: false,
      });
    }
    return { address, family: syntaxFamily };
  });
}

/**
 * Resolves a hostname and returns every address it points to.
 *
 * The addresses are returned *unvalidated against the SSRF ranges*; callers
 * must run them through `assertAddressesArePublic` before connecting. Keeping
 * resolution separate from range validation lets the DNS-pinning layer reuse
 * the exact same addresses that were validated (the DNS-rebinding defence).
 */
export async function resolveHostnameAddresses(
  hostname: string,
  options: { source?: string } = {},
): Promise<ResolvedAddress[]> {
  const { source } = options;
  const host = bareHostname(hostname);

  // IP literals are not DNS names; the URL parser already normalised them.
  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    return normalizeResolvedAddresses(
      hostname,
      [{ address: host, family: literalFamily }],
      { source },
    );
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(host, { all: true, order: 'verbatim' });
  } catch (error) {
    throw new ConnectorUnavailableError({
      message: `Could not resolve connector host: ${host}`,
      code: 'CONNECTOR_DNS_FAILURE',
      source,
      cause: error,
    });
  }

  return normalizeResolvedAddresses(hostname, addresses, { source });
}

/**
 * Rejects a resolved address list when any entry falls into a restricted range.
 *
 * A host that resolves to *any* blocked address is rejected outright: mixing a
 * public and a private answer is the classic DNS-rebinding setup, so neither
 * answer may be used. `exemptAddresses` are exact loopback addresses that code
 * (never tenant configuration) allows for local test servers.
 */
export function assertAddressesArePublic(
  hostname: string,
  addresses: readonly ResolvedAddress[],
  options: {
    policy: OutboundUrlPolicy;
    source?: string;
    exemptAddresses?: ReadonlySet<string>;
  } = {
    policy: OutboundUrlPolicy.STRICT,
  },
): void {
  const { policy, source, exemptAddresses } = options;
  if (policy !== OutboundUrlPolicy.STRICT) return;

  for (const entry of addresses) {
    if (exemptAddresses?.has(entry.address)) continue;
    if (isBlockedIpLiteral(entry.address)) {
      throw new ConnectorConfigurationError({
        message: `Connector host resolves to a restricted address: ${hostname}`,
        code: 'CONNECTOR_SSRF_BLOCKED_HOST',
        source,
      });
    }
  }
}

/**
 * Validates a code-supplied loopback exemption list.
 *
 * Only exact loopback addresses may be exempted, so even a misused exemption
 * cannot open private networks or cloud metadata endpoints.
 */
export function parseLoopbackExemptions(
  addresses: readonly string[] | undefined,
): ReadonlySet<string> {
  const exempt = new Set<string>();
  for (const raw of addresses ?? []) {
    const address = raw.toLowerCase();
    const family = isIP(address);
    const isLoopback =
      (family === 4 && (parseIpv4Literal(address) ?? 0) >>> 24 === 127) ||
      (family === 6 &&
        parseIpv6Literal(address)?.every(
          (group, index) => group === (index === 7 ? 1 : 0),
        ) === true);
    if (!isLoopback) {
      throw new ConnectorConfigurationError({
        message: 'Only loopback addresses can be exempted from the SSRF policy',
        code: 'CONNECTOR_INVALID_SSRF_EXEMPTION',
      });
    }
    exempt.add(address);
  }
  return exempt;
}
