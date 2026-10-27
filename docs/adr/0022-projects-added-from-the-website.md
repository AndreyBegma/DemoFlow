# ADR-0022: Projects added from the website, inside allowed roots

Status: accepted · Date: 2026-10-26 · Supersedes: [ADR-0016](0016-website-started-runs.md) §2 · Extends: [ADR-0008](0008-cloud-boundary.md) §3 (three more requests: inspect, initialise and register a folder)

## Context

Today a project reaches the website only after its machine reported a run:
ADR-0016 §2 makes the Runner's `reported-runs.jsonl` the registry, and a root
bound by hand on the website (spec 178, Decision 4) is never enough. The
first experience is therefore "install the CLI, `cd` into the repository, run
a scenario, then come back to the website". The owner wants to add a project
from the website: name a folder on a paired machine, see whether it is a
DemoFlow project, create the config if it is not, and link its GitHub
repository (interview, 2026-10-26).

ADR-0016 §2 exists for one reason: a compromised website account must not be
able to point a Runner at any folder of the user that holds a
`demoflow.config.json` and run its `devCommand`. Letting the website name a
folder reopens exactly that, so the Runner needs its own boundary that the
website cannot move.

## Decision

1. **Allowed roots are the machine's, never the website's.** The Runner keeps
   a list of allowed roots in `allowed-roots.json`, next to
   `credentials.json` (the directory of `runnerPaths`). The person edits it
   only on the machine: `demoflow runner allow <dir>`,
   `demoflow runner disallow <dir>`, `demoflow runner roots`. With no file,
   the one allowed root is the user's home directory. No request from the
   server reads or changes the list.
2. **A folder the website may name** is a canonical directory (its real path,
   no symbolic link on the way) that is inside an allowed root, with **no path
   segment below that root that starts with `.`** (so `~/.ssh`, `~/.config`
   and `~/.cache` are out unless the person allows one of them as a root
   itself). Anything else is refused with one code, `path-not-allowed`, and
   the refusal does not say whether the folder exists.
3. **Three new requests the website may make a Runner do**, in addition to
   ADR-0008 §3 and ADR-0016 §1:
   - **inspect** a named folder: whether it is allowed (§2), whether it holds
     `demoflow.config.json` and whether that config parses, the scenario ids
     and names under it (the same fields ADR-0016 §1 already lets cross), the
     folder's base name, and the GitHub URL of its `origin` remote when that
     remote is on `github.com`. The Runner reads the remote from the
     repository's git config file; it never runs `git` or any other command.
   - **initialise** a named folder: write the `demoflow init` template
     (`demoflow.config.json` and `demoflow/first.demo.json`, spec 273) with
     the same never-overwrite rule. The website sends no file body, no
     `baseUrl`, no command: the template is the CLI's own. `devCommand` and
     every other setting stay the person's to edit in the repository.
   - **register** a named folder: after re-checking §2 and that the config
     exists, the Runner appends the canonical root to its local
     `website-projects.jsonl` and answers with that canonical string, which
     becomes the project's `rootPath` on the server.
4. **The registry is the union of the two local files.** ADR-0016 §2's rule
   becomes: a project is registered on a machine when that machine reported a
   run from its root **or** registered the root through §3. ADR-0016 §3 still
   holds: the server names a project by the `rootPath` it holds, and the
   Runner acts only when that string is in its registry. A registered root
   that leaves the allowed roots later (`disallow`) stops being served for
   website-started work until it is allowed again; a root that came from a
   local run is unaffected, because the person ran it there.
5. **The GitHub URL is display metadata.** It is stored on the project
   (`https://github.com/<owner>/<repo>` only), shown as a link, and editable
   on the website. Nothing clones, fetches or pulls it. A project added from
   the website records its origin (`website` vs `reported`) for support and
   for the UI.
6. **The machine must be online.** Inspect, initialise and register are live
   requests over the Runner socket, like `scenarios.list`; with the machine
   offline the website says so and adds nothing.

## Consequences

- A compromised website account can learn, for folders inside the allowed
  roots, whether they are DemoFlow projects, their scenario names and their
  GitHub remotes, and can write the init template into a folder that has no
  config. It still cannot run a `devCommand` the person did not write: the
  template has none, and a folder needs a config before it can be
  registered. The person narrows this exposure with `demoflow runner allow`;
  the default (the home directory without hidden folders) is the cost
  accepted for a first experience that works without a terminal.
- Writing into the repository from the website happens for the first time,
  limited to two fixed files that are never overwritten. ADR-0020's rule that
  the website never writes repository files otherwise stands: its edits are
  exported as a patch.
- The bind-by-hand path of spec 178 (Decision 4) stays in the API for
  existing callers; the website's projects page uses the inspect → register
  flow instead.
- The Runner gains a second local file to read on every website-started run.
  `website-projects.jsonl` is small (one line per added project) and is not
  rotated.
- No cloning means a repository that is not on the machine cannot be added;
  that is a later decision with its own record, since it would make the
  Runner fetch and later execute code it was told about by the server.
