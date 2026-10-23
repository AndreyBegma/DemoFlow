# A data-demoflow-mask element drawn unblurred on one frame

Issue: [#221](https://github.com/AndreyBegma/DemoFlow/issues/221)
Depends on: nothing

## Summary

The end-to-end test for #197 caught a marked element in clear in the masked
video, on `execution-plane (macos-latest)`:

- file: `packages/renderer/test/ffmpeg/masked-elements.spec.ts`
- test: "never shows a marked element unblurred: every frame that draws it
  differs from the unmasked render inside its box"
- `element 0, frame 74: drawn unblurred: expected 0 to be greater than 10`
- PR #215 (rerun), which does not touch the engine or the renderer.

The check only counts frames where the unmasked render shows the element's
text. A difference of 0 means the masked and unmasked frames are identical
inside the box: the element was drawn without blur. This is the same class as
#185 (a password shown on one frame), fixed in #190 by padding a measured mask
by three source frames.

## Decisions

1. **Diagnose first.** The root cause is not proven. Find and record, with
   evidence from the failing run and from a loop:
   - which edge leaked (the interval's start or its end) and for which interval
     of element 0;
   - why: the page-clock to source-time mapping of `maskedElements`, frame
     rounding, a sample the page script missed, or the #190 margin not being
     applied to `maskedElements` the way it is to masked fills.
2. **Fix the leak, not the test.** The mask must cover every frame that draws a
   marked element. The test stays as it is; no tolerance is loosened.
3. **Fail safe.** Where a choice remains, the mask starts earlier and ends later,
   never the other way round (ADR-0013).
4. **No quarantine.** Do not skip the test and do not retry it.

## Acceptance criteria

- The PR names the root cause and the evidence for it.
- `execution-plane (macos-latest)` passes the test in 10 consecutive runs. A
  loop of the single test inside one CI job (`.github/workflows/flake-221.yml`)
  is acceptable evidence; the loop is removed before the PR is ready.
- `ubuntu-latest` and `windows-latest` stay green.
- `bun run check`, `bun run test` and `bun run build` are green, and so is the
  execution-plane matrix.

## Open questions

None.
