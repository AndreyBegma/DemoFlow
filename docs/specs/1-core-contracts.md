# Core contracts — scenario, project config, timeline, run result

Issue: [#1](https://github.com/AndreyBegma/DemoFlow/issues/1) · Phase 1 ·
Decisions: [ADR-0001](../adr/0001-control-plane-execution-plane-one-package.md),
[ADR-0003](../adr/0003-scenario-format-and-project-config.md),
[ADR-0004](../adr/0004-recording-is-separate-from-rendering.md),
[ADR-0008](../adr/0008-cloud-boundary.md)

## Summary

Every other Phase 1 piece — the engine, both renderers, the CLI — exchanges
data through four contracts: the scenario a person or agent writes, the
project's `demoflow.config.json`, the timeline the engine records, and the
`result.json` that reports each stage. This item creates `@demoflow/core` with
those contracts as zod 4 schemas, their TypeScript types, a derived run
status, and a JSON Schema export. It has no runtime behaviour beyond
validation, which is why it goes first.

## Scope

### In scope

- New workspace package `packages/core` (`@demoflow/core`), ESM, built with
  `tsc`, tested with Vitest under Node.
- Schemas: `Locator`, `Step` (all actions of ADR-0003), `Scenario`,
  `ProjectConfig`, `TimelineEvent`, `Timeline`, `StageStatus`, `RunResult`.
- `parseScenario(input)` / `parseProjectConfig(input)` returning either the
  value plus warnings, or path-addressed errors.
- `deriveRunStatus(stages)`.
- `bun run --filter @demoflow/core schema` writing JSON Schemas to
  `packages/core/schemas/` (committed).

### Out of scope

- Reading files, resolving paths, environment variables — `engine` and
  `apps/cli` do that.
- Metadata-sync payloads for the cloud (ADR-0008 §2) — a later spec derives
  them from these types.

## Decisions

- zod 4, ESM only. `packages/core` imports nothing but `zod` (ADR-0001).
- `schemaVersion: 1` is a required literal on `Scenario`, `Timeline` and
  `RunResult`; a later breaking change bumps it.
- The JSON Schema files are generated with zod 4's `z.toJSONSchema`, never
  written by hand, and a test fails when the committed files are stale.

## Data / Schema

`Locator` — exactly one of:

| Shape | Maps to |
|---|---|
| `{ role, name?, exact? }` (`role` is an ARIA role string) | `getByRole` |
| `{ label, exact? }` | `getByLabel` |
| `{ testId }` | `getByTestId` |
| `{ text, exact? }` | `getByText` |
| `{ placeholder, exact? }` | `getByPlaceholder` |
| `{ css }` | `locator(css)` — valid, with warning `css-locator` |

`Step` — discriminated on `action`; every step may carry `caption?: string`
(≤ 120 chars) and `timeoutMs?: number` (100–60 000, default 10 000):

| action | fields |
|---|---|
| `navigate` | `path` (string starting with `/`) or `url` (absolute) |
| `waitFor` | `target: Locator`, `state?: 'visible' \| 'hidden'` (default visible) |
| `click` | `target` |
| `fill` | `target`, and exactly one of `value: string` or `valueFrom: { env: string }` (`env` matches `^[A-Z_][A-Z0-9_]*$`) |
| `select` | `target`, `option: string` |
| `hover` | `target` |
| `scroll` | `to: 'top' \| 'bottom'` or `target`; optional `within: Locator` (scroll a container) |
| `assertVisible` | `target` |
| `assertText` | `target`, `text`, `match?: 'exact' \| 'contains'` (default contains) |
| `screenshot` | `name` (`^[a-z0-9-]+$`) |
| `marker` | `title`, `kind?: 'scene' \| 'caption'` (default scene) |
| `wait` | `ms` (1–5 000) |

`Scenario`: `{ schemaVersion: 1, name, description?, browser: 'chromium'
(default), baseUrl?, viewport?: { width, height } (default 1920×1080),
steps: Step[] (1–200) }`. Validation errors: a `navigate.url` with a scheme
other than `http`/`https`; zero steps.

`ProjectConfig` (`demoflow.config.json`): `{ baseUrl, allowedOrigins:
string[] (default [origin of baseUrl]), devCommand?: { command, args?: string[],
readyUrl, timeoutMs? }, artifactsDir?, render?: { width?, height?, fps?,
idle?: { thresholdMs?, compressToMs? } } }`. Defaults per ADR-0004: 1920,
1080, 30, 1000, 400.

`TimelineEvent` — times in milliseconds from the video's first frame;
boxes and points in CSS pixels of the viewport:

```ts
{ stepIndex, action, startMs, endMs,
  target?: { box: { x, y, width, height } },
  pointer?: { from: { x, y }, to: { x, y } },   // the real path, ADR-0004 §2
  scroll?: { before: { x, y }, after: { x, y }, container?: { x, y, width, height } },
  masked?: boolean,                              // fill from valueFrom.env
  value?: string,                                // "***" when masked; omitted for non-fill
  assertion?: { passed: boolean, message?: string },
  screenshot?: string,                           // relative path
  marker?: { title, kind },
  caption?: string,
  error?: { message } }
```

`Timeline`: `{ schemaVersion: 1, viewport, deviceScaleFactor, videoFile,
events: TimelineEvent[] }`.

`StageStatus`: `'pending' | 'running' | 'passed' | 'failed' | 'skipped'`.

`RunResult`: `{ schemaVersion: 1, runId, scenarioId, scenarioName, startedAt,
finishedAt, status, stages: { readiness, execution, verification, recording,
rendering, storage }: { status: StageStatus, startedAt?, finishedAt?, error?:
{ message, stepIndex? } }, renders: [{ renderer, file, durationMs, sizeBytes,
width, height, fps }], warnings: string[] }`.

`deriveRunStatus(stages)` → `'completed' | 'completed_with_warnings' |
'failed' | 'running'`: any stage `failed` → `failed`; any `running` or
`pending` → `running`; all `passed`/`skipped` → `completed`, or
`completed_with_warnings` when the caller passes warnings. `rendering`
`passed` with `verification` `failed` is `failed` (ADR-0004 §3).

## Acceptance criteria

- [ ] `bun run --filter @demoflow/core test` passes under Node, and
      `bun run check` and `bun run build` pass at the root.
- [ ] Every action in the table parses from a valid example and is rejected,
      with a path-addressed error, for each of: a missing required field, an
      unknown field, and both `value` and `valueFrom` on one `fill`.
- [ ] A locator with two keys (`{ role, testId }`) is rejected; `{ css }` is
      accepted and returns warning `css-locator` at its step path.
- [ ] `navigate` with `url: "file:///etc/passwd"` or `javascript:` is rejected.
- [ ] `deriveRunStatus` has a table test covering every rule above, including
      "verification failed + rendering passed → failed".
- [ ] `packages/core/schemas/scenario.schema.json` and
      `project-config.schema.json` exist, and a test regenerates them in
      memory and fails if they differ from the committed files.
- [ ] `packages/core/package.json` lists `zod` as its only runtime
      dependency, and no file under `packages/core/src` imports `node:*`.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i1-core | the package and all four contracts | packages/core/**, bun.lock | — | yes | opus |

One slot: the four schemas reference each other (`TimelineEvent.action` is
`Step['action']`, `RunResult` embeds the timeline's stages), and the barrel
and `package.json` are single files. Splitting would serialise anyway.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| bun.lock | i1-core | regenerated by `bun install`; a parallel issue (#2) rebases and reinstalls |

## Risks

- **The timeline misses something a renderer needs** (medium). Mitigation:
  `schemaVersion` plus the renderer spike (#4) is allowed to add optional
  fields in its own pull request; a required field is a new version.
- **ESM-only core and the CommonJS API** (low, not in Phase 1). Node 24 loads
  ESM through `require` [Confirmed in Node 22.12+ release notes]; Jest in
  `apps/api` may not [Unknown]. Revisited when the API first imports core.

## Open questions

- Does the API need a CommonJS build of core? Default: no, until the API
  imports it.
