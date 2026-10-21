import type { Box, Locator, MaskInterval, TimelineEvent } from '@demoflow/core';
import type { Page } from 'playwright';
import type { Clock } from './clock.ts';
import { resolveLocator } from './locator.ts';
import { MaskWatch } from './mask-watch.ts';

/** Where a tracked field was after a step: its box, gone, or not known. */
type Sighting = Box | 'gone' | undefined;

interface TrackedField {
  locator: Locator;
  intervals: MaskInterval[];
}

/** What `look` saw; `record` turns it into interval edges once the step's times are known. */
export interface MaskSightings {
  navigated: boolean;
  fields: ReadonlyArray<{
    field: TrackedField;
    sighting: Sighting;
    /** When the page saw the field leave the screen, on the engine clock (#155). */
    edgeMs: number | undefined;
  }>;
}

/**
 * Records when each masked `fill`'s field is on the page (#18, Decisions
 * 2–4). After every later step the field's locator is checked: no visible
 * match, or a navigation of the main frame, means the field is gone. Out of
 * the viewport is not gone — the renderer follows page scrolls.
 *
 * A field found gone ends its interval where the page saw it leave the
 * screen (#155, `MaskWatch`), never later than the step's `endMs`; when the
 * page cannot say, at that `endMs`. A field found back starts a new interval
 * at the step's `startMs`, with the box measured now. A navigation that
 * leaves the same field on screen does both, so the two intervals overlap for
 * that step.
 */
export class MaskTracker {
  private readonly page: Page;
  private readonly watch: MaskWatch;
  private readonly fields: TrackedField[] = [];
  private navigated = false;

  constructor(page: Page, clock: Clock) {
    this.page = page;
    this.watch = new MaskWatch(page, clock);
    // Same-document navigations (pushState) count too: the conservative reading.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.navigated = true;
    });
  }

  /**
   * Starts tracking a masked fill's field from the fill itself. The event's
   * `maskVisibility` is the tracker's own list: later steps extend it.
   */
  async track(event: TimelineEvent, locator: Locator): Promise<void> {
    const box = event.target?.box;
    // Without a box there is nothing to mask.
    if (event.masked !== true || box === undefined) return;
    const intervals: MaskInterval[] = [{ startMs: event.startMs, box }];
    event.maskVisibility = intervals;
    this.fields.push({ locator, intervals });
    await this.follow(this.fields.length - 1, locator);
  }

  /**
   * Checks every tracked field. Called after each step, before its `endMs`
   * is stamped, so a field seen gone here is gone by that `endMs`. The page's
   * edges are read first: a field that leaves between the two reads is left
   * to the step boundary.
   */
  async look(): Promise<MaskSightings> {
    const navigated = this.navigated;
    this.navigated = false;
    const edges = await this.watch.read();
    const fields = await Promise.all(
      this.fields.map(async (field, index) => {
        const sighting = await this.sight(field.locator);
        if (sighting !== undefined && sighting !== 'gone') {
          await this.follow(index, field.locator);
        }
        return { field, sighting, edgeMs: edges.get(index) };
      }),
    );
    return { navigated, fields };
  }

  record(sightings: MaskSightings, startMs: number, endMs: number): void {
    for (const { field, sighting, edgeMs } of sightings.fields) {
      const open = field.intervals.at(-1);
      const isOpen = open !== undefined && open.endMs === undefined;
      if (isOpen && (sightings.navigated || sighting === 'gone')) {
        open.endMs =
          sighting === 'gone' && edgeMs !== undefined
            ? Math.min(endMs, Math.max(open.startMs, edgeMs))
            : endMs;
      }
      const isClosed = open === undefined || open.endMs !== undefined;
      if (isClosed && sighting !== undefined && sighting !== 'gone') {
        field.intervals.push({ startMs, box: sighting });
      }
    }
  }

  /** Watches every element the field's locator shows now, so any of them still on screen keeps the mask. */
  private async follow(index: number, locator: Locator): Promise<void> {
    const elements = await resolveLocator(this.page, locator)
      .filter({ visible: true })
      .elementHandles()
      .catch(() => []);
    await this.watch.watch(index, elements);
  }

  /** Any visible match counts as the field: the conservative reading. */
  private async sight(locator: Locator): Promise<Sighting> {
    const visible = resolveLocator(this.page, locator)
      .filter({ visible: true })
      .first();
    let shown: boolean;
    try {
      shown = await visible.isVisible();
    } catch {
      // The page could not answer (it is closing, or mid-navigation): change nothing.
      return undefined;
    }
    if (!shown) return 'gone';
    // Seen a moment ago and gone before it could be measured: gone by now.
    const box = await visible.boundingBox({ timeout: 1_000 }).catch(() => null);
    return box ?? 'gone';
  }
}
