import { hostname, release } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { type OpenUrl, openUrl } from '../auth/browser.ts';
import {
  type Fetch,
  fetchSelf,
  type MachineInfo,
  pollDeviceToken,
  requestDeviceCode,
  revokeSelf,
  ServerError,
} from '../auth/client.ts';
import {
  type Credentials,
  readCredentials,
  writeCredentials,
} from '../auth/credentials.ts';
import { resolveServer } from '../auth/server.ts';
import { currentHost, type HostEnvironment } from '../config/index.ts';
import {
  defaultControlDeps,
  startRunner,
  stopRunner,
} from '../runner/control.ts';
import { packageVersion } from '../version.ts';
import { EXIT_STAGE_FAILED } from './errors.ts';
import type { Io } from './io.ts';

/** RFC 8628 §3.5: `slow_down` adds five seconds to the interval. */
const SLOW_DOWN_MS = 5_000;

export interface LoginFlags {
  server?: string;
  force?: boolean;
  /** `--start` / `--no-start`: skip the question (spec 151, Decision 3). */
  start?: boolean;
}

/** The daemon, as `login` and `logout` drive it. */
export interface RunnerControl {
  /** The answer to "Start the runner now?", or `null` without a terminal. */
  askStart(): Promise<boolean | null>;
  start(io: Io): Promise<number>;
  /** Stops a running daemon; silent when none runs. */
  stop(io: Io): Promise<void>;
}

/** Everything `login` and `logout` touch outside the process; tests replace it. */
export interface AuthDeps {
  host: HostEnvironment;
  fetch: Fetch;
  sleep(ms: number): Promise<void>;
  now(): number;
  openUrl: OpenUrl;
  machine(): MachineInfo;
  runner: RunnerControl;
}

const processRunner: RunnerControl = {
  askStart: askStartOnTerminal,
  start: (io) => startRunner(io, defaultControlDeps()),
  stop: async (io) => {
    await stopRunner(io, defaultControlDeps(), { quiet: true });
  },
};

export const defaultAuthDeps = (): AuthDeps => ({
  host: currentHost(),
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => delay(ms),
  now: () => Date.now(),
  openUrl,
  machine: () => ({
    hostname: hostname().trim().slice(0, 255) || 'unknown',
    os: `${process.platform} ${release()}`.slice(0, 128),
    cliVersion: packageVersion().slice(0, 64),
  }),
  runner: processRunner,
});

/** `demoflow login`: the device-code flow of spec 135. */
export async function loginCommand(
  flags: LoginFlags,
  io: Io,
  deps: AuthDeps = defaultAuthDeps(),
): Promise<number> {
  try {
    const stored = readCredentials(deps.host);
    if (stored !== null) {
      if (flags.force === true) {
        await revokeQuietly(stored, deps);
      } else {
        const done = await reportPaired(stored, io, deps);
        if (done) {
          return flags.start === true ? await deps.runner.start(io) : 0;
        }
      }
    }
    const code = await pair(
      resolveServer(flags.server, deps.host.env),
      io,
      deps,
    );
    return code === 0 ? await offerRunner(flags, io, deps) : code;
  } catch (error) {
    if (error instanceof ServerError) {
      io.stderr(`${error.message}\n`);
      return EXIT_STAGE_FAILED;
    }
    throw error;
  }
}

/** Already paired: says so and returns true, unless the stored token was revoked. */
async function reportPaired(
  stored: Credentials,
  io: Io,
  deps: AuthDeps,
): Promise<boolean> {
  let self: Awaited<ReturnType<typeof fetchSelf>>;
  try {
    self = await fetchSelf(stored.server, stored.token, deps.fetch);
  } catch (error) {
    if (!(error instanceof ServerError) || !error.unreachable) throw error;
    io.stdout(
      `Already logged in on ${stored.server} (the server is unreachable, so this was not verified)\n`,
    );
    return true;
  }
  if (self === null) {
    io.stderr('The stored token was revoked; pairing again\n');
    return false;
  }
  io.stdout(
    `Already logged in as ${self.email} on ${self.name} (use --force to pair again)\n`,
  );
  return true;
}

/** Decision 3: after pairing, start the daemon on `--start` or a yes. */
async function offerRunner(
  flags: LoginFlags,
  io: Io,
  deps: AuthDeps,
): Promise<number> {
  if (flags.start === false) return 0;
  const yes = flags.start === true ? true : await deps.runner.askStart();
  if (yes === true) return await deps.runner.start(io);
  if (yes === null) {
    io.stderr('Start the runner with: demoflow runner start\n');
  }
  return 0;
}

/** A yes/no on the terminal; no terminal, no question. */
async function askStartOnTerminal(): Promise<boolean | null> {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
    return null;
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await prompt.question('Start the runner now? [Y/n] ');
    return /^(y|yes|)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function revokeQuietly(stored: Credentials, deps: AuthDeps) {
  try {
    await revokeSelf(stored.server, stored.token, deps.fetch);
  } catch {
    // The old machine stays listed on the website until revoked there.
  }
}

async function pair(server: string, io: Io, deps: AuthDeps): Promise<number> {
  const code = await requestDeviceCode(server, deps.machine(), deps.fetch);
  io.stderr(
    `Your code: ${code.userCode}\nApprove it at ${code.verificationUriComplete}\n` +
      `(or open ${code.verificationUri} and type the code; it expires in ${Math.round(code.expiresIn / 60)} min)\n`,
  );
  deps.openUrl(code.verificationUriComplete);

  const deadline = deps.now() + code.expiresIn * 1000;
  let intervalMs = code.interval * 1000;
  for (;;) {
    await deps.sleep(intervalMs);
    const result = await pollDeviceToken(server, code.deviceCode, deps.fetch);
    switch (result.state) {
      case 'approved': {
        writeCredentials(deps.host, {
          server,
          token: result.runner.token,
          runnerId: result.runner.runnerId,
        });
        io.stdout(
          `Logged in as ${result.runner.email} on ${result.runner.name}\n`,
        );
        return 0;
      }
      case 'denied':
        io.stderr('Login denied on the website\n');
        return 1;
      case 'expired':
        io.stderr('The code expired; run demoflow login again\n');
        return 1;
      case 'slow_down':
        intervalMs += SLOW_DOWN_MS;
        break;
      case 'pending':
        break;
    }
    if (deps.now() >= deadline) {
      io.stderr('The code expired; run demoflow login again\n');
      return 1;
    }
  }
}
