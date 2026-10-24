# Record a scenario as a phone

Issue: #<issue>
Depends on: nothing.

## Summary

Specs 176 and 236 put "recording in a mobile viewport" out of scope; the
vertical and square outputs crop a desktop page. `ScenarioSchema.viewport`
(`packages/core/src/scenario.ts`) already takes any size, so a narrow
viewport can be recorded today. What is missing is the phone itself:
`toContextOptions` (`packages/engine/src/execute/recording.ts`) sets only
`viewport`, `deviceScaleFactor: 2` and `recordVideo`. Without `isMobile`
Chromium ignores `<meta name="viewport">`, without `hasTouch` the page sees
a fine pointer and no touch events, and the user agent says desktop. This
issue adds a scenario-level device with those three options.

## Scope

### In scope

- `packages/core`: `device` on the scenario, its default viewport, and
  `device` on the timeline. JSON schema regenerated.
- `packages/engine`: the context options for a phone, and writing `device`
  into `timeline.json`.
- A fixture scenario recorded as a phone, used by the real-run test.

### Out of scope

- The renderer: a phone run renders with today's rules. The cursor arrow is
  #307; the crops following on the vertical axis are
  #306.
- A `tap` step, swipe or pinch gestures. `click` stays Playwright's `click`.
- More presets (tablet, specific models), landscape phones, a custom user
  agent field, user-agent client hints (`Sec-CH-UA-*`).
- `demoflow record --device` and Playwright-test import (ADR-0015).
- The website's docs pages (#308).

## Decisions

1. **Scenario-level `device`.** `device: z.enum(DEVICES).default('desktop')`
   with `DEVICES = ['desktop', 'phone'] as const`, beside `viewport`.
   - *Why:* the device is a property of the recording, like `viewport`,
     which is scenario-level; one project often has desktop and phone demos
     side by side. A config-level switch would force one or the other per
     project.
   - *Why an enum and not raw Playwright options (`isMobile`, `hasTouch`,
     `userAgent`):* one valid combination instead of eight, no Playwright
     vocabulary in `packages/core` (ADR-0001: zod only), and room for a
     `tablet` later without a breaking change.
2. **Default viewport follows the device.** `viewport` becomes optional in
   the input. A transform fills it: 412×914 for `"phone"`, 1920×1080 for
   `"desktop"`. The parsed `Scenario` always has `viewport`. An explicit
   `viewport` always wins, including a wide one on a phone.
   - *Why 412×914:* the CSS size of Playwright's `Pixel 7` descriptor (412×915),
     which matches the Android user agent of Decision 3, minus one row:
     Playwright floors the video to even dimensions, so an odd height would
     leave the video one row shorter than `timeline.viewport`. It is also wider than the
     common 390×844, so the 1× source (ADR-0010) is upscaled a little less in
     the 1080-wide outputs.
   - *Why not reject a wide phone viewport:* nothing breaks, and it is the
     author's explicit choice; validation stays a type check.
3. **Context options for `"phone"`.** `isMobile: true`, `hasTouch: true`,
   `userAgent: Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36
   (KHTML, like Gecko) Chrome/<browser.version()> Mobile Safari/537.36`.
   `"desktop"` sets none of them, exactly as today.
   - *Why build the user agent from `browser.version()`:* a pinned string
     goes stale with every Playwright bump; the real version keeps feature
     detection on the server honest.
   - The engine passes the version into `toContextOptions` (it already has
     the launched `browser` in `run.ts`), so the function stays pure and unit
     tested.
4. **`deviceScaleFactor` stays 2 for every device.** The video is recorded at
   the viewport size, 412×914 for the default phone (ADR-0010 §1–2).
   - *Why:* ADR-0010 found no way to record device pixels; a phone's real
     factor (2.6–3) would change only `screenshot` steps and the
     `deviceScaleFactor` the renderer reads, not the video. One constant is
     simpler and keeps the renderer's 1× zoom rule (1.25×).
   - Consequence, documented by #308: a phone source is
     upscaled about 2.6× in the 1080-wide vertical and square outputs, so it
     is softer than a desktop crop (ADR-0010 Consequences already says the
     9:16 crop is soft). The landscape output fits the 914 px tall page into
     the window at about 1.1×, so it stays sharp.
5. **Steps are unchanged.** `click`, `fill`, `hover`, `press`, `scroll` act
   exactly as on desktop. Playwright's `click` in a `hasTouch` context
   dispatches mouse events, which touch-first pages also handle.
   - *Why:* a `tap` step would be a scenario-format change of its own
     (ADR-0003); this slice must not touch the step union.
6. **Timeline.** `TimelineSchema` gains `device: z.enum(DEVICES).optional()`.
   The engine always writes it; the renderer reads a missing one as
   `"desktop"`.
   - *Why optional:* timelines written before this issue (and `demoflow
     render` of an old run) still parse; no `schemaVersion` change.
7. **No `schemaVersion` change, no ADR.** The field is optional and additive;
   an old scenario parses and records as before (ADR-0012 §6 precedent).
8. **Fixture.** `apps/fixture/demoflow/phone.demo.json`: `device: "phone"`,
   no `viewport`, a `click` and a `fill` on the fixture app, and a probe for
   `(pointer: coarse)` and the user agent in the real-run test.

## Acceptance criteria

- [ ] Scenario tests: `device: "phone"` without `viewport` → 412×914; with a
      `viewport` → that viewport; no `device` → `"desktop"`, 1920×1080;
      `device: "tablet"` → an issue at `device`.
- [ ] `recording.spec.ts`: phone options carry `isMobile`, `hasTouch` and a
      user agent with `Android`, `Mobile` and the given version; desktop
      options carry none of them.
- [ ] A real run of `phone.demo.json`: `(pointer: coarse)` matches,
      `navigator.userAgent` contains `Mobile`, the source video and `timeline.viewport` are 412×914,
      the `click` and `fill` pass, and `timeline.json` has `device: "phone"`.
- [ ] Timeline tests: with and without `device`.
- [ ] The scenario JSON schema is regenerated; `device` has a description.
- [ ] `bun run check`, `bun run test` and `bun run build` are green, and so
      is the execution-plane matrix (Linux, macOS, Windows).

## Contention

| Resource | Owner | Others |
|---|---|---|
| `packages/core/src/scenario.ts`, `packages/core/src/timeline.ts` | #305 | No other open issue in this set. |
| `packages/engine/src/execute/recording.ts`, `packages/engine/src/run.ts` | #305 | Any open engine issue: rebase on whichever merges first. |

## Open questions

None.
