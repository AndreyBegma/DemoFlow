# CI — stable real-run tests on the execution-plane matrix

Issue: [#44](https://github.com/AndreyBegma/DemoFlow/issues/44) · bug · high ·
Related: [spec 6 OS matrix](6-os-matrix.md), [ADR-0002](../adr/0002-develop-integration-staging-and-os-matrix.md)

Depends on #47

## Summary

`develop`'s `execution-plane (ubuntu-latest)` is red: `packages/renderer/test/ffmpeg/render.spec.ts` ›
"covers the password field on every frame until the navigation (login)" sampled
frames `27,42,57,72,72 of 85` and read one frame too few (run 39120234521)
[Confirmed]. Separately, the real-run test files (engine, renderer, CLI) run in
parallel on a 3–4 vCPU runner and starve each other: the customers render took
42–160 s on the same Ubuntu runner, and the CLI `--json` test was at 106–115 s
against a 120 s limit before it was raised to 240 s [Confirmed, PR #43 analysis].
This item makes the frame sampling correct and stops the real-run files from
competing, so timeouts can come back down.

## Scope

### In scope

- The login mask test's frame sampling: compute sample indices from the
  rendered file's actual frame count, distinct by construction.
- Run the **real-run** test files of `@demoflow/renderer` and `apps/cli` one at
  a time on CI (Vitest `fileParallelism: false` for those packages, or an
  equivalent grouping), keeping pure unit files parallel if the config allows.
- Report per-OS durations before and after; lower the raised timeouts
  (`render.spec.ts` 240 s, `build.spec.ts` 300 s hook, `cli.spec.ts` 240 s)
  to at least 2× the new worst observed duration.

### Out of scope

- The spinner test quarantine (#40) and the screencast stalls themselves.
- Turbo's cross-package parallelism (engine vs renderer vs CLI) unless the
  numbers show it is the remaining cause — then say so in the PR.

## Decisions

1. **Diagnose the sampling collision before fixing it** — the PR names why two
   indices mapped to frame 72 (rounding of a duration-derived index, or an
   output shorter than the plan). — orchestrator (owner delegated).
2. **Serialize real-run files within a package on CI**; locally the behaviour
   may stay parallel. — orchestrator.
3. **Timeouts are set from data**: 2× the worst observed duration across the
   three OSes, with the numbers in the PR. — orchestrator.

## Acceptance criteria

- [ ] The login mask test samples distinct frames derived from the rendered
      file's frame count; a unit-level check of the index computation.
- [ ] `execution-plane` green on all three OSes on the PR **three runs in a
      row** (re-runs of the same commit), and Woodpecker green.
- [ ] The PR reports per-OS durations of each real-run test file before and
      after, and the new timeouts with their basis.
- [ ] No real-run test is closer than 50 % to its timeout on any OS in those
      three runs.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i44 | real-run test stability | packages/renderer/test/**, packages/renderer/vitest.config.ts, apps/cli/test/**, apps/cli/vitest.config.ts, packages/engine/vitest.config.ts | #47 | yes | opus |

One slot. `opus`: the sampling collision's cause is not yet proven.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/renderer/test/** | i44 | #47 edits `build.spec.ts` — i44 starts after #47 merges |

## Risks

- **Serial files lengthen CI wall time** (medium). Mitigation: measured in the
  PR; the matrix runs in parallel across OSes anyway.
