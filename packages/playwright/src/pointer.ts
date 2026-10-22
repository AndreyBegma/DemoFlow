// Where the pointer is (spec 209, Decision 1). Playwright does not say, so an
// init script keeps the last `mousemove` / `pointermove` client coordinates in
// the page, under a Symbol on `window` rather than a named global. Locator
// `hover` and `click` move the pointer, so after them the position is known.

/** The `Symbol.for` key the page state lives under. */
export const POINTER_KEY = 'demoflow.pointer';

/** What the init script keeps, and what the wheel's reads find there. */
export interface PointerState {
  x?: number;
  y?: number;
  /** The scroll container a wheel is watched in, between its two reads. */
  container?: Element;
}

/** The init script. Runs in the page: it may use nothing from this module. */
export function trackPointer(key: string): void {
  const state: PointerState = {};
  Object.defineProperty(window, Symbol.for(key), { value: state });
  const keep = (event: MouseEvent): void => {
    state.x = event.clientX;
    state.y = event.clientY;
  };
  const options = { capture: true, passive: true };
  window.addEventListener('mousemove', keep, options);
  window.addEventListener('pointermove', keep, options);
}
