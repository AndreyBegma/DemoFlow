# Glass UI polish for the landing page and the docs

Issue: [#376](https://github.com/AndreyBegma/DemoFlow/issues/376)
Depends on: #373 (the theme, the logo, Glass UI 0.37.0)

## Summary

The landing page (`apps/web/src/app/page.tsx`) and the docs
(`apps/web/src/app/docs/layout.tsx`) already have a floating glass header
(`className="glass … rounded-surface"`) and use `Card` for the benefit tiles
and the install block [Confirmed]. They were built before the light theme and
the logo, and they are the website's front door: the landing page is the first
impression, the docs are where a new user stays longest.

This slice brings both in line with the app shell of #373 — same logo, same
theme control, same header language — and polishes the landing sections,
while keeping the docs a readable long-form surface (vision §9: no glass on
long-form text, code or tables).

## Scope

### In scope

- `apps/web/src/app/page.tsx` and `apps/web/src/components/landing/**`
  (`copy-install.tsx`, `demo-video.tsx` — its frame only, not its source).
- `apps/web/src/app/docs/layout.tsx`, `apps/web/src/app/docs/_components/**`
  (`docs-sidebar.tsx`, `on-this-page.tsx`), `apps/web/src/mdx-components.tsx`.
- `apps/web/src/components/site-header.tsx` (new): the one header the landing
  page and the docs share (Decision 1).
- `apps/web/src/i18n/en.ts`: keys these pages add.

### Out of scope

- The landing video's 404 on production and staging: #368 fixes the Docker
  image (the file is never copied into it). This slice does not touch
  `apps/web/Dockerfile` or `apps/web/public/`.
- The docs' content (`apps/web/src/app/docs/**/page.mdx`) and
  `apps/web/src/lib/docs-nav.ts` — Phase 8 docs slices (#352, #359, #364, #365)
  edit those.
- Re-recording the landing video (spec 153).

## Decisions

1. **One site header** for the landing and the docs, extracted from the two
   copies in `page.tsx` and `docs/layout.tsx` [Confirmed: both inline a
   `<header className="sticky top-0 z-10 p-3">` with a glass bar]: logo
   (`components/brand/logo.tsx` from #373), Docs, a theme toggle (the same
   modes and storage key as #373's `lib/theme.ts`), and Open app / Sign in
   depending on the session. Glass, floating, as today.
2. **Landing sections.** Hero (headline, subline, primary "Open app" and
   secondary copy-install), the demo video in a glass frame with a soft shadow
   (the `<video>` itself stays a solid black surface), "Why DemoFlow" as
   Glass UI `Card`s with an icon each (`lucide-react`), the install block, and
   a short footer (Docs, GitHub, npm). Text stays on solid or near-solid
   surfaces; glass for the header, the video frame and the feature cards only.
3. **Docs stay readable.** Sidebar and on-this-page stay glass (they are
   navigation); the article column is the plain page surface. Code blocks,
   tables and callouts in `mdx-components.tsx` use the solid raised surface
   with token colours that pass AA in both themes. Long-form text width stays
   at `max-w-3xl` [Confirmed].
4. **Both themes, no hard-coded colours.** Every colour comes from Glass UI
   tokens; the landing hero gradient (if any) is built from tokens so it works
   in light.

## Acceptance criteria

- [ ] The landing page and every docs page show the shared header with the
      logo and a working theme toggle; the choice is the same one the app
      shell uses (switching on the landing page carries into `/app`).
- [ ] At 375 px no horizontal scroll on the landing page or on any docs page
      (code blocks scroll inside themselves).
- [ ] Docs body text, code and tables meet WCAG AA contrast in both themes
      (values in the PR); no glass behind the article text.
- [ ] `bun run check`, `bun run build`, `bun run --filter web test` pass
      (`docs-nav.test.mjs` unchanged and green).
- [ ] The PR has screenshots of the landing page and two docs pages (one with
      code and a table) in both themes, desktop and 375 px.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i376-site | landing, docs chrome, shared header | apps/web/src/app/page.tsx, apps/web/src/components/landing/**, apps/web/src/components/site-header.tsx, apps/web/src/app/docs/layout.tsx, apps/web/src/app/docs/_components/**, apps/web/src/mdx-components.tsx, apps/web/src/i18n/en.ts | #373 | yes | sonnet |

Parallel with #374 and #375 once #373 has merged.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/web/src/app/docs/layout.tsx, mdx-components.tsx | i376-site | Phase 8 docs slices change only `page.mdx` files and `docs-nav.ts`, not these |
| apps/web/src/components/landing/demo-video.tsx | i376-site | #368 changes the Dockerfile only; if it touches this file, merge #368 first |
| apps/web/src/components/brand/logo.tsx, apps/web/src/lib/theme.ts | #373 | imported, never edited |
| apps/web/src/i18n/en.ts | i376-site | append-only; whoever merges second rebases |

## Risks

- **Landing changes hide the video fix** (low): the video stays black until
  #368 deploys. Check the frame with the local dev server, where
  `/demo/landing.mp4` is served from `public/`.
- **Theme toggle on a static page** (low): the landing page is server-rendered;
  the toggle is a small client component reusing #373's `lib/theme.ts`, and the
  bootstrap script in the root layout already prevents a flash.

## Open questions

- **Footer links.** Default: Docs, GitHub (`https://github.com/AndreyBegma/DemoFlow`),
  npm (`https://www.npmjs.com/package/demoflow`).
- **Screenshots of the app on the landing page** besides the video. Default:
  none in this slice.
