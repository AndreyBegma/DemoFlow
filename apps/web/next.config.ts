import createMDX from '@next/mdx';
import type { NextConfig } from 'next';

// The API's internal origin. Rewrites are resolved at build time; on staging
// Caddy answers `/api` before it reaches Next, so the default is never hit.
const API_URL = process.env.API_URL ?? 'http://localhost:8370';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: ['@demoflow/shared'],
  // The docs pages are `page.mdx` (spec #179).
  pageExtensions: ['ts', 'tsx', 'md', 'mdx'],
  // `/api` is reserved for the API. Stripping the prefix matches Caddy, so
  // the browser sees one origin locally and on staging alike.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/:path*` }];
  },
};

// Turbopack takes plugins by name, not as imported functions.
const withMDX = createMDX({
  options: { remarkPlugins: ['remark-gfm'] },
});

export default withMDX(nextConfig);
