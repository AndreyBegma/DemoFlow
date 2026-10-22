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
 *
 * The start is the browser's send time, once the request has one: the
 * `request` event reaches Node late on a starved host, after the browser has
 * already shown the new document's blank page, and the renderer holds the
 * last frame before the start (#150).
 */
export class NavigationRecorder {
  private readonly clock: Clock;
  private readonly entries: Navigation[] = [];
  private loading: Request | undefined;
  /** The request that opened the last entry, until its send time is known. */
  private opening: Request | undefined;

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
        this.opening = request;
      }
      this.loading = request;
    });
    page.on('response', (response) => {
      this.settleStart(response.request());
    });
    page.on('requestfailed', (request) => {
      this.settleStart(request);
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

  /**
   * Moves the open entry's start back to the browser's send time of the
   * request that opened it — a redirect's first hop answers for its chain.
   * Never later than the event's arrival, so a coarse wall clock cannot push
   * the start past what Node saw.
   */
  private settleStart(request: Request): void {
    const opening = this.opening;
    if (
      opening === undefined ||
      (request !== opening && !isRedirectOf(request, opening))
    ) {
      return;
    }
    this.opening = undefined;
    // Epoch ms, -1 when the browser gave none.
    const sentAt = opening.timing().startTime;
    const entry = this.entries.at(-1);
    if (sentAt <= 0 || entry === undefined) return;
    // The system clock now, as the browser read it then (the browser is
    // always local): `performance.timeOrigin` is fixed at process start and
    // drifts from it.
    const sentMs = sentAt - (Date.now() - this.clock.now());
    const previousEndMs = this.entries.at(-2)?.endMs ?? 0;
    entry.startMs = Math.min(entry.startMs, Math.max(previousEndMs, sentMs));
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
