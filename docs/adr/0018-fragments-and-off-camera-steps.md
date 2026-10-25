# ADR-0018: Step fragments are inlined at load time; off-camera steps are an unrecorded prefix

Status: accepted · Date: 2026-10-25 · Extends: [ADR-0003](0003-scenario-format-and-project-config.md) (scenario format, project config) and [ADR-0004](0004-recording-is-separate-from-rendering.md) (capture model)

## Context

Every DemoFlow scenario of a product that needs an account starts the same way:
open the sign-in page, fill the email and the password from the environment,
click the button and wait for the first page. The steps are copied into each
scenario, and they are recorded, so every video opens on a sign-in form that
the viewer does not need to see.

Card C-171 asks for two things: steps shared between scenarios (fragments,
used with an `include` step) and steps that run but are not shown (off-camera
steps: `"record": false`, and a scenario-level `setup`). It also asks that the
video's duration and markers match what is shown, and that old scenarios keep
running unchanged.

`packages/core` holds the scenario contract and must stay free of Node APIs
(ADR-0001). The engine records with Playwright's `recordVideo`, which starts
when a browser context is created and cannot be paused.

## Decision

1. **A fragment is a JSON file in the project, inlined when the scenario is
   loaded.** It lives at `<fragmentsDir>/<name>.json`, where `fragmentsDir` is
   a new optional key of `demoflow.config.json` (default
   `demoflow/fragments`). It has `schemaVersion: 1`, optional `params` (each
   with an optional `default`) and 1 to 200 steps that use the parameters as
   `{{params.<name>}}`. `parseScenario` replaces each `include` with the
   fragment's steps, the parameters filled in. The resolved scenario is
   plain: it holds no `include`, and it parses again without any fragment.
   - *Why inline:* the engine, the timeline, `result.json` and a run's
     `scenario.json` keep one shape. A run directory stays self-contained and
     re-renderable when the fragment later changes or is gone.
   - *Why `schemaVersion` stays 1:* every new field is optional and every old
     scenario parses to the same steps. A scenario that uses the new fields
     fails on an older CLI with a clear unknown-key error, which a version bump
     would not improve.
2. **The core never reads a file.** `parseScenario` takes a
   `FragmentSource`, a synchronous function from a name to the file's parsed
   JSON or a failure; the CLI supplies one that reads below the project root.
   For the daemon's asynchronous filesystem, `prefetchFragments` walks the
   includes ahead of time. A fragment file must be inside the project: the
   CLI compares real paths, and the daemon's launch checks, as for scenario
   files, refuse a link.
3. **Includes are checked as strictly as steps.** Includes nest up to 8 deep.
   A cycle, a missing or unreadable fragment, an unknown or missing parameter,
   or a step that is invalid once filled in is a validation error. It is
   reported at the `include` in the scenario, its message naming the fragment
   file and the step inside it. A fragment holds no `repeat`, and an
   `include` cannot sit inside a `repeat`, so placeholders have exactly one
   scope each.
4. **Off-camera steps are the opening steps of a run, and only those.** They
   are the scenario's `setup`, then any leading steps with `"record": false`
   (on a step, a `repeat` or an `include`). A `"record": false` step after a
   recorded one is an error, and at least one step must be recorded.
   - *Why a prefix only:* hiding a span in the middle of a video means cutting
     the recording and stitching time back together. It also means explaining
     a jump on screen. Signing in and other preparation happen before the
     story starts, so a prefix covers the need without cutting video.
5. **The engine runs off-camera steps in a context that records nothing.** It
   then opens the recorded context with that context's storage state
   (cookies and local storage) and reloads the page the off-camera steps ended
   on, before the sync mark. The video, its duration and the timeline start
   at the first recorded step. Step indices still count the off-camera steps,
   so errors point at the authored step. A failed off-camera step fails the
   run with nothing recorded.
   - *Why a second context, not a trimmed video:* nothing hidden is ever
     encoded, so a secret typed off camera cannot leak through a trim that is
     off by a frame. The cost is that state held only in memory or in session
     storage does not carry over, which the docs say.
6. **Recorders write plain scenarios.** `demoflow record` and
   `@demoflow/playwright` (ADR-0015) emit steps only. They write no
   `include`, `record` or `setup`, and their save path validates without
   fragments, so a recording that somehow held an include would be refused
   with a clear error. A person adds fragments and `setup` by hand.

## Consequences

- Two scenarios can share a sign-in fragment, and their videos open already
  signed in.
- The MCP tool descriptions tell agents to reuse fragments and keep
  preparation off camera.
- `validate`, `render` and the MCP `validate_scenario` tool find the project
  only when a scenario includes a fragment, so a plain scenario still
  validates outside any project.
- A website-started run resolves fragments on the machine, from the
  project's own config. The website still sends only a scenario id
  (ADR-0016, ADR-0017).
- A hidden span in the middle of a scenario, if it is ever needed, takes a
  new ADR that supersedes Decision 4.
