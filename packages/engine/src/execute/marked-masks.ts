import type { Box, MaskedElement, MaskInterval } from '@demoflow/core';
import type { BrowserContext, Frame, Page } from 'playwright';
import type { Clock } from './clock.ts';
import { withTimeout } from './mask-watch.ts';
import { type Shown, withShown } from './page-visibility.ts';
import { SYNC_EXCHANGES } from './sync-mark.ts';

/** The attribute an application puts on an element that must not appear in the video (ADR-0013 §2). */
export const MASK_ATTRIBUTE = 'data-demoflow-mask';

/** The binding the page reports through, in a namespace page code does not reach casually. */
const BINDING = 'demoflow.markedMasks';

/** The page global (a registered symbol) that holds the document's id. */
const DOCUMENT_KEY = 'demoflow.markedMasks';

/** At most this many marked elements per run; past it, the whole viewport (Decision 8). */
export const MAX_MARKED_ELEMENTS = 200;

/** At most this many intervals per element; past it, the whole viewport (Decision 8). */
export const MAX_ELEMENT_INTERVALS = 2_000;

/** A report that arrives this early in a step may be about the step before (Decision 6). */
const STEP_START_GRACE_MS = 50;

/** How long a clock exchange or a document-id read may take before it counts as failed. */
const READ_TIMEOUT_MS = 1_000;

/** A document-id read after a navigation is retried this many times before the document counts as gone. */
const DOCUMENT_READS = 3;

/** What the page reports about one element, in its own time. */
type PageReport =
  | { kind: 'shown'; id: number; atMs: number; box: Box }
  // The old box ends at `atMs`; the new one starts at `fromMs`, the frame before.
  | { kind: 'moved'; id: number; atMs: number; fromMs: number; box: Box }
  | { kind: 'gone'; id: number; atMs: number };

interface PageBatch {
  doc: string;
  reports: PageReport[];
}

/** Where an edge came from: a page time, and when and in which step its report reached the engine. */
type Edge =
  | {
      kind: 'page';
      doc: RunDocument;
      pageMs: number;
      step: number;
      arrivedMs: number;
    }
  // A navigation replaced the document during `step` (Decision 11).
  | { kind: 'stepEnd'; step: number; arrivedMs: number }
  // Past a cap: exactly this engine time.
  | { kind: 'engine'; atMs: number };

interface PendingInterval {
  start: Edge;
  end: Edge | undefined;
  box: Box;
}

interface Entry {
  intervals: PendingInterval[];
}

/** The page clock's shift onto the engine clock, by the bound that errs safe on each edge (Decision 6). */
interface Shift {
  startMs: number;
  endMs: number;
}

/** One document of the run's main frame, as it reported. */
interface RunDocument {
  id: string;
  /** `undefined` once settled without an exchange: the document's edges fall back to step boundaries. */
  shift: Promise<Shift | undefined>;
  /** Element id → its entry. */
  elements: Map<number, Entry>;
  /** The navigation that replaced it, once seen. */
  replaced: Edge | undefined;
}

interface Step {
  startMs: number;
  endMs: number | undefined;
}

/**
 * Elements the application marks with `data-demoflow-mask` (#197): when each
 * is on screen, and where, on the engine clock.
 *
 * A script on every document finds them from before the page's own scripts
 * and samples them frame by frame (`markedScript`); it reports each change
 * through a binding, so a document that navigates away loses nothing it has
 * already reported. Page times are mapped onto the engine clock with a clock
 * exchange per document, by the bound that errs early for a start and late
 * for an end: a late start or an early end shows the secret, the opposite only
 * blurs a little longer. A document whose exchange fails falls back to step
 * boundaries.
 */
export class MarkedMasks {
  private readonly viewport: { width: number; height: number };
  private readonly documents = new Map<string, RunDocument>();
  /** In the order the elements first appeared. */
  private readonly entries: Entry[] = [];
  private readonly steps: Step[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  /** The run's page and clock, once the page exists; a report before that is about no document of the run. */
  private run: { page: Page; clock: Clock } | undefined;
  /** Past a cap, nothing more is recorded: the whole viewport is masked to the end. */
  private capped = false;

  constructor(viewport: { width: number; height: number }) {
    this.viewport = viewport;
  }

  /** Before the context's first page: the binding, then the script on every document. */
  async install(context: BrowserContext): Promise<void> {
    await context.exposeBinding(
      BINDING,
      ({ page, frame }, batch: PageBatch) => {
        this.receive(page, frame, batch);
      },
    );
    await context.addInitScript(withShown(markedScript), {
      binding: BINDING,
      key: DOCUMENT_KEY,
      selector: `[${MASK_ATTRIBUTE}]`,
    });
  }

  /** The run's page, on the run's clock: only its main frame is masked (ADR-0013 §6). */
  attach(page: Page, clock: Clock): void {
    this.run = { page, clock };
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const step = this.currentStep();
      const arrivedMs = clock.now();
      this.track(
        this.settleNavigation(frame, { kind: 'stepEnd', step, arrivedMs }),
      );
    });
  }

  stepStarted(startMs: number): void {
    this.steps.push({ startMs, endMs: undefined });
  }

  stepEnded(endMs: number): void {
    const step = this.steps.at(-1);
    if (step !== undefined) step.endMs = endMs;
  }

  /**
   * Each marked element's intervals on the engine clock, once every report
   * and exchange that arrived has settled. An interval still open stays open:
   * the element was on screen when the run ended, or when it failed (#42).
   */
  async list(): Promise<MaskedElement[]> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
    const shifts = new Map<RunDocument, Shift | undefined>();
    for (const document of this.documents.values()) {
      shifts.set(document, await document.shift);
    }
    const elements: MaskedElement[] = [];
    for (const entry of this.entries) {
      const intervals = entry.intervals
        .map((interval): MaskInterval => {
          const startMs = Math.max(0, this.startOf(interval.start, shifts));
          if (interval.end === undefined) return { startMs, box: interval.box };
          const endMs = Math.max(startMs, this.endOf(interval.end, shifts));
          return { startMs, endMs, box: interval.box };
        })
        .sort((a, b) => a.startMs - b.startMs);
      if (intervals.length > 0) elements.push({ intervals });
    }
    return elements;
  }

  private receive(page: Page, frame: Frame, batch: PageBatch): void {
    const run = this.run;
    if (run === undefined || page !== run.page) return;
    if (frame.parentFrame() !== null || this.capped) return;
    const arrivedMs = run.clock.now();
    const step = this.currentStep();
    const document = this.documentOf(frame, batch.doc, run.clock);
    for (const report of batch.reports) {
      const at = (pageMs: number): Edge => ({
        kind: 'page',
        doc: document,
        pageMs,
        step,
        arrivedMs,
      });
      let entry = document.elements.get(report.id);
      const open = entry?.intervals.at(-1)?.end === undefined;
      if (report.kind === 'gone') {
        const last = entry?.intervals.at(-1);
        if (last !== undefined && last.end === undefined) {
          last.end = at(report.atMs);
        }
        continue;
      }
      if (entry === undefined) {
        if (this.entries.length >= MAX_MARKED_ELEMENTS) {
          this.cap(at(report.atMs));
          return;
        }
        entry = { intervals: [] };
        this.entries.push(entry);
        document.elements.set(report.id, entry);
      }
      if (entry.intervals.length >= MAX_ELEMENT_INTERVALS) {
        // The move that crossed the cap still ends the old box where it left.
        const last = entry.intervals.at(-1);
        if (
          report.kind === 'moved' &&
          last !== undefined &&
          last.end === undefined
        ) {
          last.end = at(report.atMs);
        }
        this.cap(at(report.kind === 'moved' ? report.fromMs : report.atMs));
        return;
      }
      const last = entry.intervals.at(-1);
      // A move ends the open box where the new one is first seen (Decision 7).
      if (last !== undefined && open) last.end = at(report.atMs);
      const startMs = report.kind === 'moved' ? report.fromMs : report.atMs;
      entry.intervals.push({
        start: at(startMs),
        // Shown again on a document already replaced: it left with it.
        end: document.replaced,
        box: report.box,
      });
    }
  }

  /** The document a batch came from; its clock exchange starts with its first batch. */
  private documentOf(frame: Frame, id: string, clock: Clock): RunDocument {
    const known = this.documents.get(id);
    if (known !== undefined) return known;
    const document: RunDocument = {
      id,
      shift: this.exchange(frame, id, clock),
      elements: new Map(),
      replaced: undefined,
    };
    this.track(document.shift);
    this.documents.set(id, document);
    return document;
  }

  /** One final entry: the whole viewport, from the report that crossed the cap, to the end. */
  private cap(start: Edge): void {
    this.capped = true;
    this.entries.push({
      intervals: [
        {
          start,
          end: undefined,
          box: { x: 0, y: 0, ...this.viewport },
        },
      ],
    });
  }

  /**
   * After a main-frame commit: every document other than the one now shown
   * has left, and its open intervals end with the step the commit came in.
   * A same-document change (`pushState`) keeps the document's id.
   */
  private async settleNavigation(frame: Frame, end: Edge): Promise<void> {
    let current: string | null | undefined;
    for (let i = 0; i < DOCUMENT_READS && current === undefined; i++) {
      try {
        current = await withTimeout(
          frame.evaluate(documentId, DOCUMENT_KEY),
          READ_TIMEOUT_MS,
        );
      } catch {
        // Between documents: read again.
      }
    }
    for (const document of this.documents.values()) {
      if (document.id === current || document.replaced !== undefined) continue;
      document.replaced = end;
      for (const entry of document.elements.values()) {
        const last = entry.intervals.at(-1);
        if (last !== undefined && last.end === undefined) last.end = end;
      }
    }
  }

  /** The document's clock shift, from `SYNC_EXCHANGES` round trips on that very document. */
  private async exchange(
    frame: Frame,
    doc: string,
    clock: Clock,
  ): Promise<Shift | undefined> {
    let startMs = Number.NEGATIVE_INFINITY;
    let endMs = Number.POSITIVE_INFINITY;
    for (let i = 0; i < SYNC_EXCHANGES; i++) {
      const sentMs = clock.now();
      let read: [string | null, number] | undefined;
      try {
        read = await withTimeout(
          frame.evaluate(documentClock, DOCUMENT_KEY),
          READ_TIMEOUT_MS,
        );
      } catch {
        return undefined;
      }
      const receivedMs = clock.now();
      // Another document answered: this one's clock is out of reach.
      if (read === undefined || read[0] !== doc) return undefined;
      const pageMs = read[1];
      startMs = Math.max(startMs, sentMs - pageMs);
      endMs = Math.min(endMs, receivedMs - pageMs);
    }
    return { startMs, endMs };
  }

  /** A start on the engine clock, by the bound that errs early. */
  private startOf(
    edge: Edge,
    shifts: Map<RunDocument, Shift | undefined>,
  ): number {
    if (edge.kind === 'engine') return edge.atMs;
    if (edge.kind === 'page') {
      const shift = shifts.get(edge.doc);
      if (shift !== undefined) return edge.pageMs + shift.startMs;
    }
    // The step the report came in, or the one before when it came at once.
    const step = this.steps[edge.step];
    if (step === undefined) return 0;
    const previous = this.steps[edge.step - 1];
    if (
      previous !== undefined &&
      edge.arrivedMs - step.startMs < STEP_START_GRACE_MS
    ) {
      return previous.startMs;
    }
    return step.startMs;
  }

  /** An end on the engine clock, by the bound that errs late. */
  private endOf(
    edge: Edge,
    shifts: Map<RunDocument, Shift | undefined>,
  ): number {
    if (edge.kind === 'engine') return edge.atMs;
    if (edge.kind === 'page') {
      const shift = shifts.get(edge.doc);
      if (shift !== undefined) return edge.pageMs + shift.endMs;
    }
    // The report came after the frame it names, and the step ended later still.
    return Math.max(
      edge.arrivedMs,
      this.steps[edge.step]?.endMs ?? edge.arrivedMs,
    );
  }

  /** The index of the step running now; −1 before the first. */
  private currentStep(): number {
    return this.steps.length - 1;
  }

  private track(promise: Promise<unknown>): void {
    const settled = promise.catch(() => undefined);
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
  }
}

/** Runs in the page: the document's id, or `null` before the script ran. */
function documentId(key: string): string | null {
  const slot = window as unknown as Record<symbol, { doc: string } | undefined>;
  return slot[Symbol.for(key)]?.doc ?? null;
}

/** Runs in the page: the document's id and its clock, read together. */
function documentClock(key: string): [string | null, number] {
  const slot = window as unknown as Record<symbol, { doc: string } | undefined>;
  return [slot[Symbol.for(key)]?.doc ?? null, performance.now()];
}

/**
 * Runs in every document, before its scripts (Decision 4): a mutation
 * observer stamps when a marked element or the attribute is added, and a
 * frame loop — running only while a marked element is in the document —
 * samples every one each frame.
 *
 * - A start is the frame the mutation that added the element or the
 *   attribute ran in, else the last frame sampled without it, else the
 *   document's start: never after the first frame that shows it. A frame's
 *   timestamp is when it began, so the mutation's own moment could be later
 *   than the frame that paints it.
 * - An end is the first frame sampled without it (#155): never before the
 *   last paint that shows it.
 * - A box that moves by more than 1 px ends the old box at this frame and
 *   starts the new one at the frame before (Decision 7).
 */
function markedScript(
  input: { binding: string; key: string; selector: string },
  shown: Shown,
): void {
  if (window !== window.top) return;
  const doc = `${performance.timeOrigin}-${Math.random().toString(36).slice(2)}`;
  Object.defineProperty(window, Symbol.for(input.key), { value: { doc } });
  type Report = PageReport;
  type Send = (batch: { doc: string; reports: Report[] }) => Promise<void>;
  const slot = window as unknown as Record<string, Send | undefined>;
  let send: Send | undefined;
  /** Reports not sent yet: kept until the binding is there, so none is lost. */
  const outbox: Report[] = [];

  const ids = new WeakMap<Element, number>();
  let nextId = 0;
  /** On screen at the last frame, with the box it had then. */
  const tracked = new Map<Element, { id: number; box: Box }>();
  /** Elements the observer saw marked since the last frame, with the earliest time. */
  const stamped = new Map<Element, number>();
  let lastFrameMs: number | undefined;
  let running = false;

  const boxOf = (element: Element): Box => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const moved = (a: Box, b: Box): boolean =>
    Math.abs(a.x - b.x) > 1 ||
    Math.abs(a.y - b.y) > 1 ||
    Math.abs(a.x + a.width - (b.x + b.width)) > 1 ||
    Math.abs(a.y + a.height - (b.y + b.height)) > 1;
  const stamp = (element: Element, atMs: number): void => {
    if (!stamped.has(element)) stamped.set(element, atMs);
  };

  const frame = (atMs: number): void => {
    const reports: Report[] = [];
    const marked = new Set<Element>();
    for (const element of document.querySelectorAll(input.selector)) {
      if (shown(element)) marked.add(element);
    }
    for (const [element, was] of tracked) {
      if (marked.has(element)) continue;
      tracked.delete(element);
      reports.push({ kind: 'gone', id: was.id, atMs });
    }
    for (const element of marked) {
      const box = boxOf(element);
      const was = tracked.get(element);
      if (was === undefined) {
        let id = ids.get(element);
        if (id === undefined) {
          id = nextId++;
          ids.set(element, id);
        }
        tracked.set(element, { id, box });
        const startMs = stamped.get(element) ?? lastFrameMs ?? 0;
        reports.push({ kind: 'shown', id, atMs: startMs, box });
      } else if (moved(was.box, box)) {
        was.box = box;
        const fromMs = lastFrameMs ?? 0;
        reports.push({ kind: 'moved', id: was.id, atMs, fromMs, box });
      }
    }
    stamped.clear();
    lastFrameMs = atMs;
    outbox.push(...reports);
    send ??= slot[input.binding];
    if (outbox.length > 0 && send !== undefined) {
      send({ doc, reports: outbox.splice(0) }).catch(() => undefined);
    }
    if (
      tracked.size > 0 ||
      outbox.length > 0 ||
      document.querySelector(input.selector) !== null
    ) {
      requestAnimationFrame(frame);
    } else {
      running = false;
    }
  };
  const wake = (): void => {
    if (running) return;
    running = true;
    requestAnimationFrame(frame);
  };

  new MutationObserver((records) => {
    // The frame the mutation ran in, not the moment: a frame's timestamp is when it began, which
    // can be before the script that added the element, and video frames are placed by it (#48).
    const now = document.timeline.currentTime;
    const atMs = typeof now === 'number' ? Math.min(now, performance.now()) : 0;
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target;
        if (
          record.attributeName === input.selector.slice(1, -1) &&
          target instanceof Element &&
          target.matches(input.selector)
        ) {
          stamp(target, atMs);
        }
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(input.selector)) stamp(node, atMs);
        for (const inner of node.querySelectorAll(input.selector)) {
          stamp(inner, atMs);
        }
      }
    }
    if (
      stamped.size > 0 ||
      tracked.size > 0 ||
      document.querySelector(input.selector) !== null
    ) {
      wake();
    }
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [input.selector.slice(1, -1), 'style', 'class', 'hidden'],
  });
  // Grab the binding before the page's scripts run, when it is already there.
  send = slot[input.binding];
}
