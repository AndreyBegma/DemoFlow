import type {
  RunStatus,
  Scenario,
  Stages,
  Step,
  TimelineEvent,
} from '@demoflow/core';
import type { Browser, Page, Video } from 'playwright';
import type { RecordingOptions } from './recording.ts';

export type Awaitable<T> = T | Promise<T>;

/** What `runScenario` reports. Capture persists it as `result.json`. */
export interface RunOutcome {
  startedAt: string;
  finishedAt: string;
  /** Derived from `stages`; `running` on success because rendering is pending. */
  status: RunStatus;
  /** `rendering` and `storage` are always `pending`: later stages own them. */
  stages: Stages;
  /** One per executed step, the failed one included. Secrets are already masked. */
  events: TimelineEvent[];
  warnings: string[];
  /** The absolute path of the raw recording, when the browser was started. */
  videoPath?: string;
}

export interface RunStartedEvent {
  scenario: Scenario;
  runDir: string;
  recording: RecordingOptions;
  startedAt: string;
}

export interface BrowserLaunchedEvent {
  browser: Browser;
}

/** The engine's clock starts here: event times are measured from this moment. */
export interface PageCreatedEvent {
  page: Page;
  recording: RecordingOptions;
}

export interface StepStartedEvent {
  stepIndex: number;
  step: Step;
  startMs: number;
}

export interface StepFinishedEvent {
  stepIndex: number;
  step: Step;
  event: TimelineEvent;
}

export interface ScreenshotEvent {
  stepIndex: number;
  name: string;
  png: Buffer;
}

export interface RunFinishedEvent {
  outcome: RunOutcome;
  /** `null` when the run stopped before the browser started. */
  video: Video | null;
}

/**
 * Watches a run. Every hook is optional and awaited, observers in order.
 * A hook that throws rejects `runScenario`; the browser is still closed.
 */
export interface EngineObserver {
  onRunStarted?(event: RunStartedEvent): Awaitable<void>;
  onBrowserLaunched?(event: BrowserLaunchedEvent): Awaitable<void>;
  onPageCreated?(event: PageCreatedEvent): Awaitable<void>;
  onStepStarted?(event: StepStartedEvent): Awaitable<void>;
  /** Also called for the step that failed. */
  onStepFinished?(event: StepFinishedEvent): Awaitable<void>;
  /**
   * Stores a `screenshot` step's image. Returns its path relative to the run
   * directory, which becomes the event's `screenshot`.
   */
  onScreenshot?(event: ScreenshotEvent): Awaitable<string | undefined>;
  /** After the context is closed and the video finalised, before the browser closes. */
  onRunFinished?(event: RunFinishedEvent): Awaitable<void>;
}
