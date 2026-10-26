# The Runner inspects, initialises and registers a folder the website names, inside allowed roots

Issue: [#377](https://github.com/AndreyBegma/DemoFlow/issues/377)
Depends on: nothing. Decided by [ADR-0022](../adr/0022-projects-added-from-the-website.md).

## Summary

The website will let a person add a project by naming a folder on a paired
machine (#378, #379). This slice is the machine's half: the allowed roots the
person controls on the machine, the path rule that keeps the website out of
everything else, and three socket requests — `project.inspect`,
`project.init`, `project.register` — that the daemon answers. It also widens
the registry that website-started runs check (ADR-0016 §3) to the folders
registered this way.

## Scope

### In scope

- `apps/cli/src/runner/paths.ts`: `allowedRoots` (`allowed-roots.json`) and
  `websiteProjects` (`website-projects.jsonl`) in `RunnerPaths` [Confirmed:
  the file and `runnerPaths` exist].
- `apps/cli/src/runner/roots/**` (new): reading and writing the allowed roots,
  the path rule (Decision 3), inspection (Decision 5), the git remote reader
  (Decision 6), registration (Decision 8).
- `apps/cli/src/runner/command.ts`: `demoflow runner allow <dir>`,
  `demoflow runner disallow <dir>`, `demoflow runner roots` [Confirmed:
  `registerRunnerCommands` holds the `runner` subcommands].
- `apps/cli/src/commands/init.ts`: the file-writing half of `initCommand`
  moves into an exported `writeInitTemplate(root)` that the daemon and the
  command share; the command's output is unchanged [Confirmed:
  `initCommand`, `createExclusive` with `flag: 'wx'`].
- `apps/cli/src/runner/connection.ts`: routing of the three requests, and
  `'projects'` in the daemon's announced `features` (Decision 9) [Confirmed:
  `case 'scenarios.list'` routing; `launches.sync` is sent at line ~186].
- `apps/cli/src/runner/launch/checks.ts`: `checkProject` accepts a root found
  in either registry file (Decision 8) [Confirmed: it reads `knownRoots` from
  `reported-runs.jsonl` today].
- `apps/cli/test/runner/**`: tests (Vitest under Node).
- `apps/cli/README.md`: the three `runner` subcommands.

### Out of scope

- The API messages and endpoints (#378), the dialog (#379), the website docs
  (#380).
- Cloning a repository (ADR-0022, Consequences).
- Any change to the `demoflow init` command's flags or output.

## Decisions

1. **Allowed roots file.** `allowed-roots.json` is
   `{ "roots": ["<absolute canonical dir>", …] }`, at most 32 entries, written
   with mode 600 like `credentials.json`. Missing file = `[homedir]`. A file
   that does not parse is treated as **no roots** (every path refused) and
   `demoflow runner roots` reports it, so a corrupt file never widens access.
   *Source:* ADR-0022 §1.
2. **Commands** (all local; no server involved):
   - `demoflow runner allow <dir>` — resolves `<dir>` against the cwd,
     requires an existing directory, stores its real path. When the file is
     missing, the first `allow` writes `[<dir>]` only and prints that the home
     directory is no longer allowed. *Why:* a person who narrows the roots
     means it; an implicit home entry would undo it.
   - `demoflow runner disallow <dir>` — removes the entry equal to its real
     path (or to the resolved path when it no longer exists); removing the
     last entry leaves `{ "roots": [] }` (nothing allowed), never the default.
   - `demoflow runner roots` — prints the effective list, marking the default.
   - `--json` on `roots`, like the other commands' structured output.
   The daemon reads the file on every request; no restart is needed.
3. **The path rule** (`isAllowedPath(raw, roots, host)`), in order; any
   failure is `path-not-allowed`:
   - `raw` is a string of 1–4096 characters, absolute for the host platform
     (`path.win32.isAbsolute` / `path.posix.isAbsolute`); on Windows a UNC or
     device path (`\\`, `\\?\`) is refused.
   - its real path (`realpathSync.native`, like `canonicalRoot` in
     `apps/cli/src/runs-report/report.ts`) equals the normalised input, i.e.
     no symbolic link or junction anywhere on the way. *Why:* a link inside
     an allowed root that points outside it must not count as inside.
   - it is a directory (`lstat`).
   - it equals a root or lies below one: compared segment-wise after
     `realpath`, case-insensitively on Windows and macOS, case-sensitively on
     Linux.
   - no segment between the root and the folder starts with `.`.
   The refusal never says which check failed or whether the folder exists.
   *Source:* ADR-0022 §2.
4. **Socket requests** (server → daemon), each answered with one reply that
   carries the same `requestId`:

   | Request | Fields | Reply |
   |---|---|---|
   | `project.inspect` | `requestId`, `path` | `project.inspected` with the inspection (Decision 5) |
   | `project.init` | `requestId`, `path` | `project.initialised` with `{ created: string[], kept: string[] }` and a fresh inspection |
   | `project.register` | `requestId`, `path` | `project.registered` with `{ rootPath }` (canonical) |
   | any of them, failing | — | `project.error` with `code`: `path-not-allowed`, `config-missing` (register only), `config-invalid` (register only), `busy`, `internal` |

   Field names and limits are final here; #378 mirrors them in DTOs.
5. **Inspection** answers only:
   `{ rootPath, name, hasConfig, configValid, scenarios: [{ id, name }], githubUrl? }`
   — `rootPath` canonical; `name` the folder's base name; `scenarios` from
   `listScenarios` (`apps/cli/src/runner/launch/list.ts`, ADR-0016 §1 limits)
   only when the config is valid; never file contents, never `baseUrl`,
   `devCommand` or any other config value. *Source:* ADR-0022 §3,
   ADR-0008 §2.
6. **GitHub URL.** Read `<root>/.git/config` (or, when `.git` is a file with
   `gitdir: <dir>`, that directory's `config`, one level only, and only when
   the gitdir resolves inside an allowed root or inside the folder's parent
   repository), at most 64 KiB, parse the `[remote "origin"]` `url`. Accept
   `https://github.com/<owner>/<repo>(.git)?`, `git@github.com:<owner>/<repo>(.git)?`
   and `ssh://git@github.com/<owner>/<repo>(.git)?`; answer
   `https://github.com/<owner>/<repo>`, owner and repo matching
   `[A-Za-z0-9._-]{1,100}`. Anything else: no `githubUrl`. No credentials in
   the URL ever reach the answer. No `git` process is spawned. *Source:*
   ADR-0022 §3.
7. **Init** calls `writeInitTemplate(root)` after the path rule passes: the
   same two files and the same `wx` never-overwrite rule as `demoflow init`,
   with `baseUrl` `http://localhost:3000`. *Source:* ADR-0022 §3, spec 273.
8. **Register** re-checks the path rule and that `demoflow.config.json` exists
   and parses, then appends `{ rootPath, registeredAt }` to
   `website-projects.jsonl` (no duplicate lines; at most 1,000 entries, the
   oldest dropped beyond). `checkProject` treats a root as known when it is in
   `reported-runs.jsonl` **or** in `website-projects.jsonl` **and** still
   passes the path rule. *Source:* ADR-0022 §4.
9. **Capability.** The daemon announces `'projects'` in the `features` array
   of `launches.sync`. If no earlier Phase 8 slice has added `features` yet
   (ADR-0020 introduces it; #347/#355 append to it), this slice adds the
   field with `['projects']`, and the API side (#378) accepts it.
10. **Concurrency.** One project request at a time per daemon; a second one
    while the first is in flight answers `busy`. Each request is answered
    within 5 s or with `internal`.

## Configuration

- `allowed-roots.json` (Decision 1). No new environment variable.

## Acceptance criteria

- [ ] With no `allowed-roots.json`, `project.inspect` of a folder in the home
      directory answers an inspection; of `~/.ssh`, `/etc`, or a folder
      outside home answers `path-not-allowed`.
- [ ] A symbolic link inside the home directory pointing to `/tmp/outside`
      is refused; so is a path with `..` that resolves outside the root.
- [ ] `demoflow runner allow ~/work` then inspecting `~/other` is refused and
      `~/work/app` is accepted; `disallow` of the last root refuses everything.
- [ ] A corrupt `allowed-roots.json` refuses every path and `runner roots`
      says the file is invalid.
- [ ] Inspection of a folder without config answers `hasConfig: false`, no
      scenarios; with a valid config, the scenario ids and names; it never
      contains `baseUrl` or `devCommand`.
- [ ] `githubUrl` is filled for https, scp-style and ssh `origin` remotes on
      github.com, empty for other hosts and for a URL with credentials (the
      credentials never appear).
- [ ] `project.init` on an empty allowed folder creates both files;
      run again, answers both as `kept` and the files are byte-identical.
- [ ] `project.register` of a folder without config answers `config-missing`;
      with config, the root appears in `website-projects.jsonl`, and a
      website-started `scenarios.list` / `run.start` for that root is accepted
      by `checkProject`; after `disallow` of its root it is refused.
- [ ] Path tests run on Linux, macOS and Windows in the execution-plane matrix
      (case-insensitive compare on Windows and macOS, drive letters).

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i377-roots | allowed roots, path rule, commands, inspection, init, register | apps/cli/src/runner/roots/**, apps/cli/src/runner/paths.ts, apps/cli/src/runner/command.ts, apps/cli/src/commands/init.ts, apps/cli/src/runner/connection.ts, apps/cli/src/runner/launch/checks.ts, apps/cli/test/runner/**, apps/cli/README.md | — | yes | opus |

One slot: the path rule, the registry and the socket handlers are one
contract, and the path rule still has platform decisions to make in code.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/cli/src/runner/connection.ts | i377-roots | #349, #355, #360, #361 add their own routes and `features` strings; rebase, keep every case |
| apps/cli/src/runner/launch/checks.ts | i377-roots | #360 (check mode) may touch it; keep both |
| apps/cli/src/runner/command.ts | i377-roots | #361 (local schedule mode) may add a subcommand |
| apps/cli/README.md | i377-roots | #349, #355, #360, #361 append sections |

## Risks

- **Path rule gaps on Windows** (high): junctions, 8.3 short names, case.
  Mitigation: compare real paths only; tests on the Windows runner.
- **Default root is broad** (medium): the whole home directory without hidden
  folders. Accepted by the owner; the docs (#380) show `runner allow`.
- **`.git` worktree indirection** (low): followed one level, only inside
  allowed space; otherwise no GitHub URL.

## Open questions

- Should `runner allow` warn when the new root contains no project?
  Default: no.
- Should the hidden-segment rule allow `.github`-style folders inside a
  project? Default: the rule applies to the path to the project root only,
  not to files inside it, so it does not matter.
