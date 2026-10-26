# ADR-0021: Scheduled checks, and check passes started from the website

Status: accepted · Date: 2026-10-26 · Extends: [ADR-0017](0017-website-run-options.md) §1 and §3 and [ADR-0008](0008-cloud-boundary.md) §3 (one more request: a check pass)

## Context

A demo is written once and goes stale silently: the application changes, a
locator stops matching, an assertion fails, and nobody runs the scenario
again until someone opens the video in the docs and sees it lie. The GitHub
Action covers pull requests of the repository that holds the scenarios; it
does not cover "the product moved, the demo stayed".

The owner decided (interview of 2026-10-26, Phase 8) to check every scenario
of a project on a schedule and to mark a scenario **stale** on the website
when its check fails. Two places may hold a schedule:

- **The website.** The person sets it on the project page. The API already
  starts a run on the machine the project belongs to
  ([ADR-0016](0016-website-started-runs.md), [ADR-0017](0017-website-run-options.md)).
- **`demoflow.config.json`.** The team commits it; the runner daemon on the
  machine runs it. It works without the website.

A scheduled check must not record or render: a pass a day of video files
fills the disk, and nobody watches a check. `demoflow run` has no mode
without recording today (`apps/cli/src/commands/run.ts`, `packages/engine/src/run.ts`).
ADR-0017 §6 says any new run option the website may choose takes a new ADR.

## Decision

1. **Check mode.** `demoflow run --check` runs the scenario's steps and its
   verifications in a headless browser, and records nothing: no video, no
   sync mark, no render. Its `result.json` is written as for any run, with
   `recording` and `rendering` `skipped` and `renders: []`. The run status
   follows from the stages as it does today (ADR-0004 §3–4): a failed
   verification is a failed check. A check run is reported to the website like
   any run, marked as a check.
2. **The website may start a check pass** of a registered project: a
   request, beside `run.start`, whose only fields are the project's root (the
   server's key into the machine's registry, ADR-0016 §3) and the ids of the
   scenarios to leave out (ids from the scenario listing, ADR-0016 §1). The
   daemon runs it as `demoflow run --check` over the project (Decision 3). It
   takes no formats: a check renders nothing. This is the only new thing the
   website may make a runner do, and it extends ADR-0008 §3 and ADR-0017 §1;
   the rules of ADR-0017 §4 apply to it unchanged: a closed set of fields,
   checked again on the machine, the whole request refused on anything
   unknown. A machine says it accepts check passes in `launches.sync` before
   it is sent one (ADR-0017 §5). Every "never" of ADR-0017 §3 still holds:
   a check pass adds no command, URL, path or environment the website may
   choose.
3. **A check covers the whole project.** One pass runs every scenario of the
   project (`demoflow/**/*.demo.json`, ADR-0003 §2) except those the schedule
   excludes, one after another, and starts the application from `devCommand`
   once for the pass. Each scenario still gets its own run directory, its own
   `result.json` and its own report.
4. **Two sources of a schedule; the config wins.**
   - A `schedule` in `demoflow.config.json` is run by the runner daemon on the
     machine, by its local clock. It needs no account: without one the
     results are local (`demoflow runs`). When the machine is paired, the
     daemon also reports the project's config schedule to the website, which
     shows it read-only.
   - A schedule set on the website is run by the API: at the due time it
     starts a check pass on the project's machine through the runner socket,
     with the request of Decision 2.
   - A project whose config has a `schedule` cannot have a website schedule.
     The API refuses to create one and, when a config schedule appears for a
     project that already has a website schedule, the website schedule is
     paused (kept, not run) and the page says why.
   - *Why the config wins:* it is the team's committed decision, reviewed in
     a pull request. A website setting that silently doubled or overrode it
     would surprise the team.
5. **Cadence.** A schedule is one of `daily`, `weekdays` or `weekly`
   (with a weekday), at `HH:MM` in the machine's local time zone. Nothing more
   frequent than once a day. A machine that was off or asleep at the due time
   runs **one** catch-up pass when it is next able to (the API: when the
   machine reconnects; the daemon: when it starts or wakes), never one per
   missed slot.
6. **Stale is a per-scenario state on the server.** A scenario is stale
   when the last reported run of it in the project failed, for any reason
   (readiness, execution, verification). Checks and ordinary runs both count.
   The website shows a badge on the project and the scenario, and a block on
   `/app`. It changes only on a transition (passed → failed: stale; failed →
   passed: fixed). Alerts are on the website only: no email, no webhook.
7. **What crosses to the cloud** is what ADR-0008 §2 already allows for a
   run, plus: that a run was a check, and the project's config schedule
   (cadence, time, time zone name, the excluded scenario ids). No new step
   data, no logs, no screenshots.

## Consequences

- A check pass costs the machine one application start and one headless
  browser session per scenario, once a day at most. It costs no disk beyond
  `result.json` and the timeline per run.
- The daemon must be running for a config schedule to fire; a machine with
  no autostart unit checks nothing. Today the daemon refuses to start without
  credentials (`apps/cli/src/runner/daemon.ts`); spec 361 adds a local mode
  for the scheduler. A machine without an account runs scheduled checks but
  no website ever sees them.
- Website schedules run only while the machine is online; the website says
  "next check when the machine is online" instead of pretending a check ran.
- A project on two machines is two `Project` rows (`@@unique([runnerId, rootPath])`);
  each has its own schedule and its own stale state.
- Check runs appear in the run library like any run, with a "check" label and
  no video. A user who prunes runs prunes them too.
- Adding another alert channel (email, webhook) later is a spec, not an ADR:
  it adds no crossing of the cloud boundary. Making checks more frequent than
  daily, or letting the website choose anything else about a run, takes a new
  ADR (ADR-0017 §6).
