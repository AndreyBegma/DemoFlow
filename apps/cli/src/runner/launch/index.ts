import path from 'node:path';
import type { RenderFormat } from '@demoflow/core';
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
  CHECK_PASS_MAX_MS,
  CHECK_SCENARIO_MAX_MS,
  checkCheckStart,
  checkTotals,
  isCheckProgressLine,
} from './check.ts';
import {
  type CheckDeps,
  checkProject,
  checkScenario,
  type LaunchFs,
  type ProjectLoad,
} from './checks.ts';
import { listedFrame, listScenarios } from './list.ts';
import { checkRunOptions } from './options.ts';
import { ProgressGate, parseProgressLine } from './progress.ts';

export { nodeLaunchFs } from './checks.ts';
export { RUN_OPTIONS } from './options.ts';

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
  /**
   * The ids of the launches whose child is alive, for `launches.sync` after a
   * (re)connect. Only ids the API accepts: a UUID v4.
   */
  running(): string[];
}

/** The `requestId` shape the API accepts in `launches.sync` (spec 284). */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      const { home, config } = resolveProject(root, root, host);
      return { ok: true, home, fragmentsDir: config.fragmentsDir };
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
 * `run.cancel`, and (spec 360) `check.start`. One website-started run or
 * check pass at a time, an ordinary `demoflow run`
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
    const { type, requestId, rootPath, scenarioId, options } = message;
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
        this.start(requestId, rootPath, scenarioId, options, reply, current);
        return;
      case 'check.start':
        this.startCheck(message, reply, current);
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

  /**
   * Spec 285, Decisions 2 and 3: the launch with a spawned child, including
   * one being killed. A start still in its checks has nothing to reattach, and
   * an id the API would reject is left out so it cannot sink the whole frame.
   */
  running(): string[] {
    const launch = this.launch;
    if (launch?.child === undefined) return [];
    if (!UUID_V4.test(launch.requestId)) {
      this.deps.logger.log(
        'warn',
        `launch ${shown(launch.requestId)}: not announced, the request id is not a UUID v4`,
      );
      return [];
    }
    return [launch.requestId];
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
      const listing = await listScenarios(
        project.root,
        this.deps.fs,
        project.fragmentsDir,
      );
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
    options: unknown,
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
    const early = this.refusedEarly();
    if (early !== null) {
      refuse(early);
      return;
    }
    // Spec 326, Decision 4: pure, so a refused start touches no file.
    const checked = checkRunOptions(options);
    if (!checked.ok) {
      refuse('options-invalid');
      return;
    }
    const launch: Launch = { requestId, done: Promise.resolve() };
    this.launch = launch;
    launch.done = this.run(
      launch,
      rootPath,
      scenarioId,
      checked.formats,
      reply,
      current,
    )
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

  /** Decision 6: a start still in its checks counts as running. */
  private refusedEarly(): string | null {
    return this.launch !== null
      ? 'busy'
      : this.closing !== null
        ? 'io'
        : isReportOff(this.deps.env)
          ? 'reporting-off'
          : null;
  }

  /**
   * Spec 360, Decision 6: a check pass the website starts. Checked like a
   * `run.start`, then one `run --check` child for the whole project; it is
   * the machine's one launch and is cancelled with `run.cancel`.
   */
  private startCheck(
    message: Record<string, unknown>,
    reply: LaunchSender,
    current: LaunchSender,
  ): void {
    const { logger } = this.deps;
    const checked = checkCheckStart(message);
    if (!checked.ok && checked.requestId === null) {
      logger.log('warn', 'ignored a malformed check.start');
      return;
    }
    const { requestId } = checked;
    const refuse = (code: string) => {
      logger.log('info', `check ${shown(requestId)}: refused ${code}`);
      reply.send({ type: 'check.error', requestId, code });
    };
    if (!checked.ok) {
      refuse(checked.code);
      return;
    }
    const early = this.refusedEarly();
    if (early !== null) {
      refuse(early);
      return;
    }
    const launch: Launch = { requestId, done: Promise.resolve() };
    this.launch = launch;
    launch.done = this.runCheck(
      launch,
      checked.rootPath,
      checked.exclude,
      reply,
      current,
    )
      .catch((error: unknown) => {
        if (error instanceof Refused) refuse(error.code);
        else if (launch.child === undefined) refuse('io');
        else
          logger.log('error', `check ${shown(requestId)}: failed after start`);
      })
      .finally(() => {
        if (this.launch === launch) this.launch = null;
      });
  }

  private async runCheck(
    launch: Launch,
    rootPath: string,
    exclude: string[],
    reply: LaunchSender,
    current: LaunchSender,
  ): Promise<void> {
    const { deps } = this;
    const { requestId } = launch;
    const project = await checkProject(rootPath, deps);
    if (!project.ok) throw new Refused(project.code);
    if (launch.ending !== undefined) {
      deps.logger.log(
        'info',
        `check ${shown(requestId)}: cancelled before start`,
      );
      return;
    }
    let totals: { passed: number; failed: number } | null = null;
    // The launch cap applies per scenario: each scenario's start resets it.
    let cancelScenarioCap = (): void => {};
    const capScenario = () => {
      cancelScenarioCap();
      cancelScenarioCap = deps.clock.after(CHECK_SCENARIO_MAX_MS, () => {
        void this.stop(launch, 'timed-out');
      });
    };
    // Nothing from the message but the checked root and scenario ids.
    const child = deps.spawn(
      [
        'run',
        '--check',
        '--json',
        '--progress',
        '--project',
        project.root,
        ...exclude.flatMap((id) => ['--exclude', id]),
      ],
      project.root,
      {
        killGraceMs: LAUNCH_KILL_GRACE_MS,
        onStdoutLine: (line) => {
          if (isCheckProgressLine(line)) capScenario();
          totals = checkTotals(line) ?? totals;
        },
      },
    );
    if (child.pid === undefined) {
      await child.exited;
      throw new Refused('io');
    }
    launch.child = child;
    reply.send({ type: 'check.started', requestId });
    deps.logger.log(
      'info',
      `check ${shown(requestId)}: started, ${exclude.length} excluded`,
    );
    capScenario();
    const cancelPassCap = deps.clock.after(CHECK_PASS_MAX_MS, () => {
      void this.stop(launch, 'timed-out');
    });
    await child.exited;
    cancelScenarioCap();
    cancelPassCap();
    // A pass that was ended, or crashed before its summary, verified nothing.
    const { passed, failed } =
      launch.ending === undefined && totals !== null
        ? totals
        : { passed: 0, failed: 0 };
    deps.logger.log(
      'info',
      `check ${shown(requestId)}: ${launch.ending ?? 'finished'}, ${passed} passed, ${failed} failed`,
    );
    current.send({ type: 'check.finished', requestId, passed, failed });
  }

  private async run(
    launch: Launch,
    rootPath: string,
    scenarioId: string,
    formats: RenderFormat[] | null,
    reply: LaunchSender,
    current: LaunchSender,
  ): Promise<void> {
    const { deps } = this;
    const { requestId } = launch;
    const project = await checkProject(rootPath, deps);
    if (!project.ok) throw new Refused(project.code);
    const scenario = await checkScenario(
      project.root,
      scenarioId,
      deps.fs,
      project.fragmentsDir,
    );
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
    // Spec 302, Decision 6: the socket open when a frame is due, latest wins.
    const gate = new ProgressGate(deps.clock, (progress) => {
      current.send({
        type: 'run.progress',
        requestId,
        phase: progress.phase,
        step: progress.phase === 'steps' ? progress.step : null,
        steps: progress.phase === 'steps' ? progress.steps : null,
      });
    });
    // Decision 6: nothing from the message but the checked file and root, and
    // (spec 326, Decision 5) the enum's own format constants.
    const child = deps.spawn(
      [
        'run',
        scenario.file,
        '--json',
        '--progress',
        '--run-id',
        runId,
        '--project',
        project.root,
        ...(formats ?? []).flatMap((format) => ['--format', format]),
      ],
      project.root,
      {
        killGraceMs: LAUNCH_KILL_GRACE_MS,
        onStdoutLine: (line) => {
          const progress = parseProgressLine(line);
          if (progress !== null) gate.push(progress);
        },
      },
    );
    if (child.pid === undefined) {
      gate.stop();
      await child.exited;
      throw new Refused('io');
    }
    launch.child = child;
    reply.send({ type: 'run.started', requestId, scenarioName: scenario.name });
    deps.logger.log(
      'info',
      `launch ${shown(requestId)}: started run ${runId}, formats ${formats?.length ?? 'default'}`,
    );
    const cancelCap = deps.clock.after(LAUNCH_MAX_MS, () => {
      void this.stop(launch, 'timed-out');
    });
    await child.exited;
    // Nothing may follow the end of the run, `run.finished` included.
    gate.stop();
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
