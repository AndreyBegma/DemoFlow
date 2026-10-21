import type { Navigation } from '@demoflow/core';
import type { Page, Request } from 'playwright';
import type { Clock } from './clock.ts';

/**
 * Records the main frame's document navigations (#114): each one from its
 * request to the page's `load`, on the run's clock. A same-document change
 * (`pushState`, a hash) sends no request and is never recorded; a redirect is
 * the same navigation. A navigation that starts while one is still loading
 * extends it: one loading stretch, so the renderer holds one frame across it.
 * A navigation whose request fails ends there — the old page stays.
 */
export class NavigationRecorder {
  private readonly clock: Clock;
  private readonly entries: Navigation[] = [];
  private loading: Request | undefined;

  constructor(page: Page, clock: Clock) {
    this.clock = clock;
    page.on('request', (request) => {
      if (
        !request.isNavigationRequest() ||
        request.frame() !== page.mainFrame() ||
        request.redirectedFrom() !== null
      ) {
        return;
      }
      if (this.loading === undefined) {
        this.entries.push({ startMs: this.clock.now() });
      }
      this.loading = request;
    });
    page.on('requestfailed', (request) => {
      if (request === this.loading || isRedirectOf(request, this.loading)) {
        this.close();
      }
    });
    page.on('load', () => {
      this.close();
    });
  }

  /** The navigations so far; the last one has no `endMs` while it loads. */
  list(): Navigation[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  private close(): void {
    if (this.loading === undefined) return;
    this.loading = undefined;
    const open = this.entries.at(-1);
    if (open === undefined || open.endMs !== undefined) return;
    // Two events in one clock tick would leave nothing to hold.
    const endMs = this.clock.now();
    if (endMs > open.startMs) {
      open.endMs = endMs;
    } else {
      this.entries.pop();
    }
  }
}

/** Whether `request` is a later hop of the redirect chain that started at `first`. */
function isRedirectOf(request: Request, first: Request | undefined): boolean {
  let hop = request.redirectedFrom();
  while (hop !== null) {
    if (hop === first) return true;
    hop = hop.redirectedFrom();
  }
  return false;
}
