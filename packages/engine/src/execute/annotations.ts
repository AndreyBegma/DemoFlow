import type { Annotation, MarkerKind } from '@demoflow/core';
import type { BrowserContext, Page } from 'playwright';
import type { Clock } from './clock.ts';

/** The binding the page delivers through, in the `demoflow.` namespace as #197's is (ADR-0014 §1). */
export const ANNOTATION_BINDING = 'demoflow.annotations';

/** The longest annotation text, after trimming: a step `caption`'s limit (spec 201, Decision 2). */
export const MAX_ANNOTATION_LENGTH = 120;

/** At most this many annotations per run, across all documents (spec 201, Decision 5). */
export const MAX_ANNOTATIONS = 100;

/**
 * The text of a valid call: a string that is non-empty after trimming and at
 * most 120 characters then. The page checks this and the engine checks it
 * again, since page code can reach the binding directly.
 */
export function annotationText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= MAX_ANNOTATION_LENGTH
    ? text
    : undefined;
}

/**
 * Scenes and captions the page set through `window.demoflow.scene()` and
 * `caption()` (#201, ADR-0014): each is recorded at the engine-clock time the
 * engine receives it. Only the trimmed text and the kind arrive; nothing
 * leaves the machine.
 */
export class Annotations {
  private readonly entries: Annotation[] = [];
  private run: { page: Page; clock: Clock } | undefined;
  /** Entries from before step 0 started wait here to be moved onto its `startMs`. */
  private beforeFirstStep: Annotation[] | undefined = [];

  /** Before the context's first page: the binding the page methods call. */
  async install(context: BrowserContext): Promise<void> {
    await context.exposeBinding(
      ANNOTATION_BINDING,
      ({ page, frame }, kind: unknown, text: unknown) => {
        const run = this.run;
        if (run === undefined || page !== run.page) return;
        // Main frame only (ADR-0013 §6).
        if (frame.parentFrame() !== null) return;
        if (kind !== 'scene' && kind !== 'caption') return;
        const title = annotationText(text);
        if (title === undefined || this.entries.length >= MAX_ANNOTATIONS) {
          return;
        }
        this.record(run.clock.now(), kind, title);
      },
    );
  }

  /** The run's page, on the run's clock. */
  attach(page: Page, clock: Clock): void {
    this.run = { page, clock };
  }

  /** A call received before step 0 starts is recorded at that step's start (Decision 6). */
  stepStarted(startMs: number): void {
    const early = this.beforeFirstStep;
    if (early === undefined) return;
    this.beforeFirstStep = undefined;
    for (const entry of early) entry.atMs = Math.max(entry.atMs, startMs);
  }

  /** The annotations in time order; empty when the page made none. */
  list(): Annotation[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  private record(atMs: number, kind: MarkerKind, title: string): void {
    const entry: Annotation = { atMs, kind, title };
    this.entries.push(entry);
    this.beforeFirstStep?.push(entry);
  }
}
