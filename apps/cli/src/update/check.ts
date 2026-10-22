import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { currentHost } from '../config/platform.ts';
import { packageVersion } from '../version.ts';
import {
  detectInstall,
  type Install,
  installCommand,
  type Manager,
  packageLocation,
} from './install.ts';
import { isNewer } from './semver.ts';
import { fileSkipStore, type SkipStore } from './store.ts';

export const REGISTRY_URL = 'https://registry.npmjs.org/demoflow/latest';
export const FETCH_TIMEOUT_MS = 1_500;
export const GRACE_MS = 300;

const EACCES_HINT =
  "If npm could not write its global directory (EACCES), change npm's prefix instead of using sudo:\n" +
  '  https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally\n';

/** Everything the update check touches, injected so tests never reach the network (spec 166, Decision 7). */
export interface UpdateDeps {
  env: Readonly<Record<string, string | undefined>>;
  tty: { stdin: boolean; stdout: boolean; stderr: boolean };
  current(): string;
  install(): Install;
  fetch: typeof fetch;
  /** The answer typed, or null when there is no one to ask. */
  ask(question: string): Promise<string | null>;
  /** Runs the install with inherited stdio; resolves its exit code or the error that stopped it. */
  spawn(command: readonly [string, ...string[]]): Promise<SpawnResult>;
  store: SkipStore;
  stderr(text: string): void;
  timeoutMs?: number;
  graceMs?: number;
}

export type SpawnResult = { code: number } | { error: string };

export interface UpdateCheck {
  /** Never throws, and never takes longer than the grace period plus the user's answer and the install. */
  finish(): Promise<void>;
}

const SILENT: UpdateCheck = { finish: async () => {} };

/**
 * Decision 2: no check without a terminal on stdin, stdout and stderr, under
 * CI, with `DEMOFLOW_NO_UPDATE_CHECK=1`, or for a long-lived command.
 */
export function isSilent(argv: readonly string[], deps: UpdateDeps): boolean {
  const { tty, env } = deps;
  if (!tty.stdin || !tty.stdout || !tty.stderr) return true;
  if (env.CI !== undefined && env.CI !== '') return true;
  if (env.DEMOFLOW_NO_UPDATE_CHECK === '1') return true;
  const command = argv.find((arg) => !arg.startsWith('-'));
  if (command === 'mcp') return true;
  if (command === 'runner') {
    if (argv.includes('--foreground')) return true;
    if (
      argv.includes('logs') &&
      (argv.includes('-f') || argv.includes('--follow'))
    )
      return true;
  }
  return false;
}

/**
 * Decision 1: starts the registry request now, beside the command. Call
 * `finish()` once the command has settled.
 */
export function startUpdateCheck(
  argv: readonly string[],
  deps: UpdateDeps,
): UpdateCheck {
  let install: Install;
  try {
    if (isSilent(argv, deps)) return SILENT;
    install = deps.install();
  } catch {
    return SILENT;
  }
  if (install.kind === 'ephemeral' || install.kind === 'source') return SILENT;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? FETCH_TIMEOUT_MS,
  );
  const latest = fetchLatest(deps.fetch, controller.signal).finally(() =>
    clearTimeout(timeout),
  );

  return {
    async finish() {
      let grace: NodeJS.Timeout | undefined;
      try {
        const version = await Promise.race([
          latest,
          new Promise<null>((resolve) => {
            grace = setTimeout(() => resolve(null), deps.graceMs ?? GRACE_MS);
          }),
        ]);
        if (version === null) return;
        await offer(version, install, deps);
      } catch {
        // Decision 1: the check never shows an error of its own.
      } finally {
        clearTimeout(grace);
        controller.abort();
        clearTimeout(timeout);
      }
    },
  };
}

/** Runs `run` with the update check beside it. The exit code is always `run`'s. */
export async function withUpdateCheck(
  argv: readonly string[],
  run: () => Promise<number>,
  deps: UpdateDeps,
): Promise<number> {
  const check = startUpdateCheck(argv, deps);
  const code = await run();
  await check.finish();
  return code;
}

async function fetchLatest(
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetchFn(REGISTRY_URL, {
      signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const { version } = body as { version?: unknown };
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

async function offer(
  latest: string,
  install: Install,
  deps: UpdateDeps,
): Promise<void> {
  const current = deps.current();
  if (!isNewer(latest, current)) return;
  const available = `demoflow ${latest} is available (you have ${current}).`;

  if (install.kind === 'local') {
    deps.stderr(
      `${available} This project installs it; update it here with: npm install demoflow@${latest}\n`,
    );
    return;
  }
  if (install.kind !== 'global') {
    deps.stderr(
      `${available} To update: ${installCommand('npm', latest).join(' ')}\n`,
    );
    return;
  }

  if (deps.store.read() === latest) return;
  const answer = await deps.ask(`${available} Update now? [Y/n/never] `);
  if (answer === null) return;
  const choice = answer.trim().toLowerCase();
  if (choice === 'never') {
    deps.store.write(latest);
    return;
  }
  if (choice === '' || choice === 'y' || choice === 'yes') {
    await update(install.manager, latest, deps);
  }
}

async function update(
  manager: Manager,
  version: string,
  deps: UpdateDeps,
): Promise<void> {
  const command = installCommand(manager, version);
  const line = command.join(' ');
  deps.stderr(`Running: ${line}\n`);
  const result = await deps.spawn(command);
  if ('code' in result && result.code === 0) {
    deps.stderr(`Updated to ${version}. Re-run demoflow to use it.\n`);
    return;
  }
  const reason =
    'error' in result
      ? result.error
      : `${command[0]} exited with ${result.code}`;
  deps.stderr(`Update failed: ${reason}\nRun it yourself: ${line}\n`);
  if (manager === 'npm') deps.stderr(EACCES_HINT);
}

/** The update check against this process, its terminal and the real registry. */
export function defaultUpdateDeps(): UpdateDeps {
  const host = currentHost();
  return {
    env: process.env,
    tty: {
      stdin: process.stdin.isTTY === true,
      stdout: process.stdout.isTTY === true,
      stderr: process.stderr.isTTY === true,
    },
    current: () => packageVersion(),
    install: () => {
      const location = packageLocation();
      if (location === null) return { kind: 'unknown' };
      return detectInstall(location, host, process.execPath);
    },
    fetch: globalThis.fetch,
    ask: askOnTerminal,
    spawn: spawnInstall,
    store: fileSkipStore(host),
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}

async function askOnTerminal(question: string): Promise<string | null> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  // Ctrl-D closes stdin: that is a no, not a question left hanging.
  const closed = new Promise<null>((resolve) =>
    prompt.once('close', () => resolve(null)),
  );
  try {
    return await Promise.race([prompt.question(question), closed]);
  } catch {
    return null;
  } finally {
    prompt.close();
  }
}

/**
 * On Windows the managers are `.cmd` shims, which only a shell can start. The
 * line is fixed words plus a version already checked to be `x.y.z`.
 */
function spawnInstall(
  command: readonly [string, ...string[]],
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child =
      process.platform === 'win32'
        ? spawn(command.join(' '), { stdio: 'inherit', shell: true })
        : spawn(command[0], command.slice(1), { stdio: 'inherit' });
    child.once('error', (error) => resolve({ error: error.message }));
    child.once('exit', (code, signal) =>
      resolve(code === null ? { error: `stopped by ${signal}` } : { code }),
    );
  });
}
