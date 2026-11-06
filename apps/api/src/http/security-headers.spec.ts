import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { SECURITY_HEADERS, securityHeaders } from './security-headers.js';

function fakeResponse(existing: Record<string, string> = {}): {
  response: Response;
  headers: Map<string, string>;
} {
  const headers = new Map(Object.entries(existing));
  const response = {
    hasHeader: (name: string): boolean => headers.has(name),
    setHeader: (name: string, value: string): void => {
      headers.set(name, value);
    },
  } as unknown as Response;
  return { response, headers };
}

describe('securityHeaders', () => {
  it('sets every baseline header and continues the chain', () => {
    const { response, headers } = fakeResponse();
    const next = vi.fn() as unknown as NextFunction;
    securityHeaders({} as Request, response, next);
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      expect(headers.get(name)).toBe(value);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('never overrides a header a route already chose', () => {
    const { response, headers } = fakeResponse({
      'Cache-Control': 'max-age=60',
    });
    securityHeaders(
      {} as Request,
      response,
      vi.fn() as unknown as NextFunction,
    );
    expect(headers.get('Cache-Control')).toBe('max-age=60');
  });

  it('forbids framing and sniffing', () => {
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain(
      "frame-ancestors 'none'",
    );
  });
});
