# ADR-0015: Playwright tests become scenarios through a recording fixture

Status: accepted · Date: 2026-10-22 · Amends: [ADR-0001](0001-control-plane-execution-plane-one-package.md) §3 ·
Keeps: [ADR-0003](0003-scenario-format-and-project-config.md) ·
Spike: [#202](../research/202-playwright-reuse-spike.md) ·
Specs: [208](../specs/208-playwright-fixture.md), [209](../specs/209-playwright-scrolls-captions.md)

## Context

Roadmap Phase 7, item 4: reuse existing Playwright tests as demo scenarios.
Spike #202 measured three ways on three probe tests (`login`, `customers`,
`tour`; 30 hand-written steps in all), on Linux, macOS and Windows:

- trace import: 24 of 30 steps (80%). It also depends on the undocumented
  trace format and internal selector syntax, pinned to one Playwright version;
- source conversion: 24 of 30 (80%). A helper function is code, and the
  converter would put `typescript` (26 MB) into `demoflow`'s runtime
  dependencies;
- a Playwright Test fixture: 28 of 30 (93%), with public Playwright API only.

A fixture that writes the timeline and video itself records at test speed:
under 0.3 s for a login flow the engine replays in 2.6–3.3 s. To be a demo, it
would need a second copy of the engine's pacing, pointer, masks and sync mark.
When the same fixture writes a scenario instead, the engine replayed all three
recorded scenarios unchanged on all three operating systems.

ADR-0001 §3 lists the modules of the one `demoflow` package and what each may
import. A fixture that runs inside the user's test runner is a new module with
a new public entry, so that table moves. ADR-0001 is not rewritten; this
record amends its table.

## Decision

1. **The fixture records a scenario. The engine still records the demo.**
   `demoflow/playwright` exports `test` and `expect`. When `DEMOFLOW_RECORD=1`
   is set, the fixture writes each passing test's actions as a `.demo.json`
   scenario under `demoflow/`. `demoflow run` then runs that scenario like any
   other. The scenario stays the contract the engine executes (ADR-0003). The
   fixture never writes a timeline or a video. Without the variable it records
   nothing and wraps nothing.
2. **One package, a new entry.** ADR-0001 §3's module table gains a row:

   | Path | Holds | May import |
   |---|---|---|
   | `packages/playwright` (`@demoflow/playwright`) | the Playwright Test fixture that records a scenario | core; `@playwright/test` as a peer |

   It is published as the `demoflow/playwright` subpath of the one `demoflow`
   package, which `apps/cli` stages; the CLI's own code does not import it.
   `@playwright/test` is an optional peer dependency of `demoflow`, so
   installing `demoflow` without it still works. The fixture runs inside the
   user's test runner, on the user's Playwright version. The replay uses
   DemoFlow's pinned `playwright`. The two versions may differ.
3. **Public Playwright API only.** No trace format and no internal selector
   syntax. The fixture wraps `Page`, `Locator`, `expect` and `test.step`. That
   a `Proxy` over them keeps working is Playwright behaviour, not a promise, so
   the fixture declares a range of supported `@playwright/test` minors and its
   tests run against each of them.
4. **Secrets.**
   - A fill into `input[type=password]`, or of a value equal to an
     environment variable's, is never written in clear.
   - It becomes `valueFrom: { env }` when the variable is known.
   - A password with no variable behind it fails the test with its line.
     ADR-0003 §5 is unchanged.
5. **What a test cannot express is not guessed.**
   - An action the scenario format cannot express (a chained locator, raw
     keyboard input, a step type the format lacks) fails the test with its
     line, because a replay without it would diverge.
   - An assertion or scroll it cannot express is left out and reported in the
     test's annotations, because the replay does not depend on it.
   - A scroll is recorded from its effect, not from the code that caused it.
   - A caption, or a scene beyond `test.step`, comes from explicit helpers the
     fixture exports.
   - Control flow is recorded as it ran, once.

## Consequences

- Teams get a demo from an existing test by changing one import and setting
  one variable. The recorded scenario is committed and reviewed like a
  hand-written one, and can be edited to add captions and zoom.
- `demoflow` gains an optional peer dependency and a module that runs inside
  third-party test runners. A Playwright change in how `Page`/`Locator`
  tolerate a `Proxy` breaks recording loudly (a `TypeError` in the test), and
  the per-minor test catches it before users do.
- The published package gains an `exports` map. Anything other than the bin
  and `demoflow/playwright` is not importable from `demoflow`.
- A Playwright `trace.zip` from a test that fills a password holds it in
  clear. That is Playwright's behaviour, and DemoFlow's docs say so.
- Trace import and source conversion are not pursued (spike #202). Their probe
  code stays on the spike's commit for reference.
