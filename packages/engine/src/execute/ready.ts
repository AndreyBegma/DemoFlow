import { READY_NAME } from '@demoflow/core';
import { type BrowserContext, errors, type Page } from 'playwright';
import { StepFailure } from './actions.ts';
import { ANNOTATION_BINDING, MAX_ANNOTATION_LENGTH } from './annotations.ts';

/** The page global (a registered symbol, invisible to the page's own code) that holds the document's ready set. */
const READY_KEY = 'demoflow.ready';

/** How often the wait looks at the ready set: well inside the 100 ms the signal-to-step-end bound allows. */
const POLL_MS = 50;

/**
 * #198, ADR-0013 §3–5: defines `window.demoflow` on every document of the
 * context, before the page's own scripts. It is frozen and versioned; the
 * ready set lives on a registered symbol, not on the object. Nothing is sent
 * anywhere: the engine only reads the set through `waitForFunction`.
 */
export async function installReadySignal(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(readyScript, {
    key: READY_KEY,
    pattern: READY_NAME.source,
    binding: ANNOTATION_BINDING,
    maxLength: MAX_ANNOTATION_LENGTH,
  });
}

/**
 * Passes once `name` is in the current document's ready set — signalled before
 * or during the step. A navigation during the wait is waited through: the new
 * document must signal again. The timeout is an execution failure.
 */
export async function waitForReady(
  page: Page,
  name: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await page.waitForFunction(
      isReady,
      { key: READY_KEY, name },
      { polling: POLL_MS, timeout: timeoutMs },
    );
  } catch (error) {
    if (error instanceof errors.TimeoutError) {
      throw new StepFailure('execution', `ready-timeout ${name}`);
    }
    throw error;
  }
}

/** Runs in the page. */
function isReady(input: { key: string; name: string }): boolean {
  const names = (window as unknown as Record<symbol, Set<string> | undefined>)[
    Symbol.for(input.key)
  ];
  return names?.has(input.name) === true;
}

/** Runs in the page, before the page's own scripts. */
function readyScript(input: {
  key: string;
  pattern: string;
  binding: string;
  maxLength: number;
}): void {
  if (window !== window.top) return;
  const names = new Set<string>();
  Object.defineProperty(window, Symbol.for(input.key), { value: names });
  const format = new RegExp(input.pattern);
  // Grabbed before the page's scripts run, as the masks' script does: the
  // page cannot swap it out from under the methods.
  const send = (window as unknown as Record<string, unknown>)[input.binding];
  // Checked here and again in the engine (#201, Decision 2). An invalid call
  // is ignored, never reported, and the methods never throw.
  const annotate = (kind: 'scene' | 'caption', text: unknown): void => {
    try {
      if (typeof text !== 'string' || typeof send !== 'function') return;
      const trimmed = text.trim();
      if (trimmed.length === 0 || trimmed.length > input.maxLength) return;
      const sent: unknown = send(kind, trimmed);
      if (sent instanceof Promise) sent.catch(() => undefined);
    } catch {
      // Neither method throws.
    }
  };
  const api = Object.freeze({
    version: 1,
    scene(title: unknown): void {
      annotate('scene', title);
    },
    caption(text: unknown): void {
      annotate('caption', text);
    },
    // An invalid call is ignored, never reported: nothing tells the page why.
    ready(name: unknown): void {
      try {
        if (typeof name === 'string' && format.test(name)) names.add(name);
      } catch {
        // `ready` never throws.
      }
    },
  });
  // Writable and configurable: an application that assigns its own
  // `window.demoflow` is not broken; its signals are lost.
  Object.defineProperty(window, 'demoflow', {
    value: api,
    configurable: true,
    writable: true,
  });
}
