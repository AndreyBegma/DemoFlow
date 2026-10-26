# Export edits to the scenario and the config, reset edits, update the share

Issue: [#358](https://github.com/AndreyBegma/DemoFlow/issues/358)
Depends on #357 (the editor page) and, for the share button, #350 (the
Share dialog and the run's share state on the run page).

## Summary

Edits live with the run (ADR-0020 §1); the next run of the scenario knows
nothing of them until the person carries them into the repository. The
website never writes there (§5). This slice adds the editor's three remaining
actions: **Export** (show the scenario patch and the config fragment, copy
them, and the one command that applies them on the machine), **Reset edits**
(back to the original render), and **Update share link** (replace a shared
copy with the new render, keeping the link).

## Scope

### In scope

- `apps/web/src/components/editor/export-dialog.tsx` (new),
  `reset-edits.tsx` (new), `update-share.tsx` (new).
- `apps/web/src/components/editor/render-bar.tsx` (from #357): the three
  buttons.
- `apps/web/src/lib/edits-export.ts` and `edits-export.test.mjs` (new):
  formatting the patch and the fragment for display and copy.
- `apps/web/src/lib/api.ts`: `getEditsExport`, `resetEdits`, `updateShare`.
- `apps/web/src/i18n/en.ts`: `editor.export.*`, `editor.reset.*`,
  `editor.share.*`.

### Out of scope

- Writing any repository file from the website (ADR-0020 §5).
- Exporting trims, cuts or free-timed captions: the scenario cannot express
  them (#355, Decision 6).
- Automatic share updates (ADR-0020 §6).

## UI

- **Export** (Glass UI `Dialog`): three sections.
  1. *Scenario:* the JSON Patch from `GET /runs/:id/edits/export`, in a
     `CodeBlock` with copy, and the file it applies to (the run's
     `scenarioPath` [Confirmed: on the run row]).
  2. *Config:* the `render` fragment as JSON, with copy, and the note "merge
     into `demoflow.config.json`".
  3. *Apply on your machine:* `npx demoflow edits apply <runId>` and, when the
     fragment is not empty, the same with `--config`, each with copy; a line
     that `--dry-run` shows the diff first.
  - Below, **Not exported**: each `notExportable` entry in plain words
    ("Caption at 0:12 is not on a step", "Cuts stay with this run").
  - `scenario-changed` (422) shows a `Banner`: the scenario file has changed
    since this run; run it again to export.
  - With no saved edits, Export is disabled with a tooltip.
- **Reset edits** (`ConfirmDialog`): "Remove every edit of this run? The next
  render is the original." Then `DELETE /runs/:id/edits`, the editor reloads
  its model, and the person is offered **Render** to restore the original
  file now. *Why not render automatically:* rendering spends the machine's
  time; the person may want to reset and edit again.
- **Update share link**: shown only when the run has a share whose format the
  last render wrote. It calls `POST /shares/:id/update` and shows the result
  with a `Toast`; disabled while a render runs, and while the render is older
  than the saved edits (the page knows: it saved after the last
  `finished`), with the tooltip "Render first".

## Decisions

1. **Copy, not download.** The patch and the fragment are small text; a
   person pastes them into an editor or an agent prompt. *Why also the
   command:* it is the one path that applies the patch exactly as the Runner
   built it (#355, Decision 8).
2. **The fragment is shown as nested JSON** (`{ "render": { … } }`), so it
   can be merged by hand into the config's root object.
3. **Reset does not touch a share.** A shared copy stays what it was until
   the person updates it (ADR-0020 §6).
4. **Update share uses the share's own format**, never the editor's format
   choice; if the last render did not write that format, the button explains
   that the share's format must be rendered first.

## Acceptance criteria

`apps/web/src/lib/edits-export.test.mjs` (`node --test`):

- [ ] A patch with two ops and a fragment format as pretty JSON with
      two-space indentation; an empty fragment is reported as empty.
- [ ] Each `notExportable` kind has a sentence; an unknown kind falls back to
      its `reason`.

Manual check on staging with a paired machine (in the pull request):

- [ ] After saving a caption and a zoom on top-level steps, Export shows a
      patch with those two paths and the apply command; running
      `npx demoflow edits apply <runId>` on the machine changes the scenario
      file accordingly.
- [ ] A cut shows under Not exported.
- [ ] Reset, then Render: the video is the original.
- [ ] With a share of the run, Render, then Update share link: the same
      `/s/<token>` plays the new video; the view count is unchanged.
- [ ] `bun run check` and `bun run build` are green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i358-actions | export, reset, update share | apps/web/src/components/editor/export-dialog.tsx, apps/web/src/components/editor/reset-edits.tsx, apps/web/src/components/editor/update-share.tsx, apps/web/src/components/editor/render-bar.tsx, apps/web/src/lib/edits-export.ts, apps/web/src/lib/edits-export.test.mjs, apps/web/src/lib/api.ts, apps/web/src/i18n/en.ts | #357, #350 merged | yes | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| `apps/web/src/i18n/en.ts`, `apps/web/src/lib/api.ts` | this issue | #350, #351, #363 add their own blocks: rebase. |
| `apps/web/src/components/editor/render-bar.tsx` | #357, then this issue | nobody else |

## Risks

- **Low — a person pastes the patch into the wrong file.** Mitigation: the
  dialog names the file, and the command is the recommended path.

## Open questions

- Offer a "Copy as agent prompt" (patch plus instructions)? Default: no;
  the MCP has no edits tool yet (#355, Out of scope).
