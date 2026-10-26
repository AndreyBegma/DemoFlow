# Add project dialog: machine, path, inspection result, create config, GitHub link

Issue: [#379](https://github.com/AndreyBegma/DemoFlow/issues/379)
Depends on: #378 (the endpoints), #374 (the Glass UI projects page this
dialog lives on). Decided by
[ADR-0022](../adr/0022-projects-added-from-the-website.md).

## Summary

The projects page today creates a project from a name and binds it by hand
to a machine and a typed `rootPath` (`apps/web/src/components/projects/project-list.tsx`,
`CreateForm`, `mode: 'bind'`) [Confirmed]. This slice replaces both with one
**Add project** dialog: pick an online machine, type a folder path, see what
the machine found there (config, scenarios, GitHub remote), create the
config when it is missing, and add the project. It is built with Glass UI
primitives on the shell and projects page that #374 delivers.

## Scope

### In scope

- `apps/web/src/components/projects/add-project-dialog.tsx` (new) and its
  helpers under `apps/web/src/components/projects/add-project/**`.
- `apps/web/src/components/projects/project-list.tsx`: the **Add project**
  button opens the dialog; the old name-only `CreateForm` and the inline
  bind form are removed from the page; a GitHub link icon on rows with
  `githubUrl`.
- `apps/web/src/lib/api.ts`: `inspectFolder`, `initFolder`, `registerFolder`,
  `githubUrl` in `updateProject` and in the `Project` type [Confirmed:
  `createProject`, `updateProject`, `listRunners` exist].
- `apps/web/src/lib/add-project.ts` + `add-project.test.mjs`: the pure state
  machine of the dialog (Decision 3), tested like `launch.test.mjs`.
- `apps/web/src/i18n/en.ts`: `projects.add.*`.

### Out of scope

- The API (#378), the Runner (#377), docs (#380).
- Editing a project's path after it is added (delete and add again).
- A folder browser on the machine: the path is typed (Open questions).

## Decisions

1. **Glass UI primitives only** (`CLAUDE.md`, vision §9): `Dialog` (glass
   overlay), `Select` or `Combobox` for the machine, `Field`/`Input` for path,
   name and GitHub URL, `StatusPill` for the machine state, `Banner` for
   refusals, `KeyValueList` for the inspection, `Button`, `Spinner`. Content
   inside the dialog stays on readable surfaces, not glass. [Confirmed: the
   package exports `dialog`, `combobox`, `select`, `status-pill`,
   `key-value-list`, `banner`, `spinner`.]
2. **Machine picker.** Lists the user's machines from `listRunners`; offline
   machines are shown disabled with "Offline", machines without the
   `'projects'` feature with "Update the CLI to add projects from the
   website" (`409 runner-outdated`). The last machine that reported a run is
   preselected when online.
3. **Flow** (`add-project.ts` state machine):
   `idle → inspecting → inspected(found | no-config | refused) →
   (initialising → inspected) → registering → done | error`.
   - Typing a path debounces 600 ms, then `inspectFolder`. A new keystroke
     cancels the pending result (stale answers are dropped by request
     sequence number).
   - **Found** (`hasConfig && configValid`): show folder name, scenario count
     and the first five scenario names, the GitHub link; **Add project**
     enabled.
   - **No config**: "This folder has no `demoflow.config.json`." and a
     **Create config** button → `initFolder` → shows what was created
     ("created demoflow.config.json, demoflow/first.demo.json") and a hint to
     set `devCommand` and `baseUrl` in the repository; then the state is
     "found".
   - **Config invalid**: the refusal text, no Add button.
   - **Refused** (`path-not-allowed`): "This folder is outside the folders
     this machine allows. On that machine run `demoflow runner allow <dir>`."
     with a link to the docs (#380).
   - **Add project** → `registerFolder` with the name (default the folder
     name) and the GitHub URL (default the inspection's, editable, may be
     cleared) → navigates to the new project's page. `409 project-exists`
     offers "Open the existing project".
4. **Path hints.** The placeholder shows the machine's platform style
   (`/home/you/app`, `C:\Users\you\app`) when the runner reports a platform
   [Unknown: whether `listRunners` exposes the platform; if not, a neutral
   placeholder].
5. **No secret or file content is ever displayed**; the dialog renders only
   the inspection fields of #377 Decision 5.
6. **Keyboard and a11y.** Focus starts in the machine field, Enter submits
   the enabled primary action, Escape closes; status changes are announced
   through an `aria-live` region.

## UI

```
┌ Add project ───────────────────────────────┐
│ Machine   [ devbox  ● Online          ▾ ]  │
│ Folder    [ /home/you/dev/my-app        ]  │
│ ┌────────────────────────────────────────┐ │
│ │ ✓ demoflow.config.json   3 scenarios   │ │
│ │   login · create post · billing        │ │
│ │   github.com/you/my-app                │ │
│ └────────────────────────────────────────┘ │
│ Name      [ my-app                      ]  │
│ GitHub    [ https://github.com/you/my-app ]│
│                       [Cancel] [Add project]│
└────────────────────────────────────────────┘
```

## Acceptance criteria

- [ ] With an online machine and a folder holding a valid config, the dialog
      shows its scenarios and GitHub link and **Add project** creates it and
      opens its page.
- [ ] With a folder without config, **Create config** writes the template
      through the API, the dialog then shows "found" with one scenario.
- [ ] A `path-not-allowed` answer shows the allow-roots hint and no Add
      button.
- [ ] Offline machines cannot be chosen; an outdated machine shows the
      update hint.
- [ ] Typing quickly sends at most one inspection per 600 ms pause and never
      shows a stale result (unit test on `add-project.ts`).
- [ ] Adding a folder that is already a project offers to open it.
- [ ] Rows with `githubUrl` show a link that opens the repository in a new
      tab with `rel="noopener noreferrer"`.
- [ ] The page has no name-only create form and no hand bind form any more.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i379-dialog | the dialog, its state machine, client calls, strings | apps/web/src/components/projects/add-project-dialog.tsx, apps/web/src/components/projects/add-project/**, apps/web/src/components/projects/project-list.tsx, apps/web/src/lib/add-project.ts, apps/web/src/lib/add-project.test.mjs, apps/web/src/lib/api.ts, apps/web/src/i18n/en.ts | #378, #374 merged | yes | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/web/src/components/projects/project-list.tsx | i379-dialog | #374 restyles it first; this slice rebases on it |
| apps/web/src/lib/api.ts | i379-dialog | #350, #351, #357, #358, #363 append functions |
| apps/web/src/i18n/en.ts | i379-dialog | every web issue appends keys |

## Risks

- **Restyle collision with #374** (medium): this slice starts only after #374
  merges (board dependency).
- **Typing a path is error-prone** (low): the inspection answers live; a
  folder picker is an open question.

## Open questions

- A folder browser listing subfolders of the allowed roots? Default: no —
  it would be a fourth request that lists directory names; revisit with
  usage.
- Keep a "create an empty project without a machine" action? Default: no;
  projects without a machine have nothing to show.
