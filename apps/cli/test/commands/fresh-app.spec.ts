// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${PORT}` is the config's own syntax, written as plain text on purpose.
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserDeps } from '../../src/commands/browser.ts';
import { CommandError } from '../../src/commands/errors.ts';
import type { Io } from '../../src/commands/io.ts';
import { portFlag, runCommand } from '../../src/commands/run.ts';

let dir: string;
let holder: Server | undefined;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'demoflow-fresh-')));
  writeFileSync(
    path.join(dir, 'a.demo.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'A',
      steps: [{ action: 'navigate', path: '/' }],
    }),
  );
});

afterEach(async () => {
  const server = holder;
  holder = undefined;
  if (server !== undefined) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(dir, { recursive: true, force: true });
});

function config(value: object): void {
  writeFileSync(path.join(dir, 'demoflow.config.json'), JSON.stringify(value));
}

/** A server on an ephemeral port answering every request with `status`. */
async function hold(status: number): Promise<number> {
  const server = createServer((_, response) => {
    response.statusCode = status;
    response.end('someone else');
  });
  holder = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function harness() {
  const io: Io & { out: string; err: string } = {
    out: '',
    err: '',
    stdout: (text) => {
      io.out += text;
    },
    stderr: (text) => {
      io.err += text;
    },
  };
  const calls: string[] = [];
  const browser: BrowserDeps = {
    executablePath: () => {
      calls.push('executablePath');
      return path.join(dir, 'no-chromium');
    },
    install: async () => {
      calls.push('install');
      return 1;
    },
  };
  const home = path.join(dir, 'home');
  const run = (flags: Parameters<typeof runCommand>[1]) =>
    runCommand(path.join(dir, 'a.demo.json'), { json: true, ...flags }, io, {
      host: {
        platform: process.platform,
        env: { DEMOFLOW_HOME: home },
        homedir: path.join(dir, 'user'),
      },
      cwd: dir,
      runId: () => 'fresh-run',
      browser,
    });
  return { io, calls, run, runDir: path.join(home, 'runs', 'fresh-run') };
}

async function refusal(promise: Promise<unknown>): Promise<CommandError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CommandError);
  return error as CommandError;
}

describe('demoflow run --fresh-app', () => {
  it.each([
    200, 500,
  ])('refuses an app answering %i on readyUrl: exit 2, nothing checked, spawned or written', async (status) => {
    const port = await hold(status);
    config({
      baseUrl: 'http://127.0.0.1:${PORT}',
      devCommand: {
        command: 'demoflow-no-such-command',
        readyUrl: '${BASE_URL}/',
      },
    });
    const { io, calls, run, runDir } = harness();
    const started = performance.now();
    const error = await refusal(run({ port: String(port), freshApp: true }));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(error.code).toBe('app-already-running');
    expect(error.exitCode).toBe(2);
    expect(error.message).toBe(
      `--fresh-app: http://127.0.0.1:${port}/ already answers; another app holds this port. Stop it or pass another --port.`,
    );
    expect(io.out).toBe('');
    expect(calls).toEqual([]);
    expect(existsSync(runDir)).toBe(false);
  });

  it('needs devCommand: fresh-app-needs-dev-command', async () => {
    config({ baseUrl: 'http://127.0.0.1:1' });
    const { calls, run, runDir } = harness();
    const error = await refusal(run({ freshApp: true }));
    expect(error.code).toBe('fresh-app-needs-dev-command');
    expect(error.exitCode).toBe(2);
    expect(calls).toEqual([]);
    expect(existsSync(runDir)).toBe(false);
  });

  it('refuses a ${PORT} with no port before anything else: invalid-config', async () => {
    config({ baseUrl: 'http://127.0.0.1:${PORT}' });
    const { calls, run } = harness();
    await expect(run({})).rejects.toMatchObject({
      code: 'invalid-config',
      issues: [expect.objectContaining({ code: 'missing-port' })],
    });
    expect(calls).toEqual([]);
  });
});

describe('--port', () => {
  it('accepts 1 to 65535', () => {
    expect(portFlag('1')).toBe(1);
    expect(portFlag('65535')).toBe(65535);
  });

  it.each(['0', '65536', '12a', ''])('refuses %j with invalid-port', (text) => {
    expect(() => portFlag(text)).toThrow(
      expect.objectContaining({ code: 'invalid-port', exitCode: 2 }),
    );
  });

  it('is checked whether the config uses ${PORT} or not', async () => {
    config({ baseUrl: 'http://127.0.0.1:1' });
    const { calls, run } = harness();
    expect((await refusal(run({ port: '0' }))).code).toBe('invalid-port');
    expect(calls).toEqual([]);
  });
});
