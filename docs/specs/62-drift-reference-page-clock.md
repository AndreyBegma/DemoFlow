# Test — the clock-drift reference on the page clock

Issue: [#62](https://github.com/AndreyBegma/DemoFlow/issues/62) · bug · high ·
Builds on: [spec 48](48-sync-mark-reliability.md)

Depends on #40

## Summary

`develop` is red on slow runners since #48 (PR #58): the offset test in
`packages/renderer/test/plan/build.spec.ts` compares the renderer's measured
offset to a "drift" reference and finds gaps of 24–55 ms against a 20 ms bound
(runs 39136201772, 39137427988) [Confirmed]. The renderer is always the less
negative of the two. The reference timestamps the mark's clear when a Node
binding call (`exposeFunction` + MutationObserver) arrives — late on a loaded
runner, which pushes the reference offset negative. #48 put the renderer on
page-clock edges; the reference is still on Node-arrival time. The real
coverage check ("covers the password field on every frame", `render.spec.ts`)
stays green, so this is a test-reference defect, not a product one.

## Scope

### In scope

- The drift probe in `build.spec.ts` records the clear on the **page** clock in
  the MutationObserver callback, returns it through the binding, and maps page
  time to engine time with its own best-of-N round-trip exchange — independent
  code from the engine's mapping in `sync-mark.ts`.

### Out of scope

- The engine's and renderer's sync code (#48).
- Widening the 20 ms bound.

## Decisions

1. **Fix the reference, keep the bound.** — orchestrator (owner delegated).
2. **Independent implementation**: the test's mapping must not import or reuse
   the engine's mapping helper, so the two cannot share a bug. — orchestrator.

## Acceptance criteria

- [ ] The reference records the clear on the page clock and maps it with its
      own round-trip exchange; the PR explains why it is independent of the
      renderer's detection path.
- [ ] The offset test passes on all three OSes in five consecutive runs of the
      same commit with the 20 ms bound; the PR reports every run's gap.
- [ ] `bun run check` passes; Woodpecker green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i62 | the drift reference | packages/renderer/test/plan/build.spec.ts | #40 | yes | sonnet |

One slot. `sonnet`: the method is written here. #40 edits the same file.
