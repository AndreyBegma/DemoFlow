import type { FrameState } from '../plan/types.ts';
import type { Compositor } from './compose.ts';
import { createPicture, type Picture } from './raster.ts';

/**
 * The source times a frame draws, deepest dissolve first: the order
 * `drawLayers` asks for them, so a forward-only decoder can fetch them.
 */
export function sourcesOf(state: FrameState): number[] {
  const under = state.fade === undefined ? [] : sourcesOf(state.fade.from);
  return state.sourceMs === null ? under : [...under, state.sourceMs];
}

/**
 * Draws `state` into `target` with its dissolves (spec 114): each
 * `fade.from` is drawn into a scratch picture, `state` over it, and the two
 * mixed at `fade.progress`. `sourceAt` gives the source frame of a source
 * time `sourcesOf(state)` named. Scratch pictures are made once per depth.
 */
export function drawLayers(
  compositor: Compositor,
  target: Picture,
  state: FrameState,
  sourceAt: (sourceMs: number) => Picture,
  scratch: Picture[] = [],
  depth = 0,
): void {
  const { fade, ...self } = state;
  let under: Picture | undefined;
  if (fade !== undefined) {
    under = scratch[depth] ??= createPicture(target.width, target.height);
    drawLayers(compositor, under, fade.from, sourceAt, scratch, depth + 1);
  }
  compositor.compose(
    target,
    self,
    self.sourceMs === null ? undefined : sourceAt(self.sourceMs),
  );
  if (under !== undefined && fade !== undefined) {
    mix(target, under, fade.progress);
  }
}

/** `target` over `under` at `progress`: 0 leaves `under`, 1 leaves `target`. */
export function mix(target: Picture, under: Picture, progress: number): void {
  const p = Math.min(1, Math.max(0, progress));
  if (p === 1) return;
  const a = target.data;
  const b = under.data;
  if (p === 0) {
    a.set(b);
    return;
  }
  for (let i = 0; i < a.length; i++) {
    a[i] = Math.round(b[i] + (a[i] - b[i]) * p);
  }
}
