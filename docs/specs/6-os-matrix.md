# Execution-plane CI on Linux, macOS and Windows

Issue: [#6](https://github.com/AndreyBegma/DemoFlow/issues/6) · Phase 1 ·
Decisions: [ADR-0001](../adr/0001-control-plane-execution-plane-one-package.md),
[ADR-0002](../adr/0002-develop-integration-staging-and-os-matrix.md)

Depends on #5

## Summary

The runner must work on Linux, macOS and Windows from its first release, and
Woodpecker only has Linux agents. This item adds a GitHub Actions workflow
that, on each OS, installs the monorepo, runs the execution-plane tests, and
produces real demo videos of the fixture app through the CLI — uploading them
so a person can watch what each OS rendered.

## Scope

### In scope

- `.github/workflows/execution-plane.yml`.
- Matrix `ubuntu-latest`, `macos-latest`, `windows-latest`; Node 24;
  Bun 1.4.0 (`oven-sh/setup-bun`, pinned by commit SHA like every action).
- Steps: `bun install --frozen-lockfile`; `bunx playwright install chromium`
  (with `--with-deps` on Linux); build the execution-plane packages and the
  fixture; tests of `@demoflow/core`, `@demoflow/engine`,
  `@demoflow/renderer` and `demoflow`; start the fixture preview; `demoflow
  run` for `customers`, `login` (with a generated `FIXTURE_PASSWORD`) and
  `failing` with `--json`; assert exit codes 0, 0, 1; upload every run
  directory's `render/*.mp4` and `result.json` as an artifact named
  `demos-<os>`, kept 14 days.
- Triggers: `pull_request` and `push` on `develop`, with path filters
  `packages/core/**`, `packages/engine/**`, `packages/renderer/**`,
  `apps/cli/**`, `apps/fixture/**`, `package.json`, `bun.lock`,
  `.github/workflows/execution-plane.yml`; plus `workflow_dispatch`.
- `permissions: contents: read`, no secrets, `concurrency` cancelling
  superseded runs of the same ref.

### Out of scope

- Publishing, signing, release automation.

## Acceptance criteria

- [ ] On a pull request touching `packages/engine/**`, the workflow runs on
      all three OS and is green.
- [ ] On a pull request touching only `apps/web/**`, it does not run.
- [ ] Each run uploads `demos-ubuntu-latest`, `demos-macos-latest` and
      `demos-windows-latest`, each with six MP4s (three scenarios × two
      renderers while ADR-0005 is proposed) and three `result.json`.
- [ ] The `failing` step fails the job if its exit code is anything but 1.
- [ ] No step uses a secret, and the workflow's token is read-only.
- [ ] `deploy/README.md` gains a short section on the second CI and how to
      download the demo artifacts.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i6-matrix | the workflow and its documentation | .github/workflows/**, deploy/README.md | — | yes | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| .github/workflows/** | i6-matrix | — |

## Risks

- **Starting the fixture preview on Windows in the background** (medium).
  Mitigation: start it from a Node script that waits for the port, not a
  shell `&`.
- **Remotion or `ffmpeg-static` fails on one OS** (medium): that is a finding
  for ADR-0005, not a reason to drop the OS — the job for that renderer is
  marked failed and the report (#4) cites it.
