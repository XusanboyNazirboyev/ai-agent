import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const CLIENT_IP_HEADER = 'x-agentcore-client-ip';
export const PROXY_AUTH_HEADER = 'x-agentcore-proxy-auth';

export interface AddressedRequest {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

function normalize(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const address = /^::ffff:\d+\.\d+\.\d+\.\d+$/iu.test(value)
    ? value.slice(7)
    : value.trim();
  return isIP(address) ? address.toLowerCase() : undefined;
}

function secretMatches(presented: unknown, secret: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The address a login is attributed to (ADR 021). The client-address header
 * is believed only when the request carries the web server's proxy credential;
 * otherwise the TCP peer is used. X-Forwarded-For is never read here: the web
 * tier is the only place that may interpret it.
 */
export function loginClientAddress(
  request: AddressedRequest,
  proxySecret: string | undefined,
): string {
  const peer = normalize(request.socket?.remoteAddress) ?? 'unknown';
  if (
    !proxySecret ||
    !secretMatches(request.headers[PROXY_AUTH_HEADER], proxySecret)
  )
    return `peer:${peer}`;
  const forwarded = request.headers[CLIENT_IP_HEADER];
  const client = normalize(
    typeof forwarded === 'string' ? forwarded : undefined,
  );
  return client ? `client:${client}` : `peer:${peer}`;
}
