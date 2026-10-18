# Publish `demoflow` to npm through a Woodpecker release workflow

Issue: [#75](https://github.com/AndreyBegma/DemoFlow/issues/75) · roadmap step 2 ·
Decisions: [ADR-0001](../adr/0001-control-plane-execution-plane-one-package.md) (one published package `demoflow`, Node ≥ 20),
[roadmap.md](../product/roadmap.md) ("npm release")

Depends on #68
Depends on #69

## Summary

`demoflow` is not on npm, so nobody outside the repository can run
`npx demoflow` or register `npx demoflow mcp` in Claude Code. This item makes
the CLI publishable as one self-contained package and adds a Woodpecker
`release` workflow modelled on luna-player's
(https://github.com/AndreyBegma/luna-player/blob/main/.woodpecker/release.yml):
merging the `develop` → `main` release pull request publishes the new version
and tags it. The first version is `0.1.0`.

## Scope

### In scope

- **One self-contained package** (ADR-0001): `apps/cli` publishes as `demoflow`.
  The internal workspace packages (`@demoflow/core`, `engine`, `renderer`) are
  bundled into it, including the renderer's bundled font files and their
  licence. Third-party runtime dependencies (`playwright`, `ffmpeg-static`,
  `zod`, `commander`, `@modelcontextprotocol/sdk`, `opentype.js`, …) stay as
  real `dependencies`, pinned exactly. `"private": true` is removed; `version`
  becomes `0.1.0`.
- **Chromium on first use** (owner's choice): `demoflow run`, `demoflow mcp`
  and a new `demoflow setup` command check for Playwright's Chromium and
  install it with progress when it is missing. Nothing is downloaded at install
  time (no postinstall).
- **`.woodpecker/release.yml`**, the luna-player pattern adapted to the
  monorepo: a push to `main` builds, runs the checks, packs `apps/cli`,
  smoke-tests the packed tarball, publishes the version when it is new on npm
  (with provenance where the registry supports it from Woodpecker; otherwise
  plain), then pushes the tag `vX.Y.Z`. A tag push checks the version and
  publishes if needed. A manual run with `[demoflow-release]` in its message is
  a dry run (`npm publish --dry-run`). Pull requests never run it. Secrets:
  `npm_token` and `github_token` on the DemoFlow repository — present
  [Confirmed, 2026-10-18]. Without a secret the step says so and passes.
- **Smoke test of the tarball**: install the packed `.tgz` into an empty
  directory with npm, then `demoflow --version`, `demoflow validate` on a
  fixture scenario, and `demoflow mcp` answering an MCP `tools/list` over stdio.
- **Release procedure** documented in `deploy/README.md` (where delivery is
  documented): bump the version on `develop`, open `develop` → `main`, the
  orchestrator merges it when CI is green.

### Out of scope

- Publishing `@demoflow/*` separately.
- The first actual release — it happens through the procedure once this merges
  (a separate `develop` → `main` pull request).

## Decisions

1. **Woodpecker, the luna-player pattern** — owner (roadmap).
2. **Chromium installed on first use**, plus `demoflow setup` — owner.
3. **First version 0.1.0** — owner.
4. **The orchestrator merges the release pull request** — owner (roadmap).
5. **Bundle internal packages, keep third-party ones external** — ADR-0001;
   the bundler is the slot's choice (esbuild or tsup, pinned exactly), stated
   with its reason in the PR. — orchestrator.
6. **The 3-OS tarball smoke test is a new workflow,
   `.github/workflows/package-smoke.yml`** (pull requests and pushes to
   `develop`), not a job in `execution-plane.yml`, which another slot held at
   the time. — orchestrator decision.
7. **`playwright` is an explicit dependency of `apps/cli`**, pinned to the
   engine's version: `check_project` (#69) and the Chromium first-use install
   import it, and must not rely on hoisting. — orchestrator decision.
8. **What is packed and published is the staged `apps/cli/dist/npm`.** The CLI's
   build bundles the workspace into it with a generated `package.json`;
   `apps/cli/package.json` keeps its `workspace:*` references and stays
   `private`. The smoke test packs that directory and `release.yml` publishes
   that same directory. Acceptance criterion 1 reads "`npm pack` of
   `apps/cli/dist/npm`". — orchestrator decision.
9. **`demoflow mcp` downloads nothing at startup.** It says on stderr when
   Chromium is missing; the first `generate_demo` installs it through its
   `demoflow run` child (inside the task's timeout; tasks run one at a time),
   and the tool's description says the first run may download the browser.
   `check_project` reports `browser: missing` until then. — orchestrator
   decision.

## Acceptance criteria

- [ ] `npm pack` of the staged `apps/cli/dist/npm` (Decision 8) produces a
      tarball with no `workspace:` or `@demoflow/*` references in its
      `package.json`, containing the fonts and their licence.
- [ ] Installing that tarball in an empty directory and running
      `demoflow --version`, `demoflow validate <fixture>` and an MCP
      `tools/list` against `demoflow mcp` succeeds — on Linux, macOS and Windows
      (`package-smoke.yml`, Decision 6).
- [ ] On a machine without Chromium, `demoflow run` installs it with progress
      output and then runs; `demoflow setup` does the same on its own (test
      with an empty `PLAYWRIGHT_BROWSERS_PATH`).
- [ ] A manual Woodpecker run with `[demoflow-release]` ends in a successful
      `npm publish --dry-run` for `demoflow@0.1.0` (run id in the PR).
- [ ] `.woodpecker/release.yml` is not triggered by pull requests or pushes to
      `develop` (shown by the PR's own pipelines).
- [ ] `deploy/README.md` documents the release procedure.
- [ ] `bun run check`, `test`, `build` pass; Woodpecker green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i75 | packaging, first-use Chromium, release workflow, docs | apps/cli/**, .woodpecker/release.yml, .github/workflows/package-smoke.yml (Decision 6), scripts/release/**, deploy/README.md, package.json, bun.lock | #68, #69 | yes | opus |

One slot. `opus`: bundling the workspace with assets and a cross-OS smoke test
have no precedent in the repository.

## Risks

- **A broken first publish** (high — npm versions cannot be reused). Mitigation:
  the tarball smoke test on three OSes and the dry run before the real release.
- **Bundled `ffmpeg-static` / Playwright paths** (medium): both resolve binaries
  relative to their own package. Mitigation: they stay external dependencies.
