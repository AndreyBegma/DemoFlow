import type { Box, Locator, MaskInterval, TimelineEvent } from '@demoflow/core';
import type { Page } from 'playwright';
import { resolveLocator } from './locator.ts';

/** Where a tracked field was after a step: its box, gone, or not known. */
type Sighting = Box | 'gone' | undefined;

interface TrackedField {
  locator: Locator;
  intervals: MaskInterval[];
}

/** What `look` saw; `record` turns it into interval edges once the step's times are known. */
export interface MaskSightings {
  navigated: boolean;
  fields: ReadonlyArray<{ field: TrackedField; sighting: Sighting }>;
}

/**
 * Records when each masked `fill`'s field is on the page (#18, Decisions
 * 2–4). After every later step the field's locator is checked: no visible
 * match, or a navigation of the main frame, means the field is gone. Out of
 * the viewport is not gone — the renderer follows page scrolls.
 *
 * Edges are conservative: a field found gone after a step ends its interval
 * at that step's `endMs`; a field found back starts a new one at the step's
 * `startMs`, with the box measured now. A navigation that leaves the same
 * field on screen does both, so the two intervals overlap for that step.
 */
export class MaskTracker {
  private readonly page: Page;
  private readonly fields: TrackedField[] = [];
  private navigated = false;

  constructor(page: Page) {
    this.page = page;
    // Same-document navigations (pushState) count too: the conservative reading.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.navigated = true;
    });
  }

  /**
   * Starts tracking a masked fill's field from the fill itself. The event's
   * `maskVisibility` is the tracker's own list: later steps extend it.
   */
  track(event: TimelineEvent, locator: Locator): void {
    const box = event.target?.box;
    // Without a box there is nothing to mask.
    if (event.masked !== true || box === undefined) return;
    const intervals: MaskInterval[] = [{ startMs: event.startMs, box }];
    event.maskVisibility = intervals;
    this.fields.push({ locator, intervals });
  }

  /**
   * Checks every tracked field. Called after each step, before its `endMs`
   * is stamped, so a field seen gone here is gone by that `endMs`.
   */
  async look(): Promise<MaskSightings> {
    const navigated = this.navigated;
    this.navigated = false;
    const fields = await Promise.all(
      this.fields.map(async (field) => ({
        field,
        sighting: await this.sight(field.locator),
      })),
    );
    return { navigated, fields };
  }

  record(sightings: MaskSightings, startMs: number, endMs: number): void {
    for (const { field, sighting } of sightings.fields) {
      const open = field.intervals.at(-1);
      const isOpen = open !== undefined && open.endMs === undefined;
      if (isOpen && (sightings.navigated || sighting === 'gone')) {
        open.endMs = endMs;
      }
      const isClosed = open === undefined || open.endMs !== undefined;
      if (isClosed && sighting !== undefined && sighting !== 'gone') {
        field.intervals.push({ startMs, box: sighting });
      }
    }
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
