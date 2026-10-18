# Engine — container scroll settles before its offset is read (macOS flake)

Issue: [#56](https://github.com/AndreyBegma/DemoFlow/issues/56) · bug · medium

## Summary

On `execution-plane (macos-latest)` the engine intermittently records a
container scroll's `after` offset as 0: `packages/engine/test/execute/run.spec.ts`
("scrolls the page and a container, and records the offsets",
`panel.scroll.after.y > 0`) and `packages/engine/test/execute/mask.spec.ts`
("keeps the interval open while the field is scrolled out of the viewport").
Seen on PR runs 39128244773, 39129442951 and 39128276047, with and without
Vitest file serialization; passing on re-runs; never on Ubuntu or Windows
[Confirmed]. A wrong `after` offset is not only a test problem: the renderer
moves masks and the camera by it.

## Scope

### In scope

- Diagnose the cause on macOS headless Chromium (trace the wheel event, the
  pointer position over the container, and the offset over time).
- Fix the `scroll` action in `packages/engine/src/execute/actions.ts` so the
  recorded `after` offset is read once the scroll has settled (or the target
  is reached), on every OS.

### Out of scope

- Loosening the two tests.
- Page (non-container) scroll, unless the diagnosis shows the same cause.

## Decisions

1. **Fix the action, not the test.** — orchestrator (owner delegated).
2. **Settled means stable**: the offset is unchanged across two consecutive
   animation frames, bounded by the step's timeout. — orchestrator.

## Acceptance criteria

- [ ] The PR names the cause with evidence from a macOS run (a CI debug log of
      the wheel target and offsets over time).
- [ ] Both tests pass on `macos-latest` in five consecutive runs of the same
      commit; Ubuntu and Windows stay green.
- [ ] A test asserts the recorded `after` offset equals the container's final
      `scrollTop`/`scrollLeft` after the step.
- [ ] `bun run check` passes; Woodpecker green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i56 | the scroll action and its tests | packages/engine/src/execute/**, packages/engine/test/execute/** | — | yes | opus |

One slot. `opus`: the cause is unproven.
