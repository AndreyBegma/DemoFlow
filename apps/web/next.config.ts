import type { NextConfig } from 'next';

// The API's internal origin. Rewrites are resolved at build time; on staging
// Caddy answers `/api` before it reaches Next, so the default is never hit.
const API_URL = process.env.API_URL ?? 'http://localhost:8370';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: ['@demoflow/shared'],
  // `/api` is reserved for the API. Stripping the prefix matches Caddy, so
  // the browser sees one origin locally and on staging alike.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/:path*` }];
  },
};

export default nextConfig;
