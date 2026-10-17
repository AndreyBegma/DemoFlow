# Specifications

One file per issue, named `<issue>-<slug>.md`. The issue body summarises and
links here; the file is what the orchestrator's agents execute. Product-wide
decisions live in [../adr/](../adr/README.md).

## Phase 1 — validate the core technical risk

| Issue | Spec | Depends on |
|---|---|---|
| [#1](https://github.com/AndreyBegma/DemoFlow/issues/1) | [Core contracts](1-core-contracts.md) | — |
| [#2](https://github.com/AndreyBegma/DemoFlow/issues/2) | [Fixture app](2-fixture-app.md) | — |
| [#3](https://github.com/AndreyBegma/DemoFlow/issues/3) | [Engine](3-engine.md) | #1, #2 |
| [#4](https://github.com/AndreyBegma/DemoFlow/issues/4) | [Renderer spike](4-renderer-spike.md) — Gate: the owner chooses | #3 |
| [#5](https://github.com/AndreyBegma/DemoFlow/issues/5) | [CLI run](5-cli-run.md) | #3, #4 |
| [#6](https://github.com/AndreyBegma/DemoFlow/issues/6) | [OS matrix](6-os-matrix.md) | #5 |

Phase 2 onwards is specified after the renderer spike: its outcome changes
what those specifications say.
