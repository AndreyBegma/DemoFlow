# ADR-0016: Runs started from the website

Status: accepted · Date: 2026-10-23

## Context

[ADR-0008](0008-cloud-boundary.md) §3 lets the website make a Runner "start a
run of a scenario that exists as a file in a registered project
(`demoflow/**/*.demo.json`, by id)" and cancel a run, "nothing else". Two
things it does not settle are needed to build that:

- To pick a scenario, the website has to learn which scenarios a project has.
  Listing them is a request to the Runner that §3 does not name.
- The CLI has no list of "registered projects". The server's `Project` rows
  (spec 178) are keyed by `(runnerId, rootPath)`, and a project can be bound to
  any `rootPath` by hand on the website (spec 178, Decision 4). If a Runner
  trusted that path, a compromised website account could point it at any
  folder of the user that holds a `demoflow.config.json` and run its
  `devCommand`.

Vision §11 asks for "access only to registered project directories".

## Decision

1. **The website may list a registered project's scenarios.** The Runner
   answers with each scenario's id (its path relative to the root, ADR-0003
   §2) and its `name`, and nothing else: no steps, no description, no file
   contents. Both fields are already allowed to cross by ADR-0008 §2. The list
   is read live from the machine when the website asks. The server does not
   store it. This extends ADR-0008 §3; every other "nothing else" there still
   holds.
2. **A project is registered on a machine when that machine reported a run
   from its root.** The Runner keeps the canonical root of every run it
   reports (the same string it sends as `rootPath`, spec 178 Decision 2), in
   its local `reported-runs.jsonl`. That local record is the registry. A root
   bound by hand on the website is never enough. Registering a folder takes a
   local `demoflow run` there while the machine is paired.
3. **The server names a project to the Runner by the `rootPath` it holds.**
   The browser sends only a project id and a scenario id. The API looks up the
   project's `rootPath` and sends it with the request. The Runner acts only
   when that string equals a root in its registry (Decision 2), and it checks
   that the scenario file resolves inside that root. A path that came from the
   server is a key into the Runner's own registry, never a place to go.
4. **A website-started run is an ordinary `demoflow run`** started by the
   daemon, with the project's own `demoflow.config.json` (ADR-0008 §4), the
   daemon's environment, and the existing run report (spec 178) as its only
   way back to the server. The website chooses nothing but the scenario: no
   flags, no formats, no environment. The daemon refuses to start a run when
   reporting is off on the machine (`CI` or `DEMOFLOW_NO_REPORT=1`), since the
   user has asked for nothing to reach the server.

## Consequences

- A project bound by hand shows no scenarios until the machine has reported
  one run from its folder.
- A scenario added to a repository is pickable on the website at once,
  because the list is read live. The website shows nothing when the machine is
  offline, which is also when it could not start a run.
- `valueFrom: { env }` secrets of a website-started run come from the
  daemon's environment, which an autostart unit may not share with the user's
  shell. The Runner docs say so.
- `reported-runs.jsonl` keeps its last 2,000 lines (spec 192, Decision 2). A
  project with no run in that many reported runs falls out of the registry
  until it is run locally again.
