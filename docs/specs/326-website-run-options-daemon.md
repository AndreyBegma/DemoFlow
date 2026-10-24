# The runner daemon renders the formats a website-started run asks for

Issue: #326
Depends on: nothing to build. The protocol is in
[website-run-options-api](website-run-options-api.md#protocol). Merge after
#325, so staging has both ends.

## Summary

[ADR-0017](../adr/0017-website-run-options.md) lets the website choose the
output formats of a run it starts, and makes the machine the place where that
choice is checked. This slice is the daemon's side.

- The daemon tells the API it accepts the option, in `launches.sync`.
- On `run.start` with `options`, it checks the options against a closed
  allow-list and refuses anything else.
- It turns the checked formats into `--format` arguments of the
  `demoflow run` child. The child renders them exactly as a local
  `demoflow run --format` does (spec 133), with the project's own render
  settings.

Nothing else about a website-started run changes: the checks of spec 248,
the progress of spec 302, the cancel and the time cap.

## Scope

### In scope

- `apps/cli/src/runner/launch/options.ts` (new): `RUN_OPTIONS` and
  `checkRunOptions(value): { ok: true; formats: RenderFormat[] | null } | { ok: false }`.
  Pure; no I/O.
- `apps/cli/src/runner/launch/index.ts`: read `options` in `handle`, check it
  in `start`, append `--format` arguments in `run`.
- `apps/cli/src/runner/connection.ts`: `runOptions` on `launches.sync`.
- Tests: `apps/cli/test/runner/launch-options.spec.ts` (new),
  `launch.spec.ts`, `connection.spec.ts`, `fakes.ts`.

### Out of scope

- The API (#325) and the web
  (#327).
- `--headed`, `--base-url`, `--out`, environment variables, or any other
  option (ADR-0017 §2–3).
- A local setting to restrict which formats the website may ask for
  (ADR-0017, Consequences).
- Changes to `demoflow run`, the renderer or `@demoflow/core`. `--format`
  already exists.

## Decisions

1. **Announce.** `onOpen` in `connection.ts` sends
   `{ type: 'launches.sync', running, runOptions }`, where `runOptions` is
   `RUN_OPTIONS` (`['formats']`) when a launcher is wired
   (`deps.launches !== undefined`) and `[]` otherwise.
   - *Why tie it to the launcher:* a connection without a launcher ignores
     `run.start` altogether; claiming options there would be false.
   - *Why a constant, not computed per project:* the daemon accepts the option
     for every registered project; what it checks is the value.
2. **Read.** `handle` passes `message.options` (which may be `undefined`) to
   `start` unchanged. A `run.start` whose `requestId`, `rootPath` or
   `scenarioId` is not a string stays "malformed" and ignored, as in spec
   248, Decision 12.
3. **The allow-list** (`checkRunOptions`), ADR-0017 §1 and §4:
   - `undefined` → ok, `formats: null` (the project's own formats);
   - otherwise it must be a plain object (not null, not an array) whose only
     own key is `formats`;
   - `formats` must be an array of 1 to 9 entries, each a string that is a
     member of `RENDER_FORMATS` (`@demoflow/core`), none twice.
   - Anything else is `{ ok: false }`.
   The result holds the **enum's own constants**, looked up with
   `RENDER_FORMATS.find((known) => known === value)`, as `collectFormat` in
   `apps/cli/src/main.ts` does, in the order received.
   - *Why refuse an unknown key instead of ignoring it:* ADR-0017 §4. A newer
     API that adds an option must not reach an older daemon that would drop
     it silently; the API's capability gate is the first line, this is the
     second.
   - *Why the constants:* nothing from the message reaches `argv` but values
     the daemon itself defines, the same rule as spec 248, Decision 6.
4. **Where it runs.** In `start`, after `busy`, `io` (closing) and
   `reporting-off`, before a `Launch` is created. A failure answers
   `run.error` with `options-invalid`, logged as `refused options-invalid`.
   - *Why before the project and scenario checks:* it is pure and cheap, and
     a refused start should touch no file.
   - *Why after `busy` and `reporting-off`:* those describe the machine and
     are the answers a person can act on first.
5. **Arguments.** `run` appends `--format <f>` once per checked format, after
   `--project <root>`, in the order received:
   `run <file> --json --progress --run-id <id> --project <root> --format gif --format mp4-vertical`.
   With `formats: null`, nothing is appended, and the argument list is
   exactly today's.
   - *Why `--format` and not a temporary config:* it is the flag a local user
     already has (spec 133); the child's render, report and `result.json`
     treat it as they treat a local run. Nothing is written to the project.
6. **No headed mode.** The child never gets `--headed`. There is no code path
   that could add it: `checkRunOptions` returns formats only.
7. **Log.** The launch start line gains the number of formats, or `default`
   (`launch <id>: started run <run id>, formats 2`). No path and no scenario
   id, as before (spec 248, Decision 13).
8. **Version skew.** With an API older than #325,
   `runOptions` is stripped by the API and `options` is never sent: the
   daemon behaves as today. A format added to `RENDER_FORMATS` after this
   daemon was built is unknown to it and refused with `options-invalid`
   (ADR-0017, Consequences).

## Acceptance criteria

Vitest under Node, on the execution-plane matrix (Linux, macOS and Windows):

- [ ] `checkRunOptions` (unit): `undefined` → `formats: null`;
      `{ formats: ['gif', 'mp4-vertical'] }` → those, in order, and each is
      the identical `RENDER_FORMATS` constant; `null`, `[]`, `'mp4'`,
      `{}`, `{ formats: [] }`, `{ formats: 'mp4' }`,
      `{ formats: ['mp4', 'mp4'] }`, `{ formats: ['mov'] }`,
      `{ formats: [1] }`, ten formats, `{ formats: ['mp4'], headed: true }`
      and `{ formats: ['mp4'], baseUrl: 'https://x' }` → not ok.
- [ ] `launches.sync` (`connection.spec.ts`, against `ws-server.ts`) carries
      `runOptions: ['formats']` with a launcher and `[]` without.
- [ ] `run.start` without `options` spawns exactly
      `run <file> --json --progress --run-id <id> --project <root>` (the
      existing test, unchanged).
- [ ] `run.start` with two formats spawns the same followed by
      `--format gif --format mp4-vertical`.
- [ ] Each invalid `options` of the unit test, sent in `run.start`, answers
      `run.error` `options-invalid`, spawns nothing, reads no project file
      (fake fs records no call), and a following valid start is not `busy`.
- [ ] `busy` and `reporting-off` still win over invalid options.
- [ ] `demoflow mcp` tests and the `--format` tests of `demoflow run` stay
      green.
- [ ] `bun run check` and `bun run build` are green, and so is the
      execution-plane matrix.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/cli/src/runner/launch/**`, `apps/cli/test/runner/**` | this issue | No other open issue today; rebase on any later launch work. |
| `apps/cli/src/runner/connection.ts` | this issue | One field on `launches.sync`. |

## Open questions

None.
