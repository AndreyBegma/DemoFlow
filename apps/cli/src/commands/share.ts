import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { RenderFormat } from '@demoflow/core';
import { ServerError } from '../auth/client.ts';
import { readCredentials } from '../auth/credentials.ts';
import { currentHost, type HostEnvironment } from '../config/index.ts';
import { runnerPaths } from '../runner/paths.ts';
import {
  createShare,
  DEFAULT_SHARE_LIFETIME,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  reportedRunOf,
  SHARE_LIFETIMES,
  type Share,
  type ShareLifetime,
  ShareRefused,
  shareableFormat,
  type WaitDeps,
  waitForShare,
} from '../share/publish.ts';
import { CommandError, EXIT_STAGE_FAILED } from './errors.ts';
import type { Io } from './io.ts';
import { locateRun } from './render.ts';

/** Decision 6: the upload is polled for up to 10 minutes. */
export const SHARE_WAIT_MS = 10 * 60_000;
/** How often a long upload says it is still going. */
const PROGRESS_EVERY_MS = 15_000;
/** Decision 6: where `--password` reads the password without a terminal. */
export const PASSWORD_ENV = 'DEMOFLOW_SHARE_PASSWORD';

export interface ShareFlags {
  format?: RenderFormat;
  /** `--expires`: 7, 30 or 90 days. */
  expires?: string;
  /** `--password`: asked for, never a flag value (shell history). */
  password?: boolean;
  json?: boolean;
  out?: string;
  /** Hidden: the project root, instead of searching up from the cwd. */
  project?: string;
}

export interface ShareCommandDeps extends WaitDeps {
  host: HostEnvironment;
  cwd: string;
  /** The password typed without echo, or `null` without a terminal. */
  askPassword(): Promise<string | null>;
}

export const defaultShareDeps = (): ShareCommandDeps => ({
  host: currentHost(),
  cwd: process.cwd(),
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => delay(ms),
  now: () => Date.now(),
  askPassword: askPasswordOnTerminal,
});

/**
 * `demoflow share <runId>` (spec 349, Decision 6): a share link for a render
 * of a run this machine reported. The runner uploads the file; this command
 * asks the server for the share and waits until it is ready. Refusals are
 * `CommandError`s (exit 2); an upload that fails exits 1.
 */
export async function shareCommand(
  runId: string,
  flags: ShareFlags,
  io: Io,
  deps: ShareCommandDeps = defaultShareDeps(),
): Promise<number> {
  const expiresInDays = parseLifetime(flags.expires);
  const credentials = readCredentials(deps.host);
  if (credentials === null) {
    throw new CommandError(
      'not-logged-in',
      'this machine is not logged in: run demoflow login',
    );
  }
  const { runDir } = locateRun(runId, flags, deps);
  if (!existsSync(runDir)) {
    throw new CommandError('run-not-found', `no run directory at ${runDir}`);
  }

  try {
    const format = await shareableFormat(runDir, flags.format);
    const reported = await reportedRunOf(
      runnerPaths(deps.host).reportedRuns,
      runDir,
      credentials.server,
    );
    const password =
      flags.password === true ? await readPassword(deps) : undefined;

    io.stderr(`Sharing the ${format} render of ${runId}\n`);
    const { share, existing } = await createShare(
      credentials,
      {
        runId: reported.id,
        format,
        expiresInDays,
        ...(password === undefined ? {} : { password }),
      },
      deps.fetch,
    );
    if (existing) {
      io.stderr(
        `This render is already shared ${share.view.hasPassword === true ? 'with' : 'without'} a password; that link is kept (revoke it on the website to share it again)\n`,
      );
    } else if (share.status === 'uploading') {
      io.stderr('The runner is uploading the render\n');
    }

    let reportedAt = 0;
    const settled = await waitForShare(credentials, share, deps, {
      timeoutMs: SHARE_WAIT_MS,
      onPoll: (current, elapsedMs) => {
        if (current.status !== 'uploading') return;
        if (elapsedMs - reportedAt < PROGRESS_EVERY_MS) return;
        reportedAt = elapsedMs;
        io.stderr(`Still uploading (${Math.round(elapsedMs / 1000)} s)\n`);
      },
    });
    return printShare(settled, flags, io);
  } catch (error) {
    if (error instanceof ShareRefused) {
      throw new CommandError(error.code, error.message);
    }
    if (error instanceof ServerError) {
      io.stderr(`${error.message}\n`);
      return EXIT_STAGE_FAILED;
    }
    throw error;
  }
}

/** The link on stdout, and the file link when there is no password. */
function printShare(share: Share, flags: ShareFlags, io: Io): number {
  if (flags.json === true) {
    io.stdout(`${JSON.stringify(share.view, null, 2)}\n`);
  }
  switch (share.status) {
    case 'ready':
      if (flags.json !== true) {
        io.stdout(`${share.url}\n`);
        if (share.fileUrl !== null) io.stdout(`${share.fileUrl}\n`);
      }
      io.stderr(
        `Ready; the link works until ${share.expiresAt.slice(0, 10)}\n`,
      );
      return 0;
    case 'uploading':
      io.stderr(
        `The upload is still going after ${SHARE_WAIT_MS / 60_000} minutes; the link works once it is done: ${share.url}\n`,
      );
      return 1;
    case 'failed':
    case 'lost':
      io.stderr(`The upload failed: ${share.failure ?? share.status}\n`);
      return 1;
  }
}

function parseLifetime(value: string | undefined): ShareLifetime {
  if (value === undefined) return DEFAULT_SHARE_LIFETIME;
  const days = SHARE_LIFETIMES.find((known) => String(known) === value);
  if (days === undefined) {
    throw new CommandError(
      'invalid-expires',
      `--expires must be ${SHARE_LIFETIMES.join(', ')} days, not ${JSON.stringify(value)}`,
    );
  }
  return days;
}

/** Decision 6: typed on a terminal, else `DEMOFLOW_SHARE_PASSWORD`. */
async function readPassword(deps: ShareCommandDeps): Promise<string> {
  const typed = await deps.askPassword();
  const password = typed ?? deps.host.env[PASSWORD_ENV];
  if (password === undefined || password === '') {
    throw new CommandError(
      'invalid-password',
      typed === null
        ? `--password without a terminal reads ${PASSWORD_ENV}, which is not set`
        : 'the password is empty',
    );
  }
  if (
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    throw new CommandError(
      'invalid-password',
      `the password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  return password;
}

/** Typed twice without echo; no terminal, no question. */
async function askPasswordOnTerminal(): Promise<string | null> {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
    return null;
  }
  let muted = false;
  // The prompt itself is shown; what is typed after it is not.
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const prompt = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  const ask = async (question: string): Promise<string> => {
    muted = false;
    const answer = prompt.question(question);
    muted = true;
    const typed = await answer;
    process.stderr.write('\n');
    return typed;
  };
  try {
    const password = await ask('Password for the share: ');
    if ((await ask('Again: ')) !== password) {
      throw new CommandError('invalid-password', 'the passwords differ');
    }
    return password;
  } finally {
    prompt.close();
  }
}
