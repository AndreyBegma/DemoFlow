import path from 'node:path';
import { generateRunId } from '../../commands/run-id.ts';
import { readResult as readRunResult } from '../../commands/settle.ts';
import {
  type HostEnvironment,
  runDir as runDirFor,
} from '../../config/index.ts';
import type { RunChild, SpawnRun } from '../../mcp/child.ts';
import { ToolError } from '../../mcp/errors.ts';
import { resolveProject } from '../../mcp/project.ts';
import { isReportOff } from '../../runs-report/report.ts';
import { readReportedRunsByDir } from '../../runs-report/reported-runs.ts';
import type { Clock } from '../connection.ts';
import type { Logger } from '../log.ts';
import {
  type CheckDeps,
  checkProject,
  checkScenario,
  type LaunchFs,
  type ProjectLoad,
} from './checks.ts';
import { listedFrame, listScenarios } from './list.ts';

export { nodeLaunchFs } from './checks.ts';

/**
 * Decision 7: SIGTERM gives the child this long to stop its dev server (up to
 * 10 s, `STOP_GRACE_MS` twice) and its browser before the tree is killed.
 */
export const LAUNCH_KILL_GRACE_MS = 15_000;
/** Decision 9: a run still going after this is killed and ends `timed-out`. */
export const LAUNCH_MAX_MS = 15 * 60_000;

/** The socket, as the launcher sees it: JSON text frames only. */
export interface LaunchSender {
  send(message: Record<string, unknown>): void;
}

/** What the connection needs from the launcher. */
export interface LaunchPort {
  /**
   * `reply` answers on the socket the request came on; `current` sends on
   * whichever socket is open when it is called (Decision 10), or nowhere.
   */
  handle(
    message: Record<string, unknown>,
    reply: LaunchSender,
    current: LaunchSender,
  ): void;
}

export interface LauncherDeps extends CheckDeps {
  fs: LaunchFs;
  logger: Logger;
  clock: Clock;
  platform: NodeJS.Platform;
  /** The daemon's environment: `CI` or `DEMOFLOW_NO_REPORT=1` refuse a start. */
  env: Readonly<Record<string, string | undefined>>;
  spawn: SpawnRun;
  newRunId(): string;
  /** The run's `result.json` status; throws when there is none. */
  readStatus(runDir: string): Promise<string>;
}

/** The project's config, loaded the way `demoflow mcp` loads it. */
export function loadProjectFor(host: HostEnvironment) {
  return (root: string): ProjectLoad => {
    try {
      return { ok: true, home: resolveProject(root, root, host).home };
    } catch (error) {
      if (
        error instanceof ToolError &&
        error.code === 'invalid-project-config'
      ) {
        return { ok: false, code: 'config-invalid' };
      }
      return { ok: false, code: 'project-unknown' };
    }
  };
}

export function defaultLauncherDeps(
  host: HostEnvironment,
): Pick<LauncherDeps, 'loadProject' | 'newRunId' | 'readStatus' | 'platform'> {
  return {
    loadProject: loadProjectFor(host),
    newRunId: () => generateRunId(),
    readStatus: async (runDir) => (await readRunResult(runDir)).status,
    platform: host.platform,
  };
}

type Outcome = 'passed' | 'failed' | 'cancelled' | 'timed-out';

interface Launch {
  requestId: string;
  /** Set when the daemon ends the run: the child's exit is not the verdict. */
  ending?: 'cancelled' | 'timed-out';
  child?: RunChild;
  /** Resolves once the launch is over and `run.finished` was sent. */
  done: Promise<void>;
}

/** A request id as `runner.log` shows it: one short line, whatever was sent. */
function shown(requestId: string): string {
  return requestId.slice(0, 64).replace(/[^A-Za-z0-9-]/g, '?');
}

/** Answers what refuses a start: `run.error` with the code, nothing spawned. */
class Refused extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/**
 * Spec 248: the daemon's side of `scenarios.list`, `run.start` and
 * `run.cancel`. One website-started run at a time, an ordinary `demoflow run`
 * child that reports itself (ADR-0016 §4). `runner.log` gets request ids,
 * outcomes, codes and run ids, never a path or a scenario id (Decision 13).
 */
export class Launcher implements LaunchPort {
  private readonly deps: LauncherDeps;
  private launch: Launch | null = null;
  private closing: Promise<void> | null = null;

  constructor(deps: LauncherDeps) {
    this.deps = deps;
  }

  handle(
    message: Record<string, unknown>,
    reply: LaunchSender,
    current: LaunchSender,
  ): void {
    const { type, requestId, rootPath, scenarioId } = message;
    const { logger } = this.deps;
    switch (type) {
      case 'scenarios.list':
        if (typeof requestId !== 'string' || typeof rootPath !== 'string') {
          logger.log('warn', 'ignored a malformed scenarios.list');
          return;
        }
        void this.list(requestId, rootPath, reply);
        return;
      case 'run.start':
        if (
          typeof requestId !== 'string' ||
          typeof rootPath !== 'string' ||
          typeof scenarioId !== 'string'
        ) {
          logger.log('warn', 'ignored a malformed run.start');
          return;
        }
        this.start(requestId, rootPath, scenarioId, reply, current);
        return;
      case 'run.cancel':
        if (typeof requestId !== 'string') {
          logger.log('warn', 'ignored a malformed run.cancel');
          return;
        }
        this.cancel(requestId);
        return;
    }
  }

  /** Decision 11: cancels the running launch and resolves once its child is gone. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      const launch = this.launch;
      if (launch !== null) await this.stop(launch, 'cancelled');
    })();
    return this.closing;
  }

  private async list(
    requestId: string,
    rootPath: string,
    reply: LaunchSender,
  ): Promise<void> {
    const { logger } = this.deps;
    const refuse = (code: string) => {
      logger.log('info', `scenarios.list ${shown(requestId)}: refused ${code}`);
      reply.send({ type: 'scenarios.error', requestId, code });
    };
    try {
      const project = await checkProject(rootPath, this.deps);
      // Decision 2: a config that does not load is not a project to list.
      if (!project.ok) return refuse('project-unknown');
      const listing = await listScenarios(project.root, this.deps.fs);
      const frame = listedFrame(requestId, listing);
      const sent = (frame.scenarios as unknown[]).length;
      logger.log(
        'info',
        `scenarios.list ${shown(requestId)}: listed ${sent} (${listing.skipped} skipped${frame.truncated === true ? ', truncated' : ''})`,
      );
      reply.send(frame);
    } catch {
      refuse('io');
    }
  }

  private start(
    requestId: string,
    rootPath: string,
    scenarioId: string,
    reply: LaunchSender,
    current: LaunchSender,
  ): void {
    const refuse = (code: string) => {
      this.deps.logger.log(
        'info',
        `launch ${shown(requestId)}: refused ${code}`,
      );
      reply.send({ type: 'run.error', requestId, code });
    };
    // Decision 6: a start still in its checks counts as running.
    const early =
      this.launch !== null
        ? 'busy'
        : this.closing !== null
          ? 'io'
          : isReportOff(this.deps.env)
            ? 'reporting-off'
            : null;
    if (early !== null) {
      refuse(early);
      return;
    }
    const launch: Launch = { requestId, done: Promise.resolve() };
    this.launch = launch;
    launch.done = this.run(launch, rootPath, scenarioId, reply, current)
      .catch((error: unknown) => {
        if (error instanceof Refused) refuse(error.code);
        else if (launch.child === undefined) refuse('io');
        // Not the message: it may hold a path (Decision 13).
        else
          this.deps.logger.log(
            'error',
            `launch ${shown(requestId)}: failed after start`,
          );
      })
      .finally(() => {
        if (this.launch === launch) this.launch = null;
      });
  }

  private async run(
    launch: Launch,
    rootPath: string,
    scenarioId: string,
    reply: LaunchSender,
    current: LaunchSender,
  ): Promise<void> {
    const { deps } = this;
    const { requestId } = launch;
    const project = await checkProject(rootPath, deps);
    if (!project.ok) throw new Refused(project.code);
    const scenario = await checkScenario(project.root, scenarioId, deps.fs);
    if (!scenario.ok) throw new Refused(scenario.code);
    if (launch.ending !== undefined) {
      // The API gave up on this start (spec 247, Decision 5): nothing runs.
      deps.logger.log(
        'info',
        `launch ${shown(requestId)}: cancelled before start`,
      );
      return;
    }
    const runId = deps.newRunId();
    const runDir = runDirFor(project.home, runId, deps.platform);
    // Decision 6: nothing from the message but the checked file and root.
    const child = deps.spawn(
      [
        'run',
        scenario.file,
        '--json',
        '--run-id',
        runId,
        '--project',
        project.root,
      ],
      project.root,
      { killGraceMs: LAUNCH_KILL_GRACE_MS },
    );
    if (child.pid === undefined) {
      await child.exited;
      throw new Refused('io');
    }
    launch.child = child;
    reply.send({ type: 'run.started', requestId, scenarioName: scenario.name });
    deps.logger.log('info', `launch ${shown(requestId)}: started run ${runId}`);
    const cancelCap = deps.clock.after(LAUNCH_MAX_MS, () => {
      void this.stop(launch, 'timed-out');
    });
    await child.exited;
    cancelCap();
    const outcome = launch.ending ?? (await this.outcomeOf(runDir));
    const entry = (await readReportedRunsByDir(deps.indexFile)).get(
      path.resolve(runDir),
    );
    const serverRunId = entry?.id ?? null;
    deps.logger.log(
      'info',
      `launch ${shown(requestId)}: ${outcome} (run ${runId}${serverRunId === null ? '' : `, server run ${serverRunId}`})`,
    );
    current.send({
      type: 'run.finished',
      requestId,
      outcome,
      runId: serverRunId,
    });
  }

  /** Decision 10: the rule `buildReport` uses. */
  private async outcomeOf(runDir: string): Promise<Outcome> {
    try {
      return (await this.deps.readStatus(runDir)) === 'failed'
        ? 'failed'
        : 'passed';
    } catch {
      return 'failed';
    }
  }

  private cancel(requestId: string): void {
    const launch = this.launch;
    if (launch === null || launch.requestId !== requestId) {
      this.deps.logger.log(
        'info',
        `ignored a run.cancel for ${shown(requestId)}: not running`,
      );
      return;
    }
    void this.stop(launch, 'cancelled');
  }

  private async stop(
    launch: Launch,
    reason: 'cancelled' | 'timed-out',
  ): Promise<void> {
    launch.ending ??= reason;
    await launch.child?.kill();
    await launch.done;
  }
}
