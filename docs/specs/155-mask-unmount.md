# A masked field's box outlives the field when it unmounts on the same page

Issue: [#155](https://github.com/AndreyBegma/DemoFlow/issues/155) · bug ·
Follows [18](18-mask-visibility.md) and [146](146-mask-after-navigation.md)

## Summary

In a single-page app, a login form that is replaced in place, with no
navigation, leaves the password's mask box drawn for about half a second after
the field is gone. It shows in the fixture's login (`setSignedInAs` swaps the
form for "Welcome") and in the landing video (#153). Nothing leaks, because
the box covers too much. But every SPA login demo shows it.

#146 fixed the document-navigation case. This one belongs to the engine's
visibility record (#18).

## Root cause [Confirmed]

- **The engine checks visibility only at step boundaries.** `look()` runs
  once after each step (`packages/engine/src/run.ts`). `record()` closes an
  interval with `endMs = clock.now()` when the field is `'gone'`
  (`packages/engine/src/execute/mask.ts`). Nothing polls, observes mutations or
  listens for visibility.
- **So the click that submits ends the interval at the end of its own step.**
  That step includes the glide, the input and #117's navigation wait: about
  100 ms for a click that starts no navigation, more on a loaded machine. The
  form is gone at the input itself. The capture test pins the interval end
  to the click step's end (`packages/engine/test/capture/capture.spec.ts`).
- **The renderer then adds `maskTrailMs` (200 ms)** to every closed interval
  (`packages/renderer/src/plan/plan.ts`, `TIMING`).

## Scope

### In scope

- `packages/engine/**`: record when a tracked masked field actually becomes
  hidden or detached, not when the next step ends.
- Tests in the engine and a renderer plan or golden check against a recorded
  fixture timeline.

### Out of scope

- Renderer `TIMING` values. The 200 ms trail stays: it is the safety margin
  for clock error between the page and the video (#19, #48). The fix is to
  give it a precise edge to trail from.
- Navigations (#146).

## Decisions

1. **An interval ends when the field is hidden or detached in the page, by
   the page's own clock, mapped to the timeline with the clock the sync mark
   already provides.** (orchestrator)
   - The mechanism is the slot's to choose and to justify in the PR. For
     example: a `MutationObserver` or `IntersectionObserver` installed for
     the tracked element handle, recording the first frame on which it is
     detached or hidden, read when the step ends.
   - The step-boundary check stays as the fallback when the in-page edge is
     unavailable, for example because the page was replaced. A recorded end
     is never later than today's.
2. **Never earlier than the field leaves the screen.** (from #42: "too short
   a leak") The recorded edge is the moment of detaching or hiding, which
   comes before the next paint that shows the field gone. The 200 ms trail
   covers that paint and the clock error. The slot proves this on frames
   (below).
3. **Same contract.** (#18) `maskVisibility` keeps its schema. Only the
   `endMs` values become earlier. An interval that reopens when the field
   returns behaves as today.

## Acceptance criteria

- [ ] An engine test on the fixture login: the password interval's `endMs` is
      within 50 ms of the submit's input (mouse up), not at the click step's
      end. A loaded-runner variant passes 20 of 20 times, measured locally on
      3 busy cores.
- [ ] **A no-leak frame check**: render the fixture login. Every frame that
      shows the password field has its mask. The first frame without the
      field still has the box at most 300 ms later and never on a frame
      showing the field unmasked (frame comparison in a renderer real-run or
      plan test).
- [ ] A field hidden with `display: none`, then shown again on the same
      page, gives two intervals with precise edges (test).
- [ ] When the in-page edge is unavailable, the end falls back to today's
      step boundary (test).
- [ ] Existing `maskVisibility`, capture and mask tests pass. Golden images
      are unchanged, or change only where this box was visible, with
      before/after in the PR.
- [ ] `execution-plane` is green on all three OSes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i155 | the visibility edge | packages/engine/**, packages/renderer/test/** | — | yes | opus |

One slot. It is `opus` because the mechanism is not decided and it is a
secret-masking boundary.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/engine/** | i155 | do not open |
| packages/renderer/test/** | i155 (tests only) | do not open |

## Risks

- **An edge recorded too early leaks a frame of the secret** (critical).
  Mitigation: Decision 2, the frame-level no-leak check, and the trail kept.

## Open questions

- None. Default: when the in-page edge is uncertain, keep today's later end.
