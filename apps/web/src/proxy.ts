import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy, newNonce } from './csp';

/** Sets a fresh nonce-based CSP on every page request and response. */
export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const policy = contentSecurityPolicy(
    nonce,
    process.env.NODE_ENV !== 'production',
  );
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', policy);
  headers.set('x-nonce', nonce);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  // Pages only: API calls are proxied JSON and static assets carry no script.
  matcher: [
    {
      source: '/((?!api/|_next/static|_next/image|favicon.ico).*)',
      missing: [{ type: 'header', key: 'next-router-prefetch' }],
    },
  ],
};
