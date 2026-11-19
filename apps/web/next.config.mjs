const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4000';

// The Content-Security-Policy is set per request with a nonce in src/proxy.ts.

/** @type {import('next').NextConfig} */
export default {
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    // Pages fetch their data in the browser, so the server part of a page
    // visited in the last 30 s is reused: going back to it needs no request.
    staleTimes: { dynamic: 30 },
  },
  // The browser only talks to this origin; /api is proxied to the API, so no
  // CORS is opened and the session cookie stays first-party.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};
