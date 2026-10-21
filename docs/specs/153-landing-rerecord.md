# Re-record the landing video after #146

Issue: [#153](https://github.com/AndreyBegma/DemoFlow/issues/153) · Follows
[137](137-landing-page.md) and [146](146-mask-after-navigation.md)

## Summary

The landing video committed in #137 (PR #145) shows a stray mask box over the
Welcome page right after sign-in, about 6.4–6.6 s in. #146 (PR #148) fixed the
renderer. This slice re-records the video with the script #137 added, and
changes nothing else.

## Scope

### In scope

- Run `bun run landing:record` on current `develop`.
- Commit the regenerated `apps/web/public/demo/landing.mp4`,
  `landing-poster.png` and `og.png`.

### Out of scope

- Any change to the scenario, the page, the copy or the record script. If the
  script fails, the slot reports it and stops.

## Acceptance criteria

- [ ] The run's `result.json` reports `completed`, with every stage passed.
- [ ] A 1 fps contact sheet of the new video is in the PR body. The 5 fps
      strip around sign-in (5.5–7.5 s) shows no mask box on the Welcome page,
      and the password field is masked while it is on screen.
- [ ] The MP4 is under 8 MB. Its size is stated in the PR.
- [ ] Only the three files under `apps/web/public/demo/` and `og.png` change.
- [ ] `bun run check` and `bun run build` pass. Woodpecker is green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i153 | the landing assets | apps/web/public/** | #146 | yes | sonnet |

## Open questions

- None.

Depends on #146
