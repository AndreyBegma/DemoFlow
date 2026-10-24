import type { PlayerShape } from './playback';

/** Which implementation is playing (ADR-0009 §2). */
export type PlayerKind = 'luna' | 'native';

/** Luna's frame shape for a run format's picture. */
export function lunaAspectRatio(shape: PlayerShape): '16:9' | '9:16' | '1:1' {
  switch (shape) {
    case 'landscape':
      return '16:9';
    case 'vertical':
      return '9:16';
    case 'square':
      return '1:1';
  }
}

/**
 * What follows a player error: Luna gives way to the native `<video>` once,
 * and a native failure is reported to the page.
 */
export function afterPlayerError(current: PlayerKind): 'native' | 'report' {
  return current === 'luna' ? 'native' : 'report';
}

/**
 * The player `importer` loads, or `fallback` when the import rejects (chunk
 * failed to load, network, CSP), so the same stream still plays.
 */
export async function loadVideoPlayer<T>(
  importer: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await importer();
  } catch {
    return fallback;
  }
}
