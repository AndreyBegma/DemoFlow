import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openerCommand } from '../../src/auth/browser.ts';
import {
  credentialsPath,
  readCredentials,
  writeCredentials,
} from '../../src/auth/credentials.ts';
import { resolveServer } from '../../src/auth/server.ts';
import type { Io } from '../../src/commands/io.ts';
import { type AuthDeps, loginCommand } from '../../src/commands/login.ts';
import { logoutCommand } from '../../src/commands/logout.ts';
import {
  CliError,
  globalConfigPath,
  type HostEnvironment,
  pathFor,
} from '../../src/config/index.ts';

const TOKEN = 'dfr_secret-token-value';

type Handler = (
  request: IncomingMessage,
  body: Record<string, unknown>,
  response: ServerResponse,
) => void;

let tmp: string;
let host: HostEnvironment;
let server: Server;
let base: string;
let routes: Record<string, Handler>;
let seen: string[];
let out: string;
let err: string;
let opened: string[];
let slept: number[];
let clock: number;
let runnerCalls: string[];
/** The answer to "Start the runner now?"; `null` is no terminal. */
let answer: boolean | null;

const io: Io = {
  stdout: (text) => {
    out += text;
  },
  stderr: (text) => {
    err += text;
  },
};

function json(response: ServerResponse, status: number, body?: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

const codeBody = {
  deviceCode: 'device-secret',
  userCode: 'ABCD-1234',
  verificationUri: 'http://example.test/app/device',
  verificationUriComplete: 'http://example.test/app/device?code=ABCD-1234',
  expiresIn: 600,
  interval: 5,
};
const approved = {
  token: TOKEN,
  runnerId: 'runner-1',
  name: 'laptop',
  email: 'ada@example.com',
};

function deps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    host,
    fetch: (input, init) => fetch(input, init),
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
    openUrl: (url) => {
      opened.push(url);
    },
    machine: () => ({
      hostname: 'laptop',
      os: 'linux 6.1',
      cliVersion: '0.1.0',
    }),
    runner: {
      askStart: async () => {
        runnerCalls.push('ask');
        return answer;
      },
      start: async () => {
        runnerCalls.push('start');
        return 0;
      },
      stop: async () => {
        runnerCalls.push(`stop (${seen.length} requests sent)`);
      },
    },
    ...overrides,
  };
}

/** Polls answer from `states` in order; the last one repeats. */
function pollRoute(states: Array<[number, unknown]>): Handler {
  let i = 0;
  return (_request, _body, response) => {
    const [status, body] = states[Math.min(i, states.length - 1)] ?? [500, {}];
    i += 1;
    json(response, status, body);
  };
}

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'demoflow-auth-'));
  host = {
    platform: process.platform,
    env: { XDG_CONFIG_HOME: tmp, APPDATA: tmp },
    homedir: tmp,
  };
  out = '';
  err = '';
  opened = [];
  slept = [];
  seen = [];
  clock = 0;
  runnerCalls = [];
  answer = null;
  routes = {};
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const key = `${request.method} ${request.url}`;
      seen.push(`${key} ${request.headers.authorization ?? ''}`.trim());
      const handler = routes[key];
      if (handler === undefined) return json(response, 404, {});
      handler(request, text === '' ? {} : JSON.parse(text), response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmp, { recursive: true, force: true });
});

function pairedFile() {
  writeCredentials(host, { server: base, token: TOKEN, runnerId: 'runner-1' });
}

describe('credentials', () => {
  it.each([
    ['linux', '/home/ada', { XDG_CONFIG_HOME: '/cfg' }],
    ['linux', '/home/ada', {}],
    ['darwin', '/Users/ada', {}],
    [
      'win32',
      'C:\\Users\\ada',
      { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' },
    ],
  ] as const)('lives next to config.json on %s', (platform, homedir, env) => {
    const fake: HostEnvironment = { platform, homedir, env };
    const p = pathFor(platform);
    expect(p.dirname(credentialsPath(fake))).toBe(
      p.dirname(globalConfigPath(fake)),
    );
    expect(p.basename(credentialsPath(fake))).toBe('credentials.json');
  });

  it('is under %APPDATA% on Windows', () => {
    const win: HostEnvironment = {
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' },
      homedir: 'C:\\Users\\ada',
    };
    expect(credentialsPath(win)).toBe(
      'C:\\Users\\ada\\AppData\\Roaming\\demoflow\\credentials.json',
    );
  });

  it('round-trips and is private', () => {
    pairedFile();
    expect(readCredentials(host)).toEqual({
      server: base,
      token: TOKEN,
      runnerId: 'runner-1',
    });
    if (process.platform !== 'win32') {
      expect(statSync(credentialsPath(host)).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps mode 0600 when it overwrites a looser file', () => {
    if (process.platform === 'win32') return;
    pairedFile();
    pairedFile();
    expect(statSync(credentialsPath(host)).mode & 0o777).toBe(0o600);
  });

  it('is null when missing and invalid-credentials when malformed, without the token', () => {
    expect(readCredentials(host)).toBeNull();
    pairedFile();
    writeFileSync(credentialsPath(host), `{"token": "${TOKEN}"`);
    try {
      readCredentials(host);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe('invalid-credentials');
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });
});

describe('resolveServer', () => {
  it('prefers the flag, then DEMOFLOW_SERVER, then production', () => {
    const env = { DEMOFLOW_SERVER: 'http://env.test/' };
    expect(resolveServer('http://flag.test', env)).toBe('http://flag.test');
    expect(resolveServer(undefined, env)).toBe('http://env.test');
    expect(resolveServer(undefined, {})).toBe(
      'https://demoflow.luna-realm.com',
    );
  });

  it('rejects anything but http(s)', () => {
    expect(() => resolveServer('ftp://x.test', {})).toThrow(CliError);
    expect(() => resolveServer('nonsense', {})).toThrow(CliError);
  });
});

describe('openerCommand', () => {
  it.each([
    ['linux', 'xdg-open'],
    ['darwin', 'open'],
    ['win32', 'cmd'],
  ] as const)('%s uses %s', (platform, command) => {
    expect(openerCommand(platform, 'http://x.test').command).toBe(command);
  });
});

describe('login', () => {
  it('pairs after pending and slow_down, and stores the token', async () => {
    routes['POST /api/runner/device/code'] = (_r, body, res) => {
      expect(body).toEqual({
        hostname: 'laptop',
        os: 'linux 6.1',
        cliVersion: '0.1.0',
      });
      json(res, 200, codeBody);
    };
    routes['POST /api/runner/device/token'] = pollRoute([
      [400, { error: 'authorization_pending' }],
      [400, { error: 'slow_down' }],
      [400, { error: 'authorization_pending' }],
      [200, approved],
    ]);

    const code = await loginCommand({ server: base }, io, deps());

    expect(code).toBe(0);
    expect(out).toBe('Logged in as ada@example.com on laptop\n');
    expect(err).toContain('ABCD-1234');
    expect(opened).toEqual([codeBody.verificationUriComplete]);
    expect(slept).toEqual([5000, 5000, 10_000, 10_000]);
    expect(readCredentials(host)).toEqual({
      server: base,
      token: TOKEN,
      runnerId: 'runner-1',
    });
    expect(out + err).not.toContain(TOKEN);
    expect(out + err).not.toContain('device-secret');
  });

  it('exits 1 when denied, and writes nothing', async () => {
    routes['POST /api/runner/device/code'] = (_r, _b, res) =>
      json(res, 200, codeBody);
    routes['POST /api/runner/device/token'] = pollRoute([
      [400, { error: 'access_denied' }],
    ]);
    expect(await loginCommand({ server: base }, io, deps())).toBe(1);
    expect(err).toContain('denied');
    expect(existsSync(credentialsPath(host))).toBe(false);
  });

  it('exits 1 when the server says the code expired', async () => {
    routes['POST /api/runner/device/code'] = (_r, _b, res) =>
      json(res, 200, codeBody);
    routes['POST /api/runner/device/token'] = pollRoute([
      [400, { error: 'expired_token' }],
    ]);
    expect(await loginCommand({ server: base }, io, deps())).toBe(1);
    expect(err).toContain('expired');
  });

  it('gives up at expiresIn even if the server keeps saying pending', async () => {
    routes['POST /api/runner/device/code'] = (_r, _b, res) =>
      json(res, 200, { ...codeBody, expiresIn: 20 });
    routes['POST /api/runner/device/token'] = pollRoute([
      [400, { error: 'authorization_pending' }],
    ]);
    expect(await loginCommand({ server: base }, io, deps())).toBe(1);
    expect(slept).toEqual([5000, 5000, 5000, 5000]);
    expect(err).toContain('expired');
  });

  it('does not fail when there is no browser', async () => {
    routes['POST /api/runner/device/code'] = (_r, _b, res) =>
      json(res, 200, codeBody);
    routes['POST /api/runner/device/token'] = pollRoute([[200, approved]]);
    const code = await loginCommand(
      { server: base },
      io,
      deps({
        openUrl: () => {
          // openUrl never throws; the real one swallows ENOENT.
        },
      }),
    );
    expect(code).toBe(0);
  });

  it('exits 3 when the server is unreachable', async () => {
    const code = await loginCommand(
      { server: 'http://127.0.0.1:1' },
      io,
      deps(),
    );
    expect(code).toBe(3);
    expect(err).toContain('cannot reach');
  });

  it('reports an existing pairing after one verifying call', async () => {
    pairedFile();
    routes['GET /api/runner/self'] = (_r, _b, res) =>
      json(res, 200, {
        runnerId: 'runner-1',
        name: 'laptop',
        email: 'ada@example.com',
      });
    expect(await loginCommand({}, io, deps())).toBe(0);
    expect(out).toContain('ada@example.com');
    expect(out).toContain('laptop');
    expect(seen).toEqual([`GET /api/runner/self Bearer ${TOKEN}`]);
    expect(out + err).not.toContain(TOKEN);
  });

  it('pairs again when the stored token was revoked', async () => {
    pairedFile();
    routes['GET /api/runner/self'] = (_r, _b, res) => json(res, 401, {});
    routes['POST /api/runner/device/code'] = (_r, _b, res) =>
      json(res, 200, codeBody);
    routes['POST /api/runner/device/token'] = pollRoute([
      [200, { ...approved, token: 'dfr_new', runnerId: 'runner-2' }],
    ]);
    expect(await loginCommand({ server: base }, io, deps())).toBe(0);
    expect(err).toContain('The stored token was revoked; pairing again');
    expect(readCredentials(host)?.runnerId).toBe('runner-2');
  });

  it('--force revokes the old token first', async () => {
    pairedFile();
    routes['POST /api/runner/logout'] = (_r, _b, res) => json(res, 204);
    routes['POST /api/runner/device/code'] = (_r, _b, res) =>
      json(res, 200, codeBody);
    routes['POST /api/runner/device/token'] = pollRoute([
      [200, { ...approved, token: 'dfr_new', runnerId: 'runner-2' }],
    ]);
    expect(await loginCommand({ server: base, force: true }, io, deps())).toBe(
      0,
    );
    expect(seen[0]).toBe(`POST /api/runner/logout Bearer ${TOKEN}`);
    expect(readCredentials(host)?.token).toBe('dfr_new');
  });
});

describe('login and the runner (spec 151, Decision 3)', () => {
  function approve() {
    routes['POST /api/runner/device/code'] = (_r, _b, res) =>
      json(res, 200, codeBody);
    routes['POST /api/runner/device/token'] = pollRoute([[200, approved]]);
  }

  it('without a terminal, does not start the daemon and prints the command', async () => {
    approve();
    expect(await loginCommand({ server: base }, io, deps())).toBe(0);
    expect(runnerCalls).toEqual(['ask']);
    expect(err).toContain('Start the runner with: demoflow runner start');
  });

  it('starts it on a yes', async () => {
    approve();
    answer = true;
    expect(await loginCommand({ server: base }, io, deps())).toBe(0);
    expect(runnerCalls).toEqual(['ask', 'start']);
  });

  it('does nothing on a no', async () => {
    approve();
    answer = false;
    expect(await loginCommand({ server: base }, io, deps())).toBe(0);
    expect(runnerCalls).toEqual(['ask']);
    expect(err).not.toContain('demoflow runner start');
  });

  it('--start and --no-start skip the question', async () => {
    approve();
    await loginCommand({ server: base, start: true }, io, deps());
    expect(runnerCalls).toEqual(['start']);
    runnerCalls = [];
    rmSync(credentialsPath(host));
    await loginCommand({ server: base, start: false }, io, deps());
    expect(runnerCalls).toEqual([]);
  });

  it('passes on the exit code of a start that fails', async () => {
    approve();
    const failing = deps();
    failing.runner = { ...failing.runner, start: async () => 1 };
    expect(await loginCommand({ server: base, start: true }, io, failing)).toBe(
      1,
    );
  });

  it('never starts it when pairing fails', async () => {
    routes['POST /api/runner/device/code'] = (_r, _b, res) =>
      json(res, 200, codeBody);
    routes['POST /api/runner/device/token'] = pollRoute([
      [400, { error: 'access_denied' }],
    ]);
    await loginCommand({ server: base, start: true }, io, deps());
    expect(runnerCalls).toEqual([]);
  });
});

describe('logout', () => {
  it('stops the runner before it revokes', async () => {
    pairedFile();
    routes['POST /api/runner/logout'] = (_r, _b, res) => json(res, 204);
    expect(await logoutCommand(io, deps())).toBe(0);
    expect(runnerCalls).toEqual(['stop (0 requests sent)']);
    expect(seen).toEqual([`POST /api/runner/logout Bearer ${TOKEN}`]);
  });

  it('revokes on the stored server and deletes the file', async () => {
    pairedFile();
    routes['POST /api/runner/logout'] = (_r, _b, res) => json(res, 204);
    expect(await logoutCommand(io, deps())).toBe(0);
    expect(seen).toEqual([`POST /api/runner/logout Bearer ${TOKEN}`]);
    expect(existsSync(credentialsPath(host))).toBe(false);
    expect(out).toBe('Logged out\n');
  });

  it('deletes the file and says so when the server is down', async () => {
    writeCredentials(host, {
      server: 'http://127.0.0.1:1',
      token: TOKEN,
      runnerId: 'runner-1',
    });
    expect(await logoutCommand(io, deps())).toBe(0);
    expect(existsSync(credentialsPath(host))).toBe(false);
    expect(out).toContain('still listed under /app/machines');
    expect(out + err).not.toContain(TOKEN);
  });

  it('is a no-op when not logged in', async () => {
    expect(await logoutCommand(io, deps())).toBe(0);
    expect(out).toBe('Not logged in\n');
    expect(readFileSyncOrNull(credentialsPath(host))).toBeNull();
  });
});

function readFileSyncOrNull(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}
