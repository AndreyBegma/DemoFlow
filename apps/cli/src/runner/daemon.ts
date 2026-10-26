import { existsSync, rmSync } from 'node:fs';
import { type Fetch, fetchSelf } from '../auth/client.ts';
import { readCredentials, writeCredentials } from '../auth/credentials.ts';
import type { Io } from '../commands/io.ts';
import type { HostEnvironment } from '../config/platform.ts';
import { type SpawnRun, spawnRun } from '../mcp/child.ts';
import { ArtifactsDeleter, nodeArtifactsFs } from './artifacts/index.ts';
import {
  type Clock,
  nodeSocket,
  PING_MS,
  RunnerConnection,
  type SocketFactory,
  systemClock,
} from './connection.ts';
import { defaultLauncherDeps, Launcher, nodeLaunchFs } from './launch/index.ts';
import { acquireLock, releaseLock } from './lock.ts';
import { fileLogger, type Logger } from './log.ts';
import { runnerPaths } from './paths.ts';
import { nodeRelayFs, VideoRelay } from './relay/index.ts';
import {
  defaultWriteTemplate,
  isWebsiteRegistered,
  ProjectRequests,
} from './roots/index.ts';
import {
  hasScheduledRoot,
  machineZone,
  scheduleLoader,
  watchedRoots,
} from './schedule/roots.ts';
import { Scheduler } from './schedule/scheduler.ts';
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
  /** Starts the `demoflow run` child of a website-started run (spec 248). */
  spawn: SpawnRun;
  /** Mirror log lines here as well, e.g. a terminal running `--foreground`. */
  echo?: (line: string) => void;
  /** The machine's IANA zone for schedules (spec 361); the system's when absent. */
  zone?: () => string;
}

export const defaultDaemonDeps = (host: HostEnvironment): DaemonDeps => ({
  host,
  pid: process.pid,
  connect: nodeSocket,
  clock: systemClock,
  random: Math.random,
  fetch: (input, init) => fetch(input, init),
  spawn: spawnRun,
  ...(process.stderr.isTTY === true
    ? { echo: (line: string) => process.stderr.write(line) }
    : {}),
});

/**
 * `demoflow runner --foreground`: the daemon itself. `runner start` spawns it
 * detached; the autostart units run it directly. One per machine. Without an
 * account it runs scheduled checks only, when a watched root has a schedule
 * (spec 361, Decision 5).
 */
export async function runForeground(io: Io, deps: DaemonDeps): Promise<number> {
  const paths = runnerPaths(deps.host);
  const credentials = readCredentials(deps.host);
  if (credentials === null && !hasScheduledRoot(paths, deps.host.env)) {
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
  logger.log(
    'info',
    `runner started (PID ${deps.pid})${credentials === null ? ', local mode: scheduled checks only' : ''}`,
  );

  let current: { state: ConnectionState; retryAt?: number } = {
    state: credentials === null ? 'local' : 'connecting',
  };
  const saveState = () => {
    writeState(paths.state, {
      pid: deps.pid,
      startedAt,
      ...(credentials === null ? {} : { server: credentials.server }),
      state: current.state,
      ...(current.retryAt === undefined
        ? {}
        : { retryAt: new Date(current.retryAt).toISOString() }),
      updatedAt: new Date(deps.clock.now()).toISOString(),
    });
  };
  saveState();

  // Spec 361, Decision 5: without an account, no socket, relay or launches.
  let connection: RunnerConnection | null = null;
  let launcher: Launcher | null = null;
  const scheduler = new Scheduler({
    clock: deps.clock,
    logger,
    zone: deps.zone ?? machineZone,
    roots: () => watchedRoots(paths),
    loadSchedule: scheduleLoader(deps.host.env),
    stateFile: paths.scheduleState,
    spawn: deps.spawn,
    // Spec 248: one launch slot per machine, shared with the website.
    claim: () => (launcher === null ? () => {} : launcher.claim()),
    onSchedules: () => connection?.syncSchedules(),
    local: credentials === null,
  });
  if (credentials !== null) {
    const relay = new VideoRelay({
      indexFile: paths.reportedRuns,
      fs: nodeRelayFs,
      logger,
      platform: deps.host.platform,
    });
    const projectsFiles = {
      allowedRootsFile: paths.allowedRoots,
      websiteProjectsFile: paths.websiteProjects,
      host: deps.host,
    };
    const launcherDeps = defaultLauncherDeps(deps.host);
    launcher = new Launcher({
      indexFile: paths.reportedRuns,
      websiteRegistered: (rootPath) =>
        isWebsiteRegistered(rootPath, { ...projectsFiles, fs: nodeLaunchFs }),
      fs: nodeLaunchFs,
      logger,
      clock: deps.clock,
      env: deps.host.env,
      spawn: deps.spawn,
      onIdle: () => scheduler.wake(),
      ...launcherDeps,
    });
    connection = new RunnerConnection({
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
      relay,
      artifacts: new ArtifactsDeleter({
        indexFile: paths.reportedRuns,
        fs: nodeArtifactsFs,
        logger,
        platform: deps.host.platform,
        homeDir: deps.host.homedir,
        closeRun: (runId) => relay.closeRun(runId),
      }),
      launches: launcher,
      projects: new ProjectRequests({
        ...projectsFiles,
        fs: nodeLaunchFs,
        logger,
        clock: deps.clock,
        loadProject: launcherDeps.loadProject,
        writeTemplate: defaultWriteTemplate,
      }),
      schedules: () => scheduler.schedules(),
    });
  }

  let stopped = (): void => {};
  const stopping = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const stop = (why: string) => {
    logger.log('info', `stopping (${why})`);
    // Spec 248, Decision 11: the run is cancelled; `finally` waits for it.
    void launcher?.close();
    void scheduler.stop();
    if (connection === null) stopped();
    else void connection.stop();
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
    scheduler.start();
    if (connection === null) {
      await stopping;
      rmSync(paths.state, { force: true });
      logger.log('info', 'stopped');
      return EXIT_DAEMON_DONE;
    }
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
    // No child outlives the daemon, whatever ended it.
    await Promise.all([launcher?.close(), scheduler.stop()]);
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
