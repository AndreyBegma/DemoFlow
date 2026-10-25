// Starts the Next.js dev server on $PORT, or on :3670 when PORT is unset.
//
//   bun run start:dev
//
// The DemoFlow runner sets PORT when it records a demo of this site
// (demoflow.config.json); `next dev` alone would fall back to :3000. Plain Node,
// no shell, so it behaves the same on Linux, macOS and Windows.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const DEFAULT_PORT = '3670';

const port = process.env.PORT || DEFAULT_PORT;
const next = createRequire(import.meta.url).resolve('next/dist/bin/next');
const child = spawn(
  process.execPath,
  [next, 'dev', '--turbopack', '-p', port],
  { stdio: 'inherit' },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
