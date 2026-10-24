# Choose the output formats when starting a run from the website

Issue: #327
Depends on: #325 (the API fields). It can be built
alongside #326; merge after the API slice.

## Summary

[ADR-0017](../adr/0017-website-run-options.md) lets the website choose the
output formats of a run it starts. #325 takes them on
`POST /projects/:id/launch` and tells the web whether the machine accepts
them. This slice is the UI.

- The project page's "Run a scenario" card (spec 249) gets a format choice
  under the scenario picker.
- Run again (spec 282) repeats the files the run made.
- The confirm dialog and the launch row say which files the run makes.
- `/docs/runner` stops saying "No flags, formats or environment come from the
  site".

## Scope

### In scope

- `apps/web/src/components/projects/format-choice.tsx` (new): the choice,
  built from Glass UI `RadioGroup` and `Checkbox`.
- `apps/web/src/components/projects/start-run.tsx`: show it, send the
  formats, name them in the dialog.
- `apps/web/src/components/projects/run-again.tsx` and
  `apps/web/src/app/app/projects/[id]/runs/[runId]/page.tsx`: pass
  `run.formats` and `machine.runOptions`; send the formats.
- `apps/web/src/components/projects/launch-status.tsx`: show the formats.
- `apps/web/src/lib/api.ts`: `formats` on `startLaunch`, `formats` on
  `LaunchView`, `runOptions` on `ScenarioList` and on `RunDetail.machine`.
- `apps/web/src/lib/use-launch.ts`: `start(scenarioId, formats?)`.
- `apps/web/src/lib/launch.ts`, `launch.test.mjs`: the pure rules and the two
  error keys.
- `apps/web/src/i18n/en.ts`: the new strings.
- `apps/web/src/app/docs/runner/page.mdx`: "What the site chooses".

### Out of scope

- The API (#325) and the daemon
  (#326).
- A headed toggle, a base URL, environment, or any other option (ADR-0017
  §2–3).
- Showing the project's configured default formats by name (ADR-0017,
  Consequences): the web says "the project's formats".
- Remembering the last choice across visits.
- A format choice on Run again. It repeats the run (Decision 5).

## Decisions

1. **Two modes, default first.** `FormatChoice` is a `RadioGroup`:
   - **The project's formats** (selected on load): no `formats` is sent;
   - **Choose formats**: a 3 × 3 grid of `Checkbox`es, rows landscape,
     vertical, square, columns MP4, WebM, GIF, labelled with the existing
     `runPage.formats.*` strings (`apps/web/src/i18n/en.ts`).
   - *Why the default sends nothing:* the run then behaves exactly like today,
     on any daemon, and the project's config stays the source of its defaults
     (ADR-0017 §1).
   - *Why not preselect the config's formats:* the web does not know them
     (ADR-0017, Consequences); a guess would look like a fact.
2. **Choosing.** Switching to "Choose formats" ticks MP4 alone the first time;
   the ticks are kept while the card is open, including when switching back
   and forth. Zero ticked disables Run and shows
   `projects.launch.formats.pickOne`. The list sent is the ticked formats in
   `FORMAT_ORDER` (`apps/web/src/lib/playback.ts`).
   - *Why MP4:* it is the config's own default (`render.formats` defaults to
     `['mp4']`, `packages/core/src/project-config.ts`).
   - *Why `FORMAT_ORDER`:* the order the run page already offers formats in;
     a fixed order keeps the request independent of the tick order.
3. **Only when the machine accepts it.** The choice is shown only when the
   scenario list's `runOptions` includes `'formats'`. With `[]`, or no field
   (an API older than #325), the card shows one muted
   line, `projects.launch.formats.outdated` ("Update the demoflow CLI on this
   machine to choose formats"), and starts with the project's formats.
   - *Why hide instead of letting the API refuse:* the person sees the limit
     before choosing, not after; `runner-outdated` stays for the race where
     the machine reconnects with an older CLI.
4. **The dialog says which files.** The confirm dialog's consequence gets a
   second sentence: `projects.launch.formats.confirmChosen`
   ("Files: {list}.") with the labels joined by ", ", or
   `projects.launch.formats.confirmDefault` ("Files: the project's
   formats."). The same on Run again.
5. **Run again repeats the run's files.** `runAgainFormats(formats,
   runOptions)` in `lib/launch.ts` returns `run.formats` when it is not empty
   and `runOptions` includes `'formats'`, and `undefined` otherwise (start
   with the project's formats). Run again has no format choice.
   - *Why reuse:* "again" means the files on this page again. The launch that
     started a run is held in memory for 10 minutes only (spec 247,
     Decision 9), so `run.formats`, the formats the run's report says it
     rendered, is the only lasting record of what it made. It also covers a
     run started locally with `--format`.
   - *Why fall back to the project's formats:* a failed run that never
     rendered has no formats, and a machine with an older CLI cannot take
     them. Both still start, as today; the dialog says "the project's
     formats", so the difference is visible.
   - *Why no choice here:* the run page's card is a one-click repeat (spec
     282); choosing belongs on the project page.
6. **The launch row** shows `projects.launch.formats.row` ("{list}") under the
   scenario name when `launch.formats` is not null, and nothing when it is
   null.
7. **Errors.** `launchErrorKey` maps `runner-outdated` to
   `projects.launch.errors.runnerOutdated` ("This machine's demoflow CLI is
   too old to choose formats. Update it, or run with the project's
   formats.") and `options-invalid` to
   `projects.launch.errors.optionsInvalid` ("This machine cannot render one
   of the chosen formats. Update its demoflow CLI.").
8. **Pure rules** in `lib/launch.ts`, tested with `node --test`:
   `canChooseFormats(runOptions)`, `orderFormats(ticked)` and
   `runAgainFormats(formats, runOptions)`. The components stay thin.
9. **Docs.** `/docs/runner` "What the site chooses" says: the site sends the
   scenario's path and, optionally, the output formats; nothing else; the run
   is always headless; size, frame, background and every other render
   setting come from `demoflow.config.json`; a machine with an older CLI
   offers no choice and renders the project's formats; Run again repeats the
   formats the run rendered. Spec 179, Decision 2: written from the code.

## Acceptance criteria

- [ ] `launch.test.mjs`: `canChooseFormats(['formats'])` is true, `[]` and
      `undefined` false; `orderFormats(['gif', 'mp4'])` is
      `['mp4', 'gif']`; `runAgainFormats(['mp4', 'gif'], ['formats'])` is
      `['mp4', 'gif']`, and `([], ['formats'])` and `(['mp4'], [])` are
      `undefined`; `launchErrorKey` maps the two new codes.
- [ ] Project page with an announcing machine: the choice shows with "The
      project's formats" selected; Run then sends `{ scenarioId }` only.
- [ ] "Choose formats" starts with MP4 ticked; ticking GIF and Vertical MP4
      sends `formats: ['mp4', 'mp4-vertical', 'gif']`; unticking all disables
      Run and shows the hint.
- [ ] With `runOptions: []`, no choice, the outdated line, and Run sends
      `{ scenarioId }`.
- [ ] The confirm dialog names the chosen files, or "the project's
      formats".
- [ ] Run again on a run with formats and an announcing machine sends them;
      on a failed run without formats, or an older machine, it sends none;
      the dialog says which.
- [ ] The launch row lists the formats when the launch has them.
- [ ] `runner-outdated` and `options-invalid` show their messages.
- [ ] `/docs/runner` matches Decision 9; "No flags, formats or environment
      come from the site" is gone.
- [ ] The choice works at phone width (the grid wraps) and with the keyboard
      (Glass UI `RadioGroup` and `Checkbox`).
- [ ] `bun run check` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/web/src/components/projects/start-run.tsx`, `run-again.tsx`, `launch-status.tsx` | this issue | No other open issue. |
| `apps/web/src/lib/api.ts`, `apps/web/src/i18n/en.ts` | this issue | Shared files; rebase on whichever merges first. |
| `apps/web/src/app/docs/runner/page.mdx` | this issue | Any docs issue; rebase. |

## Open questions

None.
