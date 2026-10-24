# The runner daemon sends the live progress of a website-started run

Issue: #302
Depends on: nothing to build. The protocol is in
[run-progress-api](run-progress-api.md#protocol). Merge after
#301, so staging has both ends. Start after #285 (PR #297)
has merged: it also edits `apps/cli/src/runner/launch/index.ts`.

## Summary

Spec #301 lets the API show the phase of a website-started
run and its step n of m. This slice makes the machine tell it.

Today nothing machine-readable leaves the `demoflow run` child before it
exits: `spawnNode` calls `child.stdout.resume()` and discards stdout, `--json`
prints the result as one line at the very end, and stderr carries
human lines mixed with the app's and Playwright's output.

- `demoflow run` gains a hidden `--progress` flag. With it, the run prints one
  JSON line on stdout when it starts the app, when each step starts, and
  when it starts rendering.
- The daemon passes `--progress`, reads the child's stdout line by line,
  keeps the latest valid progress, and sends `run.progress` at most once a
  second when it changed.
- Nothing else changes: the run, its report and `run.finished` are as in
  spec 248.

## Scope

### In scope

- `apps/cli/src/commands/progress.ts` (new): the progress line format and an
  `EngineObserver` that prints step lines.
- `apps/cli/src/commands/run.ts` and `apps/cli/src/main.ts`: the hidden
  `--progress` flag and the three emit points.
- `apps/cli/src/mcp/child.ts`: an optional `onStdoutLine` on
  `SpawnRunOptions`. Without it, stdout is discarded as today.
- `apps/cli/src/runner/launch/progress.ts` (new): the line parser and the
  throttle, pure, with the clock injected.
- `apps/cli/src/runner/launch/index.ts`: pass `--progress`, wire the parser
  and the throttle to the launch, stop them when the child exits.
- `apps/cli/test/commands/progress.spec.ts` (new),
  `apps/cli/test/runner/launch.spec.ts`, `apps/cli/test/runner/fakes.ts`,
  `apps/cli/test/runner/daemon-launch.spec.ts`: tests.

### Out of scope

- The API (#301) and the project page (#303).
- Progress for `demoflow mcp` tasks or the human output of `demoflow run`.
- Step contents, captions, stage durations or failure text in progress.
- Replaying progress after a reconnect (spec #301,
  Decision 6).
- `apps/cli/src/runner/connection.ts`: the launcher already sends on the
  socket it is given (`current`).

## Decisions

1. **Channel: stdout lines behind a hidden flag.** `--progress` makes `run`
   print, on stdout, one line per event:
   `{"type":"progress","phase":"app"}`,
   `{"type":"progress","phase":"steps","step":3,"steps":7}`,
   `{"type":"progress","phase":"rendering"}`. The final `--json` result
   stays one line (`formatJson`) and has no `type`, so it is never mistaken
   for progress. *Why:* the daemon already owns the child's stdout pipe and
   ignores it; a pipe works the same on Linux, macOS and Windows. A progress
   file needs polling, leaves a file in the run directory and fights
   Windows renames; an IPC channel changes how the child stays alive (spec
   31); parsing the human stderr breaks on the next wording change.
2. **Emit points**, only with `--progress`:
   - `app`: after every input check, right before `startApp` (the first
     line of the run);
   - `steps`: from a `progressObserver` added to `runScenario`'s
     `observers`. `onRunStarted` counts the expanded steps with
     `expandScenario(event.scenario).steps.length` (`@demoflow/core`);
     `onStepStarted` prints `step: stepIndex + 1` with that total. A total
     over 10,000 prints nothing;
   - `rendering`: right before `buildRenderPlan`, when a video exists.
3. **Progress never fails a run.** The observer's hooks and every write are
   wrapped so that nothing they throw escapes. *Why:* an observer hook that
   throws rejects `runScenario` (engine `EngineObserver` contract); a stdout
   that went away (the daemon died) must not turn a run into a failure.
4. **Reading the child.** `SpawnRunOptions.onStdoutLine?: (line) => void`.
   When set, `spawnNode` reads stdout as UTF-8, splits on `\n`, strips a
   trailing `\r`, and calls it per line. A line longer than **8 KiB** is
   dropped up to its next newline. When unset, stdout is `resume()`d as
   today. A callback that throws is caught. *Why:* the MCP keeps its exact
   behaviour, and the final `--json` line, which can be several KiB, cannot
   grow a buffer without bound.
5. **Parsing.** `parseProgressLine(line)` returns a progress or `null`. It
   accepts only a JSON object with `type === 'progress'` and either
   `phase` `app` or `rendering`, or `phase: 'steps'` with integers
   `1 ≤ step ≤ steps ≤ 10000`. Anything else is `null` and ignored, without
   a log line. *Why:* the daemon never trusts its child's stdout beyond this
   shape, and the result line and any stray output are simply not progress.
6. **Throttle.** A `ProgressGate` per launch, on the injected `Clock`:
   - a progress equal to the last one sent is dropped;
   - if no frame was sent in the last **1 s**, it is sent at once;
     otherwise it waits, replacing any waiting one (latest wins), and is
     sent when the second is up;
   - `stop()` drops what waits. The launcher calls it as soon as the child
     exits, before `run.finished`, so no progress follows the finish.

   The frame is `{ type: 'run.progress', requestId, phase, step, steps }`
   with `step` and `steps` `null` outside `steps`, sent on `current` (the
   socket open at that moment, spec 248 Decision 10). With no socket it is
   dropped. *Why:* the page polls every 2 s; one frame a second keeps it
   current and caps a 15-minute run at 900 frames.
7. **Arguments.** The spawn becomes
   `run <file> --json --progress --run-id <local id> --project <root>`.
   Nothing from the message besides the checked id and root reaches the
   arguments (spec 248, Decision 6). The same `demoflow` install is both
   daemon and child (`CLI_ENTRY`), so the flag is always known.
8. **No log.** Progress is not written to `runner.log`. *Why:* one line per
   step would bury the start and end lines that matter (spec 248,
   Decision 13).

## Acceptance criteria

Vitest under Node, on the execution-plane matrix (Linux, macOS and Windows):

- [ ] `progressObserver` prints a `steps` line per started step with the
      expanded total (a scenario with a `repeat` counts expanded steps), and
      a hook whose write throws does not reject.
- [ ] `parseProgressLine` accepts the three shapes and rejects: non-JSON,
      the `--json` result line, a wrong `type`, an unknown phase, `step: 0`,
      `step > steps`, `steps: 10001`, numbers on `app`.
- [ ] `spawnNode` with `onStdoutLine` delivers lines split across chunks,
      handles `\r\n`, and drops a 9 KiB line without dropping the next one
      (stand-in child); without it, stdout is discarded as before.
- [ ] `ProgressGate` (fake clock): the first progress is sent at once; three
      within a second send the last one when the second is up; a repeat of
      the last sent is not sent; nothing is sent after `stop()`.
- [ ] `run.start` spawns exactly
      `run <file> --json --progress --run-id <id> --project <root>`.
- [ ] A fake child that prints `app`, `steps` 1/2, `steps` 2/2, `rendering`
      and exits: the fake socket receives `run.progress` frames in order,
      throttled, then `run.finished`, and no `run.progress` after it.
- [ ] Output that is not progress (the result line, garbage) sends nothing
      and does not disturb the launch.
- [ ] `demoflow mcp` tests stay green. `bun run check` and `bun run build`
      are green, and so is the execution-plane matrix.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/cli/src/runner/launch/index.ts`, `apps/cli/test/runner/**` | #302 | #285 (PR #297) edits the same files; start after it merges. |
| `apps/cli/src/commands/run.ts`, `apps/cli/src/main.ts` | #302 | No other open issue. |
| `apps/cli/src/mcp/child.ts` | #302 | One optional option; no other open issue. |
| `apps/api/**`, `apps/web/**` | #301, #303 | This slice does not touch them. |

## Open questions

None.
