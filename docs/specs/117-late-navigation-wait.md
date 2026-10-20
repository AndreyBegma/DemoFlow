# A click or key press waits for the document navigation it starts

Issue: [#117](https://github.com/AndreyBegma/DemoFlow/issues/117) · bug ·
Specs: [114](114-transitions.md) (navigations in the timeline)

Depends on #114

## Summary

After a `click` or `press`, the engine waits at most `NAVIGATION_START_MS = 100`
ms for a main-frame navigation request, then ends the step [Confirmed:
`packages/engine/src/execute/actions.ts`, `navigationStart`]. On a loaded CI
runner a form submit starts its navigation later than that, so the step ends
on the old page. `press.spec.ts` › "waits for the navigation a submit starts,
as a click does" failed this way on ubuntu-latest (PR #116, run 39166469888,
`expected 'http://127.0.0.1:…/form' to contain '/results?q=nav'`). The fixed
window is a guess about timing. This item replaces it with a signal from the
page.

## Scope

### In scope

- **Detection through the Navigation API.** An init script on every page of the
  context records the main frame's `navigate` events (Chromium only; the engine
  launches `chromium` alone [Confirmed: `packages/engine/src/run.ts`]). A
  recorded event counts as a **pending document navigation** when it is not a
  hash change, not a download (`downloadRequest === null`), was not
  intercepted (`intercept()` never called), and `location.href` still differs
  from `destination.url` when the engine checks it. A same-document
  `pushState`/`replaceState` has already changed `location.href` when it is
  checked, so it is never pending.
- **The wait.** After the mouse is released (`click`) or the key is pressed
  (`press`, with or without a target), the engine reads the page's record with
  one `evaluate`. That call runs after the page's own input handlers finish, so
  a slow submit handler has run by then. If a document navigation is pending,
  the step waits until it **commits**, meaning `page.url()` is the new
  document's URL (the main frame's `framenavigated` for a new document, or the
  navigation request's response committing).
- **The cap.** That wait is bounded by the step's `timeoutMs`. Past it the step
  fails in stage `execution` with a message naming the destination URL.
- **Fallback.** The existing 100 ms window for a navigation request stays for
  the case the record cannot see (a navigation deferred with `setTimeout` past
  the input handlers). It is never the only thing a pending navigation waits on.
- The record is reset before each `click` / `press`, so an earlier step's event
  never makes a later step wait.
- Tests in `packages/engine/test/**` against the engine's own test server.

### Out of scope

- Waiting for `load`: the time between commit and `load` is covered by the
  held frames of #114.
- Navigations started by `navigate` steps (`page.goto` already waits).
- Other browsers, and navigations of child frames.

## Decisions

1. **The Navigation API `navigate` event is the signal**, not a longer fixed
   window and not hand-rolled tracking of `submit` and link clicks. (owner,
   2026-10-20) A fixed window adds a wait to every step that does not navigate
   and can still be too short. Hand-rolled tracking misses `location.assign`
   and JS redirects.
2. **The step waits until commit**, not until the request starts and not until
   `load`. (owner, 2026-10-20) The next step and any assertion then see the new
   document deterministically, and load time is already handled by #114.
3. **The cap is the step's `timeoutMs`**, and running past it is a step failure.
   (owner, 2026-10-20) This is the same limit every other wait in a step uses.
4. **Same-document navigations, hash changes, downloads and intercepted
   navigations are not waited on.** (orchestrator) None of them replaces the
   document.
5. **Depends on #114.** (orchestrator) #114 is changing `packages/engine/src/**`
   (navigation recording in `execute/` and `run.ts`) right now, and both items
   reason about main-frame navigations. This one is cut after #114 merges, so it
   builds on that recorder instead of beside it.

## Acceptance criteria

- [ ] A form whose submit handler busy-waits 300 ms on the main thread before
      submitting: after the `press Enter` step, `page.url()` contains the
      results path (engine test, three OSes).
- [ ] The same for a `click` on a link whose click handler busy-waits 300 ms
      before following it (engine test, three OSes).
- [ ] A `click` that triggers a client-side `pushState` route change, and a
      `click` that changes nothing, end no later than they do today: no extra
      wait beyond the existing 100 ms window (engine timing test, generous
      bound, or timeline comparison).
- [ ] A pending navigation that never commits fails the step in stage
      `execution` within its `timeoutMs`, naming the destination.
- [ ] The existing `press.spec.ts` and click navigation tests pass unchanged.
- [ ] `bun run check` passes; `execution-plane` is green on all three OSes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i117 | the navigation wait | packages/engine/src/execute/**, packages/engine/src/run.ts, packages/engine/test/** | #114 | yes | opus |

One slot. `opus`: the exact commit signal and how the record behaves around
redirects and bfcache still have to be worked out in Chromium, and the root
cause (a late request start vs. a late commit) is not yet proven on the runner.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/engine/src/execute/actions.ts | i117 | do not open it |

## Risks

- **A step waits on a navigation that never happens** (medium): for example
  an event the page later cancels. Mitigation: the cap is the step's
  `timeoutMs` and the failure names the URL. A test covers a navigation that
  never commits.
- **The init script runs on the recorded page** (low): it adds no DOM and no
  visible effect, and it only listens.
- **A navigation deferred past the input handlers** (low) is still covered
  only by the 100 ms window, as today.

## Open questions

- None. Default for anything the slot finds unclear: keep today's behaviour for
  steps that do not navigate.
