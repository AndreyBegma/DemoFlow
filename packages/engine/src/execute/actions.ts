import { setTimeout as sleep } from 'node:timers/promises';
import {
  type Box,
  type Locator,
  MASKED_VALUE,
  type Step,
  type TimelineEvent,
} from '@demoflow/core';
import type { Page, Locator as PlaywrightLocator } from 'playwright';
import { describeLocator, resolveLocator } from './locator.ts';
import type { EngineObserver } from './observer.ts';
import { boxCentre, moveSteps, type Point } from './pointer.ts';
import {
  navigateUrl,
  type OriginGuard,
  originNotAllowed,
} from './readiness.ts';

/** Spec 3: the recording shows typing, one character every 35 ms. */
export const TYPING_DELAY_MS = 35;

/** A scroll waits on animation frames; this bounds one wait if the page stops producing them. */
const SCROLL_FRAME_FALLBACK_MS = 100;
/** A target that moves while the pointer glides towards it is re-aimed at most this often. */
const MAX_REAIMS = 3;
/** How long after a click a navigation it caused may take to start. */
const NAVIGATION_START_MS = 100;

export type FailedStage = 'execution' | 'verification';

/** A step that did not succeed. `stage` says which stage it fails. */
export class StepFailure extends Error {
  readonly stage: FailedStage;
  readonly detail: Partial<TimelineEvent>;

  constructor(
    stage: FailedStage,
    message: string,
    detail: Partial<TimelineEvent> = {},
  ) {
    super(message);
    this.stage = stage;
    this.detail = detail;
  }
}

export interface StepContext {
  page: Page;
  stepIndex: number;
  baseUrl: string | undefined;
  guard: OriginGuard;
  /** The resolved `valueFrom.env` of this step, when it has one. */
  secret: string | undefined;
  /** Where the real pointer is; actions that move it update it. */
  pointer: Point;
  observers: readonly EngineObserver[];
}

/** The fields of a step's timeline event the action itself knows. */
export type ActionResult = Omit<
  TimelineEvent,
  'stepIndex' | 'action' | 'startMs' | 'endMs'
>;

export async function runAction(
  step: Step,
  ctx: StepContext,
): Promise<ActionResult> {
  switch (step.action) {
    case 'navigate': {
      const url = navigateUrl(step, ctx.baseUrl);
      if (url === undefined) {
        throw new StepFailure('execution', `missing-base-url ${step.path}`);
      }
      const origin = ctx.guard.check(url);
      if (origin !== undefined) {
        throw new StepFailure('execution', originNotAllowed(origin));
      }
      await ctx.page.goto(url, { timeout: step.timeoutMs });
      return {};
    }
    case 'waitFor': {
      const target = locate(ctx, step.target);
      await target.waitFor({ state: step.state, timeout: step.timeoutMs });
      return step.state === 'visible' ? withBox(await measure(target)) : {};
    }
    case 'click':
    case 'hover': {
      const target = locate(ctx, step.target);
      if (step.action === 'click') {
        await target.click({ trial: true, timeout: step.timeoutMs });
      } else {
        await target.hover({ trial: true, timeout: step.timeoutMs });
      }
      const { box, from, to } = await glide(ctx, target, step.target);
      if (step.action === 'click') {
        await ctx.page.mouse.down();
        await ctx.page.mouse.up();
        await navigationStart(ctx.page);
      }
      return { target: { box }, pointer: { from, to } };
    }
    case 'fill': {
      const target = locate(ctx, step.target);
      const masked = step.valueFrom !== undefined;
      const value = masked ? ctx.secret : step.value;
      if (value === undefined) {
        // Readiness resolves every `valueFrom` before the browser starts.
        throw new StepFailure(
          'execution',
          'fill has no value',
          masked ? { masked: true, value: MASKED_VALUE } : {},
        );
      }
      if (!masked) {
        await target.fill('', { timeout: step.timeoutMs });
        const box = await measure(target);
        await type(target, value, step.timeoutMs);
        return { ...withBox(box), value };
      }
      // #42: a failure part-way leaves typed characters on screen, so the
      // failed step's event is masked too, with whatever box was measured.
      let box: Box | null = null;
      try {
        await target.fill('', { timeout: step.timeoutMs });
        box = await measure(target);
        await type(target, value, step.timeoutMs);
      } catch (error) {
        box ??= await measure(target);
        throw maskedFailure(error, withBox(box));
      }
      return { ...withBox(box), masked: true, value: MASKED_VALUE };
    }
    case 'select': {
      const target = locate(ctx, step.target);
      await target.selectOption(step.option, { timeout: step.timeoutMs });
      return withBox(await measure(target));
    }
    case 'scroll':
      return scroll(ctx, step);
    case 'assertVisible': {
      const target = locate(ctx, step.target);
      try {
        await target.waitFor({ state: 'visible', timeout: step.timeoutMs });
      } catch {
        const message = `expected ${describeLocator(step.target)} to be visible`;
        throw new StepFailure('verification', message, {
          assertion: { passed: false, message },
        });
      }
      return { ...withBox(await measure(target)), assertion: { passed: true } };
    }
    case 'assertText':
      return assertText(ctx, step);
    case 'screenshot': {
      const png = await ctx.page.screenshot({ type: 'png' });
      let screenshot: string | undefined;
      for (const observer of ctx.observers) {
        const stored = await observer.onScreenshot?.({
          stepIndex: ctx.stepIndex,
          name: step.name,
          png,
        });
        screenshot ??= stored;
      }
      return screenshot === undefined ? {} : { screenshot };
    }
    case 'marker':
      return { marker: { title: step.title, kind: step.kind } };
    case 'wait':
      await sleep(step.ms);
      return {};
  }
}

function locate(ctx: StepContext, locator: Locator): PlaywrightLocator {
  return resolveLocator(ctx.page, locator);
}

async function measure(target: PlaywrightLocator): Promise<Box | null> {
  return target.boundingBox({ timeout: 1_000 }).catch(() => null);
}

function withBox(box: Box | null): Pick<ActionResult, 'target'> {
  return box === null ? {} : { target: { box } };
}

async function type(
  target: PlaywrightLocator,
  value: string,
  timeoutMs: number,
): Promise<void> {
  await target.pressSequentially(value, {
    delay: TYPING_DELAY_MS,
    timeout: timeoutMs + value.length * TYPING_DELAY_MS,
  });
}

/**
 * A masked fill's failure (#42, Decision 3). Playwright's call log prints the
 * resolved element with its attributes, which can hold the partial secret a
 * page mirrors into `value`; only the first line of the message is kept.
 */
function maskedFailure(
  error: unknown,
  target: Pick<ActionResult, 'target'>,
): StepFailure {
  const detail = { ...target, masked: true, value: MASKED_VALUE };
  if (error instanceof StepFailure) {
    return new StepFailure(error.stage, error.message, {
      ...error.detail,
      ...detail,
    });
  }
  const [firstLine = ''] = errorMessage(error).split('\n');
  return new StepFailure('execution', firstLine, detail);
}

/**
 * Moves the real mouse to the target's centre (ADR-0004 §2). The target can
 * still be settling — a dialog animating in — so it is measured again on
 * arrival, and the box returned is the one under the pointer at click time.
 */
async function glide(
  ctx: StepContext,
  target: PlaywrightLocator,
  locator: Locator,
): Promise<{ box: Box; from: Point; to: Point }> {
  const from = ctx.pointer;
  let box = await requireBox(target, locator);
  let to = boxCentre(box);
  await ctx.page.mouse.move(to.x, to.y, { steps: moveSteps(from, to) });
  ctx.pointer = to;
  for (let attempt = 0; attempt < MAX_REAIMS; attempt++) {
    const now = await requireBox(target, locator);
    const moved =
      Math.abs(now.x - box.x) > 0.5 ||
      Math.abs(now.y - box.y) > 0.5 ||
      Math.abs(now.width - box.width) > 0.5 ||
      Math.abs(now.height - box.height) > 0.5;
    box = now;
    if (!moved) break;
    const next = boxCentre(box);
    await ctx.page.mouse.move(next.x, next.y, {
      steps: moveSteps(to, next),
    });
    to = next;
    ctx.pointer = to;
  }
  return { box, from, to };
}

/**
 * A click that follows a link starts its navigation a moment after the mouse
 * is released. Waiting for it here lets the origin guard see it during the
 * click step, as Playwright's own `click` waits for navigations it schedules.
 */
async function navigationStart(page: Page): Promise<void> {
  await page
    .waitForEvent('request', {
      predicate: (request) =>
        request.isNavigationRequest() && request.frame() === page.mainFrame(),
      timeout: NAVIGATION_START_MS,
    })
    .catch(() => undefined);
}

async function requireBox(
  target: PlaywrightLocator,
  locator: Locator,
): Promise<Box> {
  const box = await measure(target);
  if (box === null) {
    throw new StepFailure(
      'execution',
      `${describeLocator(locator)} has no box to point at`,
    );
  }
  return box;
}

async function scroll(
  ctx: StepContext,
  step: Extract<Step, { action: 'scroll' }>,
): Promise<ActionResult> {
  const container =
    step.within === undefined ? undefined : locate(ctx, step.within);
  await container?.waitFor({ state: 'visible', timeout: step.timeoutMs });
  const target =
    step.target === undefined ? undefined : locate(ctx, step.target);
  await target?.waitFor({ state: 'attached', timeout: step.timeoutMs });
  const handles = await Promise.all([
    container?.elementHandle({ timeout: step.timeoutMs }) ?? null,
    target?.elementHandle({ timeout: step.timeoutMs }) ?? null,
  ]);
  try {
    const [scroller, element] = handles;
    const { before, after } = await ctx.page.evaluate(scrollAndSettle, {
      scroller,
      target: element,
      edge: step.to ?? null,
      timeoutMs: step.timeoutMs,
      fallbackMs: SCROLL_FRAME_FALLBACK_MS,
    });
    const containerBox =
      container === undefined ? null : await measure(container);
    return {
      scroll:
        containerBox === null
          ? { before, after }
          : { before, after, container: containerBox },
    };
  } finally {
    await Promise.all(handles.map((handle) => handle?.dispose()));
  }
}

interface ScrollRequest {
  /** The container to scroll; `null` scrolls the page. */
  scroller: Element | null;
  /** The element to bring to the centre; `null` scrolls to `edge`. */
  target: Element | null;
  edge: 'top' | 'bottom' | null;
  timeoutMs: number;
  fallbackMs: number;
}

/**
 * Runs in the page: starts a smooth scroll and waits for it to settle (#56,
 * spec Decision 2) — the offset unchanged across two consecutive animation
 * frames, and then: a scroller that moved has fired its `scrollend`, one that
 * did not sits at its destination. Stillness alone is not enough: a smooth
 * scroll can wait out several frames before its first step, and stall mid-way.
 * An end only counts while the scroller is still where it fired, so a late
 * `scrollend` from an earlier scroll cannot end this one.
 */
async function scrollAndSettle({
  scroller,
  target,
  edge,
  timeoutMs,
  fallbackMs,
}: ScrollRequest): Promise<{ before: Point; after: Point }> {
  const root = document.scrollingElement ?? document.documentElement;
  const read = (): Point =>
    scroller === null
      ? { x: window.scrollX, y: window.scrollY }
      : { x: scroller.scrollLeft, y: scroller.scrollTop };
  const before = read();
  const box = scroller ?? root;
  const maxX = box.scrollWidth - box.clientWidth;
  const maxY = box.scrollHeight - box.clientHeight;
  const clamp = (value: number, max: number): number =>
    Math.min(Math.max(value, 0), Math.max(max, 0));

  let destination: Point;
  if (target === null) {
    destination = { x: before.x, y: edge === 'top' ? 0 : maxY };
  } else {
    // Where `scrollIntoView({ block: 'center', inline: 'nearest' })` lands.
    const rect = target.getBoundingClientRect();
    const frame = scroller?.getBoundingClientRect();
    const left = frame === undefined ? 0 : frame.left + box.clientLeft;
    const top = frame === undefined ? 0 : frame.top + box.clientTop;
    const width = scroller === null ? window.innerWidth : box.clientWidth;
    const height = scroller === null ? window.innerHeight : box.clientHeight;
    let dx = 0;
    if (rect.left < left) dx = rect.left - left;
    else if (rect.right > left + width) dx = rect.right - (left + width);
    destination = {
      x: clamp(before.x + dx, maxX),
      y: clamp(before.y + rect.top - top + rect.height / 2 - height / 2, maxY),
    };
  }
  const reached = (at: Point): boolean =>
    Math.abs(at.x - destination.x) <= 1 && Math.abs(at.y - destination.y) <= 1;

  // Where the scroller was when it last fired `scrollend`.
  let endedAt: Point | undefined;
  const onScrollEnd = (): void => {
    endedAt = read();
  };
  const events = scroller ?? document;
  events.addEventListener('scrollend', onScrollEnd);
  if (target !== null) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    (scroller ?? window).scrollTo({ top: destination.y, behavior: 'smooth' });
  }

  // A page that stops producing frames still ends the wait at the deadline.
  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
      setTimeout(resolve, fallbackMs);
    });
  const deadline = performance.now() + timeoutMs;
  let last = read();
  while (performance.now() < deadline) {
    await nextFrame();
    const now = read();
    const still = now.x === last.x && now.y === last.y;
    const moved = now.x !== before.x || now.y !== before.y;
    // An end the scroller has moved on from was not this scroll's end.
    const ended = endedAt?.x === now.x && endedAt.y === now.y;
    last = now;
    if (still && (moved ? ended : reached(now))) break;
  }
  events.removeEventListener('scrollend', onScrollEnd);
  return { before, after: last };
}

async function assertText(
  ctx: StepContext,
  step: Extract<Step, { action: 'assertText' }>,
): Promise<ActionResult> {
  const target = locate(ctx, step.target);
  const deadline = Date.now() + step.timeoutMs;
  // Not finding the element is an execution failure; finding the wrong text is a verification one.
  await target.waitFor({ state: 'visible', timeout: step.timeoutMs });
  let actual = '';
  for (;;) {
    actual = normalise(await target.innerText({ timeout: step.timeoutMs }));
    if (textMatches(actual, step.text, step.match)) {
      return {
        ...withBox(await measure(target)),
        assertion: { passed: true },
      };
    }
    if (Date.now() >= deadline) break;
    await sleep(100);
  }
  const verb = step.match === 'exact' ? 'to be' : 'to contain';
  const message = `expected ${describeLocator(step.target)} ${verb} ${JSON.stringify(step.text)}, got ${JSON.stringify(actual)}`;
  throw new StepFailure('verification', message, {
    ...withBox(await measure(target)),
    assertion: { passed: false, message },
  });
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function textMatches(
  actual: string,
  expected: string,
  match: 'exact' | 'contains',
): boolean {
  const wanted = normalise(expected);
  return match === 'exact' ? actual === wanted : actual.includes(wanted);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
