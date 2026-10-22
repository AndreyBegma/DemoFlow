# Public landing page

Issue: [#137](https://github.com/AndreyBegma/DemoFlow/issues/137) · Phase 5 ·
Roadmap: [Phase 5 — "a simple public landing page"](../product/roadmap.md#phase-5--website-and-runner-pairing)
· Vision §9 (Glass UI) · Builds on [124](124-sign-in-pages.md), [121](121-i18n-dictionary.md)

## Summary

`/` is a single centred card today [Confirmed: `apps/web/src/app/page.tsx`].
The roadmap asks for a simple public landing page: what DemoFlow is, a demo
video made with DemoFlow, "Install" (`npx demoflow`) and "Sign in". This slice
builds it. The video is a real DemoFlow render of the repository's fixture app,
and its scenario is committed so the video can be re-recorded with one command.
The documentation section is a later slice.

## Scope

### In scope

- `/` becomes the landing page with these sections, in order:
  1. a header with the logo, "Docs" and "Sign in" or "Open app";
  2. a headline and subheadline;
  3. the demo video;
  4. three benefit blocks;
  5. Install;
  6. a footer.
- A demo scenario for `apps/fixture`, the rendered MP4 and a poster image in
  `apps/web/public/`, and a script that re-records them.
- Page metadata: title, description and an Open Graph image.

### Out of scope

- The documentation section (its own slice). "Docs" links to the repository
  README on GitHub for now.
- Pricing (roadmap: none), testimonials, a blog, analytics, and a cookie
  banner (no cookies are set on `/` for guests).
- Any change to `/app/**` or the auth pages.

## Decisions

1. **The video is a DemoFlow render of `apps/fixture`.** (owner, 2026-10-21)
   - A new scenario, `apps/fixture/demoflow/landing.demo.json`, shows:
     sign in (the password masked), open invoices, filter, and open one
     invoice.
   - It uses the Phase 4 look: window frame, background, intro and outro
     cards, transitions.
   - The existing scenarios there [Confirmed: `login`, `tour`, `customers`]
     are the reference for locators.
   - The rendered `landing.mp4` (H.264, 1920×1080) and `landing-poster.png`
     (the intro card frame) are committed in `apps/web/public/demo/`.
   - The video plays `muted`, `loop` and `playsInline` with controls, and does
     not autoplay when `prefers-reduced-motion` is set.
2. **Re-recording is one command.** (orchestrator) A root script,
   `bun run landing:record`, starts the fixture app, runs `demoflow run` on the
   scenario and copies the MP4 and the poster into `apps/web/public/demo/`.
   The PR states the MP4's size; the target is under 8 MB.
3. **The copy is drafted from the vision and README.** (owner) The slot writes
   it. **The owner approves the copy and the screenshots before merge**
   (Gate). Content:
   - **Headline**: what DemoFlow does, in one line (vision §1: product demo
     videos generated from scenarios and recorded from your running app).
   - **Benefit blocks**, three of them:
     - write a scenario, or let an AI agent write it through MCP, and get a
       polished video;
     - secrets are masked by construction;
     - videos stay on your machine (ADR-0008).
   - **Install**: `npx demoflow` in a code block with a copy button, and one
     line on `demoflow record`.
4. **A signed-in visitor sees the landing page with "Open app"** in place of
   "Sign in". (owner) There is no redirect, so the page can be shared. The
   session check is the server-side `me` call of #124.
5. **Glass UI for chrome only.** (vision §9, CLAUDE.md) The header is glass.
   Content sections are readable surfaces built from the existing primitives.
   **No new dependency.**
6. **Every string through `t()`**, under `landing.*` (#121).

## UI

- **Responsive**: at 375 px nothing scrolls horizontally and the video keeps
  its aspect ratio; at 1440 px the content is capped and centred.
- **Light and dark**: follow the theme the app already supports.
- **Accessibility**:
  - one `h1`, and sections with headings;
  - the video has an `aria-label`, and the poster has alt text;
  - the copy button announces "Copied" through `aria-live`;
  - every control is reachable by keyboard.
- **Metadata**: `<title>`, `description`, and `og:title`, `og:description`,
  `og:image` (a 1200×630 frame from the video, committed). `og:url` comes
  from `WEB_URL`.

## Acceptance criteria

- [ ] **Screenshots in the PR**:
      - `/` as a guest at 1440 px and at 375 px;
      - `/` signed in, showing "Open app";
      - dark and light themes at 1440 px.
- [ ] `bun run landing:record` on a clean checkout re-creates
      `apps/web/public/demo/landing.mp4` and `landing-poster.png`. The run's
      `result.json` reports status `passed`.
- [ ] In the committed video the password field is masked in every frame (the
      run's mask check passes). The PR states the MP4 size, under 8 MB.
- [ ] With `prefers-reduced-motion: reduce`, the video does not autoplay
      (screenshot or test).
- [ ] No user-facing string literal in `apps/web/src/app/**` or
      `apps/web/src/components/**`.
- [ ] "Sign in" goes to `/sign-in`, "Open app" to `/app`, "Docs" to the README
      on GitHub. The copy button copies `npx demoflow`.
- [ ] A guest's request to `/` sets no cookie.
- [ ] `bun run check` and `bun run build` pass. Woodpecker is green. After the
      merge, staging serves the landing page at `/`.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i137 | the landing page and its demo video | apps/web/**, apps/fixture/demoflow/landing.demo.json, package.json | — | yes | sonnet |

One slot. Every section, string family and asset is named here, so it is
`sonnet`. The copy is reviewed by the owner at the gate.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/web/src/i18n/en.ts | i137, then i135-web after this merges | do not open |
| package.json (root, `landing:record` script) | i137 | do not open |
| bun.lock | nobody: no new dependency | — |

`apps/cli/**` is not touched: the script calls the built CLI, it does not
change it.

## Risks

- **The committed video goes stale as the renderer improves** (low).
  Mitigation: `bun run landing:record` re-records it in one step.
- **The repository grows with binary assets** (low). Mitigation: one MP4
  under 8 MB, one poster and one OG image. Re-recording replaces them and
  never adds new ones.
- **The copy promises what is not built** (medium). Mitigation: the copy
  states only shipped features (no Runner, library or GitHub Action yet), and
  the owner reviews it at the gate.

## Open questions

- None. Default for an unsettled visual detail: follow the existing auth pages'
  card styling.

Gate: the owner approves the landing copy and the PR screenshots before merge.
