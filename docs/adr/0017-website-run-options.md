# ADR-0017: The website may choose the output formats of a run it starts

Status: accepted · Date: 2026-10-24 · Supersedes: [ADR-0016](0016-website-started-runs.md) §4's "The website chooses nothing but the scenario: no flags, no formats, no environment"

## Context

[ADR-0016](0016-website-started-runs.md) §4 makes a website-started run an
ordinary `demoflow run` started by the daemon, and lets the website choose
nothing but the scenario. That was the smallest safe step, and it holds
today: the daemon spawns exactly
`run <file> --json --progress --run-id <id> --project <root>`
(`apps/cli/src/runner/launch/index.ts`), and `POST /projects/:id/launch`
takes `{ scenarioId }` and nothing else (`apps/api/src/launches/launches.dto.ts`).

The owner wants to pick, from the website, what a run produces. A person who
wants a GIF for a README, or a vertical cut for a social post, today has to
edit `demoflow.config.json` and commit it, or run the scenario locally with
`--format`. Square and phone output (specs 304, 305) made that more common.

`demoflow run` takes these flags (`apps/cli/src/main.ts`,
`apps/cli/src/commands/run.ts`):

| Flag | What it controls | Crosses the boundary of ADR-0008 if the website chose it? |
|---|---|---|
| `--format <f>` (repeatable) | Which files are rendered; replaces `render.formats` for this run (spec 133). Values are the closed `RENDER_FORMATS` enum of `@demoflow/core`. | No. It names files to encode from a recording the run makes anyway, with the project's own render settings. It runs no command, opens no URL and reads nothing outside the run directory. |
| `--headed` | Shows the browser window on the machine. | It runs nothing new, but it acts on the machine's screen (below). |
| `--base-url <url>` | The origin the browser opens. | Yes: ADR-0008 §3 ("never ... a URL to execute") and §4. |
| `--out <dir>` | Where artifacts are written. | Yes: a local path chosen remotely. |
| `--json`, `--progress`, `--run-id`, `--project` | The daemon's own plumbing (specs 248, 302). | Owned by the daemon; not options. |

The environment (`valueFrom: { env }` secrets, `CI`, `DEMOFLOW_NO_REPORT`)
is not a flag; ADR-0008 §2 and ADR-0003 keep secrets on the machine.

## Decision

1. **The website may choose one run option: the output formats.** A
   website-started run may carry a list of formats. It is 1 to 9 entries,
   each a member of `RENDER_FORMATS`, each at most once, in the order the
   files are rendered. With a list, the run renders exactly those formats, as
   `demoflow run --format` does (spec 133). Without one, it renders the
   project's `render.formats`, as today. Every other render setting (size,
   fps, frame, background, cards, GIF, vertical and square tuning) still comes
   only from the project's `demoflow.config.json`.
   - *Why formats:* it is the most useful choice a person makes per run, and it
     adds no new power. The local CLI already lets any format replace the
     config's list; the website gains what the machine's own user already has.
   - *Why any member of the enum, not only the config's `render.formats`:*
     `render.formats` is the project's default, not an allow-list. Spec 133
     made `--format` replace it freely. Limiting the website to the defaults
     would make the choice useless: it could only drop files, never ask for a
     GIF the config does not list. The cost of a format is CPU and disk on the
     machine, bounded by nine formats and the daemon's 15-minute cap (spec 248,
     Decision 9).
2. **Headed mode is not an option.** A website-started run is always
   headless.
   - *Why:* the person who clicks Run is on the website and often not at the
     machine. A browser window that opens on someone's desktop because a web
     session asked for it is a surprise at best and a lure at worst. An
     autostart unit often has no display at all (spec 151, a systemd user unit or a launchd agent), so a headed run
     would fail there for reasons the website cannot show. Nothing a headed run
     records differs from a headless one.
3. **Never options:** the base URL, `navigate` targets, allowed origins, the
   output or artifacts directory, `devCommand`, environment variables,
   secrets, the run id, the project root, and any flag not named in
   Decision 1. ADR-0008 §3 and §4 still hold word for word: the website never
   sends a scenario body, a command or a URL to execute, and commands and
   origins come only from the local config.
4. **The allow-list is closed and enforced on the machine.** The API checks
   the formats on input. The daemon checks them again on receipt and never
   trusts the API's check, as it does for the scenario id (spec 248,
   Decision 3). The daemon refuses the whole start when the options hold
   anything it does not allow: a key other than `formats`, a format it does
   not know, a repeated format, an empty or too-long list. It never drops an
   option it does not understand and runs anyway. Only the daemon's own
   constants reach the child's arguments, never a string from the message.
   - *Why refuse, not ignore:* a run that silently ignores what the person
     asked for produces the wrong files and looks like it worked. A refusal is
     visible and safe.
5. **A machine says it accepts options before it is sent any.** A daemon
   that understands this ADR says so in its first frame on each socket. The
   API sends options only to a machine that said so, and otherwise answers
   that the machine needs a newer CLI. A start without options is sent as it
   is today, to every daemon.
   - *Why:* a daemon from before this ADR ignores unknown fields of
     `run.start` (it reads only the strings it needs), so it would render the
     config's formats while the website showed the person's choice.
6. **Adding an option later takes a new ADR** that supersedes this one. An
   option is never added by a spec alone.

The rest of ADR-0016 §4 still holds: a website-started run is an ordinary
`demoflow run` started by the daemon, with the project's own config, the
daemon's environment and the existing run report as its only way back, and
the daemon refuses to start when reporting is off on the machine. ADR-0016
§1–3 are unchanged; in particular the scenario listing still carries ids and
names only.

## Consequences

- The run page and the project page can offer "which files" per run. The
  choice is not stored as a setting: the run's report records which formats
  it rendered, as every run's does (spec 133).
- A machine whose CLI predates this ADR still runs website-started runs with
  its config's formats. The website shows the format choice only for machines
  that said they accept it, and says why otherwise.
- The website does not learn a project's configured default formats. Showing
  them would add a field to the scenario listing, which ADR-0016 §1 keeps to
  ids and names; it is left out. The website names the default as "the
  project's formats".
- A machine's owner cannot forbid a format from the website side. A local
  setting to restrict website-chosen formats, if it is ever needed, is a
  config change and a later decision.
- A format added to `RENDER_FORMATS` later is accepted by a daemon only once
  that daemon knows it. An older daemon refuses a start that asks for it, and
  the website shows that the machine needs a newer CLI.
