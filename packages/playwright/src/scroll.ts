import type { Page } from '@playwright/test';
import { POINTER_KEY, type PointerState } from './pointer.ts';
import type { Recorder } from './recorder.ts';
import {
  type ContainerScroll,
  type Mapped,
  type ScrollPosition,
  scrollStep,
  type WheelPosition,
  wheelStep,
} from './steps.ts';

// A scroll is recorded from its effect, not from the code that caused it
// (ADR-0015 §5): `page.evaluate` reads the page's scroll position before and
// after; `page.mouse.wheel` also reads the container under the pointer.

/** The page's scroll position now. */
function readScroll(page: Page): Promise<ScrollPosition> {
  return page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    maxY: document.documentElement.scrollHeight - window.innerHeight,
  }));
}

/**
 * The page's scroll position once it stops moving: unchanged for two
 * animation frames, or after 1,000 ms. A wheel scroll is not finished when
 * `mouse.wheel` resolves.
 */
function settledScroll(page: Page): Promise<ScrollPosition> {
  return page.evaluate(async () => {
    const read = () => ({
      x: window.scrollX,
      y: window.scrollY,
      maxY: document.documentElement.scrollHeight - window.innerHeight,
    });
    const start = performance.now();
    let last = read();
    let still = 0;
    while (still < 2 && performance.now() - start < 1_000) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = read();
      if (now.x === last.x && now.y === last.y) {
        still += 1;
      } else {
        still = 0;
        last = now;
      }
    }
    return last;
  });
}

/**
 * The page's scroll position, and the scroll container under the pointer
 * (spec 209, Decision 2): the nearest ancestor-or-self of the element there
 * whose `overflow-y` scrolls and whose content overflows. `<html>` and
 * `<body>` are the page. The container is kept in the page for the second
 * read, so both read the same element.
 */
function readWheel(page: Page): Promise<WheelPosition<ContainerScroll>> {
  return page.evaluate((key) => {
    const state = (window as unknown as Record<symbol, PointerState>)[
      Symbol.for(key)
    ];
    const position = {
      x: window.scrollX,
      y: window.scrollY,
      maxY: document.documentElement.scrollHeight - window.innerHeight,
    };
    if (state === undefined) return { page: position, container: null };
    state.container = undefined;
    if (state.x === undefined || state.y === undefined) {
      return { page: position, container: null };
    }
    const isPage = (element: Element) =>
      element === document.documentElement || element === document.body;
    let element = document.elementFromPoint(state.x, state.y);
    while (element !== null && !isPage(element)) {
      const { overflowY } = getComputedStyle(element);
      const scrolls = overflowY === 'auto' || overflowY === 'scroll';
      if (scrolls && element.scrollHeight > element.clientHeight) break;
      element = element.parentElement;
    }
    if (element === null || isPage(element)) {
      return { page: position, container: null };
    }
    state.container = element;
    const testId = element.getAttribute('data-testid');
    const { id } = element;
    const within =
      testId !== null && testId !== ''
        ? { testId }
        : id !== '' && CSS.escape(id) === id
          ? { css: `#${id}` }
          : null;
    return {
      page: position,
      container: {
        top: element.scrollTop,
        maxTop: element.scrollHeight - element.clientHeight,
        within,
      },
    };
  }, POINTER_KEY);
}

/**
 * The page and the container once both stop moving: unchanged for two
 * animation frames, or after 1,000 ms (#208's rule, over both).
 */
function settledWheel(page: Page): Promise<WheelPosition> {
  return page.evaluate(async (key) => {
    const state = (window as unknown as Record<symbol, PointerState>)[
      Symbol.for(key)
    ];
    const container = state?.container;
    const read = () => ({
      page: {
        x: window.scrollX,
        y: window.scrollY,
        maxY: document.documentElement.scrollHeight - window.innerHeight,
      },
      container:
        container === undefined
          ? null
          : {
              top: container.scrollTop,
              maxTop: container.scrollHeight - container.clientHeight,
            },
    });
    const start = performance.now();
    let last = read();
    let still = 0;
    while (still < 2 && performance.now() - start < 1_000) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = read();
      if (
        now.page.x === last.page.x &&
        now.page.y === last.page.y &&
        now.container?.top === last.container?.top
      ) {
        still += 1;
      } else {
        still = 0;
        last = now;
      }
    }
    if (state !== undefined) state.container = undefined;
    return last;
  }, POINTER_KEY);
}

/** Records `mapped` from a scroll, or reports why it is left out. */
function recordScroll(
  recorder: Recorder,
  call: string,
  stack: string,
  mapped: Mapped | undefined,
  unmoved: string,
): void {
  if (mapped === undefined) {
    recorder.omit(call, stack, unmoved);
  } else if ('step' in mapped) {
    recorder.push(mapped.step);
  } else {
    recorder.omit(call, stack, mapped.reason);
  }
}

/** Runs a call and records the page scroll it caused, from its effect. */
export async function scrolling(
  recorder: Recorder,
  call: string,
  stack: string,
  run: () => unknown,
): Promise<unknown> {
  const before = await readScroll(recorder.page).catch(() => undefined);
  const result = await run();
  const after = await settledScroll(recorder.page).catch(() => undefined);
  if (before === undefined || after === undefined) {
    recorder.omit(call, stack, 'the page navigated or closed; no scroll read');
    return result;
  }
  recordScroll(
    recorder,
    call,
    stack,
    scrollStep(before, after),
    'it did not move the page',
  );
  return result;
}

/**
 * Runs `page.mouse.wheel` and records the scroll it caused, in the page or in
 * the container under the pointer (spec 209, Decisions 2–4).
 */
export async function wheeling(
  recorder: Recorder,
  stack: string,
  run: () => unknown,
): Promise<unknown> {
  const call = 'page.mouse.wheel';
  const before = await readWheel(recorder.page).catch(() => undefined);
  const result = await run();
  const after = await settledWheel(recorder.page).catch(() => undefined);
  if (before === undefined || after === undefined) {
    recorder.omit(call, stack, 'the page navigated or closed; no scroll read');
    return result;
  }
  recordScroll(
    recorder,
    call,
    stack,
    wheelStep(before, after),
    before.container === null
      ? 'it did not move the page'
      : 'it moved neither the page nor its scroll container',
  );
  return result;
}
