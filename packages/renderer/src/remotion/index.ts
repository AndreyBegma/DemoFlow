import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import type { RenderPlan } from '../plan/types.ts';
import { type Renderer, recordRender, renderPath } from '../renderer.ts';
import { COMPOSITION_ID, type DemoVideoProps } from './props.ts';

/**
 * Draws a render plan with Remotion (spec 4): a React composition renders each
 * frame in Remotion's headless Chrome, and Remotion encodes the MP4 with its
 * own FFmpeg. The composition draws `frameAt(plan, frame)` and nothing else.
 */
export const remotionRenderer: Renderer = {
  name: 'remotion',
  render(runDir, plan, out = renderPath(runDir, 'remotion')) {
    return recordRender(runDir, 'remotion', out, () => draw(runDir, plan, out));
  },
};

async function draw(
  runDir: string,
  plan: RenderPlan,
  out: string,
): Promise<void> {
  const serveUrl = await bundled();
  const source = await serveFile(path.resolve(runDir, plan.source.file));
  try {
    const inputProps: DemoVideoProps = { plan, src: source.url };
    const composition = await selectComposition({
      serveUrl,
      id: COMPOSITION_ID,
      inputProps,
    });
    await renderMedia({
      serveUrl,
      composition,
      inputProps,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      // Limited-range BT.709 (Remotion 5's default). Remotion 4's `default`
      // passes its full-range JPEG frames through and writes `yuvj420p`.
      colorSpace: 'bt709',
      muted: true,
      outputLocation: out,
      overwrite: true,
      logLevel: 'error',
    });
  } finally {
    await source.close();
  }
}

/** The bundle is built once per process: it does not depend on the run. */
let bundling: Promise<string> | undefined;

function bundled(): Promise<string> {
  if (bundling === undefined) {
    // `entry.tsx` beside this file in the source, `entry.js` once compiled.
    const extension = import.meta.url.endsWith('.ts') ? '.tsx' : '.js';
    bundling = bundle({
      entryPoint: fileURLToPath(
        new URL(`./entry${extension}`, import.meta.url),
      ),
    });
    bundling.catch(() => {
      bundling = undefined;
    });
  }
  return bundling;
}

/**
 * Serves one file on a loopback port, for Remotion's compositor to fetch: the
 * bundle stays the same for every run, so the source cannot be part of it.
 */
async function serveFile(
  file: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const { size } = await stat(file);
  const server: Server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'video/webm',
      'Content-Length': size,
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/${encodeURIComponent(path.basename(file))}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
