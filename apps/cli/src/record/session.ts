import type { StepInput, Viewport } from '@demoflow/core';
import type { Browser, ElementHandle, Page } from 'playwright';
import {
  CAPTURE_BINDING,
  CAPTURE_SCRIPT,
  type Candidates,
  type CaptureEvent,
  type CaptureMode,
  ELEMENT_TAKER,
  MODE_SETTER,
} from './capture-script.ts';
import { chooseLocator } from './locator.ts';
import {
  PANEL_BINDING,
  PANEL_HTML,
  type PanelCommand,
  type PanelState,
  panelState,
} from './panel.ts';
import {
  appendStep,
  moveStep,
  navigateStep,
  type RecordedStep,
  removeStep,
} from './steps.ts';

export const DEFAULT_SECRET_ENV = 'DEMO_PASSWORD';
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** A navigation or scroll this soon after a captured gesture is its effect, not a step. */
const CAUSED_WITHIN_MS = 1_500;
const PANEL_VIEWPORT = { width: 420, height: 720 };

export interface RecorderOptions {
  baseUrl: string;
  allowedOrigins: readonly string[];
  viewport: Viewport;
}

export interface RecordSession {
  /** The application's window. */
  app: Page;
  /** The step panel's window. */
  panel: Page;
  /** Resolves with the steps once the session stops, however it stops. */
  done: Promise<RecordedStep[]>;
  stop(): void;
}

/**
 * Opens the app on `baseUrl` and the step panel, each in a window of its own,
 * and turns what the person does into steps until the panel's stop, a closed
 * window or `stop()`.
 */
export async function openRecorder(
  browser: Browser,
  options: RecorderOptions,
): Promise<RecordSession> {
  const appContext = await browser.newContext({ viewport: options.viewport });
  const panelContext = await browser.newContext({ viewport: PANEL_VIEWPORT });
  const app = await appContext.newPage();
  const panel = await panelContext.newPage();

  let steps: RecordedStep[] = [];
  let mode: CaptureMode = 'record';
  let secretEnv = DEFAULT_SECRET_ENV;
  let notice: string | undefined;
  let lastGestureAt = 0;
  let stopped = false;
  // Events are handled one at a time, in the order they happened.
  let queue = Promise.resolve();
  const enqueue = (work: () => Promise<void>): void => {
    queue = queue.then(work).catch((error: unknown) => {
      notice = error instanceof Error ? error.message : String(error);
      render();
    });
  };

  let finish: (steps: RecordedStep[]) => void = () => {};
  const done = new Promise<RecordedStep[]>((resolve) => {
    finish = resolve;
  });
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    void queue.then(() => finish(steps));
  };

  function render(): void {
    const state = panelState(steps, mode, secretEnv, notice);
    void panel
      .evaluate(
        ([next]) =>
          (globalThis as unknown as { render(s: PanelState): void }).render(
            next,
          ),
        [state] as const,
      )
      .catch(() => {});
  }

  function push(step: StepInput, warning?: string): void {
    steps = appendStep(
      steps,
      warning === undefined ? { step } : { step, warning },
    );
    notice = undefined;
    render();
  }

  function setMode(next: CaptureMode): void {
    mode = next;
    void app
      .evaluate(`window.${MODE_SETTER}?.(${JSON.stringify(next)})`)
      .catch(() => {});
    render();
  }

  async function locate(element: ElementHandle | null, candidates: Candidates) {
    const chosen =
      element === null ? null : await chooseLocator(app, element, candidates);
    if (chosen === null) {
      notice = 'no locator reaches that element uniquely: no step recorded';
      render();
    }
    return chosen;
  }

  async function capture(
    event: CaptureEvent,
    element: ElementHandle | null,
    previousGestureAt: number,
  ): Promise<void> {
    switch (event.type) {
      case 'hello':
        return;
      case 'click': {
        const chosen = await locate(element, event.candidates);
        if (chosen)
          push({ action: 'click', target: chosen.locator }, chosen.warning);
        return;
      }
      case 'pick': {
        const picked = mode;
        setMode('record');
        const chosen = await locate(element, event.candidates);
        if (chosen === null) return;
        const target = chosen.locator;
        if (picked === 'hover')
          push({ action: 'hover', target }, chosen.warning);
        else if (picked === 'pick-text' && event.text !== '') {
          push(
            { action: 'assertText', target, text: event.text },
            chosen.warning,
          );
        } else push({ action: 'assertVisible', target }, chosen.warning);
        return;
      }
      case 'fill': {
        if (mode === 'secret-next') setMode('record');
        const chosen = await locate(element, event.candidates);
        if (chosen === null) return;
        const target = chosen.locator;
        push(
          event.secret
            ? { action: 'fill', target, valueFrom: { env: secretEnv } }
            : { action: 'fill', target, value: event.value ?? '' },
          chosen.warning,
        );
        return;
      }
      case 'select': {
        const chosen = await locate(element, event.candidates);
        if (chosen) {
          push(
            { action: 'select', target: chosen.locator, option: event.option },
            chosen.warning,
          );
        }
        return;
      }
      case 'scroll': {
        // The app scrolling itself after a click is not the person's scroll.
        if (Date.now() - previousGestureAt < CAUSED_WITHIN_MS) return;
        if (event.atBottom) return push({ action: 'scroll', to: 'bottom' });
        if (event.atTop) return push({ action: 'scroll', to: 'top' });
        if (event.candidates === undefined || element === null) return;
        const chosen = await chooseLocator(app, element, event.candidates);
        if (chosen)
          push({ action: 'scroll', target: chosen.locator }, chosen.warning);
      }
    }
  }

  await appContext.exposeBinding(
    CAPTURE_BINDING,
    async (source, event: CaptureEvent) => {
      if (event.type === 'hello') return mode;
      if (stopped || source.frame !== app.mainFrame()) return undefined;
      const previousGestureAt = lastGestureAt;
      lastGestureAt = Date.now();
      // Taken at once: the document may be gone by the time the queue gets here.
      const element =
        event.elementId === undefined
          ? null
          : await source.frame
              .evaluateHandle(`window.${ELEMENT_TAKER}(${event.elementId})`)
              .then((handle) => handle.asElement())
              .catch(() => null);
      enqueue(() => capture(event, element, previousGestureAt));
      return undefined;
    },
  );
  await appContext.addInitScript({ content: CAPTURE_SCRIPT });

  await panelContext.exposeBinding(
    PANEL_BINDING,
    (_source, command: PanelCommand) => {
      enqueue(async () => applyCommand(command));
    },
  );

  function applyCommand(command: PanelCommand): void {
    switch (command.type) {
      case 'mode':
        setMode(command.mode);
        return;
      case 'marker':
        if (command.title.trim() !== '') {
          push({
            action: 'marker',
            kind: command.kind,
            title: command.title.trim(),
          });
        }
        return;
      case 'wait':
        if (
          Number.isInteger(command.ms) &&
          command.ms >= 1 &&
          command.ms <= 5_000
        ) {
          push({ action: 'wait', ms: command.ms });
        } else {
          notice = 'a wait is 1 to 5000 ms';
          render();
        }
        return;
      case 'remove':
        steps = removeStep(steps, command.index);
        render();
        return;
      case 'move':
        steps = moveStep(steps, command.index, command.delta);
        render();
        return;
      case 'secretEnv':
        if (ENV_NAME.test(command.name)) secretEnv = command.name;
        else
          notice = `"${command.name}" is not an environment variable name (A-Z, 0-9, _)`;
        render();
        return;
      case 'stop':
        stop();
        return;
    }
  }

  app.on('framenavigated', (frame) => {
    if (frame !== app.mainFrame()) return;
    const at = Date.now();
    const url = frame.url();
    enqueue(async () => {
      // A click on a link navigates by itself: only typed URLs and the start are steps.
      if (at - lastGestureAt < CAUSED_WITHIN_MS) return;
      const step = navigateStep(url, options.baseUrl);
      if (step === null) return;
      const origin = new URL(url).origin;
      push(
        step,
        options.allowedOrigins.includes(origin)
          ? undefined
          : `${origin} is not in allowedOrigins: the run will refuse it`,
      );
    });
  });
  for (const page of [app, panel]) page.on('close', stop);
  browser.on('disconnected', stop);

  await panel.setContent(PANEL_HTML);
  render();
  await app.goto(options.baseUrl);
  return { app, panel, done, stop };
}
