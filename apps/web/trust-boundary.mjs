// Trust boundary between the browser and the API (ADR 021). Shared by the web
// server (server.mjs) and its tests. Plain JS so the server can load it
// without a build step.
import { isIP } from 'node:net';

export const CLIENT_IP_HEADER = 'x-agentcore-client-ip';
export const PROXY_AUTH_HEADER = 'x-agentcore-proxy-auth';

/** Normalizes an address; returns undefined for anything that is not an IP. */
export function normalizeAddress(value) {
  if (typeof value !== 'string') return undefined;
  let address = value.trim();
  if (address.startsWith('[') && address.includes(']'))
    address = address.slice(1, address.indexOf(']'));
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/iu.test(address)) address = address.slice(7);
  return isIP(address) ? address.toLowerCase() : undefined;
}

/**
 * The client address as seen by the outermost trusted hop.
 * trustedHops = number of reverse proxies in front of this server that
 * APPEND to X-Forwarded-For (0 = this server faces clients directly, and any
 * X-Forwarded-For is ignored). Entries left of the trusted ones are
 * client-controlled and never used.
 */
export function clientAddress(peer, forwardedFor, trustedHops) {
  const direct = normalizeAddress(peer);
  if (!Number.isInteger(trustedHops) || trustedHops <= 0) return direct;
  const raw = Array.isArray(forwardedFor)
    ? forwardedFor.join(',')
    : forwardedFor;
  const hops =
    typeof raw === 'string' ? raw.split(',').map((part) => part.trim()) : [];
  if (hops.length < trustedHops) return direct;
  return normalizeAddress(hops[hops.length - trustedHops]) ?? direct;
}

/**
 * Rewrites the incoming headers in place: removes anything a client could use
 * to impersonate the boundary and, for API requests, sets the computed client
 * address and the proxy credential.
 */
export function applyTrustBoundary(
  headers,
  { peer, isApi, trustedHops, secret },
) {
  delete headers[CLIENT_IP_HEADER];
  delete headers[PROXY_AUTH_HEADER];
  if (!isApi || !secret) return;
  const address = clientAddress(peer, headers['x-forwarded-for'], trustedHops);
  if (address) headers[CLIENT_IP_HEADER] = address;
  headers[PROXY_AUTH_HEADER] = secret;
}
