# ADR-0019: Opt-in share links — one render, uploaded on an explicit share

Status: accepted · Date: 2026-10-26 · Supersedes: the roadmap's Phase 5 rule "No public share links" ([roadmap](../product/roadmap.md), Phase 5) · Extends: [ADR-0008](0008-cloud-boundary.md) §2 and §3

## Context

Until now a video never left the user's machine. [ADR-0008](0008-cloud-boundary.md)
§2 lists video among the things a runner **never** sends, §5 leaves "cloud
upload of a video" to "a later, explicit, per-video action", and the website
plays a run only through the relay ([ADR-0009](0009-playback-relay-and-luna-player-adapter.md)):
the API asks the owning runner for byte ranges and stores nothing. The
roadmap's Phase 5 made the consequence explicit: "No public share links …
Sharing is by file or through the GitHub Action."

That leaves the product without its most common use. A demo is made to be
shown to someone who has no DemoFlow account: a colleague, a customer, a
reviewer, a README. Today the person downloads the file and sends it by
other means, and a link to the run page works only for its owner and only
while the machine is online.

The owner decided, in the Phase 8 interview (2026-10-26), to add share
links: stored on the server's disk, open to anyone with the link, optionally
behind a password, and created only by an explicit action.

## Decision

1. **A share is an explicit, per-video action.** A share is created only
   when a person (on the website or with `demoflow share`) or an MCP client
   the project allows (Decision 6) asks for it. Nothing is ever uploaded
   because a run finished, a render changed or a machine came online.
   ADR-0008 §5 still holds; this ADR is the action it left for later.
2. **What crosses, on a share, and nothing more** (extends ADR-0008 §2):
   - **one rendered file**, in the one format the person chose, exactly as
     the renderer wrote it;
   - **a poster**: one JPEG frame of that file, at most 1280 px wide, made on
     the machine;
   - the scenario's **name** (already on the server, ADR-0008 §2) and its
     **description**, which crosses for the first time: the daemon reads it
     from the scenario file on the machine at share time;
   - the **chapter list**: each scene's title and its start time in that
     render, in milliseconds.

   Still never: the source recording, other formats, `fill` values, query
   strings, logs, screenshots, traces, local paths, the scenario body. A share
   does not change what an ordinary run report sends.
3. **What the website may make a runner do** gains one item (extends
   ADR-0008 §3): **upload one render of a run it reported, for a share the
   owner created**. The upload reuses the relay's pull model: the API asks,
   the runner answers with the file in acknowledged chunks over its existing
   socket. The runner checks that the run is one it reported and the format
   one it rendered, as it does for playback, and never reads a path or a
   name from the message.
4. **The server stores the shared copy on its own disk**, in a directory
   outside the database, one directory per share. No third-party object store.
   - Limits, set in the API's environment: **200 MB per file, 2 GB per user**
     (the sum of the user's live shares). An upload that would exceed either
     is refused before a byte is sent.
   - The files are **not backed up**. The original is always on the user's
     machine. A share whose file is gone is marked lost; its owner uploads it
     again.
5. **Access: anyone with the link, optionally a password.** A share has an
   unguessable token in its URL (`/s/<token>`). The owner may set a password;
   only its argon2id hash is stored, attempts are rate-limited, and while a
   password is set the file is served only to a browser that entered it — the
   direct file URL works only for shares without a password.
   - **Lifetime:** 7, 30 (default) or 90 days, chosen at creation; the owner
     may extend by 30 days, never beyond 90 days from now. There is no
     share without an expiry. Expired shares are deleted with their files.
   - **Revocation is immediate:** revoking a share, deleting its run on the
     website, deleting its project and deleting the account all delete the
     share; the link stops working at once and the file is deleted.
   - Deleting the run's files on the machine, or pruning local runs, does
     **not** revoke a share: the share is a copy.
   - The owner sees how many times the share page was opened. No IP address,
     user agent or other data about viewers is stored.
6. **Who may create a share:** the website (the run's owner), the CLI
   (`demoflow share`, signed in with `demoflow login`) and the MCP server. An
   MCP client publishes outside the machine without a person in the loop, so
   **the MCP tool is refused unless the project's committed
   `demoflow.config.json` says `share: { allowMcp: true }`**. The decision to
   let agents publish is a commit a person reviews.
7. **A machine says it can share before it is asked to.** A daemon that
   implements this ADR announces `share` in the capability list
   (`features: string[]`) of its first frame on each socket, the same list
   ADR-0020 adds `edits` to, as
   [ADR-0017](0017-website-run-options.md) §5 does for run options. The API
   never sends a share request to a daemon that did not, and answers that the
   machine needs a newer CLI.

## Consequences

- The server now holds user video. Disk on the production host is a
  capacity the owner watches; the per-user limit and the expiry bound it, and
  the stored files are excluded from database backups.
- Viewers download from the server, not from the machine: a share keeps
  working while the machine is off. Upload traffic passes through Cloudflare
  and the API once per share.
- A share is a snapshot. Re-rendering the run (the Phase 8 editor) does not
  change it. Replacing the file of an existing share is an explicit action
  only — the owner's "Update link" ([ADR-0020](0020-edits-from-the-website.md)
  §6, `POST /shares/:id/update`, added by #356): same token, same expiry and
  view count, a new upload under Decisions 2–4. Nothing replaces it
  automatically.
- A leaked link exposes that one video until it is revoked or expires. The
  token is stored so the owner can copy the link again; the password and the
  expiry are the owner's tools against a leak.
- An older CLI cannot share. The website shows why and how to update.
- The roadmap's Phase 5 rule "No public share links" no longer holds;
  "sharing is by file or through the GitHub Action" remains true for anyone
  who does not create a share.
