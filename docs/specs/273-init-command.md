# `demoflow init`: write a config and a first scenario

Issue: [#273](https://github.com/AndreyBegma/DemoFlow/issues/273)
Depends on: #272 (merge order: both edit the README and `/docs/cli` tables).

## Summary

Vision §3.4 lists "creating a scenario template" among what the CLI should
support. Today the Getting started page asks a new user to hand-write
`demoflow.config.json` and `demoflow/first.demo.json`, and `demoflow check`,
`demoflow record` and `demoflow run` all need the config to exist first.

This slice adds `demoflow init`, which writes both files in the current
directory and never overwrites either.

## Scope

### In scope

- `apps/cli/src/commands/init.ts` (new): `initCommand`.
- `apps/cli/src/main.ts`: the command and its flag.
- `apps/cli/test/commands/init.spec.ts` (new).
- `apps/cli/README.md`, `apps/web/src/app/docs/cli/page.mdx`: a table row
  each and an `## init` section on `/docs/cli`.
- `apps/web/src/app/docs/page.mdx` (Getting started): one sentence offering
  `npx demoflow init` as the shortcut for "Describe your project" and "Write
  the first scenario".

### Out of scope

- An MCP tool. Agents write scenarios through `generate_demo` and
  `validate_scenario`; no source asks for an MCP `init`.
- Interactive prompts, detecting the app's dev server or port, writing
  `devCommand`, or editing `.gitignore`.
- Registering the project with the website. A registered project is a root
  the machine reported a run from (ADR-0016 §2).
- More than one template.

## Decisions

1. **Command.** `demoflow init [--base-url <url>]`. Default base URL
   `http://localhost:3000`, the value the Getting started page uses. No
   positional argument; it works in `process.cwd()`. *Why:* the smallest
   interface that removes the hand-written step; a person who wants another
   folder `cd`s there.
2. **Files.**
   - `demoflow.config.json`: `{ "baseUrl": "<url>" }` with a trailing
     newline, 2-space JSON, as `record` writes.
   - `demoflow/first.demo.json`:
     `{ "schemaVersion": 1, "name": "First demo", "steps": [ { "action":
     "navigate", "path": "/", "caption": "Open the app" }, { "action":
     "wait", "ms": 1000 } ] }`.
   - *Why this scenario:* it passes against any app that answers at
     `baseUrl`, so the first `demoflow run` produces a video instead of a
     failed locator. The Getting started page's "Settings" example assumes a
     link the user's app may not have. The docs point to `demoflow record`
     and `/docs/scenarios` for real steps.
   - Paths come from `PROJECT_CONFIG_FILE` and the `demoflow` scenario folder
     that `check` lists (`apps/cli/src/mcp/readonly.ts`); the folder is
     created with `recursive: true`.
3. **Never overwrite.** Each file is created with the exclusive flag (`wx`).
   `EEXIST` means "kept": the existing file is left byte-for-byte unchanged
   and the summary says `kept <file>`. Exit 0 in every combination, including
   both kept. *Why:* the safe option; `init` run twice, or in an existing
   project, must not destroy work. Exclusive create also covers a file that
   appears between a check and a write.
4. **Only the current directory.** A `demoflow.config.json` in a parent
   directory is not looked for. *Why:* the person chose where to run `init`;
   walking up would make the command's effect depend on unrelated folders.
5. **Validation first.** The config object is passed through
   `parseProjectConfig` before anything is written. An invalid `--base-url`
   prints the issue (`baseUrl: …`) on stderr and exits 2 (invalid input,
   spec 5) with no file written. The scenario template is a constant; a test
   asserts `parseScenario` accepts it with no warnings, so a schema change
   that breaks it fails CI.
6. **Output.** One line per file, `created <path>` or `kept <path>`
   (relative to the current directory, `/` separators), then the next steps:
   `demoflow check`, `demoflow run demoflow/first.demo.json`, and
   `demoflow record <name>` to record a real scenario. No `--json`. *Why no
   JSON:* nothing automates `init`; vision §3.4's JSON output is for
   results, and `check --json` follows it.
7. **Errors.** A file-system error other than `EEXIST` (permissions, a
   read-only disk) propagates as it does for the other commands. A config
   already written stays; nothing is rolled back. *Why:* the written file is
   valid on its own, and deleting files on failure risks deleting the wrong
   one.
8. **Side effects.** No browser, no network, no global config, nothing
   outside the current directory.
9. **Testability.** `initCommand(flags, io, { cwd })`, with `cwd` defaulting
   to `process.cwd()`, so tests run in a temporary directory.

## Acceptance criteria

Vitest under Node, in a temporary directory:

- [ ] In an empty directory, `init` writes both files; they parse with
      `parseProjectConfig` and `parseScenario` without warnings; exit 0;
      output lists both as `created`.
- [ ] `--base-url http://localhost:5173` is written as given; `--base-url
      not-a-url` exits 2 with the issue on stderr and writes nothing.
- [ ] With an existing `demoflow.config.json` (any content), it is unchanged
      byte-for-byte, reported `kept`, and the scenario is still created; the
      same for an existing `demoflow/first.demo.json`; both existing → exit 0,
      nothing written.
- [ ] A `demoflow.config.json` in a parent directory does not stop or change
      the result.
- [ ] `demoflow init --help` lists `--base-url`.
- [ ] Docs: README and `/docs/cli` table rows, an `## init` section on
      `/docs/cli`, and the Getting started sentence.
- [ ] `bun run check` and the execution-plane OS matrix are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/cli/src/main.ts` | #273 | No other open issue touches it. |
| `apps/cli/src/commands/init.ts`, `apps/cli/test/commands/init.spec.ts` | #273 | New files. |
| `apps/cli/README.md`, `apps/web/src/app/docs/cli/page.mdx` | #272 first | #273 adds its row and section after #272 merges (merge order). |
| `apps/web/src/app/docs/page.mdx` | #273 | No other open issue touches it. |
| `packages/core/**` | read only | `parseProjectConfig` and `parseScenario` are used, not edited. |

## Open questions

None.
