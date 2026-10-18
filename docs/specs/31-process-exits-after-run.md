# Fix — a finished run keeps the Node process alive

Issue: [#31](https://github.com/AndreyBegma/DemoFlow/issues/31) · bug ·
Related specs: [3 Engine](3-engine.md), [24 FFmpeg compositor](24-renderer-ffmpeg-only.md), [5 CLI run](5-cli-run.md)

## Summary

After `demoflow run` completes, the Node process stays alive for about 90 s.
Something opened by the engine or the renderer — a Playwright browser or
context, an FFmpeg child process, a pipe, a timer, a socket — is not
released. The CLI hides it: `apps/cli/src/main.ts` calls `process.exit`
once stdout and stderr are flushed, with a comment naming Playwright and
FFmpeg as suspects [Confirmed]. The handle itself was never identified. Any
process that embeds `runScenario` or `ffmpegRenderer.render` — the Phase 2
runner, an MCP server, an in-process test — would carry the leak once per
run. This item names the handle, releases it, removes the CLI workaround, and
adds the tests that would have caught it.

## Scope

### In scope

- Diagnosis: the responsible handle(s), found with `why-is-node-running` or
  `process.getActiveResourcesInfo()` — run ad hoc, not added as a dependency.
- The fix where the handle is opened: `packages/engine/src/**` (browser,
  context, capture observer, clock) and/or `packages/renderer/src/**`
  (decoder and encoder children and their pipes in
  `src/ffmpeg/pipeline.ts`, any probe).
- Removing the `process.exit` workaround from `apps/cli/src/main.ts`.
- Regression tests (Acceptance criteria).

### Out of scope

- The CLI's exit-code contract (spec 5) — unchanged; the code still reaches
  the shell through `process.exitCode`.
- Performance of the engine or the renderer.

## Decisions

1. **The cause is proven before it is fixed.** The pull request names each
   handle that kept the loop alive and where it was opened, with the output
   of the tool that found it. — the issue.
2. **Release what we open.** Close, kill or destroy the resource where it is
   created or in the owning `finally`. If a third-party library holds it
   (Playwright, `ffmpeg-static`, an undici keep-alive socket) and offers no
   clean release, release it from our side — close or destroy the agent, the
   pipe or the process we handed it — with a comment linking the upstream
   issue. `unref()` only for a resource that is not itself a leak (a
   one-shot timer that ends on its own). — the owner.
3. **The CLI workaround goes.** `apps/cli/src/main.ts` sets
   `process.exitCode` and returns; no `process.exit`. The comment about
   Playwright and FFmpeg handles goes with it. — the owner.
4. **Embedding is tested, not only exit.** Two consecutive
   `runScenario` + `render` calls in one process leave the same set of active
   resources as before the first. — the owner.
5. **A bug fix ships with the test that would have caught it** — `CLAUDE.md`.

## Acceptance criteria

- [ ] A child Node process that runs `runScenario` and then
      `ffmpegRenderer.render` on the fixture's `customers.demo.json` exits on
      its own, with code 0, within 2 s of `render` resolving, without
      `process.exit` (automated test; the child is spawned by the test and
      killed on timeout).
- [ ] In one process, `process.getActiveResourcesInfo()` after two
      consecutive `runScenario` + `render` calls equals its value before the
      first (as a multiset of resource types, ignoring the test runner's own).
- [ ] `apps/cli/src/main.ts` contains no `process.exit`; a CLI test runs
      `demoflow run` on `customers.demo.json` and the process exits on its own
      with the spec-5 exit code.
- [ ] The pull request names the handle(s), where each was opened, and how
      it was found.
- [ ] Engine, renderer and CLI tests pass under Node with Vitest, on
      Woodpecker and on all three OSes of the `execution-plane` workflow;
      `bun run check` passes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i31 | diagnosis, the fix, the workaround's removal, the tests | packages/engine/src/**, packages/engine/test/**, packages/renderer/src/**, packages/renderer/test/**, apps/cli/src/**, apps/cli/test/** | — | yes | opus |

One slot: the cause is unknown, so the files cannot be split before the
diagnosis. `opus` because the root cause is not yet proven.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/engine/src/**, packages/renderer/src/** | i31 | #18 and #19 change the engine step loop, the timeline and the renderer plan — they start after #31 merges (owner's order: #17 → #31 → #18 → #19) |
| packages/engine/test/** | i31 | #17 (i17) is live there — i31 starts after #17 merges |

## Risks

- **The handle is in Chromium or Playwright internals** (medium).
  Mitigation: Decision 2 — release it from our side with a comment and an
  upstream link.
- **Platform differences** (medium): a pipe or process may behave
  differently on Windows. Mitigation: the tests run on all three OSes.
- **A flaky timing test** (low): the 2 s bound is measured from `render`
  resolving inside the child, not from spawn; the test's own timeout is
  generous and kills the child.
