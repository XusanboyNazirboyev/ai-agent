/**
 * Content-Security-Policy with a per-request nonce (ADR 021). Next.js reads
 * the nonce from the request's CSP header and puts it on every script it
 * renders; 'strict-dynamic' lets those scripts load the app's chunks. No
 * 'unsafe-inline' for scripts or styles in production.
 *
 * `dev` (anything but NODE_ENV=production) only exists for `next dev`: React's
 * dev build needs 'unsafe-eval', and Next's dev overlay creates <style>
 * elements without a nonce, which the strict style policy refuses (broken
 * overlay, a console error per element). Browsers ignore 'unsafe-inline' when
 * a nonce is present, so dev uses 'unsafe-inline' without one. Scripts stay
 * nonce-only. The production build is checked for zero violations by e2e.
 */
export function contentSecurityPolicy(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    dev
      ? "style-src 'self' 'unsafe-inline'"
      : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
