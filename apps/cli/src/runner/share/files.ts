import type { RenderFormat } from '@demoflow/core';
import { pathFor } from '../../config/platform.ts';

/** Spec 349, Decision 3: what a share makes lives in `<runDir>/share/`. */
export const SHARE_DIR = 'share';

/** `<runDir>/share/poster-<format>.jpg`: one poster per rendered format. */
export function posterPath(
  runDir: string,
  format: RenderFormat,
  platform: NodeJS.Platform,
): string {
  return pathFor(platform).join(runDir, SHARE_DIR, `poster-${format}.jpg`);
}
