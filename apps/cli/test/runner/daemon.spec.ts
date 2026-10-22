import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  credentialsPath,
  readCredentials,
  writeCredentials,
} from '../../src/auth/credentials.ts';
import type { Io } from '../../src/commands/io.ts';
import type { HostEnvironment } from '../../src/config/platform.ts';
import {
  type ControlDeps,
  defaultControlDeps,
  runnerStatus,
  startRunner,
  statusCommand,
  stopRunner,
} from '../../src/runner/control.ts';
import { isAlive, readLock } from '../../src/runner/lock.ts';
import { runnerPaths } from '../../src/runner/paths.ts';
import { startRunnerServer, type TestRunnerServer } from './ws-server.ts';

const TOKEN = 'dfr_daemon-test-token';
const NEW_TOKEN = 'dfr_rotated-test-token';
const ENTRY = path.join(import.meta.dirname, 'daemon-entry.ts');

let tmp: string;
let host: HostEnvironment;
let server: TestRunnerServer;
let out: string;
let err: string;

const io: Io = {
  stdout: (text) => {
    out += text;
  },
  stderr: (text) => {
    err += text;
  },
};

function deps(overrides: Partial<ControlDeps> = {}): ControlDeps {
  return {
    ...defaultControlDeps(),
    host,
    daemon: { command: process.execPath, args: [ENTRY] },
    startWaitMs: 15_000,
    ...overrides,
  };
}

async function until(
  what: string,
  check: () => boolean,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function log(): string {
  const file = runnerPaths(host).log;
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'demoflow-runner-'));
  // The child finds its config through the same variables `currentHost` reads.
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    XDG_CONFIG_HOME: path.join(tmp, '.config'),
    APPDATA: path.join(tmp, 'AppData', 'Roaming'),
  };
  host = { platform: process.platform, env, homedir: tmp };
  server = await startRunnerServer([TOKEN]);
  writeCredentials(host, {
    server: server.server,
    token: TOKEN,
    runnerId: 'runner-1',
  });
  out = '';
  err = '';
});

afterEach(async () => {
  const holder = readLock(runnerPaths(host).lock);
  if (holder !== null && isAlive(holder.pid)) {
    await stopRunner(io, deps());
  }
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('runner start | status | stop', () => {
  it('runs one detached daemon, reports it and stops it with a bye', async () => {
    expect(await startRunner(io, deps())).toBe(0);
    const pid = readLock(runnerPaths(host).lock)?.pid;
    expect(out).toBe(`Runner started (PID ${pid})\n`);
    await until(
      'connected',
      () => runnerStatus(deps()).connection === 'connected',
    );
    expect(server.upgrades[0]).toEqual({
      path: '/api/runner',
      authorization: `Bearer ${TOKEN}`,
    });

    out = '';
    expect(await startRunner(io, deps())).toBe(0);
    expect(out).toBe(`Runner already running (PID ${pid})\n`);
    expect(server.connections).toHaveLength(1);

    out = '';
    statusCommand({}, io, deps());
    expect(out).toContain(`Runner:     running (PID ${pid}`);
    expect(out).toContain('Connection: connected');
    expect(out).toContain(`Server:     ${server.server}`);
    expect(out).toContain('Autostart:  not installed');
    statusCommand({ json: true }, io, deps());
    const json = JSON.parse(out.trim().split('\n').at(-1) ?? '');
    expect(json).toMatchObject({ running: true, pid, connection: 'connected' });

    out = '';
    expect(await stopRunner(io, deps())).toBe('stopped');
    expect(out).toBe(`Runner stopped (PID ${pid})\n`);
    const connection = server.connections[0];
    expect(connection?.messages.at(-1)).toEqual({
      type: 'bye',
      reason: 'stopped',
    });
    await until('the close frame', () => connection?.clientClose !== null);
    expect(existsSync(runnerPaths(host).lock)).toBe(false);
    expect(existsSync(runnerPaths(host).state)).toBe(false);
    expect(log()).toContain('stopped');

    out = '';
    statusCommand({}, io, deps());
    expect(out).toContain('Runner:     not running');
  });

  it('exits on 4401 within 2 s and logs revoked', async () => {
    await startRunner(io, deps());
    const pid = readLock(runnerPaths(host).lock)?.pid ?? 0;
    await until('a connection', () => server.connections.length === 1);
    server.connections[0]?.close(4401, 'revoked');
    await until('the daemon to exit', () => !isAlive(pid), 2_000);
    expect(log()).toContain('revoked');
    expect(runnerStatus(deps())).toMatchObject({
      running: false,
      connection: 'revoked',
    });
    // It never came back.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(server.upgrades).toHaveLength(1);
  });

  it('treats a 401 on the upgrade as revoked after asking /runner/self', async () => {
    server.tokens.clear();
    await startRunner(io, deps());
    await until(
      'the daemon to exit',
      () => !existsSync(runnerPaths(host).lock),
    );
    // One attempt by the daemon; undici itself may resend a refused upgrade once.
    expect(log().match(/connecting to/g)).toHaveLength(1);
    expect(server.selfRequests).toBe(1);
    expect(log()).toContain('revoked');
  });

  it('saves a rotated token before acknowledging it', async () => {
    await startRunner(io, deps());
    await until('a connection', () => server.connections.length === 1);
    const connection = server.connections[0];
    connection?.send({ type: 'rotate', token: NEW_TOKEN });
    await until('rotated', () =>
      (connection?.messages ?? []).some((m) => m.type === 'rotated'),
    );
    expect(readCredentials(host)?.token).toBe(NEW_TOKEN);
  });

  it('never writes a token into the log, the state file or status', async () => {
    await startRunner(io, deps());
    await until('a connection', () => server.connections.length === 1);
    server.connections[0]?.send({ type: 'rotate', token: NEW_TOKEN });
    await until('rotated', () =>
      (server.connections[0]?.messages ?? []).some((m) => m.type === 'rotated'),
    );
    out = '';
    statusCommand({}, io, deps());
    statusCommand({ json: true }, io, deps());
    const state = readFileSync(runnerPaths(host).state, 'utf8');
    await stopRunner(io, deps());
    for (const text of [log(), state, out, err]) {
      expect(text).not.toContain('dfr_');
    }
  });

  it('refuses to start without credentials', async () => {
    rmSync(credentialsPath(host));
    expect(await startRunner(io, deps())).toBe(1);
    expect(err).toContain('demoflow login');
  });
});
