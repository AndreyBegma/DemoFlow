# Woodpecker `test-pr` runs out of memory when every package is affected

Issue: [#242](https://github.com/AndreyBegma/DemoFlow/issues/242)
Depends on: nothing

## Summary

A pull request that changes `packages/core` puts every package in scope of the
Woodpecker `test-pr` step: `turbo run test --filter=...[base]` selects core and
all of its dependents, which is all seven packages (api, cli, core, engine,
playwright, renderer, web). Turbo runs them in parallel with its default
concurrency (10). Each runner then starts its own pool: jest uses
`cores − 1` workers, and every vitest package starts its own worker pool. The
playwright and renderer tests start Chromium, and the `postgres` service runs
alongside. Pull request pipelines are cold, so nothing comes from cache.

The agent runs out of memory. PR #241 (#236), pipelines 520–522
(https://ci.luna-realm.com/repos/12/pipeline/52x):

- 521, 522: `A jest worker process (pid=…) was terminated by another process:
  signal=SIGKILL` on two `apps/api` suites, different suites each time. All
  199–208 tests that ran passed. Sibling packages exit 130 and `postgres`
  exits 137, which is SIGKILL (128 + 9).
- 520: `packages/playwright` `probes.spec.ts` fails under the same load.
- The agent was otherwise idle during 522. GitHub's `execution-plane` matrix
  for the same commit is green.

The agent host (the staging host) has 16 cores and 61 GB of RAM. When this
spec was written, 30 GB was available and the 7 GB of swap was full. The
host also runs the staging stack and the developer's own sessions, so the CI
does not get the whole machine.

The push/manual `test` step runs the same command in full mode: a push to
`main`, and a manual run, including a manual run on `develop`, which gates
`build-staging`. A push to `develop` runs no tests (the header comment of
`pipeline.yml`), so an ordinary merge does not hit this.

`build` already runs with `--concurrency=2` for the same reason. `test` was
never bounded.

## Scope

### In scope

- `.woodpecker/pipeline.yml`: the shared `&test_commands` anchor (used by both
  `test` and `test-pr`), the step environments, and the header comment.
- If Decision 3 is needed: the five `vitest.config.ts` files (`apps/cli`,
  `packages/core`, `packages/engine`, `packages/playwright`,
  `packages/renderer`), and the `apps/api` jest configuration.

### Out of scope

- `.github/workflows/**`: GitHub Actions stays as it is.
- The affected/full mode logic, the docs-only path filter, and the
  security model (ADR-0011): no new volume, socket or host cache for pull
  requests.
- Pipeline 486's Docker network exhaustion ("all predefined address pools
  have been fully subnetted"). That is a separate host issue.
- Making individual tests use less memory.

## Decisions

1. **Bound turbo.** The `bun run test` line in `&test_commands` becomes
   `bun run test --concurrency=2 $${FILTER}` (or the `--` form that `build`
   uses, whichever form bun passes through to turbo; check the turbo output,
   which prints the concurrency it ran with). Both steps share the anchor, so
   `test` and `test-pr` both get it. Two is the bound `build` already runs
   with on this agent, and builds succeed. With two tasks at once, at most
   two runner pools and at most one Chromium (playwright or renderer) are
   alive at the same time, plus Postgres.
2. **CI-only.** The bound lives only in `pipeline.yml`. The root `test`
   script, `turbo.json` and the GitHub workflows are untouched, so local
   `bun run test` and GitHub Actions behave as before.
3. **Per-runner cap, only if 1 is not enough.** If the fix PR's forced full
   run (Acceptance) still shows a SIGKILL or exit 137 with Decision 1 in
   place, also cap the workers each runner starts:
   - Woodpecker sets `DEMOFLOW_TEST_MAX_WORKERS: '4'` in the `test` and
     `test-pr` environments, and adds it to `turbo.json`
     `globalPassThroughEnv` so turbo passes it to the tasks.
   - Each vitest config reads it into `maxWorkers` (`poolOptions` for the
     vitest version in use) only when it is set. The jest config does the
     same for `maxWorkers`. Moving jest's config from `package.json` to
     `jest.config.ts` for this is allowed.
   - Unset means today's defaults, so local runs and GitHub Actions are
     unchanged.
   - Do not pass `-- --maxWorkers` through turbo: turbo forwards it to every
     task, and `apps/web` runs `node --test`, which does not accept it.
4. **The bound is a guess, documented as one.** The implementer cannot ssh to
   the agent, so the bound cannot be sized from measured peak memory. The
   header comment of `pipeline.yml` gets one short paragraph: the bound, the
   reason (#242: SIGKILL under parallel tests on a shared 61 GB host), and
   the rule to raise it only after a forced full run passes at the higher
   value. If the implementer can read the agent's memory (the Woodpecker
   agent API, or `free` in a step on a push branch) they record what they
   saw in the PR description. They do not add a host-inspecting step to
   pull request pipelines.
5. **No masking.** No test is skipped, retried or given a longer timeout to
   make the run pass. If a test still fails with the bound in place and no
   SIGKILL, it is a separate bug: file it and do not fold it into this fix.

## Acceptance criteria

- [ ] `&test_commands` runs `turbo run test` with `--concurrency=2`. The
      step log of `test-pr` shows it.
- [ ] The test-mode block (merge base, root-file check, `FILTER`, the
      "test mode:" echoes) is unchanged except for the `bun run test` line.
      The security notes in the header are unchanged. The bound and its
      reason are added to the header.
- [ ] Every package in scope passes in a Woodpecker pull request pipeline,
      with no SIGKILL, no exit 130 or 137 and no OOM. Either:
      - PR #241's pipeline, rebased on the fix, passes `test-pr`; or
      - the fix PR's own run takes full mode and passes. Editing
        `.woodpecker/` already matches the root-file pattern, so it should
        print `test mode: full (root files changed …)`. Quote that line in the
        PR description. If it does not take full mode, add a temporary
        commit that changes `packages/core` trivially, get a green run, and
        drop the commit before marking the PR ready.
- [ ] No test is skipped, retried or given a longer timeout (Decision 5).
- [ ] `.github/workflows/**` is untouched. If Decision 3 is applied, a local
      `bun run test` with `DEMOFLOW_TEST_MAX_WORKERS` unset still uses the
      runners' default worker counts.
- [ ] `bun run check` is green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `.woodpecker/pipeline.yml` | #242 | None in flight. |

## Open questions

None.
