# ADR-0009: Playback through an API relay; Luna Player behind an adapter

Status: accepted · Date: 2026-10-17

## Context

A browser cannot read the runner's filesystem (vision §8). Luna Player
(`github:AndreyBegma/luna-player`, 0.1.1) is a React 19 DOM package; on
2026-10-17 its player component is not implemented on `main` or `develop`, and
it exposes no URL scheme, IPC or desktop interface.

## Decision

1. **The website plays a local video through the API.** The browser requests
   `GET /api/videos/:id/stream` with its session; the API checks that the
   video belongs to the user, asks the owning runner over its WebSocket for the
   requested byte range, and streams it back with HTTP range semantics.
   Nothing is stored on the server. When the runner is offline, the page says
   the video is unavailable and why.
2. **The player is an adapter** in `apps/web`: a `VideoPlayer` interface with
   two implementations, Luna Player and the native `<video>` element. Luna is
   used once its player ships under a tag that can be pinned; until then, and
   whenever it fails to load, the native element plays the same stream.
3. "Play in Luna Player" therefore means the embedded Luna component on the
   video page, not a hand-off to another application.

## Consequences

- Playback traffic passes through the server; demo videos are small, and the
  cost is accepted for one path that works from any device.
- A loopback endpoint for same-machine playback can be added later as an
  optimisation behind the same adapter.

## Update — 2026-10-17

Luna Player is published to npm as
[`luna-player`](https://www.npmjs.com/package/luna-player) (0.1.2, MIT),
released by its own Woodpecker pipeline on every version bump merged into its
`main`. `apps/web` installs it from npm, pinned exactly, like
`@andrewbehma/glass-ui` — not as a GitHub pin. 0.1.2 still ships only the
logic and platform modules; the adapter of decision 2 switches to Luna when a
version with the player component is published.
