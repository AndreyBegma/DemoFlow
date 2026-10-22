# `demoflow/playwright`: container scrolls, and the `caption` and `scene` helpers

Issue: [#209](https://github.com/AndreyBegma/DemoFlow/issues/209)
Depends on: #208. This issue extends the fixture #208 adds and edits
only `packages/playwright/**`. Start from `develop` after #208 has merged.

It does **not** depend on #201. The helpers below write `marker` steps into
the recorded scenario, in the test process. They never call
`window.demoflow`, which exists only while the engine runs the app
(ADR-0013, ADR-0014).

## Summary

Spike #202 left two of its 30 probe steps out of reach of every candidate
([report](../research/202-playwright-reuse-spike.md), "Coverage: 28 of 30"):

- a container scroll made with `page.mouse.wheel`. #208 watches only the
  page's scroll position, so it reports the call and records nothing;
- the `Slow report` caption: `test.step` can only mean a scene.

This issue records the first from its effect and gives tests explicit helpers
for the second (ADR-0015 §5):

```ts
import { test, expect } from 'demoflow/playwright';

test('tour', async ({ page, demoflow }) => {
  await page.goto('/slow');
  demoflow.caption('Slow report');
  await page.getByRole('button', { name: 'Load report' }).click();
});
```

## Scope

### In scope

- `packages/playwright/src/**`:
  - container scrolls from `page.mouse.wheel`;
  - `locator.scrollIntoViewIfNeeded()` as `scroll {target}`;
  - a `demoflow` test fixture with `caption(text)` and `scene(title)`;
  - its type exported from `src/index.ts` (`DemoflowHelpers`).
- `packages/playwright/test/**`: the probes, the expected files, unit tests.

### Out of scope

- Any edit outside `packages/playwright/**` (the published entry and CI are
  #208's and need no change).
- The docs page: #210.
- Turning `window.demoflow.scene`/`caption` calls the page makes into steps.
  During a test run there is no `window.demoflow`. During the replay, the
  engine takes the page's annotations directly (ADR-0014 §7), so a marker
  for them would show each one twice.
- Scrolls that end between the top and the bottom: the `scroll` step has no
  offset. They stay reported, not recorded.
- Horizontal scrolls.

## Decisions

1. **The pointer position comes from the page.** While recording, the
   fixture adds an init script (`page.addInitScript`) that keeps the last
   `mousemove` / `pointermove` client coordinates in a closure under a
   `Symbol` on `window`, not a named global. Locator `hover` and `click` move
   the pointer there, so after them the position is known.
2. **The container under the pointer.** Before a `page.mouse.wheel(dx, dy)`
   with `dy !== 0`, the fixture evaluates in the page: the element at the
   pointer (`document.elementFromPoint`), then the nearest ancestor-or-self
   whose computed `overflow-y` is `auto` or `scroll` and whose
   `scrollHeight > clientHeight`. It reads that element's `scrollTop` and its
   maximum, and the page's scroll position.
3. **Recorded from the effect.** After the wheel, the fixture waits until
   both positions are unchanged for two animation frames, at most 1,000 ms
   (#208's settle rule). Then:
   - the page moved: #208's page-scroll rule applies, unchanged;
   - else the container moved and ended at 0: `scroll {to: "top", within}`;
   - else it ended at its maximum (within 1 px, for fractional scroll
     positions on macOS and Windows): `scroll {to: "bottom", within}`;
   - else: reported as `not recorded: page.mouse.wheel … ends mid-container`.
4. **The container's locator.** `within` is, in order: `{ testId }` from the
   container's `data-testid`; `{ css: "#<id>" }` from its `id`, when the id
   is a valid CSS identifier (`CSS.escape(id) === id`); otherwise none, and
   the wheel is reported as `not recorded: … the scroll container has no
   data-testid or id`. The fixture does not invent a CSS path (ADR-0015 §5).
5. **`scrollIntoViewIfNeeded()`** on a locator with a scenario form records
   `scroll {target}` when it resolves. On a locator without one it fails the
   test, as #208's other actions do.
6. **The `demoflow` fixture.** `test` gains a `demoflow` fixture of type
   `DemoflowHelpers = { caption(text: string): void; scene(title: string): void }`.
   - Recording: each call appends `marker {title, kind: "caption"}` or
     `{title, kind: "scene"}` at that point in the step order. The text is
     trimmed. An empty text, or a caption over 120 characters (the step
     `caption` limit, as for page annotations in ADR-0014 §4), throws
     `demoflow.caption: expected 1–120 characters` (or `demoflow.scene: …`
     for an empty title), with the test's line.
   - Pass-through: both are no-ops that validate nothing and never throw, so
     a suite behaves the same with and without recording.
   - *Why throw while recording:* a helper is the test author's own code,
     and #208 fails loudly on what it cannot record. This differs on
     purpose from `window.demoflow`, whose page-side methods never throw.
7. **`test.step` is unchanged.** An outermost `test.step` still records a
   scene marker (#208 Decision 3). `demoflow.scene` is for a scene with no
   `test.step` around it.

## Acceptance criteria

Vitest under Node, on Linux, macOS and Windows (execution-plane workflow).

- [ ] The `tour` probe adds `demoflow.caption('Slow report')` after its
      `goto('/slow')`. Recorded, it deep-equals its updated expected file,
      and against `apps/fixture/demoflow/tour.demo.json` (ignoring `caption`,
      `zoom`, `timeoutMs` and `match`) it has 14/14 steps:
      `scroll {to: "bottom", within: {testId: "log-panel"}}` and
      `marker {title: "Slow report", kind: "caption"}` are present. In all,
      the three probes reach 30/30.
- [ ] The `tour` run no longer reports `not recorded: page.mouse.wheel`.
- [ ] The recorded `tour` replays through `runScenario` with execution and
      recording passing.
- [ ] Inline-page tests (served as #208's tests serve the fixture):
      - a wheel over a container with only an `id` records
        `within: {css: "#<id>"}`;
      - a container with neither `data-testid` nor `id` is reported, not
        recorded;
      - a wheel that leaves the container mid-way is reported;
      - a wheel back to the top records `to: "top"`;
      - a wheel over a non-scrollable area that moves the page records the
        page scroll, as before;
      - `scrollIntoViewIfNeeded()` on `getByTestId('x')` records
        `scroll {target: {testId: "x"}}`; on `.first()` it fails with
        `cannot record`.
- [ ] `demoflow.scene('Checkout')` records `{kind: "scene"}` in call order
      between two clicks. `demoflow.caption('')` and a 121-character caption
      fail the test with `demoflow.caption` and the line. Without
      `DEMOFLOW_RECORD`, the same calls do nothing and the test passes.
- [ ] The minor-compatibility suite (#208 Decision 10, Linux) records the
      updated `tour` identically on 1.62.1, 1.63.0 and 1.64.1.
- [ ] `bun run check`, `bun run build` and the execution-plane matrix are
      green.

## Risks

- **Scroll settling on macOS** (medium). #56 found container scrolls slow to
  settle there. The two-frames-unchanged rule with a 1,000 ms cap, and the
  1 px bottom tolerance, are the mitigation; a probe that still flakes points
  at the cap, not at a retry.
- **The init script on another minor** (low). `addInitScript` and
  `elementFromPoint` are public and old.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i209 | container scrolls and the helpers | packages/playwright/** | #208 | yes | opus |

One slot. `opus`: the container scroll is detected from its effect across
three OSes, and container scroll settling has flaked on macOS before (#56).
The helpers alone would be sonnet work.

## Open questions

None.
