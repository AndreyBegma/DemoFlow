import type { BackgroundConfig, BackgroundPreset } from '@demoflow/core';
import type { GradientSpec } from './types.ts';

/**
 * The built-in backgrounds (spec 100, Decision 2): two-stop gradients from
 * the top left to the bottom right. A `Record`, so a preset added to the
 * config schema without colours fails the typecheck.
 */
export const BACKGROUND_PRESET_COLOURS: Record<BackgroundPreset, GradientSpec> =
  {
    ocean: { from: '#0b2e4f', to: '#2b86c5', angle: 135 },
    sunset: { from: '#f7a35c', to: '#d6457a', angle: 135 },
    forest: { from: '#0d3b2e', to: '#3a9a68', angle: 135 },
    dusk: { from: '#28215a', to: '#a24e8e', angle: 135 },
    graphite: { from: '#1c1f24', to: '#4a515c', angle: 135 },
    paper: { from: '#f4f0e8', to: '#d8d2c5', angle: 135 },
  };

/** A background as the gradient the compositor draws; a solid colour is one with equal stops. */
export function resolveBackground(background: BackgroundConfig): GradientSpec {
  if ('preset' in background)
    return BACKGROUND_PRESET_COLOURS[background.preset];
  if ('color' in background) {
    return { from: background.color, to: background.color, angle: 0 };
  }
  return { ...background.gradient };
}
