import path from 'node:path';
import { type Renderer, recordRender, renderPath } from '../renderer.ts';
import { drawPlan } from './pipeline.ts';

/**
 * The FFmpeg compositor (spec 4, slot i4-ffmpeg). It pipes frames through
 * FFmpeg rather than building a filter graph, so `frameAt` stays the only
 * interpretation of the plan: a graph would re-express its easing as FFmpeg
 * expressions. Text is drawn with an embedded stroke font (`font.ts`).
 */
export const ffmpegRenderer: Renderer = {
  name: 'ffmpeg',
  render(runDir, plan, out = renderPath(runDir, 'ffmpeg')) {
    return recordRender(runDir, 'ffmpeg', out, () =>
      drawPlan(path.resolve(runDir, plan.source.file), plan, out),
    );
  },
};
