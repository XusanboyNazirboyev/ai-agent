import type { NextFunction, Request, Response } from 'express';

/**
 * Baseline response headers for an API that returns JSON only (audit S2,
 * docs/audit/2026-11-05-staff-audit.md). Dependency-free on purpose: the list is
 * short and fixed, so a package would add supply-chain surface for no gain.
 * - nosniff: a JSON body is never reinterpreted as script or HTML.
 * - frame deny and CSP `frame-ancestors 'none'`: the API is never framed.
 * - no-referrer, same-origin resource policy: nothing leaks to or loads from
 *   other origins by default.
 * - no-store: responses can hold session or customer data, so no shared cache.
 * HSTS is not set here: TLS is terminated before this process and the header
 * belongs to the TLS-terminating edge.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

export function securityHeaders(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    if (!response.hasHeader(name)) response.setHeader(name, value);
  next();
}

/**
 * JSON bodies above this are refused with 413. The largest legitimate body is
 * a knowledge document of 40,000 characters (at most ~160 KB in UTF-8) plus
 * JSON overhead; webhook updates are a few KB.
 */
export const JSON_BODY_LIMIT = '256kb';

/** Shared HTTP setup so `main.ts` and the bootstrap test run the same code. */
export function configureHttp(app: {
  use: (handler: typeof securityHeaders) => unknown;
  useBodyParser: (type: 'json', options: { limit: string }) => unknown;
  enableShutdownHooks: () => unknown;
}): void {
  app.use(securityHeaders);
  // Refuse oversized JSON bodies (413). `rawBody` stays on for signatures.
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  // Run OnModuleDestroy (queue workers, connections) on SIGTERM and SIGINT.
  app.enableShutdownHooks();
}
