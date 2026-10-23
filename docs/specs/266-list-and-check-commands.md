# `demoflow list` and `demoflow check`: the MCP's read-only views on the command line

Issue: [#266](https://github.com/AndreyBegma/DemoFlow/issues/266)
Depends on: nothing.

## Summary

Vision §3.4 asks the CLI to support "listing demos and artifacts", "reading
configuration and diagnostics" and "machine-readable JSON output for
automation", and says "the CLI and MCP server should share the same core logic
and contracts rather than implementing separate versions of the workflow".

Spec [69](69-mcp-read-only-tools.md) gave the MCP server `list_demos` and
`check_project`, implemented as `listDemos` and `checkProject` in
`apps/cli/src/mcp/readonly.ts`. The command line has neither: a person or a CI
script without an MCP client cannot list recent runs or check that FFmpeg and
Chromium are ready, short of starting a run.

This slice adds two thin commands over those functions.

## Scope

### In scope

- `apps/cli/src/commands/list.ts` (new): `listCommand`.
- `apps/cli/src/commands/check.ts` (new): `checkCommand`.
- `apps/cli/src/main.ts`: the two commands and their flags.
- `apps/cli/test/commands/list-check.spec.ts` (new).

### Out of scope

- `apps/cli/README.md` and `/docs/cli`. Open PR #262 (#254) owns both; the
  commands' docs are a follow-up once it merges. `--help` describes them
  until then.
- Any change to `listDemos`, `checkProject` or the MCP tools.
- An `--out <dir>` flag (Decision 3).
- Validating every scenario in `check` (Decision 5).
- Opening a video (vision §3.4 "opening a video locally"): its own slice.

## Decisions

1. **Commands.**
   - `demoflow list [--limit <n>] [--json]`
   - `demoflow check [--json]`
   - Both take the hidden `--project <dir>` that `run`, `render` and `record`
     take.
2. **Reuse, not copy.** `listCommand` calls `listDemos({ project, limit },
   process.cwd(), host)`; `checkCommand` calls `checkProject({ project },
   process.cwd(), host)`. `--project` is passed through `path.resolve`, since
   `resolveProject` requires an absolute path. *Why:* vision §3.4's "same
   core logic"; a second implementation would drift from the MCP's.
3. **Home.** The runs listed are those of the home `resolveProject` resolves:
   `DEMOFLOW_HOME`, the project config, the global config, the OS default. No
   `--out`. *Why:* `listDemos` takes the resolved project, not a home; adding
   `--out` would change the shared function, and the MCP has no such input
   either. A person who runs with `--out` can set `DEMOFLOW_HOME` instead.
4. **`list` output.**
   - Human: one line per run, newest first:
     `<status>  <startedAt, local, formatDate-like YYYY-MM-DD HH:mm>  <duration or ->  <scenarioName>  <taskId>`,
     and, when the run was reported, the `pageUrl` on the next line indented by
     two spaces. No runs: `No runs yet in <home>/runs.` on stdout, exit 0.
   - `--json`: `JSON.stringify(await listDemos(...))` and a newline, nothing
     else on stdout. The shape is the MCP's (`{ demos }`), so scripts and
     agents read one contract.
   - `--limit`: an integer 1–`MAX_LIST_LIMIT` (100), default
     `DEFAULT_LIST_LIMIT` (20). Anything else: `invalid-limit` on stderr,
     exit 2, before any file is read.
5. **`check` output and exit code.**
   - Human: the root, `config: valid`, the scenarios (one per line, or
     `none`), `ffmpeg: system | bundled | missing`, `browser: installed |
     missing`. A missing browser adds the hint `run demoflow setup`.
   - `--json`: `checkProject`'s object unchanged.
   - Exit 0 when `ffmpeg` is not `missing` and `browser` is `installed`;
     otherwise exit 1 (after printing, in both modes). *Why exit 1:* a CI
     step can gate on `demoflow check`, which is what "diagnostics for
     automation" is for. No scenarios is not a failure: a new project has
     none.
   - Scenarios are listed, not validated. *Why:* `demoflow validate` exists
     per file, and `checkProject` does not validate; validating here would
     make the CLI and MCP answers differ (Decision 2).
6. **Errors.** A `ToolError` from `resolveProject` (`project-not-found`) is
   printed as `<message>` and `hint: <hint>` on stderr, exit 2 (invalid
   input, spec 5). In `--json` mode stdout stays empty. Any other error
   propagates as for the other commands.
7. **Side effects.** Neither command starts a browser, writes a file, or makes
   a network request (`checkProject` only resolves Chromium's executable
   path). *Why:* they must be safe to run anywhere, including CI.
8. **Testability.** `listCommand(flags, io, deps)` and
   `checkCommand(flags, io, deps)` take `{ host, cwd, check? }`, where `check`
   defaults to `checkProject`, so tests can fake FFmpeg and browser
   availability without touching the machine.

## Acceptance criteria

Vitest under Node, a temporary project (with `demoflow.config.json` and two
scenario files) and a temporary home via `DEMOFLOW_HOME`:

- [ ] `list` prints a valid run and a reported run (with its page URL), skips
      a run with a corrupt `result.json`, newest first; `--json` prints
      exactly `listDemos`'s object; `--limit 1` returns one run; `--limit 0`,
      `--limit 101` and `--limit x` exit 2 with `invalid-limit`.
- [ ] `list` with no runs prints the empty line and exits 0.
- [ ] `check` with a faked `bundled`/`installed` exits 0; with `missing`
      FFmpeg or browser exits 1 and, for the browser, prints the
      `demoflow setup` hint; `--json` prints exactly the check object.
- [ ] Both commands in a directory without `demoflow.config.json` above it
      exit 2 with the message and hint on stderr and nothing on stdout.
- [ ] `--project <relative dir>` works.
- [ ] `demoflow list --help` and `demoflow check --help` list their flags.
- [ ] `bun run check` and the execution-plane OS matrix are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/cli/src/main.ts` | #266 | No other open issue touches it. |
| `apps/cli/src/commands/list.ts`, `check.ts`, `apps/cli/test/commands/list-check.spec.ts` | #266 | New files. |
| `apps/cli/src/mcp/readonly.ts` | read only | Not edited. |
| `apps/cli/README.md`, `apps/web/src/app/docs/cli/page.mdx` | PR #262 (#254) | Not touched here (Out of scope). |
| `apps/cli/src/runs-report/**` | #264 | Not touched here. |

## Open questions

None.
