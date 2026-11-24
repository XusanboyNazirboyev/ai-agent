const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4000';

// The Content-Security-Policy is set per request with a nonce in src/proxy.ts.

/** @type {import('next').NextConfig} */
export default {
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    // ADR 083 amendment (owner 2026-11-24, slow page switches): a page seen in
    // the last 5 minutes opens without a server round trip; its data is
    // fetched in the browser anyway, so only the near-static shell is reused.
    staleTimes: { dynamic: 300 },
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
