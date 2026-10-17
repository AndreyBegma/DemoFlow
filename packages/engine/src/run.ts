import { mkdir } from 'node:fs/promises';
import {
  deriveRunStatus,
  type Scenario,
  type Stage,
  type Stages,
  type TimelineEvent,
} from '@demoflow/core';
import { type BrowserContext, chromium, type Page } from 'playwright';
import {
  errorMessage,
  type FailedStage,
  runAction,
  StepFailure,
} from './execute/actions.ts';
import { type Clock, startClock } from './execute/clock.ts';
import type { EngineObserver, RunOutcome } from './execute/observer.ts';
import { type Point, viewportCentre } from './execute/pointer.ts';
import {
  checkReadiness,
  OriginGuard,
  originNotAllowed,
} from './execute/readiness.ts';
import { recordingOptions, toContextOptions } from './execute/recording.ts';

export interface RunOptions {
  /** Absolute; created when missing. The caller names it after the run id. */
  runDir: string;
  /** The project's `baseUrl`; the scenario's own `baseUrl` wins when set. */
  baseUrl?: string;
  /** Origins the run may open (ADR-0008). Anything else fails the run. */
  allowedOrigins: readonly string[];
  /** Where `valueFrom.env` is read. Defaults to `process.env`; an empty value counts as missing. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to `true`. */
  headless?: boolean;
  observers?: readonly EngineObserver[];
}

const ASSERTIONS = new Set(['assertVisible', 'assertText']);

/**
 * Runs a validated scenario in Chromium and records it (spec 3). The
 * returned outcome reports every stage; the first failed step stops the run.
 */
export async function runScenario(
  scenario: Scenario,
  options: RunOptions,
): Promise<RunOutcome> {
  const observers = options.observers ?? [];
  const emit = async <K extends keyof EngineObserver>(
    hook: K,
    event: Parameters<NonNullable<EngineObserver[K]>>[0],
  ): Promise<void> => {
    for (const observer of observers) {
      const handler = observer[hook] as
        | ((payload: typeof event) => unknown)
        | undefined;
      await handler?.call(observer, event);
    }
  };

  const startedAt = timestamp();
  const stages = pendingStages();
  const recording = recordingOptions(scenario, options.runDir);
  const baseUrl = scenario.baseUrl ?? options.baseUrl;

  await mkdir(options.runDir, { recursive: true });
  await emit('onRunStarted', {
    scenario,
    runDir: options.runDir,
    recording,
    startedAt,
  });

  stages.readiness = { status: 'running', startedAt };
  const readiness = checkReadiness(scenario, {
    baseUrl,
    allowedOrigins: options.allowedOrigins,
    env: options.env ?? process.env,
  });
  if (!readiness.ok) {
    stages.readiness = finish(stages.readiness, 'failed', readiness.problem);
    for (const name of ['execution', 'verification', 'recording'] as const) {
      stages[name] = { status: 'skipped' };
    }
    const outcome = conclude(startedAt, stages, []);
    await emit('onRunFinished', { outcome, video: null });
    return outcome;
  }
  stages.readiness = finish(stages.readiness, 'passed');

  const secrets = [...readiness.secrets.values()];
  const scrub = (message: string): string =>
    secrets.reduce((text, secret) => text.replaceAll(secret, '***'), message);

  const browser = await chromium.launch({
    headless: options.headless ?? true,
  });
  try {
    await emit('onBrowserLaunched', { browser });
    const context = await browser.newContext(toContextOptions(recording));
    const guard = new OriginGuard(options.allowedOrigins);
    const navigation = watchNavigation(context, guard);

    stages.recording = { status: 'running', startedAt: timestamp() };
    const page = await context.newPage();
    const clock = startClock();
    await emit('onPageCreated', { page, recording });

    const events: TimelineEvent[] = [];
    const hasAssertions = scenario.steps.some((step) =>
      ASSERTIONS.has(step.action),
    );
    stages.execution = { status: 'running', startedAt: timestamp() };
    if (hasAssertions) {
      stages.verification = { status: 'running', startedAt: timestamp() };
    }

    const failure = await executeSteps({
      scenario,
      page,
      clock,
      baseUrl,
      guard,
      secrets: readiness.secrets,
      pointer: viewportCentre(scenario.viewport),
      observers,
      events,
      navigation,
      scrub,
      emit,
    });

    if (failure === undefined) {
      stages.execution = finish(stages.execution, 'passed');
      stages.verification = hasAssertions
        ? finish(stages.verification, 'passed')
        : { status: 'skipped' };
    } else {
      const other: FailedStage =
        failure.stage === 'execution' ? 'verification' : 'execution';
      stages[failure.stage] = finish(stages[failure.stage], 'failed', {
        message: failure.message,
        stepIndex: failure.stepIndex,
      });
      stages[other] = { ...stages[other], status: 'skipped' };
    }

    // Closing the context finalises the video, also after a failed step.
    await context.close();
    const video = page.video();
    let videoPath: string | undefined;
    try {
      videoPath = video === null ? undefined : await video.path();
      stages.recording = finish(
        stages.recording,
        videoPath === undefined ? 'failed' : 'passed',
        videoPath === undefined ? { message: 'no video recorded' } : undefined,
      );
    } catch (error) {
      stages.recording = finish(stages.recording, 'failed', {
        message: errorMessage(error),
      });
    }

    const outcome = conclude(startedAt, stages, events, videoPath);
    await emit('onRunFinished', { outcome, video });
    return outcome;
  } finally {
    await browser.close();
  }
}

interface ExecuteInput {
  scenario: Scenario;
  page: Page;
  clock: Clock;
  baseUrl: string | undefined;
  guard: OriginGuard;
  secrets: ReadonlyMap<number, string>;
  pointer: Point;
  observers: readonly EngineObserver[];
  events: TimelineEvent[];
  navigation: NavigationWatch;
  scrub: (message: string) => string;
  emit: <K extends keyof EngineObserver>(
    hook: K,
    event: Parameters<NonNullable<EngineObserver[K]>>[0],
  ) => Promise<void>;
}

interface Failure {
  stage: FailedStage;
  message: string;
  stepIndex: number;
}

/** Runs the steps in order and returns the first failure, if any. */
async function executeSteps(input: ExecuteInput): Promise<Failure | undefined> {
  const { clock, emit, scrub } = input;
  let pointer = input.pointer;
  for (const [stepIndex, step] of input.scenario.steps.entries()) {
    const startMs = clock.now();
    await emit('onStepStarted', { stepIndex, step, startMs });

    const ctx = {
      page: input.page,
      stepIndex,
      baseUrl: input.baseUrl,
      guard: input.guard,
      secret: input.secrets.get(stepIndex),
      pointer,
      observers: input.observers,
    };
    let failure: StepFailure | undefined;
    let result = {};
    // A page that left on its own between steps (a timer, a late redirect) stops the run here.
    let foreign = input.navigation.take();
    if (foreign === undefined) {
      try {
        result = await runAction(step, ctx);
      } catch (error) {
        failure =
          error instanceof StepFailure
            ? error
            : new StepFailure('execution', errorMessage(error));
      }
      pointer = ctx.pointer;
      foreign = input.navigation.take();
    }

    // A navigation to a foreign origin is the failure, whatever the step itself saw.
    if (foreign !== undefined) {
      failure = new StepFailure('execution', originNotAllowed(foreign));
    }

    const event: TimelineEvent = {
      stepIndex,
      action: step.action,
      startMs,
      endMs: Math.max(startMs, clock.now()),
      ...result,
      ...(failure === undefined ? {} : failure.detail),
      ...(step.caption === undefined ? {} : { caption: step.caption }),
    };
    if (failure !== undefined && failure.stage === 'execution') {
      event.error = { message: scrub(failure.message) };
    }
    if (event.assertion?.message !== undefined) {
      event.assertion = {
        ...event.assertion,
        message: scrub(event.assertion.message),
      };
    }
    input.events.push(event);
    await emit('onStepFinished', { stepIndex, step, event });

    if (failure !== undefined) {
      return {
        stage: failure.stage,
        message: scrub(failure.message),
        stepIndex,
      };
    }
  }
  return undefined;
}

interface NavigationWatch {
  /** The first foreign origin a top-level frame tried to open since the last call. */
  take(): string | undefined;
}

/**
 * Catches a top-level navigation to an origin outside the allowlist, however
 * it started — a link, a redirect, a script, a popup. The request event fires
 * before anything loads; `framenavigated` is the backstop.
 */
function watchNavigation(
  context: BrowserContext,
  guard: OriginGuard,
): NavigationWatch {
  let foreign: string | undefined;
  const note = (url: string): void => {
    foreign ??= guard.check(url);
  };
  context.on('request', (request) => {
    if (
      request.isNavigationRequest() &&
      request.frame().parentFrame() === null
    ) {
      note(request.url());
    }
  });
  context.on('page', (page) => {
    page.on('framenavigated', (frame) => {
      if (frame.parentFrame() === null) note(frame.url());
    });
  });
  return {
    take() {
      const origin = foreign;
      foreign = undefined;
      return origin;
    },
  };
}

function pendingStages(): Stages {
  return {
    readiness: { status: 'pending' },
    execution: { status: 'pending' },
    verification: { status: 'pending' },
    recording: { status: 'pending' },
    rendering: { status: 'pending' },
    storage: { status: 'pending' },
  };
}

function finish(
  stage: Stage,
  status: 'passed' | 'failed',
  error?: Stage['error'],
): Stage {
  return {
    ...stage,
    status,
    finishedAt: timestamp(),
    ...(error === undefined ? {} : { error }),
  };
}

function conclude(
  startedAt: string,
  stages: Stages,
  events: TimelineEvent[],
  videoPath?: string,
): RunOutcome {
  const warnings: string[] = [];
  return {
    startedAt,
    finishedAt: timestamp(),
    status: deriveRunStatus(stages, warnings),
    stages,
    events,
    warnings,
    ...(videoPath === undefined ? {} : { videoPath }),
  };
}

function timestamp(): string {
  return new Date().toISOString();
}
