# ADR-0001: Control plane and execution plane; one `demoflow` package on Node

Status: accepted · Date: 2026-10-17

## Context

[vision.md](../product/vision.md) describes a website, a local Runner, an MCP
server, a CLI, a shared core, a browser engine and a renderer, and warns
against creating many packages or services before there is a need (§3.6, §13).
The product is a multi-user SaaS (ADR-0006) whose recordings stay on the
user's machine by default (§7).

## Decision

1. **Two planes.** The control plane is `apps/api` (NestJS) and `apps/web`
   (Next.js) on the server: accounts, runners, projects, run metadata, job
   coordination. The execution plane is the `demoflow` package on the user's
   machine: browser automation, recording, rendering, local artifacts.
2. **One published package, `demoflow`, on Node ≥ 20.** One executable with
   subcommands: `demoflow run`, `demoflow runner …`, `demoflow mcp` (stdio MCP
   server), `demoflow login`. One version, one install
   (`npm i -g demoflow` / `npx demoflow`). The monorepo is managed by Bun, but
   everything in the execution plane must run on Node; its tests run under
   Node (Vitest), never `bun test`.
3. **Module layout.** Split further only when there is a real need:

   | Path | Holds | May import |
   |---|---|---|
   | `packages/core` (`@demoflow/core`) | zod 4 schemas and types: scenario, project config, timeline, run result, statuses; JSON Schema export | zod only — no Node, no browser, no framework |
   | `packages/engine` (`@demoflow/engine`) | Playwright execution and recording | core, playwright |
   | `packages/renderer` (`@demoflow/renderer`) | timeline + source video → MP4 | core |
   | `apps/cli` (published as `demoflow`) | commands, config and home resolution, later the runner daemon and MCP | core, engine, renderer |
   | `apps/fixture` | a deterministic demo target for tests and CI | — |
   | `packages/shared` (`@demoflow/shared`) | glue between `apps/api` and `apps/web` only | — |

   `apps/api` and `apps/web` may import `@demoflow/core` (to validate synced
   metadata and render scenario summaries), never `engine` or `renderer`.
4. **Platforms.** The runner targets Linux, macOS and Windows from the first
   release. Recording uses Chromium only; the scenario schema carries a
   `browser` field whose only accepted value is `chromium` for now.

## Consequences

- Three operating systems from day one: every execution-plane change is
  verified on all three (ADR-0002), and filesystem paths, process spawning and
  permissions are written portably.
- `packages/core` cannot use Node APIs; anything touching the filesystem
  belongs in `engine` or `apps/cli`.
- Adding Firefox or WebKit later is a schema change plus an engine change, not
  a redesign.
