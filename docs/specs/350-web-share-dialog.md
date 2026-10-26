# Share dialog on the run page and the `/app/shares` list

Issue: [#350](https://github.com/AndreyBegma/DemoFlow/issues/350)
Depends on: #347. Implements the owner's side of [ADR-0019](../adr/0019-opt-in-share-links.md).

## Summary

#347 lets the API create, list, extend and revoke shares. This slice is the
website's owner side: a **Share** button on the run page that opens a dialog
(format, expiry, optional password, the quota), shows the upload's progress
and then the link; and a page, `/app/shares`, that lists every share with its
size, views and expiry, the quota used, and Extend / Revoke per row.

## Scope

### In scope

- `apps/web/src/lib/shares.ts` (new) and `shares.test.mjs`: the client calls
  of #347's owner API and their types, plus pure helpers (quota text, expiry
  text, which actions a row offers). Kept out of `apps/web/src/lib/api.ts`
  so other Phase 8 slices do not collide there; it may import that file's
  request helper.
- `apps/web/src/components/shares/` (new): `share-button.tsx`,
  `share-dialog.tsx`, `share-list.tsx`, `quota-meter.tsx`.
- `apps/web/src/app/app/projects/[id]/runs/[runId]/page.tsx`: mount the
  Share button in the page header actions.
- `apps/web/src/app/app/shares/page.tsx` (new).
- `apps/web/src/app/app/page.tsx`: a "Shares" link beside Projects, Machines
  and Settings [Confirmed: those links exist there].
- `apps/web/src/i18n/en.ts`: `shares.*`.

### Out of scope

- The public page `/s/[token]` (#351).
- The API (#347).
- "Update link" after a re-render (#358).
- Changing a password (no endpoint, #347 Open questions).

## Decisions

1. **The button.** On the run page, beside the existing actions. Enabled
   when the run has at least one render, its artifacts are not deleted, and
   its machine is online and lists `share` in `machine.features` (#347,
   Decision 6). Otherwise disabled with the reason as its hint: no render,
   files deleted on the machine, machine offline, or "update DemoFlow on
   <machine> to share" [Source: ADR-0019 §7]. A run that already has a share
   for a format shows it in the dialog instead of creating a second
   (`409 share-exists`, #347 Decision 1).
2. **The dialog** (Glass UI dialog primitives, as `delete-run.tsx` uses
   `ConfirmDialog` [Confirmed]):
   - **Format:** a select of the run's renders, each with its size; default
     the first. A render over the file limit is disabled with "over 200 MB".
   - **Expires in:** 7 / 30 / 90 days, default 30.
   - **Password (optional):** a field, 8–128 characters, with a note that the
     direct file link is off while a password is set.
   - **Quota:** "`<used>` of `<limit>` used"; the share's size is added in a
     preview, and Create is disabled with "not enough space" when it would
     not fit.
   - **Create** posts `POST /shares`, then polls `GET /shares/:id` every
     second while `uploading` (no fake percentage: an indeterminate
     progress). `ready` shows the link with Copy, and — without a password —
     the file link with Copy and, for a GIF, a Markdown snippet
     `![<title>](<fileUrl>)` with Copy. `failed` shows the failure in words
     and Try again.
   - The text says plainly that the file is uploaded to DemoFlow's server
     and anyone with the link can watch it until it expires.
3. **`/app/shares`.** A table of `GET /shares`, newest first: title (linking
   to the run page), format, size, views, "expires in N days", password
   yes/no, status. Row actions: Copy link, Open, Extend 30 days (hidden at
   the 90-day cap), Revoke (`ConfirmDialog`). `failed` rows offer Retry from
   the run page; `lost` rows say "the file is gone from the server — share
   again". Above the table: the quota meter. Empty: an empty state that says
   shares are created from a run's page.
4. **Content surfaces stay readable.** Glass is for the dialog's chrome only;
   the table and the dialog's body use the readable surfaces, as
   `docs/product/vision.md` §9 and `CLAUDE.md` require.
5. **Strings** live in `en.ts` under `shares.*` (spec #48's i18n
   dictionary [Confirmed: `apps/web/src/i18n/en.ts`]).

## Acceptance criteria

- [ ] The Share button's enabled and disabled states follow Decision 1,
      covered by a pure helper's tests in `shares.test.mjs`.
- [ ] Creating a share shows progress, then the link; Copy writes the link
      to the clipboard; a password hides the file link.
- [ ] Opening the dialog on a run that has a share for the chosen format
      shows that share, not a second Create.
- [ ] `quota-exceeded`, `file-too-large`, `runner-offline` and
      `runner-outdated` each show their own message.
- [ ] `/app/shares` lists the user's shares with views and expiry; Extend
      moves the expiry and disappears at the cap; Revoke removes the row and
      the link answers 404 afterwards.
- [ ] `/app` links to `/app/shares`; `/app/shares` is behind the `/app`
      guard [Confirmed: `apps/web/src/app/app/layout.tsx` guards every page].
- [ ] `bun run check`, `bun run build` pass; `node --test` of
      `apps/web/src/lib/*.test.mjs` passes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i350-web | the dialog and the list | apps/web/src/lib/shares.ts, apps/web/src/lib/shares.test.mjs, apps/web/src/components/shares/**, apps/web/src/app/app/shares/**, apps/web/src/app/app/projects/[id]/runs/[runId]/page.tsx, apps/web/src/app/app/page.tsx, apps/web/src/i18n/en.ts | #347 | yes | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/web/src/i18n/en.ts | i350-web while it runs | #351, #352, #357–#359, #363, #364 add their own keys: appends, rebase |
| apps/web/src/app/app/projects/[id]/runs/[runId]/page.tsx | i350-web | #357/#358 mount the editor there; cut after this merges |
| apps/web/src/app/app/page.tsx | i350-web | #363 adds the stale block; rebase |

## Risks

- **Long uploads look stuck** (low). Mitigation: show elapsed time and the
  file size under the progress; the API fails a stale upload after 15
  minutes (#347).

## Open questions

- A per-share "copy as embed" for MP4 (`<video>` tag) — default: no; the
  file link is enough.
