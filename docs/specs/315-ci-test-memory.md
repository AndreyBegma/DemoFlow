# Woodpecker `test-pr` still runs out of memory when every package is affected

Issue: [#315](https://github.com/AndreyBegma/DemoFlow/issues/315)
Depends on: nothing

## Summary

[#242](242-woodpecker-test-oom.md) bounded `turbo run test` to
`--concurrency=2`. That bound is per turbo task, not per process: each task
still starts its own worker pool sized to the host. `apps/api` runs jest with
the default `cores − 1` workers (15 on the 16-core agent host), and every
vitest package starts a pool of its own. With two tasks at a time, Chromium,
FFmpeg and the `postgres` service beside them, and a second Woodpecker agent
(another repository) on the same host, memory still runs out.

PR #314 (square export, changes `packages/core`, so every package is in
scope) failed `ci/woodpecker/pr/pipeline` three times in a row on the same
commit `f7d479e` — pipelines 624, 627 and 629:

- `@demoflow/api`: `A jest worker process (pid=…) was terminated by another
  process: signal=SIGKILL` on different suites each time (launches, github,
  projects). Every test that ran passed.
- `postgres` exits 137 (SIGKILL); `@demoflow/engine` exits 130.
- Pipeline 616 (PR #312, also changes `packages/core`): FFmpeg in
  `@demoflow/renderer` failed with `Cannot allocate memory`.
- GitHub's `execution-plane` matrix for the same commits is green.

## Scope

- Cap the per-task worker pools **in CI only**.
- Keep `--concurrency=2` and the affected-package filter as they are.
- Update the header comment of `.woodpecker/pipeline.yml`.

### Out of scope

- Moving CI to another host, adding memory, or limiting the number of
  Woodpecker agents. Those are the person's.
- Skipping, quarantining or splitting tests.
- GitHub Actions workflows.

## Decisions

1. **Cap pools, not tasks.** jest in `apps/api` runs with `--maxWorkers=2`
   when `CI` is set; each vitest config sets `maxWorkers: 2` (and
   `minWorkers: 1`) when `process.env.CI` is set. *Why:* the pool is what
   multiplies memory; dropping turbo to `--concurrency=1` would serialise
   seven packages and roughly double the step's wall time for the same
   saving.
2. **Local runs unchanged.** The cap reads `CI`; a developer's `bun run test`
   keeps full parallelism. *Why:* the problem is the shared CI host, not the
   test suite.
3. **Where the jest cap lives.** In the Woodpecker test command (pass
   `--maxWorkers=2` through turbo to the api task, or set it in
   `apps/api`'s jest config behind `CI`) — whichever keeps `bun run test` in
   `apps/api` identical locally. Choose one and say which in the PR body.
   *Why:* either is one line; the constraint is local parity.
4. **Proof.** The PR forces a full run (every package affected) on Woodpecker
   and links the green pipeline number in its body, as #242 did. *Why:* the
   bound is still a guess until a full run passes.

## Acceptance criteria

- [ ] With `CI` set, `apps/api` jest uses at most 2 workers and every vitest
      package (`packages/core`, `engine`, `renderer`, `playwright`,
      `apps/cli`, and `apps/web` if it uses vitest) at most 2.
- [ ] Without `CI`, the test commands behave exactly as before.
- [ ] `.woodpecker/pipeline.yml` keeps `--concurrency=2`; its header comment
      explains the per-task cap and links #315.
- [ ] A forced full `test-pr` run passes on Woodpecker; the PR body links it.
- [ ] No test is skipped, quarantined or removed.
- [ ] `bun run check` and `bun run build` are green.

## Test plan

- Locally: `CI=1 bun run test` in `apps/api` shows 2 workers; without `CI`,
  the default.
- Woodpecker: the PR's own pipeline must touch `packages/core` (or force the
  full filter) so every package runs; it must pass.

## Touches

- `.woodpecker/pipeline.yml`
- `apps/api/package.json` (jest config) — if Decision 3 lands there
- `packages/core/vitest.config.ts`, `packages/engine/vitest.config.ts`,
  `packages/renderer/vitest.config.ts`, `packages/playwright/vitest.config.ts`,
  `apps/cli/vitest.config.ts` (each that exists)
