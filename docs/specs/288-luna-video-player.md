# Luna Player `VideoPlayer` adapter

Issue: [#288](https://github.com/AndreyBegma/DemoFlow/issues/288)
Depends on: AndreyBegma/luna-player#10 (released as `luna-player@0.2.0`, published 2026-10-24)

# feat(web): Luna Player VideoPlayer adapter

## Description

Phase 6: the Luna implementation of the web `VideoPlayer` adapter (ADR-0009 §2). Today `choosePlayer()` in `apps/web/src/components/player/video-player.ts` always returns `NativeVideoPlayer`, because `luna-player@0.1.2` ships no player component. `luna-player@0.2.0` adds `luna-player/player` (`<Player>`, extracted from Luna Watch's player) and `luna-player/player.css` (AndreyBegma/luna-player#10). This issue switches the run page to it and keeps the native `<video>` as the fallback.

## Depends on

AndreyBegma/luna-player#10 merged and `luna-player@0.2.0` published to npm with `luna-player/player` and `luna-player/player.css` in its `exports` (`npm view luna-player@0.2.0 exports`). Until then this stays `cs:blocked`.

## Design

- **Pin.** `apps/web/package.json` gets `"luna-player": "0.2.0"` (exact, like `@andrewbehma/glass-ui`), and `bun.lock` is updated with `bun install`. Do **not** add `hls.js`: the relay serves MP4/WebM only, and the adapter never imports `luna-player/hls`. The peers `react`, `react-dom`, `@andrewbehma/glass-ui`, `lucide-react`, `motion` and `tailwindcss` are already in `apps/web`, and so are the Glass UI Radix peers the player's slider and tooltip need (`@radix-ui/react-slider`, `@radix-ui/react-tooltip`). `bun install` must report no unmet peer warnings other than optional `hls.js`.
- **Styles.** `apps/web/src/app/globals.css` (the Tailwind entry) adds `@import "luna-player/player.css";` after the Glass UI imports. The player's components use Tailwind utilities and Glass UI tokens, and `player.css` carries `@source "."`, so Tailwind must see it through the CSS entry. A JS `import 'luna-player/player.css'` is not enough.
- **`LunaVideoPlayer`** (`apps/web/src/components/player/luna-video-player.tsx`, `'use client'`) satisfies `VideoPlayerProps`:
  - maps `shape` through a pure `lunaAspectRatio(shape)`: `landscape` → `'16:9'`, `vertical` → `'9:16'`, `square` → `'1:1'`;
  - renders `<Player src={src} aspectRatio={…} onError={…} storage={null} />` (`storage={null}`: no `luna-player:*` keys on the DemoFlow origin; drop it if volume memory is wanted) inside the same box the native player uses (`mx-auto max-h-[70vh] w-full rounded-control bg-black`, `max-w-sm` for vertical, `max-w-md` for square), so switching implementations moves nothing on the page. The player's frame sets its own `aspect-ratio`, so the wrapper sets only width, max-width, max-height and radius;
  - passes `labels` built from the app's `t()` for the keys the player shows (play/pause, mute/unmute, volume, seek + `seekPosition`, playback speed, fullscreen enter/exit, `playbackFailed`, `ariaPlayer`), with new `runPage.player.*` keys in the i18n catalogue. `luna-player`'s built-in English (`en` from `luna-player/labels`) is the fallback for anything not passed.
- **Loading and fallback** (ADR-0009 §2: "whenever it fails to load, the native element plays the same stream"):
  - The Luna module is loaded lazily, with `React.lazy` (or `next/dynamic`) around `import('luna-player/player')`. **If that import rejects** (chunk failed to load, network, CSP), the lazy component resolves to `NativeVideoPlayer` instead of throwing. While it loads, the Suspense fallback is an empty black box of the same shape, so the layout does not shift.
  - **If Luna's `onError` fires**, the adapter swaps to `NativeVideoPlayer` for the same `src`, once. If the native player then also fails, it calls the page's `onError()`. This is the existing `handlePlayerError`: refetch the machine, then show offline / failed / Retry. The decision is a pure function in `apps/web/src/lib/player-choice.ts`: `afterPlayerError(current: 'luna' | 'native'): 'native' | 'report'`.
  - Retry in `RunPlayback` already remounts the player with a new `key`, which starts again from Luna. A format switch or a new attempt is a fresh mount, so no fallback state leaks between sources.
- **`choosePlayer()`** returns `LunaVideoPlayer`, and the doc comment is updated (the trigger it describes has happened). `NativeVideoPlayer` stays exported and unchanged as the fallback.
- **Unmount aborts the stream.** `RunPlayback` unmounts the player during deletion so the browser drops its range request. Luna's `<Player>` clears `src` on unmount. Verify that it does, and that the relay logs the cancellation the same way as with the native player.
- GIF formats keep rendering as `<img>`. No change.

## Acceptance criteria

- [ ] `apps/web/package.json` pins `"luna-player": "0.2.0"` exactly. `bun.lock` is updated. `hls.js` is not added.
- [ ] `globals.css` imports `luna-player/player.css` after the Glass UI imports, and the player's Tailwind classes are present in the built CSS: the controls render styled in `next build` output, not just in dev. The controls use Glass UI tokens in both the light and the dark theme.
- [ ] `LunaVideoPlayer` implements `VideoPlayerProps` with no type assertions, maps all three shapes, and occupies the same box as `NativeVideoPlayer` for each shape.
- [ ] `choosePlayer()` returns `LunaVideoPlayer`. The run page plays MP4 and WebM through the relay with Luna's controls: play/pause, seek, time, volume, speed, fullscreen, and keyboard when the player has focus.
- [ ] If `import('luna-player/player')` rejects, the native `<video controls>` plays the same `src`. Covered by a test of the loader fallback: the loader function is extracted so it can be called with a rejecting importer.
- [ ] If Luna calls `onError`, the native player is tried once for the same `src`. A second failure calls the page's `onError()`, and the offline / failed banners and Retry behave exactly as today.
- [ ] Deleting a run's files while it is playing still cancels the relay stream (player unmounted, range request aborted).
- [ ] The player's visible strings come from `t()` (`runPage.player.*`), not from Luna's English defaults.
- [ ] Tests, `node --test`, added to `apps/web`'s `test` script:
  - `src/lib/player-choice.test.mjs` covers `lunaAspectRatio` for the three shapes, `afterPlayerError('luna') === 'native'`, `afterPlayerError('native') === 'report'`, and the loader returning the native player when the importer rejects (`loadVideoPlayer(importer)` in `player-choice.ts`, a pure async function with no React).
- [ ] `bun run check`, `bun run lint`, `bun run build` and `bun run --filter @demoflow/web test` are green. `next build` succeeds without `hls.js` installed.
- [ ] Manual check on staging after merge: one landscape, one vertical and one square run play in Luna, and the keyboard works when focused. With the machine offline the page shows the offline banner, not a broken player.

## Touches

- `apps/web/package.json`, `bun.lock`
- `apps/web/src/app/globals.css`
- `apps/web/src/components/player/luna-video-player.tsx`: new
- `apps/web/src/components/player/video-player.ts`: `choosePlayer()`, doc comment
- `apps/web/src/lib/player-choice.ts`: new, `lunaAspectRatio`, `afterPlayerError`, `loadVideoPlayer`
- `apps/web/src/lib/player-choice.test.mjs`: new
- the i18n catalogue under `apps/web/src/i18n`: `runPage.player.*` keys
- Not touched: `native-video-player.tsx`, `run-playback.tsx` (its `VideoPlayerProps` contract is unchanged), the API relay.

## Suggested model

Sonnet. Small, well-bounded adapter work against a fixed interface. The only subtle part is the two-level fallback (chunk failure, then runtime error), and it is specified as pure functions above.

