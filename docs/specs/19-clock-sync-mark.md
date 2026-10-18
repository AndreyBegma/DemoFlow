# Engine and renderer — a clock sync mark per run

Issue: [#19](https://github.com/AndreyBegma/DemoFlow/issues/19) · before Phase 4 ·
Decisions: [ADR-0004](../adr/0004-recording-is-separate-from-rendering.md) (accepted),
[spec 1](1-core-contracts.md) (optional timeline fields)

Depends on #18

## Summary

Timeline times are milliseconds from the engine clock's zero (page
creation, `packages/engine/src/execute/clock.ts`) [Confirmed]; the
Playwright video leads that clock by 0–3 frames, typically ~90–120 ms
(PR #16). The renderer guesses: `DEFAULT_OFFSET_MS = -100` and a 200 ms
`maskLeadMs` (`packages/renderer/src/plan/plan.ts`) [Confirmed]. This item
has the engine paint a sync mark at the start of every run and record when it
did, and has the renderer find the mark in the video, measure the offset for
that run, trim the mark out of the output, and shrink the mask padding to one
frame. Surfaced by the renderer spike (#4).

## Scope

### In scope

- `@demoflow/core`: an optional `syncMark` on `Timeline`.
- `@demoflow/engine`: paint the mark at clock zero, clear it before the
  first step, record both times.
- `@demoflow/renderer`: detect the mark, measure `offsetMs`, start the output
  after the mark, `maskLeadMs` of one frame when the offset is measured.

### Out of scope

- Any FFmpeg dependency in `@demoflow/engine` (Decisions 3).
- Drift over the length of a run — the offset is one constant per run, as
  today.
- Changing the default offset or padding for timelines without a mark.

## Decisions

1. **Flash and decode.** The mark is a full-frame solid colour painted on the
   blank page, detected by decoding the start of the video — the method of
   `packages/engine/test/capture/clock-drift.spec.ts` — rather than a CDP
   screencast timestamp (Chromium-only, no public Playwright API, a second
   screencast may disturb the recording). — the owner.
2. **The contract records the mark, not the offset**: an optional
   `syncMark: { colour, onMs, offMs }` on `Timeline` — `colour` a `#rrggbb`
   string, `onMs` / `offMs` engine-clock times at which the colour was
   painted and cleared (`offMs > onMs`). `schemaVersion` stays 1 (spec 1
   allows optional fields). — the owner (Decisions 3 follows).
3. **The renderer measures.** It already resolves FFmpeg (`resolveFfmpeg`,
   system build or the pinned `ffmpeg-static`); the engine gets no decoder
   and no new dependency. A run directory stays renderable on its own
   (ADR-0004). — the owner.
4. **The edge used is the clear.** The renderer finds the first frame after
   the mark in which the colour is gone, and sets
   `offsetMs = (that frame's video time) − offMs`. — orchestrator default,
   confirmed by the owner.
5. **No mark, no measurement, no failure.** A timeline without `syncMark`, or
   a video in which the mark is not found, renders with
   `DEFAULT_OFFSET_MS` and the 200 ms padding, as today; the engine never
   fails a run over the mark. — the owner.
6. **The mark is trimmed.** The rendered output starts at the first frame
   after the mark. The engine clears the mark before executing step 0, so
   it precedes every event. — the owner.
7. **Padding of one frame when measured.** With a measured offset,
   `maskLeadMs` is one source frame (40 ms at Playwright's 25 fps); without,
   200 ms. — the owner.
8. **The colour is `#ff00ff`, shown for at least 3 frames** (≥ 120 ms), so
   VP8 compression cannot hide it; detection compares the mean colour of a
   downscaled frame against it with a tolerance. The exact tolerance is the
   renderer slot's to choose and test. — orchestrator default, confirmed by
   the owner.

## Data / Schema

`packages/core/src/timeline.ts`, on `TimelineSchema`:

```ts
// Painted at clock zero, cleared before step 0; the renderer measures the
// video/clock offset from it (#19).
syncMark: z
  .strictObject({
    colour: z.string().regex(/^#[0-9a-f]{6}$/),
    onMs: msSchema,
    offMs: msSchema,
  })
  .refine((mark) => mark.offMs > mark.onMs, { path: ['offMs'] })
  .optional(),
```

and a refinement that `syncMark.offMs` is at or before the first event's
`startMs`.

## Acceptance criteria

- [ ] Every engine run that records a video writes `syncMark` with
      `offMs - onMs >= 120` and `offMs <=` the first event's `startMs`.
- [ ] `TimelineSchema` accepts a timeline without `syncMark` and rejects one
      with `offMs <= onMs`, a malformed colour, or `offMs` after the first
      event (core tests).
- [ ] On a real fixture run (`packages/renderer/test/plan/fixture-runs.ts`),
      the offset the renderer measures is within one frame (40 ms) of the
      offset the `clock-drift.spec.ts` method measures on the same run.
- [ ] No frame of the rendered output shows the mark colour (renderer test
      on a real run: the first output frame is after the mark).
- [ ] With a measured offset the plan uses `maskLeadMs = 40`; with no
      `syncMark`, or a mark not found in the video, it uses
      `DEFAULT_OFFSET_MS` and 200 ms (renderer tests).
- [ ] No dependency is added to `@demoflow/engine`.
- [ ] Core, engine and renderer tests pass under Node with Vitest, on
      Woodpecker and on all three OSes of the `execution-plane` workflow;
      `bun run check` passes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i19-engine | the contract field and the mark | packages/core/src/timeline.ts, packages/core/test/**, packages/engine/src/execute/**, packages/engine/src/capture/**, packages/engine/test/** | — | yes | sonnet |
| i19-renderer | detection, offset, trim, padding | packages/renderer/src/plan/**, packages/renderer/src/ffmpeg/**, packages/renderer/test/** | i19-engine | no | opus |

`i19-engine` executes Decisions 2, 6 and 8 as written. `i19-renderer` is
`opus`: it chooses the detection tolerance, places the trim in the plan, and a
wrong offset uncovers a masked field.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/core/src/timeline.ts | i19-engine | #18 (i18-engine) adds `maskVisibility` here — #19 starts after #18 merges |
| packages/renderer/src/plan/plan.ts | i19-renderer | #18 (i18-renderer) rewrites `maskSpans` here — serialize after it |
| packages/engine/src/execute/** | i19-engine | #18 adds visibility checks to the step loop — serialize after it |

## Risks

- **A wrong offset uncovers a secret** (high). With a 40 ms padding, an
  offset off by more than a frame shows a masked field early. Mitigation:
  the one-frame acceptance test against the independent drift method;
  any detection doubt falls back to Decisions 5's defaults.
- **The mark shows in the output** (medium). Mitigation: Decision 6's trim
  and its acceptance test.
- **Detection under compression or on a slow runner** (low). Mitigation:
  ≥ 3 frames of a saturated colour; mean-colour detection with a tolerance.
