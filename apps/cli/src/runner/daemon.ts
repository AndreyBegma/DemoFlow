import { existsSync, rmSync } from 'node:fs';
import { type Fetch, fetchSelf } from '../auth/client.ts';
import { readCredentials, writeCredentials } from '../auth/credentials.ts';
import type { Io } from '../commands/io.ts';
import type { HostEnvironment } from '../config/platform.ts';
import {
  type Clock,
  nodeSocket,
  PING_MS,
  RunnerConnection,
  type SocketFactory,
  systemClock,
} from './connection.ts';
import { acquireLock, releaseLock } from './lock.ts';
import { fileLogger, type Logger } from './log.ts';
import { runnerPaths } from './paths.ts';
import { type ConnectionState, writeState } from './state.ts';

/** How often the daemon looks for `runner.stop`. */
export const STOP_POLL_MS = 500;

/**
 * Exit codes of `demoflow runner --foreground`. A revoked runner exits 0 on
 * purpose: autostart supervisors restart on failure only, and a revoked token
 * will never connect again.
 */
export const EXIT_DAEMON_DONE = 0;
export const EXIT_DAEMON_NOT_LOGGED_IN = 1;
export const EXIT_DAEMON_CRASHED = 3;

export interface DaemonDeps {
  host: HostEnvironment;
  pid: number;
  connect: SocketFactory;
  clock: Clock;
  random(): number;
  fetch: Fetch;
  /** Mirror log lines here as well, e.g. a terminal running `--foreground`. */
  echo?: (line: string) => void;
}

export const defaultDaemonDeps = (host: HostEnvironment): DaemonDeps => ({
  host,
  pid: process.pid,
  connect: nodeSocket,
  clock: systemClock,
  random: Math.random,
  fetch: (input, init) => fetch(input, init),
  ...(process.stderr.isTTY === true
    ? { echo: (line: string) => process.stderr.write(line) }
    : {}),
});

/**
 * `demoflow runner --foreground`: the daemon itself. `runner start` spawns it
 * detached; the autostart units run it directly. One per machine.
 */
export async function runForeground(io: Io, deps: DaemonDeps): Promise<number> {
  const paths = runnerPaths(deps.host);
  const credentials = readCredentials(deps.host);
  if (credentials === null) {
    io.stderr('Not logged in; run demoflow login first\n');
    return EXIT_DAEMON_NOT_LOGGED_IN;
  }
  const startedAt = new Date(deps.clock.now()).toISOString();
  const lock = acquireLock(paths.lock, { pid: deps.pid, startedAt });
  if (!lock.acquired) {
    io.stdout(`Runner already running (PID ${lock.holder.pid})\n`);
    return EXIT_DAEMON_DONE;
  }
  rmSync(paths.stop, { force: true });
  const logger = fileLogger(paths.log, {
    now: () => new Date(deps.clock.now()),
    ...(deps.echo === undefined ? {} : { echo: deps.echo }),
  });
  logger.log('info', `runner started (PID ${deps.pid})`);

  let current: { state: ConnectionState; retryAt?: number } = {
    state: 'connecting',
  };
  const saveState = () => {
    writeState(paths.state, {
      pid: deps.pid,
      startedAt,
      server: credentials.server,
      state: current.state,
      ...(current.retryAt === undefined
        ? {}
        : { retryAt: new Date(current.retryAt).toISOString() }),
      updatedAt: new Date(deps.clock.now()).toISOString(),
    });
  };
  saveState();

  const connection = new RunnerConnection({
    server: credentials.server,
    token: credentials.token,
    runnerId: credentials.runnerId,
    connect: deps.connect,
    clock: deps.clock,
    random: deps.random,
    logger,
    saveToken: (token) =>
      writeCredentials(deps.host, { ...credentials, token }),
    isRevoked: async (token) =>
      (await fetchSelf(credentials.server, token, deps.fetch)) === null,
    onState: (state, retryAt) => {
      current = retryAt === undefined ? { state } : { state, retryAt };
      saveState();
    },
  });

  const stop = (why: string) => {
    logger.log('info', `stopping (${why})`);
    void connection.stop();
  };
  const watch = setInterval(() => {
    if (existsSync(paths.stop)) stop('runner stop');
  }, STOP_POLL_MS);
  // `status` and `stop` trust the state file only while it is fresh.
  const tick = setInterval(saveState, PING_MS);
  const onSignal = (signal: NodeJS.Signals) => stop(signal);
  // Windows has no catchable SIGTERM: there `runner.stop` is the only way.
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  try {
    const outcome = await connection.run();
    if (outcome === 'revoked') {
      current = { state: 'revoked' };
      saveState();
    } else {
      rmSync(paths.state, { force: true });
    }
    logger.log('info', outcome === 'revoked' ? 'exited: revoked' : 'stopped');
    return EXIT_DAEMON_DONE;
  } catch (error) {
    logFailure(logger, error);
    return EXIT_DAEMON_CRASHED;
  } finally {
    clearInterval(watch);
    clearInterval(tick);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    rmSync(paths.stop, { force: true });
    releaseLock(paths.lock, deps.pid);
  }
}

function logFailure(logger: Logger, error: unknown): void {
  logger.log(
    'error',
    `crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
}
