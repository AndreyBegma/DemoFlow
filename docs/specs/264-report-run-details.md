# The run report sends stage statuses, renders and a redacted failure message

Issue: [#264](https://github.com/AndreyBegma/DemoFlow/issues/264)
Depends on: [#263](263-run-details-api.md) (merge order).

## Summary

With [#263](263-run-details-api.md) the API stores a run's stage statuses, its
rendered files and its failure. This slice makes the CLI send them in the
report `demoflow run` posts to `POST /runner/runs` at the end of a paired run.
A website-started run reports through the same child `demoflow run`
(spec [248](248-runner-starts-runs.md)), so it is covered too.

Everything comes from `result.json`. The failure message is the one field
that can carry something [ADR-0008](../adr/0008-cloud-boundary.md) §2 forbids
(a URL's query string, a local path), so it is cleaned on the machine before
it leaves.

## Scope

### In scope

- `apps/cli/src/runs-report/report.ts`: `RunReport` and `buildReport`.
- `apps/cli/src/runs-report/redact.ts` (new): `redactMessage`.
- `apps/cli/test/runs-report/**`.

### Out of scope

- The API (#263) and the web (#265).
- The scenario's steps (see spec 263, Out of scope).
- Reporting a re-render: `demoflow render` still reports nothing
  (spec [255](255-render-command.md), Decision 7).
- Any change to when a report is sent (pairing, `CI`,
  `DEMOFLOW_NO_REPORT`, the 2 s timeout, silent failure).

## Decisions

1. **`stages`.** `{ [name]: result.stages[name].status }` for the six stages.
   Nothing else from a stage (times, error) is copied into it.
2. **`renders`.** One entry per format, from `result.renders` in order, the
   first entry of each format winning (the same rule `formats` already
   applies through a `Set`): `{ format, width, height, sizeBytes,
   durationMs }`. `durationMs` is rounded to an integer. `file`, `renderer`
   and `fps` are not sent: `file` is a local path (ADR-0008 §2), and neither
   the page nor a source asks for the others.
   - An empty `result.renders` sends `renders: []`, not nothing: the run
     reported that it rendered no file.
3. **`failure`.** Only when `result.status` is `failed`: the first stage in
   `STAGE_NAMES` order whose `status` is `failed` and which has
   `error.message`. `failure = { stage, message: redactMessage(...) }`. When
   no failed stage has a message, or the redacted message is empty, `failure`
   is left out.
   - *Why the first stage in pipeline order:* it is the cause; later stages
     fail because of it. `exitCodeFor` uses the same order.
   - `failedStep` keeps its current rule; the two are independent fields.
4. **Redaction**, `redactMessage(message, { root, home, pathApi })`, in this
   order:
   1. **URLs.** In every `http://` or `https://` URL, everything from the
      first `?` or `#` to the end of the URL (the next whitespace, quote,
      `)` or `>`) is removed. `https://host/p?token=x#y` becomes
      `https://host/p`. *Why:* ADR-0008 §2 forbids query strings of URLs;
      a fragment can carry a token just as well.
   2. **Paths.** Every occurrence of the canonical project root is replaced
      by `<project>`, then every occurrence of `os.homedir()` by `~`. On
      Windows (`pathApi === path.win32`) both are matched case-insensitively
      and with either separator. The root goes first because it usually sits
      under the home. *Why:* ADR-0008 §2 forbids local file paths in what a
      runner sends. The root itself is already sent as `rootPath` (spec 178),
      but replacing it keeps the message short and readable; the home covers
      paths outside the project (a browser cache, the artifacts home).
   3. **Length.** Trimmed, then cut to 999 characters plus `…` when longer
      than 1000 (the API's bound).
   - What is not redacted: other absolute paths (for example `/tmp/...`), and
     text from the page the scenario asserted on. The engine already keeps
     `fill` values out of error messages (spec [42](42-masked-fill-failure.md)).
     *Why stop here:* the ADR allows "the error message of a failed step";
     these rules remove what the ADR names as forbidden without guessing at
     arbitrary text.
5. **Testability.** `redactMessage` is a pure function taking `root`, `home`
   and `pathApi`; `buildReport` takes an optional `home` (default
   `os.homedir()`), like its existing optional `pathApi`, so tests run the
   Windows cases on every OS.

## Acceptance criteria

Vitest under Node:

- [ ] A passed run's report has `stages` (all six), `renders` with one entry
      per format (a duplicate format keeps the first), and no `failure`.
- [ ] A failed verification with `stepIndex` sends `failure.stage:
      'verification'` with its message and `failedStep`; a readiness failure
      without `stepIndex` sends `failure.stage: 'readiness'` and no
      `failedStep`.
- [ ] `redactMessage`: `https://host/p?token=x#y` → `https://host/p`; a URL in
      quotes and in parentheses; the root → `<project>`; the home → `~`; a
      Windows root `C:\Users\Ann\app` matched as `c:/users/ann/app` with
      `path.win32`; a 5000-character message is 1000 characters ending in `…`;
      a message that is only whitespace leaves `failure` out.
- [ ] No `file`, `renderer` or `fps` in the report body.
- [ ] Every existing report test passes unchanged.
- [ ] `bun run check` and the execution-plane OS matrix are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/cli/src/runs-report/**`, `apps/cli/test/runs-report/**` | #264 | #266 works in `apps/cli/src/commands/**` and `apps/cli/src/main.ts`; no shared file. |
| The `POST /runner/runs` body | #263 defines it | #264 merges after #263. |

## Open questions

None.
