# Intro, scene and outro cards

Issue: [#108](https://github.com/AndreyBegma/DemoFlow/issues/108) · Phase 4 ·
Roadmap: [roadmap.md](../product/roadmap.md) (Phase 4 — Cards) ·
Decisions: [ADR-0003](../adr/0003-scenario-format-and-project-config.md),
[ADR-0004](../adr/0004-recording-is-separate-from-rendering.md),
[ADR-0005](../adr/0005-renderer-chosen-by-spike.md) · spec [100](100-window-frame-background.md)

Depends on #100

## Summary

The rendered video starts on the first page frame and stops after the last
event. The roadmap's Phase 4 adds cards: an intro card from the scenario's
`name` / `description`, a scene card on every `scene` marker, and an outro card
with a title and an optional call to action from `demoflow.config.json`. Each
can be turned off. Cards are drawn by the FFmpeg compositor on the #100
background, in the existing caption typography. This item adds them; the fade
between cards and scenes is a separate issue.

## Scope

### In scope

- **Intro card** [Confirmed: roadmap]: the scenario `name` as the title and
  `description` (when present) as a subtitle, centred on the background, shown
  **before** the first page frame. Default duration 2000 ms.
- **Scene cards** [Confirmed: roadmap]: a `marker` step with `kind: 'scene'`
  shows a card with the marker `title`. The card is **inserted time**: the page
  video pauses on the frame at the marker's `startMs`, the card is shown, then
  the video resumes from the same frame. Default 1500 ms. Scene markers are
  ignored by the renderer today [Confirmed: `packages/renderer/src/plan/plan.ts`
  reads only `caption` markers].
- **Outro card**: `render.cards.outro.title` as the title and the optional
  `render.cards.outro.cta` as a second line, after the last page frame. Default
  2500 ms. Without a `title` there is no outro (the config has no project name
  [Confirmed: `ProjectConfigSchema`]).
- **Failure**: a failed run keeps today's failure end card and watermark; it
  gets **no outro**. Intro and scene cards before the failure are kept.
- **Time map**: card time is inserted into the plan's time map (as
  `time-map.ts` already compresses idle time), so cursor, rings, zoom keys,
  captions, masks and key badges stay in sync with the page after every card.
  No overlay is drawn on a card. The camera is at zoom 1 on a card.
- **Config** in `RenderConfigSchema` (`packages/core/src/project-config.ts`),
  additive with defaults:

  ```json
  "render": {
    "cards": {
      "intro":  { "enabled": true,  "durationMs": 2000 },
      "scenes": { "enabled": true,  "durationMs": 1500 },
      "outro":  { "title": "Acme", "cta": "acme.dev/try", "durationMs": 2500 }
    }
  }
  ```

  `enabled: false` turns intro or scene cards off; the outro is off unless
  `title` is set. Durations are integers 500–10000 ms. `title` and `cta` are
  strings of 1–80 characters. The JSON Schema for project config is
  regenerated.
- **Text**: titles wrap to at most two lines and are truncated with an ellipsis
  beyond that, never overflow the card; text is drawn as text by the
  compositor (the bundled Inter fonts, spec 25), never from the page.
- **CLI**: `run` passes `config.render.cards` to `buildRenderPlan`, as it does
  `frame` and `background`.
- **Golden images** (#73): intro card with and without a description, a scene
  card, an outro with and without `cta`, a two-line wrapped title; existing
  baselines unchanged when every card is off.

### Out of scope

- Fades and transitions (separate issue), card styles or themes, logos and
  images on cards, per-scene durations, export formats, 9:16.

## Decisions

1. **Cards insert time; they never cover page time.** — orchestrator: a card
   over live page frames would hide the action the demo exists to show.
2. **The outro needs an explicit `title`.** — orchestrator: the project config
   has no name, and guessing one from `package.json` or the directory leaks
   internal names into a video.
3. **Intro and scene cards on by default, outro off by default.** —
   orchestrator: the first two come from the scenario the author wrote; the
   outro has no content without config.
4. **No outro on a failed run.** — orchestrator: the failure card already ends
   the video and says why.

## Acceptance criteria

- [ ] A fixture run with default config renders an intro card with the
      scenario name before the first page frame, and the video is the intro's
      duration longer than with `intro.enabled: false` (within one frame).
- [ ] A scenario with a `scene` marker renders a scene card at the marker; the
      page frame just before the card equals the one just after it (golden
      image or frame comparison), and the cursor and a later click ring are at
      the same page position as without the card (plan test).
- [ ] A mask active across a scene card is applied to the page frames on both
      sides of the card (plan test with a mask interval spanning the marker).
- [ ] `render.cards.outro.title` set renders an outro after the last page
      frame; unset renders none; a failed run renders the failure card and no
      outro.
- [ ] Every card off reproduces the existing golden images within tolerance.
- [ ] Out-of-range durations, empty or over-long `title` / `cta` are rejected
      by the schema; the JSON Schema is regenerated.
- [ ] Golden images for the cards listed in Scope; before/after images in the
      PR; `bun run check` passes; Woodpecker and all three OSes green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i108 | cards in plan, compositor and config | packages/renderer/src/**, packages/renderer/test/**, packages/core/src/project-config.ts, packages/core/test/**, packages/core/schemas/**, apps/cli/src/commands/run.ts, apps/cli/test/commands/** | #100 | yes | opus |

One slot: the time-map insertion is decided here and every overlay depends on
it. `opus` for that reason.

## Risks

- **Overlays drift after an inserted card** (high — a mask could slip off a
  secret). Mitigation: the mask-spanning-a-card plan test and the existing
  real-run mask coverage test with cards on.
- **Long titles overflow** (medium). Mitigation: the wrap-and-ellipsis rule and
  its golden image.
