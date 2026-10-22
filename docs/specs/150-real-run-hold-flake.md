# Real-run hold test misses a held frame on loaded CI

Issue: [#150](https://github.com/AndreyBegma/DemoFlow/issues/150)
Depends on: nothing

## Summary

The test is `packages/renderer/test/ffmpeg/render.spec.ts`, "holds the page
before a document load until the next one is ready, never a blank page". It
fails intermittently:

- Woodpecker pipeline 347: `frame 21: expected 0.0227… to be less than 0.001`.
- GitHub `execution-plane (macos-latest)` on PR #175, 2026-10-22:
  `expected 0 to be greater than 0.01`.

Neither change touched the hold. It passes locally under load.

## Decisions

1. **Diagnose first.** The root cause is not proven, the same as #173. Find
   which input decides "held" for the asserted frames:
   - the recorded `navigations[i].startMs`;
   - the last source frame before it;
   - the new document's first frame.

   Then find which of them a starved runner shifts. Record the evidence in the
   PR body. A diagnostic loop in CI is allowed, and is removed before the PR.
2. **If the test is wrong:** assert on the frames the render plan marks as
   held, together with the source frames around them, not on fixed frame
   indices or fixed timing.
3. **If the renderer or the engine is wrong**, for example a late first frame
   of the new document lands inside the held window: fix the code and keep the
   test's intent.
4. **No quarantine** and no retries.

## Acceptance criteria

- The PR names the root cause and gives the evidence for it.
- The test passes in 10 consecutive runs on `execution-plane (macos-latest)`,
  which may be one looped job.
- `bun run check`, `bun run test` and `bun run build` are green, and so is
  the matrix.

## Contention

| Resource | Owner | Others |
|---|---|---|
| packages/renderer/test/ffmpeg/render.spec.ts | #150 | #176 adds its own spec file |

## Open questions

None.
