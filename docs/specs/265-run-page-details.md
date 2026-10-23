# Show a run's stages, files and failure message on the run page

Issue: [#265](https://github.com/AndreyBegma/DemoFlow/issues/265)
Depends on: [#263](263-run-details-api.md).

## Summary

With [#263](263-run-details-api.md), `GET /runs/:id` returns `stages`,
`renders` and `failure` for runs reported by a CLI with
[#264](264-report-run-details.md). Vision §6 ("Video detail page") asks for
"duration, resolution, and file size", "execution and verification status",
"rendering status", and to "inspect verification results". This slice shows
them on the run page, `/app/projects/[id]/runs/[runId]`.

## Scope

### In scope

- `apps/web/src/app/app/projects/[id]/runs/[runId]/page.tsx`.
- `apps/web/src/components/projects/run-details.tsx` (new): the failure
  banner, the stages list and the files list.
- `apps/web/src/lib/api.ts`: the `RunDetail` type gains the three fields.
- `apps/web/src/lib/format-bytes.ts` and its `*.test.mjs` (new).
- `apps/web/src/i18n/en.ts`: strings in the existing `runPage` block.

### Out of scope

- The API (#263) and the CLI (#264).
- The library table and the `/app` overview: they read `GET /projects/:id/runs`
  and `GET /projects`, which do not carry the fields (spec 263, Decision 4).
- Scenario steps (spec 263, Out of scope).
- The player card (`RunPlayback`) and its format picker: unchanged.

## Decisions

1. **Failure first.** When `failure` is not `null`, a `Banner tone="danger"`
   sits right under the title card: "Failed at <stage label>" and the message
   below it, in a block that keeps line breaks (`whitespace-pre-wrap`,
   `break-words`). The message is rendered as a React text child, never as
   HTML or Markdown. *Why first:* the failure is the reason a person opens a
   failed run; it should not sit under the player.
2. **Stages.** A `KeyValueList` (Glass UI, as the metadata card) in its own
   `Card`: the six stages in pipeline order (readiness, execution,
   verification, recording, rendering, storage), each with a status label
   (passed, failed, skipped, pending, running). Failed uses the danger tone
   the existing `RunStatus` uses; the others are plain text. Hidden when
   `stages` is `null`.
3. **Files.** In the same card, under the stages: one row per entry of
   `renders`, in the order received: the format's existing label (the one
   the player's picker uses), `width×height`, `formatBytes(sizeBytes)` and
   `formatDuration(durationMs)`. Hidden when `renders` is `null`; an empty
   array shows "No files were rendered."
4. **`formatBytes`.** Under 1 KB: `"<n> B"`; under 1 MB: KB with no
   decimals; otherwise MB with one decimal (`"12.3 MB"`). Powers of 1024.
   *Why:* video sizes are KB to hundreds of MB; one decimal is enough.
5. **Older runs.** A run whose three fields are `null` renders exactly as
   today: no empty card, no "not reported" text. *Why:* most existing runs
   predate the fields, and an empty section for each would be noise.
6. **Surfaces.** Content cards are readable surfaces, glass only for chrome
   (vision §9), as on the rest of the page. All new strings in `en.ts` under
   `runPage`.

## Acceptance criteria

- [ ] A failed run with `failure` shows the danger banner with the stage
      label and the message; a message containing `<b>x</b>` shows those
      characters literally.
- [ ] A run with `stages` shows all six in order with their labels.
- [ ] A run with `renders` shows each file's format, resolution, size and
      duration; `renders: []` shows the empty line.
- [ ] A run with all three `null` renders the same elements as before this
      slice.
- [ ] `formatBytes` is unit-tested at 0, 1023, 1024, 1048575, 1048576 and
      a 300 MB value.
- [ ] `bun run check`, `bun run test` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/web/src/app/app/projects/[id]/runs/**`, `apps/web/src/components/projects/run-details.tsx` | #265 | No other open issue. |
| `apps/web/src/i18n/en.ts` | #265 (the `runPage` block) | PR #262 (#254) edits only `apps/web/src/app/docs/**` MDX pages and `apps/cli/README.md`, not `en.ts`. |
| `apps/web/src/lib/api.ts` | #265 (the `RunDetail` type) | No other open issue. |

## Open questions

None.
