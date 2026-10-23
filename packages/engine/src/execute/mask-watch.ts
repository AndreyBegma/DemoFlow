import type { ElementHandle, Page } from 'playwright';
import type { Clock } from './clock.ts';
import { type Shown, withShown } from './page-visibility.ts';
import { SYNC_EXCHANGES } from './sync-mark.ts';

/** The page global (a registered symbol) the watch lives on, as the navigation probe does (#143). */
const WATCH_KEY = 'demoflow.maskWatch';

/** A read held by a pending document navigation (#143) gives up after this; the step boundary stands. */
const READ_TIMEOUT_MS = 1_000;

/**
 * Elements that could be a masked field: what `fill` accepts, without
 * `type=hidden`, which is never on screen. A watched element's own tag is
 * added per read, for a field a locator finds through another element.
 */
const CANDIDATES =
  'input:not([type=hidden]),textarea,select,[contenteditable]:not([contenteditable=false])';

/**
 * Where a masked field leaves the screen, by the page's own frames (#155).
 *
 * Every element a tracked field's locator matches while it is on screen is
 * watched in the page. A `requestAnimationFrame` loop samples each one per
 * frame with Playwright's visibility rule and stamps the first frame drawn
 * without it — the convention of the sync mark's `offMs` (#48), so both map
 * onto the video alike. A frame loop rather than a mutation observer: it also
 * sees a field hidden by CSS alone, and its time is a frame's, not a moment
 * before the paint. An intersection observer would count a field scrolled out
 * as gone, which it is not (#18).
 *
 * The watch is read when a step ends. It gives an edge only when every
 * watched element is off screen and nothing could have stood in for them:
 * another candidate element added or changed since the field was last on
 * screen, and not on screen now, may have matched the locator meanwhile, so
 * its edge is not trusted. Locator matches that change through text or ARIA
 * alone are not seen — a known blind spot; the step boundary covers every
 * case the watch cannot answer.
 */
export class MaskWatch {
  private readonly page: Page;
  private readonly clock: Clock;

  constructor(page: Page, clock: Clock) {
    this.page = page;
    this.clock = clock;
  }

  /** Replaces the elements watched for `field`; keeps the state of those already watched. */
  async watch(field: number, elements: ElementHandle[]): Promise<void> {
    try {
      if (elements.length > 0) {
        await this.page.evaluate(withShown(register), {
          key: WATCH_KEY,
          field,
          elements,
        });
      }
    } catch {
      // A page that cannot take the watch leaves the field to the step boundary.
    } finally {
      await Promise.all(elements.map((element) => element.dispose()));
    }
  }

  /**
   * Each field's edge on the engine clock, for the fields whose watched
   * elements are all off screen and whose edge is trusted. A field the page
   * gives nothing for keeps the step boundary.
   *
   * The page time is mapped with the sync mark's clock exchange (#19, #48),
   * but by the bound that errs late: the page read its clock somewhere in the
   * round-trip, so `receivedMs − pageMs` is never below the true shift. The
   * smallest of a few such exchanges is the tightest; a mapped edge is never
   * earlier than the frame it names. An early end leaks, a late one is safe.
   */
  async read(): Promise<Map<number, number>> {
    const edges = new Map<number, number>();
    let read: { nowMs: number; edges: Array<[number, number]> } | undefined;
    try {
      read = await withTimeout(
        this.page.evaluate(readEdges, {
          key: WATCH_KEY,
          candidates: CANDIDATES,
        }),
        READ_TIMEOUT_MS,
      );
    } catch {
      return edges;
    }
    const receivedMs = this.clock.now();
    if (read === undefined || read.edges.length === 0) return edges;
    let shiftMs = receivedMs - read.nowMs;
    for (let i = 1; i < SYNC_EXCHANGES; i++) {
      try {
        const pageMs = await withTimeout(
          this.page.evaluate(() => performance.now()),
          READ_TIMEOUT_MS,
        );
        if (pageMs !== undefined) {
          shiftMs = Math.min(shiftMs, this.clock.now() - pageMs);
        }
      } catch {
        break;
      }
    }
    for (const [field, pageMs] of read.edges) {
      edges.set(field, pageMs + shiftMs);
    }
    return edges;
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  // A late answer is dropped, and so is its failure.
  promise.catch(() => undefined);
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One watched element, as the frame loop last saw it. */
interface Watched {
  element: Element;
  shown: boolean;
  /** The last frame (or the registration) that saw it on screen. */
  shownMs: number;
  /** The first frame drawn without it since it was last seen; absent while it is shown. */
  hiddenMs: number | undefined;
}

interface Registry {
  fields: Map<number, Watched[]>;
  /** Nodes added or changed since the oldest field still on screen was last seen, with when. */
  touched: Map<Node, number>;
  running: boolean;
  shown(element: Element): boolean;
  frame(atMs: number): void;
}

/**
 * Runs in the page: creates the registry on first use — the frame loop and
 * the mutation record — and sets the watched elements of `field`.
 */
function register(
  input: {
    key: string;
    field: number;
    elements: Node[];
  },
  shown: Shown,
): void {
  const slot = window as unknown as Record<symbol, Registry | undefined>;
  let registry = slot[Symbol.for(input.key)];
  if (registry === undefined) {
    const created: Registry = {
      fields: new Map(),
      touched: new Map(),
      running: false,
      shown,
      frame(atMs) {
        if (created.fields.size === 0) {
          created.running = false;
          return;
        }
        for (const watched of created.fields.values()) {
          for (const entry of watched) {
            const shown = created.shown(entry.element);
            if (shown) {
              entry.shownMs = atMs;
              entry.hiddenMs = undefined;
            } else if (entry.shown) {
              entry.hiddenMs = atMs;
            }
            entry.shown = shown;
          }
        }
        requestAnimationFrame(created.frame);
      },
    };
    new MutationObserver((records) => {
      if (created.fields.size === 0) return;
      const atMs = performance.now();
      for (const record of records) {
        if (record.type === 'attributes') {
          created.touched.set(record.target, atMs);
          continue;
        }
        for (const node of record.addedNodes) {
          if (node instanceof Element) created.touched.set(node, atMs);
        }
      }
    }).observe(document, { subtree: true, childList: true, attributes: true });
    Object.defineProperty(window, Symbol.for(input.key), { value: created });
    registry = created;
  }
  const watch = registry;
  const nowMs = performance.now();
  const before = watch.fields.get(input.field) ?? [];
  watch.fields.set(
    input.field,
    input.elements.flatMap((element): Watched[] => {
      if (!(element instanceof Element)) return [];
      const kept = before.find((entry) => entry.element === element);
      const shown = watch.shown(element);
      if (kept !== undefined && kept.shown === shown) return [kept];
      return [{ element, shown, shownMs: nowMs, hiddenMs: undefined }];
    }),
  );
  if (!watch.running) {
    watch.running = true;
    requestAnimationFrame(watch.frame);
  }
}

/**
 * Runs in the page: each field's edge, in page time, when all its watched
 * elements are off screen and nothing could have stood in for them. A field
 * found off screen stops being watched: the next sighting registers it again.
 */
function readEdges(input: { key: string; candidates: string }): {
  nowMs: number;
  edges: Array<[number, number]>;
} {
  const nowMs = performance.now();
  const slot = window as unknown as Record<symbol, Registry | undefined>;
  const registry = slot[Symbol.for(input.key)];
  if (registry === undefined) return { nowMs, edges: [] };
  const edges: Array<[number, number]> = [];
  for (const [field, watched] of [...registry.fields]) {
    if (watched.some((entry) => registry.shown(entry.element))) continue;
    registry.fields.delete(field);
    if (watched.length === 0) continue;
    // Seen by the last frame and gone now: no frame without it has begun, so now is the earliest bound.
    const edge = Math.max(
      ...watched.map((entry) =>
        entry.shown ? nowMs : (entry.hiddenMs ?? nowMs),
      ),
    );
    const since = Math.min(...watched.map((entry) => entry.shownMs));
    const own = new Set<Element>(watched.map((entry) => entry.element));
    const selector = [
      input.candidates,
      ...new Set(watched.map((entry) => entry.element.localName)),
    ].join(',');
    let trusted = true;
    for (const [node, atMs] of registry.touched) {
      if (atMs < since || !(node instanceof Element)) continue;
      const found = [
        ...(node.matches(selector) ? [node] : []),
        ...node.querySelectorAll(selector),
      ];
      if (
        found.some((element) => !own.has(element) && !registry.shown(element))
      ) {
        trusted = false;
        break;
      }
    }
    if (trusted) edges.push([field, edge]);
  }
  // What no field still on screen could need again.
  let oldest = Number.POSITIVE_INFINITY;
  for (const watched of registry.fields.values()) {
    for (const entry of watched) oldest = Math.min(oldest, entry.shownMs);
  }
  for (const [node, atMs] of registry.touched) {
    if (atMs < oldest) registry.touched.delete(node);
  }
  return { nowMs, edges };
}
