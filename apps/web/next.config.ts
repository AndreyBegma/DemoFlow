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
  // The DemoFlow runner opens the dev server on 127.0.0.1
  // (demoflow.config.json); Next 16 blocks its dev resources from any host but
  // localhost, so the page would never hydrate. Dev only, ignored by builds.
  allowedDevOrigins: ['127.0.0.1'],
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
