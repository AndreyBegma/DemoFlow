# ADR-0020: A run's edits come from the website, and the Runner re-renders

Status: accepted · Date: 2026-10-26 · Extends: [ADR-0008](0008-cloud-boundary.md) §2 and §3 · Specs: [353](../specs/353-edits-schema-and-render.md), [354](../specs/354-trim-and-cuts.md), [355](../specs/355-runner-edits-and-rerender.md), [356](../specs/356-editor-relay-api.md), [357](../specs/357-timeline-editor.md), [358](../specs/358-edits-export-reset-share.md), [359](../specs/359-editor-docs.md)

## Context

A rendered video is fixed by three things: the recording (`source.webm`,
`timeline.json`), the scenario that drove it, and the project's `render.*`
([ADR-0004](0004-recording-is-separate-from-rendering.md)). Fixing a typo in a
caption, moving a zoom from one step to another, retitling the outro, or
cutting a slow page load means editing the scenario or the config and running
the whole scenario again: the app, the browser, its timing.
`demoflow render <runId>` (spec 255) re-renders without the browser, but only
with the project's *current* config, and only from the command line.

The owner wants a timeline editor on the run page: captions (text and timing),
zoom per step, cards and style, and trimming with any number of cuts, previewed
in the browser and rendered by the machine that holds the recording.

Two decisions stand in the way:

- [ADR-0008](0008-cloud-boundary.md) §3 lists what the website may make a
  Runner do: start a run of a committed scenario, cancel it, stream a video,
  delete a run's artifacts. "Nothing else." Re-rendering is not on the list
  (spec 255 names this in its Out of scope), and neither is reading or writing
  anything in a run directory.
- ADR-0008 §2 lists what crosses to the cloud: a scenario's name and id, its
  steps as action, locator and caption, stage statuses, durations, resolution,
  file sizes, a failed step's error. Step times, target boxes and the
  scenario's `description` are not on the list, and an editor cannot place a
  caption or a zoom without them.

## Decision

1. **Edits are a file in the run directory: `runs/<runId>/edits.json`.**
   Its shape is `RunEditsSchema` in `@demoflow/core`: captions, zoom per
   step, card text, background and window style, a trim and cuts. All times
   are **timeline milliseconds** (the engine clock of `timeline.json`), never
   output milliseconds, so an edit stays where it was put when the idle map,
   the cards or a cut move the output around it. The file is optional; a run
   without it renders exactly as it does today. Nothing else in the run
   directory is ever written by an edit: `source.webm`, `timeline.json`,
   `scenario.json` and the capture stages of `result.json` stay as recorded.
2. **The renderer applies the edits over the run's own inputs.**
   `buildRenderPlan` reads `edits.json` beside `timeline.json`. An edit
   replaces what the timeline and the config would have given for that one
   thing (a caption list, a step's zoom, a card's text, the background, the
   window, the time range); everything it does not name is unchanged. This
   holds for `demoflow render` and for a re-render the website asks for.
   - *Relation to [ADR-0012](0012-camera-directed-by-the-scenario.md):* the
     camera still zooms only on a step, and only on a step whose event carries
     a target box (§2). An edit may set, change or remove a step's `zoom` for
     this run; it cannot zoom at an arbitrary time or on a region that is not
     a step's target. ADR-0012's Consequences ("zoom at an arbitrary time
     would be a new field, decided on its own") still hold.
   - *Relation to ADR-0004 §4:* a failed run is still visibly failed. Edits
     never remove the failure card or the watermark, and a trim or a cut can
     never hide the failed step: the time range always ends on it.
3. **What the website may make a Runner do — two additions to ADR-0008 §3:**
   - *read and write the edits of a run it reported:* the Runner answers with
     the run's **edit model** (Decision 4) and saves or deletes `edits.json`
     when asked;
   - *re-render a run it reported*, with the project's current `render.*`
     plus the run's edits, and report the new renders back.

   The run is named by its id and found through the Runner's own
   `reported-runs.jsonl`, the same lookup `artifacts.delete` uses (spec 233).
   Every other "nothing else" of §3 holds word for word: the website never
   sends a scenario body, a command or a URL; the Runner validates `edits.json`
   with `RunEditsSchema` before writing it, and an edit holds data only —
   text, times, numbers, a background value — never a path, a URL, a locator
   or a step.
4. **The edit model crosses live, and is never stored on the server.**
   When the editor opens, the Runner sends, for that run: each event's step
   index, action, start and end time, target box and `zoom`; captions and
   scene titles (from steps and from the page, ADR-0014); the scenario's
   `name` and `description`; the `render.*` style that would apply; the
   current edits; and the current render's output-to-timeline time map, so
   the browser can draw a preview over the video it already plays. This
   extends ADR-0008 §2 by step times, target boxes and the description. It
   still never carries `fill` values, URL query strings, locators beyond
   what §2 already allows, logs, screenshots, traces or local paths. The API
   relays it to the browser and keeps nothing; the run detail and the run
   report are unchanged. When the Runner is offline, the editor says so and
   shows nothing.
5. **The website never writes a file in the repository.** The scenario and
   `demoflow.config.json` stay the person's. "Export" produces, on the Runner,
   an RFC 6902 JSON Patch against the scenario file that touches only
   `caption` and `zoom` of top-level steps, and a `render` fragment for the
   config. The person applies it — `demoflow edits apply <runId>` on the
   machine, by hand, or through an agent — and commits it. Edits that a
   scenario cannot express (a caption at a free time, a trim, a cut, a step
   that came from a `repeat` or an `include`) are listed as not exportable,
   with the reason.
6. **A re-render replaces the run's render files.** As `demoflow render`
   does today (spec 255): `renders[]` and the `rendering` stage of
   `result.json` change, the verdict never does. Resetting the edits deletes
   `edits.json`, and the next render is the original. There are no render
   versions. A shared copy (ADR-0019) is never replaced on its own: the
   person updates it explicitly, which keeps ADR-0008 §5 ("nothing is
   uploaded automatically").

## Consequences

- **Cost: more crosses the boundary.** Step times and target boxes describe
  the layout of the user's application (where a button is, how long a page
  took). They cross only while the editor is open, only to the run's owner,
  and are never stored; the cost is accepted for an editor that can place
  anything at all.
- **Cost: the scenario's `description` crosses.** It is author-written text,
  like a caption. ADR-0019 sends it with a share for the same reason.
- **Cost: the Runner does more work on the website's behalf.** A re-render
  spends the machine's CPU and disk. It is bounded like a run: one render of a
  run at a time, the daemon's 15-minute cap (spec 248), and only the formats
  the website may already choose (ADR-0017).
- **Cost: the timeline contract grows a sibling.** `RunEditsSchema` is a
  versioned contract of `@demoflow/core` like `TimelineSchema` (ADR-0004
  Consequences); changing it is a versioned change.
- An edited run and its scenario drift apart until the person exports and
  commits. The next run of the scenario does not know the edits of the last.
  The run page says which runs carry edits.
- A run recorded before edits existed is editable: the model is built from
  `timeline.json`, which every run has.
- Editing needs the machine online, like playback (ADR-0009).
