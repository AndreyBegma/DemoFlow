# Public share page `/s/[token]`: player, chapters, download, password

Issue: [#351](https://github.com/AndreyBegma/DemoFlow/issues/351)
Depends on: #348.

## Summary

#348 answers a share's data, file and poster to anyone with the token, and
unlocks a password-protected share. This slice is the page the link opens,
for a viewer with no account: the video in the player the run page already
uses, the scenario's title and description, its scenes as chapters that seek
the video, a Download button, a small "Made with DemoFlow" badge, a password
form for a protected share, and clear pages for expired and unavailable
links. Link unfurlers (Slack, Telegram, X) get a title and the poster.

## Scope

### In scope

- `apps/web/src/app/s/[token]/page.tsx` (new, server component, outside
  `/app`), `not-found.tsx` as needed.
- `apps/web/src/components/share-page/` (new): `share-view.tsx`,
  `chapters.tsx`, `unlock-form.tsx`, `made-with-badge.tsx`.
- `apps/web/src/lib/share-page.ts` (new) and `share-page.test.mjs`: the
  server fetch of `GET /s/:token` (forwarding the viewer's cookies, as
  `apps/web/src/lib/session.ts` does [Confirmed]) and pure helpers (chapter
  time text, which state to render).
- `apps/web/src/components/player/video-player.ts`,
  `luna-video-player.tsx`, `native-video-player.tsx`: an optional way to
  seek (Decision 3).
- `apps/web/src/i18n/en.ts`: `sharePage.*`.

### Out of scope

- The API (#348) and the owner's dialog and list (#350).
- An embeddable iframe player (owner, Q6).
- Comments, reactions, viewer analytics.

## Decisions

1. **States.** From #348's answer: `ShareData` → the share; `{ locked: true }`
   → the password form only (no title, no poster); `404` → Next's not-found;
   `410 expired` → "This link has expired"; `410 unavailable` → "This video
   is no longer available". The page sends `noindex` in every state.
2. **The share.** Title (`h1`) and description; the player; chapters;
   Download; the badge.
   - **Video formats** play in the `VideoPlayer` adapter — `choosePlayer()`
     (Luna Player with the native fallback, ADR-0009 §2 [Confirmed:
     `video-player.ts`]) — with `src = fileUrl`, `shape` from the share's
     width and height (`16:9`, `9:16` or `1:1`), and the poster.
   - **GIF formats** (`kind: 'image'`) are an `<img>` of `fileUrl` with the
     title as `alt`; they have no chapters to seek.
   - **Download** links `downloadUrl` (#348, Decision 3).
   - **"Made with DemoFlow"** links `/` (the landing page), small and below
     the player, never over the video. [Source: owner, Q14]
3. **Seeking for chapters.** `VideoPlayerProps` gains an optional
   `onControls?(controls: { seek(ms: number): void }): void`; both
   implementations call it once they can seek. The native element sets
   `currentTime`; Luna uses its seek API if it has one [Unknown: check
   `luna-player` 0.2.0's exports], otherwise this slice falls back to the
   native player on the share page. Chapters render as a list of `mm:ss
   title` buttons; clicking seeks and plays. No chapters → no list.
4. **Password form.** One password field and Unlock; posts
   `/api/s/:token/unlock`, then `router.refresh()` so the server component
   fetches again with the new cookie. `401` → "Wrong password"; `429` → "Too
   many attempts, try again in a few minutes".
5. **Unfurl metadata.** `generateMetadata` sets `og:title` (title),
   `og:description` (description), `og:image` (`posterUrl`, absolute), and
   `og:type: video.other` with `og:video` = `fileUrl` for MP4 shares without
   a password. A locked share's metadata is "A shared DemoFlow video" and no
   image. [Source: ADR-0019 §2 — nothing of a locked share leaves]
6. **Look.** A content surface, readable, centred, max width like the run
   page; glass only for floating chrome (the badge), per
   `docs/product/vision.md` §9. The page works without JavaScript for the
   video itself (the native fallback renders the `<video>` tag).
7. **No account UI.** No sign-in prompt, no header of the app; a viewer is
   never asked to sign up. The landing link is the badge.

## Acceptance criteria

- [ ] An MP4 share renders title, description, the player with the poster,
      chapters, Download and the badge; clicking a chapter seeks to its time.
- [ ] A GIF share renders an `<img>` and no player.
- [ ] A locked share renders only the password form; a right password shows
      the video after refresh; wrong and rate-limited attempts show their
      messages.
- [ ] Expired, unavailable and unknown tokens render their pages; an
      unknown token answers 404 (`notFound()`). Expired and unavailable
      answer 410 if the App Router lets a page set it [Unknown], otherwise
      200 with `noindex` (Open questions).
- [ ] The HTML of an unlocked share has `og:title`, `og:image` and
      `noindex`; a locked share's HTML contains neither its title nor its
      poster URL.
- [ ] `/s/<token>` is reachable without a session; the `/app` guard does not
      apply [Confirmed: the proxy matcher is `/app/:path*` only].
- [ ] The run page still plays through the adapter unchanged.
- [ ] `bun run check`, `bun run build` pass; `node --test` of the new
      `.test.mjs` passes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i351-web | the public page | apps/web/src/app/s/**, apps/web/src/components/share-page/**, apps/web/src/lib/share-page.ts, apps/web/src/lib/share-page.test.mjs, apps/web/src/components/player/video-player.ts, apps/web/src/components/player/luna-video-player.tsx, apps/web/src/components/player/native-video-player.tsx, apps/web/src/i18n/en.ts | #348 | yes | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/web/src/components/player/video-player.ts and both players | i351-web | #357 (editor preview) needs time and seek too: whichever is second builds on the first's `onControls` |
| apps/web/src/i18n/en.ts | shared | appends; rebase |

## Risks

- **Luna Player has no seek API** (medium). Mitigation: Decision 3's native
  fallback on this page; note it for luna-player.
- **Large files on mobile data** (low). Mitigation: `preload="metadata"` and
  the poster; nothing autoplays.

## Open questions

- Showing the expiry date to viewers — default: no; it is the owner's detail.
- HTTP 410 for expired and unavailable pages — default: 200 with `noindex`
  if a page cannot set the status; the body says what happened either way.
