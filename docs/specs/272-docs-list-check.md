# Docs: `demoflow list` and `demoflow check`, and what the run report sends

Issue: [#272](https://github.com/AndreyBegma/DemoFlow/issues/272)
Depends on: nothing.

## Summary

Spec [266](266-list-and-check-commands.md) shipped `demoflow list` and
`demoflow check` and left their docs out of scope: "the commands' docs are a
follow-up once it merges" (PR #262 owned both files then; it has merged).
Neither `apps/cli/README.md` nor the website's `/docs/cli` page lists them.
`demoflow render` (spec [255](255-render-command.md)) is already documented in
both places and is not part of this slice.

The README's "Runs on the website" section is also stale since
spec [264](264-report-run-details.md). It says "Only metadata is sent" and
lists the fields, but the report now also carries each stage's status, each
rendered file's format, resolution and size, and, for a failed run, the
failing stage and its redacted error message. A statement of what leaves the
machine that lists less than what is sent is a defect.

## Scope

### In scope

- `apps/cli/README.md`: the command table, a paragraph on `list` and
  `check`, and the "Runs on the website" field list.
- `apps/web/src/app/docs/cli/page.mdx`: the command table, `## list` and
  `## check` sections.

### Out of scope

- Any product code, including `--help` texts.
- `demoflow render` docs: already present in both files.
- A "what is sent" section on the website's Runner page. The website has no
  such list today; the README is the one place that states it (Decision 3).
- `demoflow init` (#273), which adds its own rows after this merges.

## Decisions

1. **Source of truth is the code.** Flags, defaults, limits and exit codes
   are taken from `apps/cli/src/main.ts` and
   `apps/cli/src/commands/{list,check}.ts`, with spec 266 Decisions 4–6 as a
   guide. *Why:* docs that drift from the code are the defect this slice
   fixes.
2. **What to say about each command.**
   - `list`: recent runs of the current project, newest first; status, start
     time, duration, scenario name, run id, and the run's page URL when it was
     reported. `--limit` 1–100, default 20; anything else exits 2. `--json`
     prints the same `{ demos }` object as the MCP's `list_demos`. The runs are
     those of the artifacts home `run` writes to (`DEMOFLOW_HOME`, the project
     config, the global config, the OS default).
   - `check`: the project root, whether the config is valid, the scenario
     files (listed, not validated — `demoflow validate` does that), FFmpeg
     (`system`, `bundled`, `missing`) and the browser (`installed`,
     `missing`, with a `demoflow setup` hint). Exit 0 when FFmpeg and the
     browser are available, 1 otherwise, so a CI step can gate on it. `--json`
     prints the same object as the MCP's `check_project`.
   - Both: outside a project (no `demoflow.config.json` upwards) they exit 2
     with a message and a hint. Neither starts a browser, writes a file or
     makes a network request.
   - *Why this much and no more:* it is what a person needs to use them from a
     terminal or CI; the rest is `--help`.
3. **The report's field list.** "Runs on the website" lists, in prose, what
   `apps/cli/src/runs-report/` sends today: the project folder and its name,
   the scenario's name and path, the verdict, the start time, the duration,
   each stage's status, each rendered file's format, resolution and size, the
   failed step's number, the CLI version, and for a failed run the failing
   stage and its error message. It then says how the message is redacted
   (query strings and fragments of URLs removed, the project path shown as
   `<project>` and the home directory as `~`, cut to 1,000 characters) and
   that the message can still contain text from the page under test. "Videos,
   frames and step values never leave the machine" stays.
   - *Why say what is not redacted:* spec 264 Decision 4 leaves other
     absolute paths and page text in; a privacy statement must not promise
     more than the code does.
   - *Why only the README:* it is the only place with the list today; adding
     a website section is new content no source asks for.
4. **Style.** Follow the existing sections: a table row per command, a
   `## <command>` section with a `sh` example, as `## render` does. English,
   no product names beyond what the pages already use.

## Acceptance criteria

- [ ] `apps/cli/README.md`'s command table has `demoflow list` and
      `demoflow check` rows, and a paragraph covers both as in Decision 2.
- [ ] "Runs on the website" lists every field of Decision 3 and the redaction
      rules, and keeps the "never leave the machine" sentence.
- [ ] `/docs/cli` has both table rows and `## list` and `## check` sections
      with an example, the flags and the exit codes.
- [ ] Every flag, default, limit and exit code matches `main.ts` and
      `commands/{list,check}.ts`.
- [ ] No file outside the two in scope changes. `bun run check` and the web
      build are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/cli/README.md`, `apps/web/src/app/docs/cli/page.mdx` | #272 | #273 adds an `init` row and section after this merges (its `Depends on`). |
| `apps/cli/src/**` | read only | Not edited. |

## Open questions

None.
