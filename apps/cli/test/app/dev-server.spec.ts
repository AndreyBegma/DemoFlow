import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AppStartError, startApp } from '../../src/app/dev-server.ts';

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/** `node -e <server>`: an app that listens on `port` after `delayMs`. */
function serverCommand(port: number, delayMs = 0) {
  const script = `setTimeout(() => require('node:http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1'), ${delayMs})`;
  return { command: process.execPath, args: ['-e', script] };
}

describe('startApp', () => {
  it('does nothing without devCommand', async () => {
    const app = await startApp({}, tmpdir());
    expect(app.started).toBe(false);
    await app.stop();
  });

  it('uses an app that already answers on readyUrl and never starts devCommand', async () => {
    const server = createServer((_, response) => response.end('up'));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const app = await startApp(
        {
          devCommand: {
            command: 'demoflow-no-such-command',
            readyUrl: `http://127.0.0.1:${port}/`,
          },
        },
        tmpdir(),
      );
      expect(app.started).toBe(false);
      await app.stop();
      expect(await answers(`http://127.0.0.1:${port}/`)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('starts devCommand, waits for readyUrl and stops the app', async () => {
    const port = await freePort();
    const readyUrl = `http://127.0.0.1:${port}/`;
    const app = await startApp(
      { devCommand: { ...serverCommand(port, 500), readyUrl } },
      tmpdir(),
      { pollMs: 50 },
    );
    expect(app.started).toBe(true);
    expect(await answers(readyUrl)).toBe(true);
    await app.stop();
    expect(await answers(readyUrl)).toBe(false);
    await app.stop();
  });

  it('fails when devCommand exits before readyUrl answers', async () => {
    const port = await freePort();
    await expect(
      startApp(
        {
          devCommand: {
            command: process.execPath,
            args: ['-e', 'process.exit(4)'],
            readyUrl: `http://127.0.0.1:${port}/`,
          },
        },
        tmpdir(),
        { pollMs: 50 },
      ),
    ).rejects.toThrow(/exited with code 4/);
  });

  it('fails when devCommand cannot be spawned', async () => {
    const port = await freePort();
    await expect(
      startApp(
        {
          devCommand: {
            command: 'demoflow-no-such-command',
            readyUrl: `http://127.0.0.1:${port}/`,
          },
        },
        tmpdir(),
        { pollMs: 50 },
      ),
    ).rejects.toBeInstanceOf(AppStartError);
  });

  it('stops the app and fails when readyUrl never answers in time', async () => {
    const port = await freePort();
    const other = await freePort();
    // Listens, but on a port readyUrl does not name.
    const dev = serverCommand(other);
    await expect(
      startApp(
        {
          devCommand: {
            ...dev,
            readyUrl: `http://127.0.0.1:${port}/`,
            timeoutMs: 1_500,
          },
        },
        tmpdir(),
        { pollMs: 50 },
      ),
    ).rejects.toThrow(/did not answer within 1500 ms/);
    expect(await answers(`http://127.0.0.1:${other}/`)).toBe(false);
  });
});
