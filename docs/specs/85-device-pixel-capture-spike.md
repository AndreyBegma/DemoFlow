# Spike — a 2× source: pipelined screenshots, or a large viewport with CSS zoom

Issue: [#85](https://github.com/AndreyBegma/DemoFlow/issues/85) · Phase 4, step 1 ·
Builds on: [spec 82](82-cdp-capture-spike.md) and its report
[82-cdp-capture-spike.md](../research/82-cdp-capture-spike.md) ·
Decisions: [ADR-0004](../adr/0004-recording-is-separate-from-rendering.md) §1

Depends on #82

## Summary

#47 showed `recordVideo` cannot upscale; #82 showed a CDP screencast is capped
at CSS pixels, and that sequential screenshots — at device pixels — reach only
7–20 fps on CI runners with gaps up to 316 ms. This time-boxed spike measures
the two remaining candidates against #82's Decision 1 criteria and ends the
question either way:

1. **Pipelined screenshots** — `Page.captureScreenshot` with a device-scale
   clip (a bare call is CSS-sized, report §"bare captureScreenshot"), with
   2–4 requests in flight; distinct frames only count.
2. **Large viewport + CSS zoom** — record with the ordinary `recordVideo` at a
   viewport of `2 × width` by `2 × height` and `deviceScaleFactor: 1`, with the
   page zoomed 200% (CSS `zoom` on the root, injected before any script), so
   the layout width stays the scenario's viewport while frames are
   2560×1440 at Playwright's own 25 fps.

If neither meets every criterion, the source stays 1× and a new ADR records
it, superseding ADR-0004 §1's "zoom has pixels to spend".

## Scope

### In scope

- Both prototypes behind the existing opt-in switch idea
  (`DEMOFLOW_CAPTURE=screenshots` / `zoomed`), engine-only, default unchanged.
- The #82 harness and opt-in `cdp-spike` CI job, extended to these modes.
- For candidate 2, a **layout-equivalence check**: for every fixture scenario,
  each step's target box (in CSS px, divided by the zoom) and the page's
  `scrollWidth` / `scrollHeight` match the 1× run within 1 px; media queries
  are probed explicitly (`matchMedia('(min-width: …)')` at the fixture's
  breakpoints) and must answer as at 1×.
- Report `docs/research/85-device-pixel-capture-spike.md`: numbers per OS,
  decision per criterion, and — when the answer is no — the new ADR's text in
  a separate docs pull request after this one merges.

### Out of scope

- Making any mode the default; renderer changes.

## Decisions

1. **Time box: one slot, at most two CI measurement rounds per candidate.** —
   owner ("ограниченно по времени").
2. **Criteria: #82 Decision 1 unchanged**, plus layout equivalence for
   candidate 2. The orchestrator decides. — owner (roadmap), orchestrator.
3. **Candidate 2 is the orchestrator's proposal**; its known risk is media
   queries seeing the doubled viewport, hence the explicit probe. —
   orchestrator.

## Acceptance criteria

- [ ] Both modes produce a `source.webm` at `viewport × 2` with page content in
      every quadrant (#73 layout check) on all three OSes, or the report shows
      exactly where a mode fails.
- [ ] The report gives, per OS and mode: effective fps, longest gap during
      steps, sharpness ratio at 1.6× zoom vs the 1× source, sync mark found +
      offset test result, CI time vs 1×, and (mode 2) layout equivalence — with
      run ids.
- [ ] The report ends with a decision against each criterion; if no mode
      passes, it says so and names the follow-up ADR.
- [ ] Without a switch, behaviour and all existing tests are unchanged.
- [ ] `bun run check` passes; Woodpecker and all three OSes green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i85 | both prototypes, harness extension, report | packages/engine/src/**, packages/engine/test/**, .github/workflows/execution-plane.yml, docs/research/85-device-pixel-capture-spike.md, docs/research/85-device-pixel-capture-spike/** | #82 | yes | opus |

One slot. `opus`: unproven capture paths.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| .github/workflows/execution-plane.yml | i85 (the opt-in job only) | #75 puts its smoke test in its own workflow |

## Risks

- **Candidate 2 changes layout** (high): breakpoints or `100vw` units may see
  the doubled viewport. Mitigation: the layout-equivalence check; a failure is
  a clean "no".
- **Time sink** (medium). Mitigation: Decision 1's time box.
