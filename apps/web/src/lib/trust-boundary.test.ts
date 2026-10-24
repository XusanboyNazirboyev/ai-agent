import { describe, expect, it } from 'vitest';
import {
  applyTrustBoundary,
  clientAddress,
  CLIENT_IP_HEADER,
  normalizeAddress,
  PROXY_AUTH_HEADER,
} from '../../trust-boundary.mjs';

describe('clientAddress', () => {
  it('uses the socket address and ignores X-Forwarded-For without trusted hops', () => {
    expect(clientAddress('203.0.113.7', '1.2.3.4', 0)).toBe('203.0.113.7');
    expect(clientAddress('::ffff:203.0.113.7', undefined, 0)).toBe(
      '203.0.113.7',
    );
  });

  it('takes the entry appended by the outermost trusted hop, never client entries', () => {
    // Client sent "1.2.3.4"; the edge appended the real address.
    expect(clientAddress('10.0.0.5', '1.2.3.4, 198.51.100.9', 1)).toBe(
      '198.51.100.9',
    );
    expect(
      clientAddress('10.0.0.5', 'evil, 1.2.3.4, 198.51.100.9, 10.0.0.4', 2),
    ).toBe('198.51.100.9');
    expect(clientAddress('10.0.0.5', ['1.2.3.4', '198.51.100.9'], 1)).toBe(
      '198.51.100.9',
    );
  });

  it('falls back to the socket address when the header is missing, short or invalid', () => {
    expect(clientAddress('10.0.0.5', undefined, 1)).toBe('10.0.0.5');
    expect(clientAddress('10.0.0.5', '198.51.100.9', 2)).toBe('10.0.0.5');
    expect(clientAddress('10.0.0.5', 'not-an-ip', 1)).toBe('10.0.0.5');
    expect(clientAddress('10.0.0.5', '1.2.3.4', -1)).toBe('10.0.0.5');
  });

  it('normalizes and validates addresses', () => {
    expect(normalizeAddress('[2001:DB8::1]:443')).toBe('2001:db8::1');
    expect(normalizeAddress('1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeAddress('1.2.3.4:80')).toBeUndefined();
    expect(normalizeAddress('<script>')).toBeUndefined();
    expect(normalizeAddress(undefined)).toBeUndefined();
  });
});

describe('applyTrustBoundary', () => {
  const secret = 's'.repeat(40);

  it('replaces client-supplied boundary headers on API requests', () => {
    const headers: Record<string, string | string[] | undefined> = {
      [CLIENT_IP_HEADER]: '6.6.6.6',
      [PROXY_AUTH_HEADER]: 'guess',
      'x-forwarded-for': '7.7.7.7',
    };
    applyTrustBoundary(headers, {
      peer: '203.0.113.7',
      isApi: true,
      trustedHops: 0,
      secret,
    });
    expect(headers[CLIENT_IP_HEADER]).toBe('203.0.113.7');
    expect(headers[PROXY_AUTH_HEADER]).toBe(secret);
  });

  it('strips the boundary headers from page requests and without a secret', () => {
    const page: Record<string, string | undefined> = {
      [CLIENT_IP_HEADER]: '6.6.6.6',
      [PROXY_AUTH_HEADER]: 'x',
    };
    applyTrustBoundary(page, {
      peer: '203.0.113.7',
      isApi: false,
      trustedHops: 0,
      secret,
    });
    expect(page).toEqual({});
    const noSecret: Record<string, string | undefined> = {
      [CLIENT_IP_HEADER]: '6.6.6.6',
    };
    applyTrustBoundary(noSecret, {
      peer: '203.0.113.7',
      isApi: true,
      trustedHops: 0,
      secret: undefined,
    });
    expect(noSecret).toEqual({});
  });
});
