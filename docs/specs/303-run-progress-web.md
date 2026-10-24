# Show the live progress of a website-started run

Issue: #303
Depends on: #301 (the `progress` field of `LaunchView`). It
can be built against [run-progress-api](run-progress-api.md)'s contract,
then merged after it, the way #249 was built against #247.

## Summary

With #301 and #302, `GET
/projects/:id/launch` tells which phase a running launch is in and, during
the steps, step n of m. This slice shows it in `LaunchStatus`, the launch row
that both the project page's "Run a scenario" card (#249) and the run page's
"Run again" action (#282) render through `useLaunch`.

## Scope

### In scope

- `apps/web/src/lib/api.ts`: `LaunchPhase`, `LaunchProgress`, and
  `progress?: LaunchProgress | null` on `LaunchView`.
- `apps/web/src/lib/launch.ts` and `launch.test.mjs`: `launchProgress()`,
  the progress → label and bar rule.
- `apps/web/src/components/projects/launch-status.tsx`: render it.
- `apps/web/src/i18n/en.ts`: strings.
- `apps/web/src/app/docs/runner/page.mdx`: one paragraph in "Runs started
  from the website".

### Out of scope

- The API (#301) and the daemon (#302).
- Changing the poll: it stays 2 s, paused while hidden (`use-launch.ts`
  unchanged).
- Progress on the projects list, the library table, or a finished launch.
- A stage-by-stage checklist, step captions, or an estimate of time left.

## Decisions

1. **Types.** In `api.ts`:
   `type LaunchPhase = 'app' | 'steps' | 'rendering'`;
   `interface LaunchProgress { phase: LaunchPhase; step: number | null; steps: number | null }`;
   `LaunchView` gains `progress?: LaunchProgress | null`. *Why optional:* a
   web build that reaches an API from before #301 gets no
   field, and `undefined` must behave as `null`.
2. **One pure rule.** `launchProgress(launch)` in `launch.ts` returns `null`
   unless `launch.state === 'running'` and `launch.progress` is an object
   with a known phase. Otherwise:
   - `app` → `{ key: 'projects.launch.progress.app' }`;
   - `steps` with `1 ≤ step ≤ steps` → `{ key: 'projects.launch.progress.steps', step, steps }`;
     `steps` with missing or inconsistent numbers → `null`;
   - `rendering` → `{ key: 'projects.launch.progress.rendering' }`.

   An unknown phase is `null`. *Why:* a newer API may add a phase; the row
   then falls back to today's, rather than showing a raw string. The rule is
   unit-tested without a browser, like the rest of `launch.ts`.
3. **What the row shows.** Below the existing line (name, pill, elapsed,
   **Cancel run**), when `launchProgress` is not null:
   - `app` and `rendering`: one `text-sm text-ink-2` line with the label;
   - `steps`: Glass UI `Progress` (`@andrewbehma/glass-ui/progress`) with
     `value={step}`, `max={steps}`, `label` "Step {step} of {steps}", tone
     `neutral`.

   Nothing else changes: the pill still says **Running**, the elapsed clock
   still runs. *Why:* `Progress` is the package's readout primitive (its
   `label` carries the human units); the bar's value equals the label's
   number so the two never disagree. Content surface, so no glass.
4. **Strings**, under `projects.launch.progress`:

   | Key | English |
   |---|---|
   | `app` | Starting the app |
   | `steps` | Step {step} of {steps} |
   | `rendering` | Rendering the video |

5. **Docs.** "Runs started from the website" on `/docs/runner` gains one
   paragraph: while a run goes, the card shows whether the machine is
   starting the app, which step of how many it is on, or that it is
   rendering; a machine with an older `demoflow` shows only **Running**.

## Acceptance criteria

- [ ] `launch.test.mjs` covers `launchProgress`: `null` for a non-running
      state, for `progress` `null` and `undefined`, for an unknown phase and
      for `steps` with `step > steps`; the right key for `app`, `rendering`
      and `steps` 3/7.
- [ ] A running launch with `steps` 3/7 shows a `Progress` bar labelled
      "Step 3 of 7"; with `app`, "Starting the app"; with `rendering`,
      "Rendering the video".
- [ ] A running launch without `progress`, and every non-running state, look
      as today.
- [ ] The run page's "Run again" row shows the same progress (it renders
      `LaunchStatus`).
- [ ] The Runner docs page has the paragraph.
- [ ] `bun run check`, `bun run test` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/web/src/lib/launch.ts`, `launch.test.mjs`, `components/projects/launch-status.tsx` | #303 | No other open issue. |
| `apps/web/src/i18n/en.ts`, `apps/web/src/lib/api.ts` | #303 | #286 (bulk delete) also edits them; rebase on whichever merges first. |
| `apps/web/src/app/docs/runner/page.mdx` | #303 | No other open issue. |
| `apps/api/**`, `apps/cli/**` | #301, #302 | This slice does not touch them. |

## Open questions

None.
