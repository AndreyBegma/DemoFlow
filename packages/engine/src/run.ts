import { mkdir } from 'node:fs/promises';
import {
  type Annotation,
  deriveRunStatus,
  type ExpandedStep,
  expandScenario,
  type MaskedElement,
  type Navigation,
  offCameraSteps,
  type Scenario,
  type Stage,
  type Stages,
  type StepOrigin,
  type TimelineEvent,
} from '@demoflow/core';
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  chromium,
  type Page,
} from 'playwright';
import {
  errorMessage,
  type FailedStage,
  runAction,
  StepFailure,
} from './execute/actions.ts';
import { Annotations } from './execute/annotations.ts';
import { type Clock, startClock } from './execute/clock.ts';
import { MarkedMasks } from './execute/marked-masks.ts';
import { MaskTracker } from './execute/mask.ts';
import { NavigationRecorder } from './execute/navigations.ts';
import type { EngineObserver, RunOutcome } from './execute/observer.ts';
import { installPageScripts } from './execute/page-scripts.ts';
import { type Point, viewportCentre } from './execute/pointer.ts';
import {
  checkReadiness,
  OriginGuard,
  originNotAllowed,
} from './execute/readiness.ts';
import { recordingOptions, toContextOptions } from './execute/recording.ts';
import { recordSyncMark, type SyncMark } from './execute/sync-mark.ts';

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
    const guard = new OriginGuard(options.allowedOrigins);
    // A `repeat` runs as its expanded steps (spec 165); `stepIndex` counts them,
    // the off-camera ones included (spec 171).
    const { steps } = expandScenario(scenario);
    const hidden = offCameraSteps(steps);
    const hasAssertions = steps.some((step) => ASSERTIONS.has(step.action));
    stages.execution = { status: 'running', startedAt: timestamp() };
    if (hasAssertions) {
      stages.verification = { status: 'running', startedAt: timestamp() };
    }
    const execute = (
      session: Session,
      range: { from: number; to: number },
      events: TimelineEvent[],
    ): Promise<Failure | undefined> =>
      executeSteps({
        steps,
        ...range,
        page: session.page,
        clock: session.clock,
        baseUrl,
        guard,
        secrets: readiness.secrets,
        pointer: viewportCentre(scenario.viewport),
        observers,
        events,
        navigation: session.navigation,
        masks: new MaskTracker(session.page, session.clock),
        marked: session.marked,
        annotations: session.annotations,
        scrub,
        emit,
      });

    // The opening off-camera steps run in a context of their own with no
    // video; the recorded one starts in its storage, on the page it ended on.
    let start: OffCameraEnd | undefined;
    if (hidden > 0) {
      const off = await openSession(browser, scenario, guard, {
        options: toContextOptions(recording, browser.version(), {
          video: false,
        }),
      });
      const offEvents: TimelineEvent[] = [];
      const failure = await execute(off, { from: 0, to: hidden }, offEvents);
      if (failure === undefined) {
        start = {
          storageState: await off.context.storageState(),
          url: off.page.url(),
        };
      }
      await off.context.close();
      if (failure !== undefined) {
        failStages(stages, failure);
        stages.recording = { status: 'skipped' };
        // The failed step is the run's only event: there is no video to time.
        const outcome = conclude(
          startedAt,
          stages,
          offEvents.filter((event) => event.stepIndex === failure.stepIndex),
        );
        await emit('onRunFinished', { outcome, video: null });
        return outcome;
      }
    }

    stages.recording = { status: 'running', startedAt: timestamp() };
    const session = await openSession(browser, scenario, guard, {
      options: {
        ...toContextOptions(recording, browser.version()),
        ...(start === undefined ? {} : { storageState: start.storageState }),
      },
    });
    const { context, page, clock, marked, annotations } = session;
    const navigations = new NavigationRecorder(page, clock);
    await emit('onPageCreated', { page, recording });
    let failure: Failure | undefined;
    if (start !== undefined && /^https?:/.test(start.url)) {
      failure = await reopen(page, start.url, hidden - 1, steps, scrub);
    }
    const syncMark = await recordSyncMark(page, clock);

    const events: TimelineEvent[] = [];
    failure ??= await execute(
      session,
      { from: hidden, to: steps.length },
      events,
    );
    // Before the context closes: a document's clock exchange may still be running on it.
    const maskedElements = await marked.list();

    if (failure === undefined) {
      stages.execution = finish(stages.execution, 'passed');
      stages.verification = hasAssertions
        ? finish(stages.verification, 'passed')
        : { status: 'skipped' };
    } else {
      failStages(stages, failure);
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

    const outcome = conclude(startedAt, stages, events, {
      videoPath,
      syncMark,
      navigations: navigations.list(),
      maskedElements,
      annotations: annotations.list(),
    });
    await emit('onRunFinished', { outcome, video });
    return outcome;
  } finally {
    await browser.close();
  }
}

/** A browser context and its page, with what watches and times it. */
interface Session {
  context: BrowserContext;
  page: Page;
  clock: Clock;
  marked: MarkedMasks;
  annotations: Annotations;
  navigation: NavigationWatch;
}

async function openSession(
  browser: Browser,
  scenario: Scenario,
  guard: OriginGuard,
  { options }: { options: BrowserContextOptions },
): Promise<Session> {
  const context = await browser.newContext(options);
  const marked = new MarkedMasks(scenario.viewport);
  const annotations = new Annotations();
  await installPageScripts(context, marked, annotations);
  const navigation = watchNavigation(context, guard);
  const page = await context.newPage();
  const clock = startClock();
  marked.attach(page, clock);
  annotations.attach(page, clock);
  return { context, page, clock, marked, annotations, navigation };
}

/** Where the off-camera steps left the browser (spec 171). */
interface OffCameraEnd {
  /** Cookies and localStorage; sessionStorage does not carry over. */
  storageState: Awaited<ReturnType<BrowserContext['storageState']>>;
  url: string;
}

/**
 * Opens the page the off-camera steps ended on, before the sync mark: the
 * video starts there. A failure is the last off-camera step's.
 */
async function reopen(
  page: Page,
  url: string,
  stepIndex: number,
  steps: readonly ExpandedStep[],
  scrub: (message: string) => string,
): Promise<Failure | undefined> {
  try {
    await page.goto(url, { waitUntil: 'load' });
    return undefined;
  } catch (error) {
    return {
      stage: 'execution',
      message: scrub(
        `cannot reopen ${url} after the off-camera steps: ${errorMessage(error)}`,
      ),
      stepIndex,
      origin: steps[stepIndex]?.origin,
    };
  }
}

function failStages(stages: Stages, failure: Failure): void {
  const other: FailedStage =
    failure.stage === 'execution' ? 'verification' : 'execution';
  stages[failure.stage] = finish(stages[failure.stage], 'failed', {
    message: failure.message,
    stepIndex: failure.stepIndex,
    ...(failure.origin === undefined ? {} : { origin: failure.origin }),
  });
  stages[other] = { ...stages[other], status: 'skipped' };
}

interface ExecuteInput {
  /** Every expanded step; the ones in `[from, to)` run. */
  steps: readonly ExpandedStep[];
  from: number;
  to: number;
  page: Page;
  clock: Clock;
  baseUrl: string | undefined;
  guard: OriginGuard;
  secrets: ReadonlyMap<number, string>;
  pointer: Point;
  observers: readonly EngineObserver[];
  events: TimelineEvent[];
  navigation: NavigationWatch;
  masks: MaskTracker;
  marked: MarkedMasks;
  annotations: Annotations;
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
  origin: StepOrigin | undefined;
}

/** Runs the steps in order and returns the first failure, if any. */
async function executeSteps(input: ExecuteInput): Promise<Failure | undefined> {
  const { clock, emit, scrub } = input;
  let pointer = input.pointer;
  for (let stepIndex = input.from; stepIndex < input.to; stepIndex++) {
    const step = input.steps[stepIndex];
    if (step === undefined) break;
    const startMs = clock.now();
    input.marked.stepStarted(startMs);
    input.annotations.stepStarted(startMs);
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

    // Before endMs is stamped, so a masked field seen gone is gone by then.
    const sightings = await input.masks.look();
    const endMs = Math.max(startMs, clock.now());
    input.masks.record(sightings, startMs, endMs);
    input.marked.stepEnded(endMs);

    const event: TimelineEvent = {
      stepIndex,
      ...(step.origin === undefined ? {} : { origin: step.origin }),
      action: step.action,
      startMs,
      endMs,
      ...result,
      ...(failure === undefined ? {} : failure.detail),
      ...(step.caption === undefined ? {} : { caption: step.caption }),
      ...('zoom' in step && step.zoom !== undefined ? { zoom: step.zoom } : {}),
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
    // A failed masked fill is tracked too (#42): its interval stays open to the end.
    if (step.action === 'fill') {
      await input.masks.track(event, step.target);
    }
    input.events.push(event);
    await emit('onStepFinished', { stepIndex, step, event });

    if (failure !== undefined) {
      return {
        stage: failure.stage,
        message: scrub(failure.message),
        stepIndex,
        origin: step.origin,
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
  recorded: {
    videoPath?: string | undefined;
    syncMark?: SyncMark | undefined;
    navigations?: Navigation[];
    maskedElements?: MaskedElement[];
    annotations?: Annotation[];
  } = {},
): RunOutcome {
  const { videoPath, syncMark, navigations, maskedElements, annotations } =
    recorded;
  const warnings: string[] = [];
  return {
    startedAt,
    finishedAt: timestamp(),
    status: deriveRunStatus(stages, warnings),
    stages,
    events,
    warnings,
    ...(syncMark === undefined ? {} : { syncMark }),
    ...(navigations === undefined ? {} : { navigations }),
    // Omitted when none was on screen: the timeline is then written as before #197.
    ...(maskedElements === undefined || maskedElements.length === 0
      ? {}
      : { maskedElements }),
    // Omitted when the page made no call: the timeline is then written as before #201.
    ...(annotations === undefined || annotations.length === 0
      ? {}
      : { annotations }),
    ...(videoPath === undefined ? {} : { videoPath }),
  };
}

function timestamp(): string {
  return new Date().toISOString();
}
