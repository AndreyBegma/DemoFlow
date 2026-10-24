import { randomUUID } from 'node:crypto';
import {
  HttpStatus,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Clock } from '../common/clock';
import { PrismaService } from '../database/prisma.service';
import {
  type LaunchSink,
  RunnerConnections,
} from '../runner/runner-connections.service';
import type {
  LaunchMessage,
  RunOutcome,
  RunPhase,
} from '../runner/runner-socket';
import { runError } from '../videos/runs.service';

/** No `scenarios.listed` this long after `scenarios.list`: 504 (spec #247, Decision 5). */
export const LIST_TIMEOUT_MS = 10 * 1000;
/** No `run.started` this long after `run.start`: 504, then `run.cancel`. */
export const START_TIMEOUT_MS = 15 * 1000;
/** No `run.finished` this long after `run.cancel`: `lost`. */
export const CANCEL_TIMEOUT_MS = 30 * 1000;
/** No `run.finished` this long after `run.started`: `lost`. The daemon's own cap is 15 min. */
export const RUN_TIMEOUT_MS = 20 * 60 * 1000;
/** A finished launch is kept this long for `GET` (Decision 9). */
export const LAUNCH_RETENTION_MS = 10 * 60 * 1000;
/** A detached launch whose machine has no new socket this long is `lost` (spec #284, Decision 3). */
export const RECONNECT_GRACE_MS = 90 * 1000;
/** A new socket without `launches.sync` this long ends its machine's detached launches (Decision 4). */
export const SYNC_TIMEOUT_MS = 10 * 1000;
/** How often the timeouts are checked. */
const SWEEP_INTERVAL_MS = 1000;

export type LaunchState =
  | 'starting'
  | 'running'
  | 'cancelling'
  | RunOutcome
  | 'lost';

const ACTIVE: ReadonlySet<LaunchState> = new Set([
  'starting',
  'running',
  'cancelling',
]);

/** The child's latest `run.progress` (spec #301): step `step` of `steps` while `phase` is `steps`. */
export interface RunProgress {
  phase: RunPhase;
  step: number | null;
  steps: number | null;
}

/** What the browser polls (Decision 1). */
export interface LaunchView {
  id: string;
  scenarioId: string;
  scenarioName: string | null;
  state: LaunchState;
  startedAt: string;
  finishedAt: string | null;
  runId: string | null;
  /** Only while `running`; null before the first frame (spec #301, Decision 7). */
  progress: RunProgress | null;
}

export interface ScenarioList {
  scenarios: { id: string; name: string }[];
  truncated: boolean;
  skipped: number;
}

/** The project a request is for, once every check of Decision 3 passed. */
export interface LaunchTarget {
  projectId: string;
  runnerId: string;
  rootPath: string;
}

interface Failure {
  status: HttpStatus;
  error: string;
}

type Outcome<T> = { ok: true; value: T } | ({ ok: false } & Failure);

/** Runner codes as HTTP (Decision 4); anything else is `runner-error`. */
const RUNNER_ERRORS: Record<string, Failure> = {
  'project-unknown': { status: HttpStatus.CONFLICT, error: 'project-unknown' },
  'scenario-not-found': {
    status: HttpStatus.NOT_FOUND,
    error: 'scenario-not-found',
  },
  'scenario-invalid': {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    error: 'scenario-invalid',
  },
  'config-invalid': {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    error: 'config-invalid',
  },
  busy: { status: HttpStatus.CONFLICT, error: 'runner-busy' },
  'reporting-off': { status: HttpStatus.CONFLICT, error: 'reporting-off' },
};
const RUNNER_ERROR: Failure = {
  status: HttpStatus.BAD_GATEWAY,
  error: 'runner-error',
};
const OFFLINE: Failure = {
  status: HttpStatus.SERVICE_UNAVAILABLE,
  error: 'runner-offline',
};
const TIMEOUT: Failure = {
  status: HttpStatus.GATEWAY_TIMEOUT,
  error: 'runner-timeout',
};

function runnerFailure(code: string): Failure {
  return Object.hasOwn(RUNNER_ERRORS, code)
    ? RUNNER_ERRORS[code]
    : RUNNER_ERROR;
}

interface PendingList {
  id: string;
  projectId: string;
  runnerId: string;
  /** Clock ms. */
  sentAt: number;
  settle: (outcome: Outcome<ScenarioList>) => void;
}

interface Launch {
  id: string;
  projectId: string;
  runnerId: string;
  scenarioId: string;
  scenarioName: string | null;
  state: LaunchState;
  /** Clock ms. */
  startedAt: number;
  /** Clock ms the current state began: what the timeouts count from. */
  since: number;
  finishedAt: number | null;
  runId: string | null;
  /** `run.finished` arrived and its run id is being checked. */
  finishing: boolean;
  /**
   * Clock ms of the socket close that left it without a machine, until a
   * `launches.sync` reattaches it (spec #284, Decision 2). Not in the view.
   */
  detachedAt: number | null;
  /** The latest valid `run.progress`, kept across a detach (spec #301, Decision 6). */
  progress: RunProgress | null;
  /** The `POST` waiting while `starting`. */
  settle?: (outcome: Outcome<LaunchView>) => void;
}

/**
 * Starts and cancels runs of a project's scenario on its machine, and lists
 * the scenarios (spec #247, ADR-0008 §3, ADR-0016). Everything lives in
 * memory: the run itself reaches the library through `POST /runner/runs`,
 * and a launch is only its live status.
 *
 * Works only on the instance that holds the Runner's socket, like the video
 * relay (spec #191, Decision 10) and artifact deletion (spec #233).
 */
@Injectable()
export class LaunchesService
  implements LaunchSink, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(LaunchesService.name);
  private readonly lists = new Map<string, PendingList>();
  /** By launch id, in creation order. */
  private readonly launches = new Map<string, Launch>();
  /** Clock ms each machine's current socket opened, until its `launches.sync` (Decision 4). */
  private readonly syncWindows = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly connections: RunnerConnections,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.connections.setLaunchSink(this);
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.tick(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Asks the machine for the project's scenarios; nothing is stored. */
  async listScenarios(target: LaunchTarget): Promise<ScenarioList> {
    const outcome = await new Promise<Outcome<ScenarioList>>((settle) => {
      const request: PendingList = {
        id: randomUUID(),
        projectId: target.projectId,
        runnerId: target.runnerId,
        sentAt: this.now(),
        settle,
      };
      this.lists.set(request.id, request);
      const sent = this.connections.sendTo(target.runnerId, {
        type: 'scenarios.list',
        requestId: request.id,
        rootPath: target.rootPath,
      });
      if (!sent) {
        this.endList(request, { ok: false, ...OFFLINE }, OFFLINE.error);
      }
    });
    if (!outcome.ok) {
      throw runError(outcome.status, outcome.error);
    }
    return outcome.value;
  }

  /**
   * Sends `run.start` and answers once the machine says it started. One
   * active launch per Runner (Decision 3): checked here, synchronously, so
   * two concurrent starts cannot both pass.
   */
  async start(target: LaunchTarget, scenarioId: string): Promise<LaunchView> {
    if (this.busy(target.runnerId)) {
      throw runError(HttpStatus.CONFLICT, 'runner-busy');
    }
    const outcome = await new Promise<Outcome<LaunchView>>((settle) => {
      const now = this.now();
      const launch: Launch = {
        id: randomUUID(),
        projectId: target.projectId,
        runnerId: target.runnerId,
        scenarioId,
        scenarioName: null,
        state: 'starting',
        startedAt: now,
        since: now,
        finishedAt: null,
        runId: null,
        finishing: false,
        detachedAt: null,
        progress: null,
        settle,
      };
      this.launches.set(launch.id, launch);
      const sent = this.connections.sendTo(target.runnerId, {
        type: 'run.start',
        requestId: launch.id,
        rootPath: target.rootPath,
        scenarioId,
      });
      if (!sent) {
        this.failStart(launch, OFFLINE, OFFLINE.error);
      }
    });
    if (!outcome.ok) {
      throw runError(outcome.status, outcome.error);
    }
    return outcome.value;
  }

  /** The project's latest launch, or null. */
  latest(projectId: string): LaunchView | null {
    const launch = this.latestOf(projectId);
    return launch ? toView(launch) : null;
  }

  /**
   * Sends `run.cancel` for the project's running launch (Decision 6). A
   * detached one sends it once reattached (spec #284, Decision 8).
   */
  cancel(projectId: string): LaunchView {
    const launch = this.latestOf(projectId);
    if (launch?.state === 'cancelling') {
      return toView(launch);
    }
    if (launch?.state !== 'running' || launch.finishing) {
      throw runError(HttpStatus.CONFLICT, 'not-running');
    }
    launch.state = 'cancelling';
    launch.since = this.now();
    if (launch.detachedAt === null) {
      this.sendCancel(launch);
    }
    return toView(launch);
  }

  message(runnerId: string, message: LaunchMessage): boolean {
    switch (message.type) {
      case 'scenarios.listed':
      case 'scenarios.error': {
        const request = this.lists.get(message.requestId);
        // Only the machine a request was sent to can answer it.
        if (request?.runnerId !== runnerId) {
          return false;
        }
        if (message.type === 'scenarios.listed') {
          this.endList(
            request,
            {
              ok: true,
              value: {
                scenarios: message.scenarios.map(({ id, name }) => ({
                  id,
                  name,
                })),
                truncated: message.truncated,
                skipped: message.skipped,
              },
            },
            'listed',
          );
        } else {
          this.endList(
            request,
            { ok: false, ...runnerFailure(message.code) },
            message.code,
          );
        }
        return true;
      }
      case 'run.started':
      case 'run.error': {
        const launch = this.launches.get(message.requestId);
        if (launch?.runnerId !== runnerId || launch.state !== 'starting') {
          return false;
        }
        if (message.type === 'run.error') {
          this.failStart(launch, runnerFailure(message.code), message.code);
          return true;
        }
        launch.state = 'running';
        launch.since = this.now();
        launch.scenarioName = message.scenarioName;
        const settle = launch.settle;
        launch.settle = undefined;
        settle?.({ ok: true, value: toView(launch) });
        return true;
      }
      case 'run.finished': {
        const launch = this.launches.get(message.requestId);
        if (
          launch?.runnerId !== runnerId ||
          (launch.state !== 'running' && launch.state !== 'cancelling') ||
          launch.finishing
        ) {
          return false;
        }
        // The machine telling the outcome: nothing left to wait for (spec #284, Decision 7).
        launch.finishing = true;
        launch.detachedAt = null;
        this.ownRunId(launch, message.runId)
          .then((runId) => this.end(launch, message.outcome, runId))
          .catch((error: unknown) => {
            this.logger.error(error);
            this.end(launch, message.outcome, null);
          });
        return true;
      }
      case 'run.progress': {
        const launch = this.launches.get(message.requestId);
        // Spec #301, Decision 4: early frames while `starting` are kept; not a heartbeat.
        if (
          launch?.runnerId !== runnerId ||
          !ACTIVE.has(launch.state) ||
          launch.finishing ||
          !isConsistent(message)
        ) {
          return false;
        }
        // Decision 8: nothing logged per frame.
        launch.progress = {
          phase: message.phase,
          step: message.step,
          steps: message.steps,
        };
        return true;
      }
      case 'launches.sync': {
        // Once per socket, inside its window; a later one is stray.
        if (!this.syncWindows.delete(runnerId)) {
          return false;
        }
        this.sync(runnerId, message.running);
        return true;
      }
    }
  }

  /** The machine's new socket opens its sync window (spec #284, Decision 4). */
  opened(runnerId: string): void {
    this.syncWindows.set(runnerId, this.now());
  }

  /**
   * Decision 7: pending requests end and a starting launch fails; a running
   * or cancelling one is detached until the machine is back (spec #284,
   * Decision 2).
   */
  closed(runnerId: string): void {
    this.syncWindows.delete(runnerId);
    for (const request of [...this.lists.values()]) {
      if (request.runnerId === runnerId) {
        this.endList(request, { ok: false, ...OFFLINE }, OFFLINE.error);
      }
    }
    for (const launch of [...this.launches.values()]) {
      if (launch.runnerId !== runnerId || launch.finishing) {
        continue;
      }
      if (launch.state === 'starting') {
        this.failStart(launch, OFFLINE, OFFLINE.error);
      } else if (
        (launch.state === 'running' || launch.state === 'cancelling') &&
        launch.detachedAt === null
      ) {
        launch.detachedAt = this.now();
      }
    }
  }

  /** Timeouts and retention, on the injected clock. Runs every `SWEEP_INTERVAL_MS`. */
  tick(): void {
    const now = this.now();
    for (const request of [...this.lists.values()]) {
      if (now - request.sentAt >= LIST_TIMEOUT_MS) {
        this.endList(request, { ok: false, ...TIMEOUT }, TIMEOUT.error);
      }
    }
    // An old daemon never syncs: its detached launches end as before 284.
    for (const [runnerId, openedAt] of [...this.syncWindows]) {
      if (now - openedAt >= SYNC_TIMEOUT_MS) {
        this.syncWindows.delete(runnerId);
        for (const launch of this.detachedOf(runnerId)) {
          this.end(launch, 'lost', null);
        }
      }
    }
    for (const launch of [...this.launches.values()]) {
      if (launch.finishing) {
        continue;
      }
      if (launch.detachedAt !== null) {
        if (
          !this.syncWindows.has(launch.runnerId) &&
          now - launch.detachedAt >= RECONNECT_GRACE_MS
        ) {
          this.end(launch, 'lost', null);
          continue;
        }
        // Decision 8: the cancel timeout waits for the reattach.
        if (launch.state === 'cancelling') {
          continue;
        }
      }
      const age = now - launch.since;
      switch (launch.state) {
        case 'starting':
          if (age >= START_TIMEOUT_MS) {
            // Nothing may run that the website does not know about.
            this.connections.sendTo(launch.runnerId, {
              type: 'run.cancel',
              requestId: launch.id,
            });
            this.failStart(launch, TIMEOUT, TIMEOUT.error);
          }
          break;
        case 'running':
          if (age >= RUN_TIMEOUT_MS) {
            this.end(launch, 'lost', null);
          }
          break;
        case 'cancelling':
          if (age >= CANCEL_TIMEOUT_MS) {
            this.end(launch, 'lost', null);
          }
          break;
        default:
          if (
            launch.finishedAt !== null &&
            now - launch.finishedAt >= LAUNCH_RETENTION_MS
          ) {
            this.launches.delete(launch.id);
          }
      }
    }
  }

  /**
   * Spec #284, Decision 5: a listed detached launch is reattached, an
   * unlisted one is `lost`. Any other id is ignored (Decision 6).
   */
  private sync(runnerId: string, running: string[]): void {
    const listed = new Set(running);
    let reattached = 0;
    let lost = 0;
    for (const launch of this.detachedOf(runnerId)) {
      if (!listed.delete(launch.id)) {
        this.end(launch, 'lost', null);
        lost += 1;
        continue;
      }
      launch.detachedAt = null;
      reattached += 1;
      if (launch.state === 'cancelling') {
        launch.since = this.now();
        this.sendCancel(launch);
      }
    }
    const ignored = listed.size;
    if (ignored > 0) {
      this.logger.warn(
        `Runner ${runnerId} synced ${ignored} launch id(s) this API does not hold detached; ignored`,
      );
    }
    // Decision 11: counts only, no path, no scenario id.
    this.logger.log(
      JSON.stringify({
        event: 'launches.sync',
        runnerId,
        reattached,
        lost,
        ignored,
      }),
    );
  }

  private detachedOf(runnerId: string): Launch[] {
    return [...this.launches.values()].filter(
      (launch) =>
        launch.runnerId === runnerId &&
        launch.detachedAt !== null &&
        !launch.finishing,
    );
  }

  /** A `run.cancel` the machine cannot get leaves the launch `lost`. */
  private sendCancel(launch: Launch): void {
    const sent = this.connections.sendTo(launch.runnerId, {
      type: 'run.cancel',
      requestId: launch.id,
    });
    if (!sent) {
      this.end(launch, 'lost', null);
    }
  }

  private busy(runnerId: string): boolean {
    for (const launch of this.launches.values()) {
      if (launch.runnerId === runnerId && ACTIVE.has(launch.state)) {
        return true;
      }
    }
    return false;
  }

  private latestOf(projectId: string): Launch | undefined {
    let latest: Launch | undefined;
    for (const launch of this.launches.values()) {
      if (launch.projectId === projectId) {
        latest = launch;
      }
    }
    return latest;
  }

  /**
   * Decision 8: the browser never sees a run id that is not its own — kept
   * only when that run belongs to the launch's project and machine.
   */
  private async ownRunId(
    launch: Launch,
    runId: string | null,
  ): Promise<string | null> {
    if (runId === null) {
      return null;
    }
    const count = await this.prisma.run.count({
      where: {
        id: runId,
        projectId: launch.projectId,
        runnerId: launch.runnerId,
      },
    });
    if (count !== 1) {
      this.logger.warn(
        `Launch ${launch.id} on runner ${launch.runnerId} reported a run id that is not its project's; dropped`,
      );
      return null;
    }
    return runId;
  }

  /** A start that failed leaves no launch behind (Decision 4). */
  private failStart(launch: Launch, failure: Failure, label: string): void {
    this.launches.delete(launch.id);
    this.logLaunch(launch, label);
    const settle = launch.settle;
    launch.settle = undefined;
    settle?.({ ok: false, ...failure });
  }

  private end(
    launch: Launch,
    state: RunOutcome | 'lost',
    runId: string | null,
  ): void {
    launch.state = state;
    launch.finishing = false;
    launch.detachedAt = null;
    launch.finishedAt = this.now();
    launch.runId = runId;
    this.logLaunch(launch, state);
  }

  private endList(
    request: PendingList,
    outcome: Outcome<ScenarioList>,
    label: string,
  ): void {
    this.lists.delete(request.id);
    // Decision 11: no email, no path, no scenario id.
    this.logger.log(
      JSON.stringify({
        event: 'scenarios.list',
        projectId: request.projectId,
        runnerId: request.runnerId,
        outcome: label,
        durationMs: this.now() - request.sentAt,
      }),
    );
    request.settle(outcome);
  }

  private logLaunch(launch: Launch, label: string): void {
    this.logger.log(
      JSON.stringify({
        event: 'launch',
        projectId: launch.projectId,
        runnerId: launch.runnerId,
        outcome: label,
        durationMs: this.now() - launch.startedAt,
      }),
    );
  }

  private now(): number {
    return this.clock.now().getTime();
  }
}

function toView(launch: Launch): LaunchView {
  return {
    id: launch.id,
    scenarioId: launch.scenarioId,
    scenarioName: launch.scenarioName,
    state: launch.state,
    startedAt: new Date(launch.startedAt).toISOString(),
    finishedAt:
      launch.finishedAt === null
        ? null
        : new Date(launch.finishedAt).toISOString(),
    runId: launch.runId,
    progress: launch.state === 'running' ? launch.progress : null,
  };
}

/**
 * Spec #301, Decision 3: `steps` carries both numbers with `step ≤ steps`,
 * any other phase carries neither.
 */
function isConsistent({ phase, step, steps }: RunProgress): boolean {
  if (phase !== 'steps') {
    return step === null && steps === null;
  }
  return step !== null && steps !== null && step <= steps;
}
