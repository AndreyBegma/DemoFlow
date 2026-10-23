# Store and return a run's stage statuses, renders and failure message (API)

Issue: [#263](https://github.com/AndreyBegma/DemoFlow/issues/263)
Depends on: nothing.

## Summary

Vision §6 ("Video detail page") asks the run page for "creation time,
duration, resolution, and file size", "execution and verification status",
"rendering status", and lets the user "inspect verification results".
[ADR-0008](../adr/0008-cloud-boundary.md) §2 already lists what a runner may
send for that: "the status of every stage; durations, resolution and file
sizes; the error message of a failed step".

Spec [178](178-projects-and-library.md), Decision 1 kept `Run` to the
library's columns, so none of it is stored: the run page can show the failed
step's number but not why it failed, nor the size or resolution of a file.

This slice is the API and the wire contract. [#264](264-report-run-details.md)
makes the CLI send the fields; [#265](265-run-page-details.md) shows them.

## Scope

### In scope

- `apps/api/prisma/schema.prisma` and one migration `<timestamp>_run_details`.
- `apps/api/src/projects/projects.dto.ts`: the optional fields of
  `RunReportDto` and their nested DTOs.
- `apps/api/src/projects/projects.service.ts`: storing them on report.
- `apps/api/src/videos/runs.service.ts`: returning them from `GET /runs/:id`.
- Integration tests next to the existing ones.

### Out of scope

- The CLI (#264) and the web (#265).
- The scenario's steps as action, locator and caption (ADR-0008 §2, vision
  §6 "Scenario summary"). `result.json` does not hold them; the CLI would have
  to read and expand the scenario file. A later slice with its own decisions.
- Warnings (`completed_with_warnings`). ADR-0008 §2 does not list them, and a
  warning's text can hold a local path.
- Changing `GET /projects` or `GET /projects/:id/runs` (Decision 4).
- Back-filling runs reported before this slice.

## Decisions

1. **Columns.** `Run` gains four nullable columns:
   `stages Json?`, `renders Json?`, `failureStage String?`,
   `failureMessage String?`.
   - *Why JSON, not a `RunRender` table:* the renders are only ever read
     with their run, at most six, and never queried by field. A table adds
     a relation and a cascade for no query.
   - *Why nullable:* every run reported before this slice, and every report
     from an older CLI, has none of them. `null` means "not reported", never
     "nothing happened".
2. **Report fields, all optional** on `RunReportDto`:
   - `stages`: an object with exactly the six keys of `STAGE_NAMES`
     (`readiness`, `execution`, `verification`, `recording`, `rendering`,
     `storage`), each one of `pending`, `running`, `passed`, `failed`,
     `skipped`. A missing or extra key is 400.
   - `renders`: an array of at most `RUN_FORMATS.length` objects
     `{ format, width, height, sizeBytes, durationMs }`; `format` in
     `RUN_FORMATS` and unique across the array; `width`, `height` integers
     1–16384; `sizeBytes` integer 0–`Number.MAX_SAFE_INTEGER`; `durationMs`
     integer 0–2147483647. No other keys.
   - `failure`: `{ stage, message }`; `stage` one of the six names; `message`
     a string of 1–1000 characters (after trim).
   - Nested objects use `@ValidateNested` with `@Type`, so the global
     `whitelist` / `forbidNonWhitelisted` pipe rejects unknown keys inside them
     too. A test proves it.
   - *Why bounds:* the report is written by a machine token, not a person;
     every field the API stores is bounded, as in spec 178.
3. **Consistency is not cross-checked.** The API does not require
   `failure` on a failed run, nor `renders` to match `formats`. It stores what
   it receives. *Why:* the CLI is the only writer and derives all of them from
   one `result.json`; a cross-check would reject a report for a reason the
   user cannot act on, and reports fail silently (spec 178, Decision 3).
4. **Only the run page gets them.** `GET /runs/:id` returns `run` as today plus
   `stages`, `renders` and `failure` (`{ stage, message }` or `null`). The
   list endpoints keep `RunView` as it is: a page of 50 runs does not carry
   six renders each, and no list shows them.
   - In code: `RunPage.run` becomes `RunDetailView = RunView & { stages,
     renders, failure }`, built by a `toRunDetailView(run)` beside
     `toRunView`.
   - A stored JSON value that does not parse as the expected shape (it cannot
     happen through the DTO, but the column is untyped) is returned as `null`.
5. **Merge order.** This slice merges before #264. Until it is deployed the
   global pipe rejects a report carrying the new fields, and the CLI swallows
   that failure silently, so a new CLI against an old API loses the report.
   Production deploys from `main`, where both arrive together.

## Acceptance criteria

- [ ] The migration adds the four nullable columns; existing rows read as
      `null`.
- [ ] A report with all three fields round-trips through `GET /runs/:id`
      exactly.
- [ ] A report without them (today's shape) is accepted and `GET /runs/:id`
      returns `stages: null, renders: null, failure: null`.
- [ ] 400 for: a missing or extra stage key, an unknown stage status, a
      duplicate or unknown render format, seven renders, a non-integer or
      out-of-range number, an extra key inside a render or `failure`, a
      1001-character message, an unknown failure stage.
- [ ] `GET /projects` and `GET /projects/:id/runs` responses are unchanged.
- [ ] Another user's run is still 404.
- [ ] `bun run check`, `bun run test` and `bun run build` are green.

## Contention

| Resource | Owner | Others |
|---|---|---|
| `apps/api/prisma/**` (a migration) | #263 | No other open issue adds a migration. |
| `apps/api/src/projects/**`, `apps/api/src/videos/runs.service.ts` | #263 | No other open issue touches `apps/api`. |
| The `GET /runs/:id` response shape | #263 | #265 reads it; #264 writes the report. Both merge after #263. |

## Open questions

None.
