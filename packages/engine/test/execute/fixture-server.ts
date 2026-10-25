import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

/** The fixture app's build output; turbo builds it before the engine's tests. */
export const FIXTURE_DIST = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve('@demoflow/fixture/package.json'),
  ),
  'dist',
);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export interface FixtureServer {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  close(): Promise<void>;
}

/** Answers with a session cookie, as a sign-in would (spec 171). */
export const SIGN_IN_PATH = '/__sign-in';
export const SESSION_COOKIE = 'demoflow-session';

/**
 * Serves the built fixture on an ephemeral port (spec 3: never a fixed
 * port). Unknown paths fall back to `index.html`, as the app routes itself.
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const index = path.join(FIXTURE_DIST, 'index.html');
  if (!(await isFile(index))) {
    throw new Error(
      `${index} is missing: build the fixture first (bun run build --filter @demoflow/fixture)`,
    );
  }
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(
      new URL(request.url ?? '/', 'http://fixture').pathname,
    );
    const file = path.join(FIXTURE_DIST, path.normalize(pathname));
    const inside = file.startsWith(FIXTURE_DIST + path.sep);
    void (async () => {
      const target = inside && (await isFile(file)) ? file : index;
      response.writeHead(200, {
        'content-type':
          CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream',
        ...(pathname === SIGN_IN_PATH
          ? { 'set-cookie': `${SESSION_COOKIE}=signed-in; Path=/` }
          : {}),
      });
      createReadStream(target).pipe(response);
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
