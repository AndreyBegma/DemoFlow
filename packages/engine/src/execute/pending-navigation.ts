import type {
  BrowserContext,
  Frame,
  Page,
  Request,
  Response,
} from 'playwright';

/** The page global (a registered symbol, invisible to the page's own code) the probe lives on. */
const PROBE_KEY = 'demoflow.pendingNavigation';

/** How long after a click or key press a navigation the probe cannot see may take to start. */
const NAVIGATION_START_MS = 100;

interface Probe {
  reset(): void;
  /** The destination of a document navigation that has not committed yet, if any. */
  pending(): Promise<string | null>;
}

/**
 * #117: records the top frame's Navigation API `navigate` events on every
 * document of the context. It only listens: no DOM, nothing visible.
 */
export async function installNavigationProbe(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(probe, PROBE_KEY);
}

/**
 * Runs a click's or key press's input, then waits for the document navigation
 * it started to commit (#117), so the next step sees the new document. A
 * navigation that never commits fails the step after `timeoutMs`; one that
 * ends without a document — a download, an aborted request, a 204 — leaves
 * the old page, as today. When the probe sees nothing, the request window
 * catches a navigation a timer starts just after the handlers.
 */
export async function withNavigation(
  page: Page,
  timeoutMs: number,
  input: () => Promise<void>,
): Promise<{ destination: string } | undefined> {
  // While a document navigation is pending, Playwright holds an evaluate until
  // the next document exists, so every read below races the step's cap.
  const cap = deadline(timeoutMs);
  await race(
    page.evaluate(callProbe, { key: PROBE_KEY, reset: true }),
    cap.promise,
  );
  const end = watchEnd(page);
  try {
    await input();
    // Runs after the page's input handlers, and after the submission task they queue (#143).
    const read = await race(
      page.evaluate(callProbe, { key: PROBE_KEY, reset: false }),
      end.settled,
      cap.promise,
    );
    if (end.committed()) return undefined;
    if (read === null) {
      await navigationStart(page);
      return undefined;
    }
    // A string is the pending destination; anything else means the read is held by one.
    const destination =
      typeof read === 'string' ? read : (end.requested() ?? page.url());
    const settled = await race(end.settled, cap.promise);
    return settled === TIMED_OUT ? { destination } : undefined;
  } finally {
    cap.clear();
    end.dispose();
  }
}

/**
 * Submits the form `selector` names and reads the probe in the same page
 * task, ahead of the task the submission queues: the gap a loaded renderer
 * leaves between a key press and its `navigate` event (#143). For tests.
 */
export async function pendingAfterSubmit(
  page: Page,
  selector: string,
): Promise<string | null> {
  return page.evaluate(
    async ({ key, selector }) => {
      document.querySelector<HTMLFormElement>(selector)?.requestSubmit();
      const api = (window as unknown as Record<symbol, Probe | undefined>)[
        Symbol.for(key)
      ];
      return (await api?.pending()) ?? null;
    },
    { key: PROBE_KEY, selector },
  );
}

const TIMED_OUT = Symbol('timed out');

interface Deadline {
  promise: Promise<typeof TIMED_OUT>;
  clear(): void;
}

function deadline(ms: number): Deadline {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

/** The first of the promises to settle; a rejection (a destroyed context) counts as `undefined`. */
async function race<T extends readonly Promise<unknown>[]>(
  ...promises: T
): Promise<Awaited<T[number]> | undefined> {
  return Promise.race(
    promises.map((promise) =>
      (promise as Promise<Awaited<T[number]>>).catch(() => undefined),
    ),
  );
}

/** The init script. Runs in the page, so it closes over nothing. */
function probe(key: string): void {
  if (window.top !== window || typeof navigation === 'undefined') return;
  let last: NavigateEvent | null = null;
  navigation.addEventListener('navigate', (event) => {
    last = event;
  });
  // Fires for same-document commits only — pushState, a hash, an intercepted navigation.
  navigation.addEventListener('currententrychange', () => {
    last = null;
  });
  const api: Probe = {
    reset() {
      last = null;
    },
    async pending() {
      // #143: a form submission navigates in a task it queues behind the key
      // or click event, so its `navigate` event can still be ahead of this
      // read. One task turn lets the queued submission run first.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const event = last;
      if (
        event === null ||
        event.hashChange ||
        event.downloadRequest !== null ||
        event.defaultPrevented
      ) {
        return null;
      }
      const url = event.destination.url;
      return location.href === url ? null : url;
    },
  };
  Object.defineProperty(window, Symbol.for(key), { value: api });
}

async function callProbe({
  key,
  reset,
}: {
  key: string;
  reset: boolean;
}): Promise<string | null> {
  const api = (window as unknown as Record<symbol, Probe | undefined>)[
    Symbol.for(key)
  ];
  if (reset) {
    api?.reset();
    return null;
  }
  return (await api?.pending()) ?? null;
}

interface End {
  /** Resolves when the main frame commits a navigation, or one ends without a document. */
  settled: Promise<void>;
  /** Whether the main frame committed a navigation since the watch began. */
  committed(): boolean;
  /** The URL of the last main-frame navigation request since the watch began. */
  requested(): string | undefined;
  dispose(): void;
}

function watchEnd(page: Page): End {
  let committed = false;
  let requested: string | undefined;
  let settle = (): void => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const finish = (commit: boolean): void => {
    committed ||= commit;
    settle();
  };
  const isMainNavigation = (request: Request): boolean =>
    request.isNavigationRequest() && request.frame() === page.mainFrame();
  const onRequest = (request: Request): void => {
    if (isMainNavigation(request)) requested = request.url();
  };
  const onFrame = (frame: Frame): void => {
    if (frame === page.mainFrame()) finish(true);
  };
  const onDownload = (): void => finish(false);
  const onFailed = (request: Request): void => {
    if (isMainNavigation(request)) finish(false);
  };
  const onResponse = (response: Response): void => {
    // No content: the browser keeps the current document.
    const status = response.status();
    if (
      (status === 204 || status === 205) &&
      isMainNavigation(response.request())
    ) {
      finish(false);
    }
  };
  page.on('request', onRequest);
  page.on('framenavigated', onFrame);
  page.on('download', onDownload);
  page.on('requestfailed', onFailed);
  page.on('response', onResponse);
  return {
    settled,
    committed: () => committed,
    requested: () => requested,
    dispose() {
      page.off('request', onRequest);
      page.off('framenavigated', onFrame);
      page.off('download', onDownload);
      page.off('requestfailed', onFailed);
      page.off('response', onResponse);
    },
  };
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
