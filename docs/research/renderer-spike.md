# Renderer spike: Remotion and an FFmpeg compositor

Issue: [#4](https://github.com/AndreyBegma/DemoFlow/issues/4) ·
Spec: [4-renderer-spike](../specs/4-renderer-spike.md) ·
Decision: [ADR-0005](../adr/0005-renderer-chosen-by-spike.md) (proposed)

This report compares the two renderers of `@demoflow/renderer` and closes with
a recommendation. The owner decides after watching the videos.

Both renderers draw the same render plan and nothing else. Each output frame
is `frameAt(plan, frame)` (PR #20). Remotion draws it as a React composition in
headless Chrome (PR #22). The FFmpeg compositor draws it in TypeScript and pipes
raw frames to FFmpeg (PR #21). So the comparison is of renderers, not of two
readings of the timeline.

## Method

- **Machine:** AMD Ryzen 7 PRO 8700GE (16 threads), Fedora Linux 44 (kernel
  6.19), Node 24.21.0. The machine was shared with other jobs during the run
  (load average 12 → 20 on 16 threads). The spread in the tables is mostly
  that load, not the renderers.
- **Runs:** the four fixture scenarios (`customers`, `login`, `tour`,
  `failing`), recorded once through the engine. Both renderers then drew the
  same four run directories.
- **Order:** in one process, three passes. Each pass renders every run with
  FFmpeg, then with Remotion, one at a time, so the renderers never share the
  CPU.
- **Render time:** wall-clock time of `Renderer.render()`. That includes
  writing `result.json` and probing the MP4. It does not include recording.
  Each table gives the median of the three passes and the range.
- **Remotion "cold":** Remotion bundles its composition with webpack once per
  process, so its first render in a process includes the bundle (pass 1 of
  `customers`). Its first render on a new machine also downloads Chrome
  Headless Shell. That render took 14.66 s for `customers`, in a separate
  warm-up process.
- **Output:** every MP4 is H.264 High, `yuv420p(tv, bt709)`, 1920×1080,
  30 fps, with faststart, from both renderers.
- **Install size:** `npm i` with npm 11.19.0 into an empty directory, on Linux
  x64 glibc. That is what `npm i -g demoflow` would add. Bun's numbers from PR
  #22 are given for comparison: Bun also installs the musl binaries.

### Reproduce

```sh
bun install
bun run build
bun run --filter @demoflow/renderer spike --record <dir> --passes 3 --copy-to <videos>
```

- `--record <dir>` records the four fixture runs into `<dir>/<scenario>`. It
  needs Playwright's Chromium, as the engine's tests do.
- `spike <runDir>...` renders existing runs instead.
- Each MP4 is written to `<runDir>/render/<renderer>.mp4`.
- Each run's measurements are written to `<runDir>/render/spike.json`.
- With `--copy-to <videos>`, the MP4s are also copied to
  `<videos>/<run>-<renderer>.mp4`.

The script is `packages/renderer/scripts/spike.ts`. It runs under Node, with
no shell and only `node:path` paths.

## FFmpeg compositor

| | customers | login | tour | failing |
|---|---|---|---|---|
| Output video | 3.24 s, 97 frames | 2.23 s, 67 frames | 6.20 s, 186 frames | 3.68 s, 110 frames |
| Render time, median (range) | 4.55 s (4.52–4.97) | 4.64 s (3.92–4.75) | 8.36 s (7.90–10.89) | 2.90 s (2.28–3.04) |
| MP4 size | 828 083 B | 144 141 B | 1 168 831 B | 190 539 B |

| | |
|---|---|
| Packages added to `npm i -g demoflow` | **0** beyond `ffmpeg-static`, which the render plan needs anyway |
| Download added | **0** beyond `ffmpeg-static` (see *Shared* below) |
| Linux (x64, Fedora 44) | installs and renders all four runs |
| macOS | **Unknown**: #6's OS matrix is not available yet |
| Windows | **Unknown**: #6's OS matrix is not available yet |
| Licence | our code; the stroke font is public domain (Hershey, U.S. NBS) |
| Code we own | about 1 190 lines in `src/ffmpeg/`, of which about 250 are the font table |

- The compositor composites frames in single-threaded JavaScript. It ran at
  14–48 frames per second here.
- Encoding is libx264, CRF 18, preset `medium`.
- Text is drawn with the embedded Hershey Simplex stroke font, because
  `ffmpeg-static` 7.0.2 has no `drawtext` filter. The font covers printable
  ASCII only. Any other character is drawn as `?`.

## Remotion

| | customers | login | tour | failing |
|---|---|---|---|---|
| Output video | 3.24 s, 97 frames | 2.23 s, 67 frames | 6.20 s, 186 frames | 3.68 s, 110 frames |
| Render time, median (range) | 4.75 s (4.75–6.92) | 3.68 s (3.27–5.20) | 7.99 s (6.96–9.82) | 4.12 s (4.04–4.72) |
| First render in a process (bundle included) | 6.92 s | — | — | — |
| First render on a new machine (Chrome download and bundle included) | 14.66 s | — | — | — |
| MP4 size | 1 075 422 B | 173 806 B | 1 635 229 B | 205 834 B |

| | npm (glibc), **used for the comparison** | Bun (PR #22) |
|---|---|---|
| `remotion` + `@remotion/renderer` + `@remotion/bundler`, React excluded | **176 packages, 196 MB** | 185 packages, 289 MB |
| Runtime only (`remotion` + `@remotion/renderer`), bundle prebuilt at publish time, React excluded | **23 packages, 34 MB** | 24 packages, 60.7 MB |
| Chrome Headless Shell, downloaded on the first render, not at install | **91.9 MB download, 220 MB on disk** | same |

- React and React DOM (3 packages, 8 MB) are excluded above. Only Remotion
  needs them.
- Bun installs both the glibc and the musl builds of `@remotion/compositor`
  and `@rspack/binding`. npm installs only the one for the platform.
- The runtime-only row applies only if the composition is bundled when
  `demoflow` is published. Today it is bundled on the user's machine, which
  needs `@remotion/bundler`.
- Chrome is downloaded from `remotion.media` into
  `<nearest package.json>/node_modules/.remotion/`. For a global install, that
  is inside the global `node_modules`. So the first render needs the network,
  even after the install succeeded.
- Remotion encodes with its own FFmpeg (n7.1, inside
  `@remotion/compositor-<platform>`), not `ffmpeg-static`. Remotion 4 has no
  option to change it, so a user gets two FFmpeg binaries.

| Platform | |
|---|---|
| Linux (x64, Fedora 44) | installs and renders all four runs |
| macOS | **Unknown**: #6's OS matrix is not available yet |
| Windows | **Unknown**: #6's OS matrix is not available yet |

### Licence

The file read is `node_modules/remotion/LICENSE.md` in `remotion` 4.0.532,
quoted verbatim:

> # Remotion License
>
> In Remotion 5.0, the license will slightly change. [View the changes here](https://github.com/remotion-dev/remotion/pull/3750).
>
> ---
>
> Depending on the type of your legal entity, you are granted permission to use Remotion for your project. Individuals and small companies are allowed to use Remotion to create videos for free (even commercial), while a company license is required for for-profit organizations of a certain size. This two-tier system was designed to ensure funding for this project while still allowing the source code to be available and the program to be free for most. Read below for the exact terms of use.
>
> - [Free License](#free-license)
> - [Company License](#company-license)
>
> ## Free License
>
> Copyright © 2026 [Remotion](https://www.remotion.dev)
>
> ### Eligibility
>
> You are eligible to use Remotion for free if you are:
>
> - an individual
> - a for-profit organization with up to 3 employees
> - a non-profit or not-for-profit organization
> - evaluating whether Remotion is a good fit, and are not yet using it in a commercial way
>
> ### Allowed use cases
>
> Permission is hereby granted, free of charge, to any person eligible for the "Free License", to use the software non-commercially or commercially for the purpose of creating videos and images and to modify the software to their own liking, for the purpose of fulfilling their custom use case or to contribute bug fixes or improvements back to Remotion.
>
> ### Disallowed use cases
>
> It is not allowed to copy or modify Remotion code for the purpose of selling, renting, licensing, relicensing, or sublicensing your own derivate of Remotion.
>
> ### Warranty notice
>
> The software is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement. In no event shall the author or copyright holders be liable for any claim, damages or other liability, whether in an action of contract, tort or otherwise, arising from, out of or in connection with the software or the use or other dealings in the software.
>
> ### Support
>
> Support is provided on a best-we-can-do basis via GitHub Issues and Discord.
>
> ## Company License
>
> You are required to obtain a Company License to use Remotion if you are not within the group of entities eligible for a Free License. This license will enable you to use Remotion for the allowed use cases specified in the Free License, and give you access to prioritized support (read the [Support Policy](https://www.remotion.dev/docs/support)).
>
> Visit [remotion.pro](https://www.remotion.pro/license) for pricing and to buy a license.
>
> ### FAQs
>
> Are you not sure whether you need a Company License because of an edge case? Here are some [frequently asked questions](https://www.remotion.pro/faq).

The file links two more pages that apply:

- Remotion 5's licence change:
  <https://github.com/remotion-dev/remotion/pull/3750>.
- Company License pricing: <https://www.remotion.pro/license>.

Neither was read for this report, and neither is quoted here.

**What the text says:** the free licence covers an individual, a for-profit
organisation of up to 3 employees, a non-profit, or an evaluation. Anyone else
"is required to obtain a Company License to use Remotion".

**Our interpretation, not a fact, and not legal advice:**

- `demoflow` runs Remotion on the user's machine to make the user's videos.
- Read that way, the party that "uses Remotion" is the user's organisation,
  not only us.
- A team of more than three people at a for-profit company would then need its
  own Company License to render with DemoFlow.
- Whether a licence we buy could cover our users is not answered by the file.
  The FAQ and Remotion 5's terms might answer it; Remotion would have to
  confirm it.

## Shared by both

- `ffmpeg-static` 5.3.0 is needed whichever renderer is chosen: the render plan
  probes the source with it.
  - npm adds 20 packages and 78 MB.
  - Its binary (FFmpeg 7.0.2, 76 MB on disk) is downloaded from GitHub by a
    postinstall script.
  - npm 11.19 lists that script under its `install-scripts` warning. It still
    ran here.
  - A system FFmpeg is used instead only if it has libx264. Fedora's has none.
- Both renderers draw the same frames, so these limits of the recording apply
  to both. They are not limits of either renderer:
  - the source is 1× (VP9 1280×720, 25 fps), so the zoom is 1.25×, and
    1.875× the source pixels at full zoom ([#17](https://github.com/AndreyBegma/DemoFlow/issues/17)
    proposes a 2× source);
  - after sign-in, the `login` mask stays over the welcome page, because the
    timeline does not record which click navigated
    ([#18](https://github.com/AndreyBegma/DemoFlow/issues/18));
  - the clock offset between video and timeline is a fixed −100 ms, not
    measured per run ([#19](https://github.com/AndreyBegma/DemoFlow/issues/19)).

## Visual comparison

Frames were extracted from both MP4s at the same frame numbers and compared
side by side. SSIM was computed between the two renderers' videos of each run
with FFmpeg's `ssim` filter.

| run | SSIM, all planes | SSIM, luma |
|---|---|---|
| customers | 0.990 | 0.985 |
| login | 0.998 | 0.998 |
| tour | 0.995 | 0.993 |
| failing | 0.950 | 0.926 |

- **These match:**
  - the page image;
  - the camera's zoom and pan;
  - the cursor, its path and the click rings;
  - the mask's position, blur and wash;
  - the badge's place and colour.
- **The text differs.** It is the only visible difference.
  - Remotion draws text in Chromium's `sans-serif`, anti-aliased: a normal
    product-video look.
  - The compositor draws a thin single-stroke Hershey font. It reads as
    technical or plotter-like.
  - The compositor reads the look table's text sizes as cap heights, and
    Remotion reads them as CSS `font-size`. So the compositor's captions and
    end card are about 1.4× larger.
  - The `failing` run has the lowest SSIM because its 3 s end card is mostly
    text.
- **MP4 size:** Remotion's files are 8–40 % larger. The two use different
  encoder settings, and the size gap does not show a quality gap.

## Recommendation

**The FFmpeg compositor**, with real font rendering added before Phase 4.

Reasons, by the criteria the issue names:

- **Licence.** This decides it. We ship the renderer to every user, and under
  the quoted terms most companies above three people would need a Remotion
  Company License to use DemoFlow (our interpretation, above). A product whose
  output depends on each customer buying a third party's licence is not one we
  can sell simply. The compositor has no such term.
- **Install size and portability.** Remotion adds:
  - 176 packages and 196 MB through npm, or 23 packages and 34 MB with a
    bundle prebuilt at publish time;
  - a 91.9 MB Chrome download on the first render, from a server that is not
    npm;
  - a second FFmpeg binary.

  The compositor adds nothing beyond `ffmpeg-static`, which both need. Fewer
  native downloads also means fewer ways to fail on macOS and Windows. Both
  platforms are still Unknown until #6.
- **Render time.** No material difference.
  - Warm, each renderer is faster on two of the four runs, within this
    machine's noise.
  - The compositor has no bundle step (+2.2 s in a new process here) and no
    first-run Chrome download (+7.7 s here).
  - Its JavaScript compositing is single-threaded. It can be split across
    workers if longer videos need it.
- **Quality.** Equal everywhere except text. There Remotion is clearly better
  today.
- **Maintenance.**
  - The compositor is code we own: about 1 190 lines, including the raster
    primitives, the blur and the font.
  - Each new effect is code we write and test, where Remotion would give us a
    CSS property.
  - That cost is real, but it is bounded. The render plan already does the
    hard part, and each renderer only draws `FrameState`.

**What I would build next:** proper text in the compositor. Rasterise glyphs
from an embedded OFL-licensed font (for example Inter) in JavaScript, so the
compositor reads no system font and adds no native dependency. Also use one
text-size convention (CSS `font-size`) in both renderers' look.

**What would change my mind:**

- **Remotion confirms the licence covers our users.** If Remotion confirms in
  writing that a DemoFlow licence covers rendering on our users' machines, the
  licence reason goes away. So does it if the Remotion 5 terms say so, at a
  price we accept. I would then recommend Remotion for its text and its
  CSS-based effects.
- **The owner rejects the text.** If the owner judges the compositor's text
  unacceptable, and real font rendering would need a native dependency or more
  than about a week, the compositor loses its cost advantage.
- **Phase 4 needs browser layout.** If Phase 4's titles and transitions turn
  out to need real layout (multi-line rich text, images, animated CSS), a
  browser renderer earns its weight.
