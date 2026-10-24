# No mouse cursor on a phone recording

Issue: #<issue>
Depends on: #305.

## Summary

`planRender` (`packages/renderer/src/plan/plan.ts`) fills `cursor` with
`cursorMoves(events, out)` and `clicks` with `clickRings(events, out)` for
every run. On a phone recording (#305) the arrow gliding between
targets says "desktop" in every frame. The click ring already reads as a
tap. This issue drops the arrow when the timeline says the run was a phone.

## Scope

### In scope

- `packages/renderer`: no cursor moves for `timeline.device === "phone"`.

### Out of scope

- A new tap visual (a finger dot, a press-and-hold ring): the existing click
  ring is the tap.
- Key badges, captions, zoom and masks: unchanged.
- A config switch to hide or show the cursor on any run.
- The engine and core (#305 owns `device`).

## Decisions

1. **No cursor on a phone.** With `timeline.device === "phone"`, `cursor` is
   `[]`. `clicks` is unchanged. Everything downstream already handles an
   empty `cursor` (the cursor is hidden before the first move).
   - *Why in the plan, not the compositor:* the plan is where the overlays
     are decided and tested without FFmpeg; the compositor already draws
     nothing for an empty list.
2. **Missing `device` is desktop.** Old timelines and `demoflow render` of an
   old run render exactly as before.
   - *Why:* re-rendering a past run must not change its look.
3. **No config.** A phone recording never shows an arrow; a desktop one
   always does, as today.
   - *Why:* nobody has asked for a cursor switch; adding one would be a new
     product decision.

## Acceptance criteria

- [ ] Plan test: a `device: "phone"` timeline gives `cursor: []` and the same
      `clicks` as the `"desktop"` one.
- [ ] Existing plan tests pass unchanged (no `device`).
- [ ] One new baseline: a phone frame at a click, ring and no arrow.
- [ ] `bun run check`, `bun run test` and `bun run build` are green, and so
      is the execution-plane matrix.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `packages/renderer/src/plan/plan.ts` | #307 (cursor only) | #304 and #306 edit the crop parts; whichever merges second rebases. |

## Open questions

None.
