# A masked field's box stays drawn on the next page after a navigation

Issue: [#146](https://github.com/AndreyBegma/DemoFlow/issues/146) · bug ·
Follows [114](114-transitions.md) (navigations in the timeline, held frames)
and [18](18-mask-visibility.md)

## Summary

A masked `fill` followed by a click that navigates leaves the field's mask
box on the new page until a later step ends the span. It is visible in the
landing video (PR #145, about 6.4–6.6 s): a grey box over the Welcome page
after sign-in. Nothing leaks, because the extra box covers too much, not too
little. But every demo with a login shows it.

The cause is in `maskSpans` (`packages/renderer/src/plan/plan.ts`)
[Confirmed]. Without `maskVisibility`, a span ends only at the next
`navigate` step, or when a scroll moves the box out of the viewport. With
`maskVisibility`, it ends at the measured interval's end. Its doc comment
says why: "the timeline cannot tell which click navigated, so covering too
long is safe, too short a leak". Since #114 the timeline records document
navigations (`timeline.navigations[]`, `{ startMs, endMs? }`) [Confirmed:
`packages/core/src/timeline.ts`], so the renderer can now tell.

## Scope

### In scope

- `packages/renderer/src/plan/**`: end a mask span at the first document
  navigation after the masked event. Plan tests and golden images for it.

### Out of scope

- Engine changes. The engine records what it records.
- Changing #114's held-frame rule: a held frame keeps the hold's masks.
- Re-recording the landing video (#137). The orchestrator does it after this
  merges, with `bun run landing:record`.

## Decisions

1. **The old document's masks end when the old document leaves the screen,
   and never earlier.** (orchestrator, from #42's principle "too short a
   leak")
   - **Transitions on**: the held frame shows the old page and uses the
     hold's own masks (#114), so the live-page span may end at the
     navigation's `startMs`. The hold covers it from there.
   - **Transitions off**: the old page stays on screen until the new
     document paints. The span ends at the navigation's `endMs`, plus the
     existing `trailMs`. An open navigation (no `endMs`) keeps today's
     behaviour.
   The slot confirms both cases against the frames, not only the plan.
2. **Only document navigations end a span.** (#114) A same-document route
   change (`pushState`) keeps today's behaviour, because the field may still
   be on screen.
3. **No timeline, no change.** (orchestrator) A timeline without
   `navigations` (recorded before #114) renders exactly as today.

## Acceptance criteria

- [ ] A plan test, with transitions on and with transitions off: a masked
      fill, then a click with a document navigation. No live-page mask box
      is drawn on a frame that shows the new document.
- [ ] A plan test: with transitions off, every frame that still shows the old
      document has the mask. The no-leak direction.
- [ ] The held frames' masks (#114 `held-frame-mask` golden) are
      byte-identical.
- [ ] A pushState route change after a masked fill keeps today's span (test).
- [ ] A timeline without `navigations` gives a plan deep-equal to today's.
- [ ] A new golden image of the first live frame after a login navigation
      shows no stray box. Existing baselines are unchanged, or changed only
      where this bug was visible, with before/after in the PR.
- [ ] `execution-plane` is green on all three OSes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i146 | mask span ends | packages/renderer/** | — | yes | opus |

One slot. It is `opus` because it is a secret-masking boundary: a wrong end
time leaks a password.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/renderer/** | i146 | do not open |

## Risks

- **Ending the span too early leaks a secret** (critical). Mitigation:
  Decision 1 ties the end to when the old document leaves the screen, a
  no-leak test with transitions off, and frame checks.

## Open questions

- None. Default: when in doubt, keep the mask longer.
