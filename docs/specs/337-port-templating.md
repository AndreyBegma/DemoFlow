# Port templating (`${PORT}`) and `--fresh-app` for parallel runs

Issue: [#337](https://github.com/AndreyBegma/DemoFlow/issues/337) · feature ·
Decisions: [ADR-0001](../adr/0001-control-plane-execution-plane-one-package.md) (core is zod-only, no Node APIs),
[ADR-0002](../adr/0002-develop-integration-staging-and-os-matrix.md) (Linux, macOS, Windows),
[ADR-0003](../adr/0003-scenario-format-and-project-config.md) §6 (the config is data, never code),
[ADR-0008](../adr/0008-cloud-boundary.md) §4 (commands only from the local config), spec [90](90-run-starts-app.md) (`startApp`)

## Summary

Nautelle's runner records a demo of each finished UI card. It runs
`demoflow run <scenario> --json --base-url http://127.0.0.1:<port> --format mp4`
in the card's worktree, on a free port it picked, and several cards may do it
at the same time. On `develop` (0.5.0) this cannot work, for three reasons
[Confirmed in code]:

1. `baseUrl`, `devCommand.readyUrl` and `devCommand.args` are fixed strings
   (`packages/core/src/project-config.ts`). The dev command starts on the
   port the config names, not the port the caller picked.
2. `startApp()` (`apps/cli/src/app/dev-server.ts`) returns `started: false`
   and reuses whatever already answers on `readyUrl`. A second card records
   the first card's app.
3. `--base-url` replaces `baseUrl` for the engine only
   (`apps/cli/src/commands/run.ts`: `flags.baseUrl ?? config.baseUrl`), while
   `allowedOrigins` stays the origin of the config's `baseUrl` (core's
   transform). A `--base-url` on another origin fails readiness with an origin
   that is not allowed.

This slice adds `${PORT}` / `${BASE_URL}` templates to those fields, a
`--port <n>` flag on `demoflow run`, makes `allowedOrigins` follow the base URL
the run really uses, and adds `--fresh-app`, which refuses to reuse an app. It
documents both. The release Nautelle pins (0.6.0) is cut afterwards through the
usual release flow.

## Scope

### In scope

- **core** (pure, no `process.env`):
  - `packages/core/src/config-template.ts` (new): parse and substitute the
    `${…}` syntax of Decision 1; the list of templated fields (Decision 2).
  - `packages/core/src/parse.ts`: `parseProjectConfig(input, options?)` takes
    the variables (Decision 3) and substitutes before the schema runs.
    Without `options` it behaves exactly as today for a config without
    templates.
  - `packages/core/src/project-config.ts`: `allowedOrigins` follows the
    effective base URL (Decision 5); `.meta({ description })` on the templated
    fields.
  - `packages/core/src/json-schema.ts` and the regenerated
    `packages/core/schemas/project-config.schema.json` (Decision 9).
  - `packages/core/src/index.ts`: export the new module.
- **CLI**:
  - `apps/cli/src/config/project.ts`: `loadProjectConfig(root, options?)`
    passes `--port`, the environment's `PORT` and `--base-url` to core
    (Decision 3), in the strict or the stand-in mode (Decision 4).
  - `apps/cli/src/app/dev-server.ts`: `startApp` gets `env` (the resolved
    `PORT` for the child, Decision 6) and `fresh` (Decision 7).
  - `apps/cli/src/commands/run.ts`, `apps/cli/src/commands/errors.ts`,
    `apps/cli/src/main.ts`: `--port <n>` and `--fresh-app` on `run`.
  - `apps/cli/src/record/command.ts`: strict mode (it starts the app); no new
    flag.
- **Docs**: `apps/cli/README.md`, `apps/web/src/app/docs/cli/page.mdx`
  (`run` flags), `apps/web/src/app/docs/config/page.mdx` ("Starting your
  app": templates, precedence, a parallel-runs example), `docs/specs/README.md`
  (a row for #337).
- Tests listed in the acceptance criteria.

### Out of scope

- A version bump or release. *Why:* releases go through their own bump PR on
  `develop` and the `develop → main` release PR (0.3.0–0.5.0 precedent). The
  orchestrator cuts **0.6.0** after this merges; Nautelle then pins
  `demoflow@0.6.0`.
- `--port` / `--fresh-app` on `record`, `check`, `render`, `list`, `runs`, or
  as MCP tool arguments. `record` reads `PORT` from the environment. MCP
  `generate_demo` spawns `demoflow run` with the server's `process.env`
  (`apps/cli/src/mcp/child.ts`), so `PORT` set for the MCP server reaches the
  run. *Why:* only `run` is called by an unattended caller that picks ports;
  the others never start an app (`record` is a person at a keyboard).
- The runner daemon's website-started runs (ADR-0016). They spawn
  `demoflow run` with the daemon's environment
  (`apps/cli/src/runner/launch/index.ts`) and run one at a time (a second
  start is refused `busy`), so they need no port. A daemon whose environment
  sets `PORT` passes it through unchanged.
- Choosing a free port. The caller picks it. *Why:* only the caller knows
  which ports its other runs hold; DemoFlow would race them anyway.
- Templates in any field other than those of Decision 2, any variable other
  than `PORT` and `BASE_URL`, or arbitrary environment variables.
- Starting `.cmd` / `.bat` dev commands on Windows without a shell (existing
  `startApp` behaviour, unchanged).

## Decisions

1. **Syntax: `${PORT}`, `${PORT:-<n>}`, `${BASE_URL}`; `$${` is a literal
   `${`.** A variable name is `[A-Z_][A-Z0-9_]*` inside `${…}`. Only `PORT`
   and `BASE_URL` are known. `PORT` may carry a default, `${PORT:-3000}`,
   where the default must be a valid port (Decision 3). Anything else is an
   issue on the field's path, and the config is invalid (exit 2): an unknown
   name (`unknown-variable`: "`${HOME}` is not a DemoFlow variable; expected
   `${PORT}` or `${BASE_URL}`; write `$${HOME}` for a literal"), an unclosed
   `${` (`unclosed-variable`), a default on `BASE_URL` or a default that is
   not a port (`invalid-default`). A lone `$` is literal.
   *Why:* `${…}` is what the issue and every shell, compose file and `.env`
   reader use, so authors read it without docs. Unknown names are errors,
   not kept as text, because a kept `${HOME}` would reach the app as a
   literal string and fail far from the cause. The `$${` escape keeps an
   argument such as `sh -c 'echo ${HOME}'` possible. The default lets a
   person keep running plain `demoflow run` while Nautelle passes `--port`.
   Different from the scenario's `{{…}}` (spec 165) on purpose: that syntax
   is per repeat item, this one is per run.

2. **Templated fields: `baseUrl`, `devCommand.command`, every
   `devCommand.args[i]`, `devCommand.readyUrl`.** `baseUrl` accepts `${PORT}`
   only (a `${BASE_URL}` in it is `variable-not-allowed`); the three
   `devCommand` fields accept both. A `${` in `allowedOrigins` or
   `artifactsDir` is `variable-not-allowed` with the list of fields that take
   templates. `render.*` strings (card text) are not inspected. Substitution
   is per string, so an argument never splits in two.
   *Why:* exactly the fields the issue names; `allowedOrigins` follows the
   base URL instead (Decision 5). Rejecting `${` in the two path/URL fields
   that look templatable turns a silent mistake into a clear one; card text
   may legitimately contain `${`.

3. **Where and in what order.** Core holds the syntax and substitution as
   pure functions over a variables object; it never reads `process.env`
   (ADR-0001). The CLI resolves the variables and passes them in:
   - `PORT` = `--port` > the environment's `PORT` > the `${PORT:-n}` default
     of the field being substituted. A port is a decimal integer from 1 to
     65535. An invalid `--port` is `invalid-port` (`CommandError`, exit 2)
     whether or not the config uses it. An invalid environment `PORT` is an
     issue (`invalid-port`, "PORT from the environment is "abc"; expected an
     integer from 1 to 65535") only when a field uses `${PORT}`; otherwise
     it is ignored.
   - A `${PORT}` with no port from any source is an issue `missing-port`:
     "`devCommand.readyUrl`: `${PORT}` needs a port: pass `--port <n>`, set
     PORT, or write `${PORT:-3000}`". `loadProjectConfig` throws it as
     `invalid-config` (exit 2) before any run directory, browser download or
     app start.
   - `baseUrl` is substituted first. `BASE_URL` = `--base-url` if given, else
     the substituted `baseUrl`, exactly as written (no trailing-slash
     normalisation). The `devCommand` fields are substituted next.
   - The schema (`HttpUrlSchema`, `NonEmptyStringSchema`) validates the
     substituted values, so `http://localhost:${PORT}` with port 99999 is the
     usual URL issue.
   `BASE_URL` is never read from the environment.
   *Why:* `PORT` from the environment is what the issue asks for and what
   Next.js, Vite-based and Express apps already read. `BASE_URL` is a common
   variable set by unrelated tools; reading it would silently move a run to
   another app, while the effective base URL is by definition the one the
   browser opens, so `readyUrl: "${BASE_URL}/health"` always probes the app
   the run records. Substituting before the schema keeps one validator and
   the existing URL messages.

4. **Strict mode for commands that start the app, stand-in mode for the
   rest.** `run` and `record` load the config in strict mode (Decision 3's
   `missing-port` is an error). `render`, `list`, `runs`, `check` and the MCP
   project resolution (`apps/cli/src/mcp/project.ts`, used by
   `check_project`, `list_demos`, `validate_scenario`, `generate_demo`'s
   checks) use the environment's `PORT` when valid and otherwise a stand-in
   port for validation only; syntax errors (Decision 1) and invalid defaults
   are still errors there. The stand-in mode is the default of
   `loadProjectConfig`.
   *Why:* these commands never open `baseUrl` or start the app; they need
   `artifactsDir` and `render`. A config written for Nautelle must not make
   `demoflow check` or `demoflow list` fail on a machine where `PORT` is not
   set.

5. **`allowedOrigins` follows the effective base URL.** When omitted it is
   `[origin of the effective base URL]` (`--base-url` if given, else the
   substituted `baseUrl`). When given, that origin is added to it if
   missing. `record` and `run` both use the result.
   *Why:* the issue asks for it, and today `--base-url` on another origin is
   refused by the origin guard, which is exactly Nautelle's call. The
   readiness stage already refuses a base URL outside the list, so adding
   its origin removes no protection a working config had.

6. **`--port <n>` sets `PORT` for the app; it implies nothing about
   `--base-url`.** Whenever a port is resolved (flag, environment or a
   default that was used), `startApp` spawns `devCommand` with
   `{ ...process.env, PORT: '<n>' }`. `--base-url` still overrides `baseUrl`
   and wins over a templated one. `--port` with a config that uses no
   `${PORT}` is allowed: `PORT` reaches the app and stderr gets one warning,
   "warning: --port 4123 is given but demoflow.config.json uses no ${PORT};
   baseUrl and readyUrl are unchanged". The scenario's environment
   (`host.env`, secrets, spec 5) is not changed.
   *Why:* the issue: "a new `--port` flag that also sets `PORT` for the
   app". With a templated `baseUrl`, `--port` alone is enough and Nautelle can
   drop `--base-url`; deriving one flag from the other would guess the host
   and scheme. The warning, not an error, keeps apps that read `PORT`
   themselves working with an untemplated config plus `--base-url`.

7. **`--fresh-app`: refuse, exit 2, before anything else.** With
   `--fresh-app`, `run` probes `readyUrl` after every input check and before
   `ensureChromium`. If anything answers — any HTTP status, 5xx included —
   it throws `CommandError('app-already-running', …)`: stderr
   `app-already-running: --fresh-app: http://127.0.0.1:4123/ already answers;
   another app holds this port. Stop it or pass another --port.`, exit `2`,
   stdout empty even with `--json`, no run directory created, `devCommand`
   not spawned. `--fresh-app` without `devCommand` is
   `CommandError('fresh-app-needs-dev-command')`, exit 2. `startApp` takes
   `fresh: true` and throws `AppStartError` instead of reusing if `readyUrl`
   answers between the probe and the spawn (reported as today: readiness
   failed, exit 2).
   *Why:* exit 2 is spec 5's "invalid input / readiness", so no new exit code
   enters the contract; the stable `app-already-running:` prefix on stderr is
   how every input error is already reported (`describeError`), so Nautelle
   can tell "port taken, retry on another" from other failures. Failing
   before the Chromium check makes it fast, and creating no run directory
   keeps a caller's `--run-id` reusable. A 5xx still means someone else's
   server holds the port, so the fresh probe is stricter than the readiness
   probe (`status < 500`). Residual race: an app that binds the port after
   the probe and before ours answers could still be recorded; the docs
   recommend a strict-port dev command (`vite --strictPort`), which then
   exits and fails the start.

8. **No shell, on every OS.** `devCommand` is still spawned without a shell
   (`shell: false`, ADR-0003 §6); substitution happens per array element
   before `spawn`, so a substituted value is one `argv` element on Linux,
   macOS and Windows, and Node's own Windows argument quoting applies. DemoFlow
   expands `${PORT}` itself, so the same config works on Windows; `%PORT%`
   and `$PORT` are passed through as literal text. The docs say so.
   *Why:* one config for all three OSes (ADR-0002) and no injection surface:
   a substituted URL can never become shell syntax.

9. **JSON Schema describes what the author writes.** In
   `project-config.schema.json`, `baseUrl` and `devCommand.readyUrl` keep the
   `^[hH][tT][tT][pP][sS]?://` pattern but drop `"format": "uri"` (a `{` is
   not a valid URI character, so editors would flag `http://localhost:${PORT}`),
   and they, `devCommand.command` and `devCommand.args` carry a description
   naming `${PORT}`, `${PORT:-n}`, `${BASE_URL}` and the precedence. The zod
   schema still validates the substituted value as a URL. The override lives
   in `jsonSchemas()`; the file is regenerated with
   `bun run --filter @demoflow/core schema`.
   *Why:* the schema is for editors (`$schema` in the config); runtime
   validation is unchanged and stricter.

10. **Backwards compatible.** A config with no `${` behaves exactly as on
    0.5.0, with or without `PORT` in the environment, except Decision 5: a
    `--base-url` on another origin is now allowed instead of refused, and an
    explicit `allowedOrigins` that lacked the base URL's origin now gains it
    (such a config failed readiness before). Without `--fresh-app`, an app
    already answering on `readyUrl` is still reused and never stopped.
    *Why:* existing users and the 0.4.0/0.5.0 Nautelle call keep working.

11. **One slice.** Core templating, the two flags and the docs stay inside
    `packages/core` and `apps/cli` plus three docs pages, with no other open
    issue touching them. *Why:* splitting would ship templating without the
    flag that makes it useful in parallel; the docs are a few paragraphs.

## Acceptance criteria

- [ ] **Two parallel runs.** A test in the CLI's real-run suite (run by
      `.github/workflows/execution-plane.yml` on Linux, macOS and Windows)
      creates two temporary checkouts A and B of the same tiny app: a
      `server.mjs` that listens on the port from its `--port` argument and
      serves `<h1>checkout A port <argv port> env <process.env.PORT></h1>`
      (its checkout name read from a file next to it). Both have the same
      config: `baseUrl: "http://127.0.0.1:${PORT}"`, `devCommand:
      { command: <node>, args: ["server.mjs", "--port", "${PORT}"], readyUrl:
      "${BASE_URL}/" }`, and a scenario that navigates `/` and `assertText`s
      its own checkout name and port twice. It picks two free ports and starts
      `demoflow run --json --port <A>` in A and `--port <B>` in B at the same
      time. Both exit 0, each `result.json` is `completed`, each run has its
      MP4, and both servers are gone afterwards.
- [ ] **`--fresh-app`.** With a server already listening on port P (one test
      answering 200, one answering 500), `demoflow run --port P --fresh-app`
      exits 2 within 5 s, stderr starts with `app-already-running:` and
      names the URL, stdout is empty with `--json`, no run directory exists,
      the browser check is never called (`deps.browser` fake) and
      `devCommand` (`demoflow-no-such-command`) is never spawned. Without
      `devCommand`: exit 2, `fresh-app-needs-dev-command`. Without
      `--fresh-app`, the existing "uses an app that already answers" test
      still passes.
- [ ] **Core, `packages/core/test/config-template.spec.ts` (new) and
      `project-config.spec.ts`:** `${PORT}` substituted in `baseUrl`,
      `readyUrl`, `command`, each `args` element; `${BASE_URL}` from the
      substituted `baseUrl` and from a `baseUrl` override; `${PORT:-3000}`
      used only when no port is given; `$${PORT}` stays `${PORT}`; issues
      with the field path and code for `${HOME}` (`unknown-variable`), `${PORT`
      (`unclosed-variable`), `${BASE_URL}` in `baseUrl` and `${PORT}` in
      `allowedOrigins` / `artifactsDir` (`variable-not-allowed`),
      `${PORT:-x}` (`invalid-default`), missing port (`missing-port`), and
      environment `PORT=abc` only when used (`invalid-port`); a config without
      `${` parses to the same value as on 0.5.0 with and without variables;
      `allowedOrigins` omitted → the effective origin, given → effective
      origin added once. `packages/core` still imports nothing from `node:`.
- [ ] **CLI, `apps/cli/test/config/project.spec.ts`:** precedence `--port` >
      `PORT` > default; strict mode throws `invalid-config` with
      `missing-port`; stand-in mode loads the same config without a port;
      `invalid-port` for `--port 0`, `65536`, `12a`.
- [ ] **`apps/cli/test/app/dev-server.spec.ts`:** the child sees `PORT` from
      `env`; an argument `--title=a b ${PORT}` (substituted beforehand)
      arrives as one `argv` element; `fresh: true` throws `AppStartError`
      when `readyUrl` answers and spawns nothing. All on the three OSes.
- [ ] **`run` wiring:** `--port` without any `${PORT}` in the config prints
      the Decision 6 warning once and still sets `PORT` for the app;
      `--base-url http://127.0.0.1:<p>` against a config whose `baseUrl` is
      `http://localhost:3000` now passes readiness (Decision 5).
- [ ] `demoflow check` and `demoflow list` succeed on a templated config with
      `PORT` unset (Decision 4).
- [ ] `packages/core/schemas/project-config.schema.json` is regenerated and
      `test/json-schema.spec.ts` passes; `baseUrl` and `devCommand.readyUrl`
      have no `format`, and the four fields carry the descriptions of
      Decision 9.
- [ ] Docs: `/docs/cli` (`run` flags table: `--port <n>`, `--fresh-app`; exit
      codes), `/docs/config` ("Starting your app": the syntax, the fields,
      precedence, `$${`, a parallel-runs example, the strict-port advice,
      Windows note), and `apps/cli/README.md` match Decisions 1–8.
- [ ] `docs/specs/README.md` has the #337 row.
- [ ] `bun run check` passes; Woodpecker and the three-OS execution-plane
      matrix are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `packages/core/src/{config-template,parse,project-config,json-schema,index}.ts`, `packages/core/schemas/project-config.schema.json` | #337 | No other open issue touches them. |
| `apps/cli/src/{config/project.ts,app/dev-server.ts,commands/run.ts,commands/errors.ts,main.ts,record/command.ts}` | #337 | No other open issue touches them (open: #287, #289). |
| `apps/cli/README.md`, `apps/web/src/app/docs/{cli,config}/page.mdx`, `docs/specs/README.md` | #337 | No other open issue touches them. |
| `apps/cli/src/mcp/**`, `apps/cli/src/runner/**` | read only | Pick up stand-in mode through `loadProjectConfig`'s default; not edited. |

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i337 | templating, `--port`, `--fresh-app`, docs | packages/core/src/**, packages/core/schemas/project-config.schema.json, packages/core/test/**, apps/cli/src/config/project.ts, apps/cli/src/app/dev-server.ts, apps/cli/src/commands/run.ts, apps/cli/src/commands/errors.ts, apps/cli/src/main.ts, apps/cli/src/record/command.ts, apps/cli/test/**, apps/cli/README.md, apps/web/src/app/docs/cli/page.mdx, apps/web/src/app/docs/config/page.mdx, docs/specs/README.md | — | yes | opus |

## Open questions

None. The release (0.6.0) follows through the release flow after merge.
