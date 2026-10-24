# The crops follow up and down on a tall source

Issue: #<issue>
Depends on: #304.

## Summary

`followKeys` (`packages/renderer/src/plan/plan.ts`) gives the vertical
crop's horizontal centre; `verticalViewAt` (`frame.ts`) takes `x` from it
and `y` from the steps' camera (`cameraStateAt(plan.camera).centre.y`). The
camera only moves on a step with `zoom` (ADR-0012), so with no zoom the crop
sits at the page's vertical centre for the whole video. `cropSize` already
gives a full-width, shorter-than-the-page crop on a tall source (412×915 →
412×732 for 9:16, 412×412 for 1:1), so on a phone recording
(#305) — or any narrow `viewport` set today — the vertical and
square outputs show a fixed middle band of the page and miss what the steps
act on. This issue makes the follow camera follow on the vertical axis too,
only where it can move.

## Scope

### In scope

- `packages/renderer`: `FollowKey.y`, two-axis `followKeys`, and the crop's
  `y` from the follow keys on a tall source. Tests and one baseline.

### Out of scope

- The landscape output: it shows the whole page in the window; nothing to
  follow.
- Any change on a 16:9 (or any wide) source: Decision 2.
- New config. `render.vertical` and `render.square` keep their three fields;
  `deadZone` now applies per axis.
- Scrolling: the crop follows within the viewport; page scrolls are already
  in the recording.
- The website's docs pages (#308).

## Decisions

1. **Two-axis keys.** `FollowKey` becomes `{ atMs, x, y }`. `followKeys`
   takes the crop's width and height, starts at the viewport centre, and for
   each targeted event moves to the target's centre unless **both**
   `|Δx| < deadZone × cropWidth` and `|Δy| < deadZone × cropHeight`, each
   measured where the clamped crop would go. A move moves both axes together
   over `followMs`, eased, with the same start rule as today. `followAt`
   returns a point.
   - *Why both axes in one key:* one move per step, as today, keeps the
     camera calm; separate per-axis keys could start two moves at different
     times for one target.
   - *Why the same `deadZone` per axis:* it is already a share of the crop,
     so it scales with each side; a second field would be a knob nobody
     tunes.
2. **Vertical follow only on a tall source.** `y` comes from the follow keys
   when `cropSize(viewport, output).height < viewport.height` (the crop at
   zoom 1 is shorter than the page). Otherwise `y` comes from the steps'
   camera, as today.
   - *Why:* on a 16:9 source the crop at zoom 1 is full height and clamps
     anyway, but while a step zooms the camera's `y` and the follow keys'
     would differ in timing; keeping today's source of `y` there makes every
     existing render identical, which the baselines prove.
3. **Zoom composes.** The crop's size is `cropSize / zoom` on both axes, as
   today; its centre is the follow point, clamped to the page.
   - *Why:* a zoom step's target is the same element the follow camera moves
     to, so the zoomed crop is centred on it either way.
4. **Cursor stays unchased**, as spec 176 Decision 3: the camera moves to
   targets, never to the cursor.

## Acceptance criteria

- [ ] `followKeys` unit cases: both-axis skip rule, start at the viewport
      centre, a target with no box keeps the last point.
- [ ] Plan tests on 412×915: vertical (412×732) and square (412×412) crops
      follow top, middle and bottom targets, clamp at edges, and skip moves
      under the dead zone; `zoom` composes.
- [ ] Plan tests on 1920×1080: all existing vertical and square tests pass
      unchanged; `y` follows the steps' camera.
- [ ] Existing baselines unchanged; one new baseline: a vertical scene on a
      412×915 source with a target near the bottom.
- [ ] `bun run check`, `bun run test` and `bun run build` are green, and so
      is the execution-plane matrix.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `packages/renderer/src/plan/{plan,frame,types}.ts` | #306, after #304 | #307 edits the cursor part of `plan.ts`; different functions. Whichever merges second rebases. |

## Open questions

None.
