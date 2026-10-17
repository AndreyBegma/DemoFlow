// Starts and stops the fixture's `vite preview` for the execution-plane CI.
//
//   node .github/scripts/serve-fixture.mjs start   spawn, wait for the port, write the pid
//   node .github/scripts/serve-fixture.mjs stop    kill the recorded pid
//
// A Node script instead of a shell `&`: backgrounding behaves differently on
// Windows runners. Vite is spawned directly (no `bun run` wrapper) so the
// recorded pid is the server itself and killing it leaves nothing behind.

import { spawn } from 'node:child_process';
import {
  closeSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3680;
const TIMEOUT_MS = 60_000;

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const fixtureDir = path.join(root, 'apps', 'fixture');
const pidFile = path.join(root, 'fixture-preview.pid');
const logFile = path.join(root, 'fixture-preview.log');

function canConnect() {
  return new Promise((resolve) => {
    // `localhost`, as the fixture config names it: vite may bind only ::1.
    const socket = net.connect({ port: PORT, host: 'localhost' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function start() {
  const requireFromFixture = createRequire(
    path.join(fixtureDir, 'package.json'),
  );
  const viteBin = path.join(
    path.dirname(requireFromFixture.resolve('vite/package.json')),
    'bin',
    'vite.js',
  );
  const log = openSync(logFile, 'w');
  const child = spawn(
    process.execPath,
    [viteBin, 'preview', '--port', String(PORT), '--strictPort'],
    { cwd: fixtureDir, detached: true, stdio: ['ignore', log, log] },
  );
  closeSync(log);
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) break;
    if (await canConnect()) {
      console.log(`fixture preview is up on port ${PORT} (pid ${child.pid})`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.error(`fixture preview did not open port ${PORT}:`);
  console.error(readFileSync(logFile, 'utf8'));
  process.exit(1);
}

function stop() {
  let pid;
  try {
    pid = Number(readFileSync(pidFile, 'utf8'));
  } catch {
    console.log('no fixture preview recorded');
    return;
  }
  try {
    process.kill(pid);
    console.log(`stopped fixture preview (pid ${pid})`);
  } catch (error) {
    console.log(`fixture preview (pid ${pid}) was not running: ${error.code}`);
  }
  rmSync(pidFile, { force: true });
}

const command = process.argv[2];
if (command === 'start') {
  await start();
} else if (command === 'stop') {
  stop();
} else {
  console.error('usage: serve-fixture.mjs start|stop');
  process.exit(2);
}
