import { type ChildProcess, spawn } from 'node:child_process';
import type { ProjectConfig } from '@demoflow/core';

/** The application started for a session; `stop()` is safe to call twice. */
export interface RunningApp {
  /** True when this process started the app, false when it was already up. */
  started: boolean;
  stop(): Promise<void>;
}

export interface StartAppOptions {
  /** Receives the app's own output and progress lines. */
  log?: (text: string) => void;
  /** Interval between `readyUrl` probes. */
  pollMs?: number;
  platform?: NodeJS.Platform;
  /** Added to the app's environment: the run's `PORT` (spec 337, Decision 6). */
  env?: Record<string, string>;
  /** `--fresh-app`: never reuse an app that already answers on `readyUrl`. */
  fresh?: boolean;
}

/** The app could not be started or never answered on `readyUrl`. */
export class AppStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppStartError';
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 5_000;
const NOT_STARTED: RunningApp = { started: false, stop: async () => {} };

/**
 * Starts the application from `devCommand` (ADR-0008 §4: commands come only
 * from the local config) and resolves once `readyUrl` answers. A no-op when
 * there is no `devCommand`, or when `readyUrl` already answers — the person's
 * own dev server is used as is and never stopped. With `fresh`, an app that
 * already answers is an `AppStartError` instead.
 */
export async function startApp(
  config: { devCommand?: ProjectConfig['devCommand'] },
  root: string,
  options: StartAppOptions = {},
): Promise<RunningApp> {
  const dev = config.devCommand;
  if (dev === undefined) return NOT_STARTED;
  if (options.fresh === true) {
    if (await anyAnswer(dev.readyUrl)) {
      throw new AppStartError(
        `--fresh-app: ${dev.readyUrl} already answers; another app holds this port`,
      );
    }
  } else if (await answers(dev.readyUrl)) {
    return NOT_STARTED;
  }

  const platform = options.platform ?? process.platform;
  const log = options.log ?? (() => {});
  log(`Starting the app: ${[dev.command, ...(dev.args ?? [])].join(' ')}\n`);
  // No shell: the command and its arguments are data (ADR-0003 §6).
  const child = spawn(dev.command, dev.args ?? [], {
    cwd: root,
    env: { ...process.env, ...options.env },
    // Its own process group on POSIX, so stop() reaches its children too.
    detached: platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => log(chunk));
  }
  const exited = new Promise<string>((resolve) => {
    child.once('error', (error) => resolve(error.message));
    child.once('exit', (code, signal) =>
      resolve(`it exited with ${signal ?? `code ${code}`}`),
    );
  });

  const app: RunningApp = {
    started: true,
    stop: () => stopTree(child, exited, platform),
  };
  const timeoutMs = dev.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let early: string | undefined;
  void exited.then((reason) => {
    early = reason;
  });
  for (;;) {
    if (early !== undefined) {
      throw new AppStartError(
        `devCommand did not start the app: ${early} before ${dev.readyUrl} answered`,
      );
    }
    if (await answers(dev.readyUrl)) return app;
    if (Date.now() >= deadline) {
      await app.stop();
      throw new AppStartError(
        `${dev.readyUrl} did not answer within ${timeoutMs} ms of starting devCommand`,
      );
    }
    await delay(options.pollMs ?? 250);
  }
}

/** Any HTTP answer below 500 means the server is up (a redirect or a 404 included). */
async function answers(url: string): Promise<boolean> {
  const status = await probe(url);
  return status !== undefined && status < 500;
}

/**
 * Any HTTP answer at all, 5xx included: someone's server holds the port. The
 * `--fresh-app` check, stricter than readiness (spec 337, Decision 7).
 */
export async function anyAnswer(url: string): Promise<boolean> {
  return (await probe(url)) !== undefined;
}

async function probe(url: string): Promise<number | undefined> {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(2_000),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return undefined;
  }
}

async function stopTree(
  child: ChildProcess,
  exited: Promise<string>,
  platform: NodeJS.Platform,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null)
    return;
  if (platform === 'win32') {
    // taskkill /T is the only way to reach the tree on Windows.
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => resolve());
      killer.once('exit', () => resolve());
    });
  } else {
    signalGroup(pid, 'SIGTERM');
    const gone = await Promise.race([
      exited.then(() => true),
      delay(STOP_GRACE_MS).then(() => false),
    ]);
    if (!gone) signalGroup(pid, 'SIGKILL');
  }
  await Promise.race([exited, delay(STOP_GRACE_MS)]);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
