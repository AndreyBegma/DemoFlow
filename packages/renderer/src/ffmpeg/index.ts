import path from 'node:path';
import {
  planChapters,
  type Renderer,
  recordRender,
  renderPath,
} from '../renderer.ts';
import { drawPlan } from './pipeline.ts';

/**
 * The FFmpeg compositor (spec 4, slot i4-ffmpeg). It pipes frames through
 * FFmpeg rather than building a filter graph, so `frameAt` stays the only
 * interpretation of the plan: a graph would re-express its easing as FFmpeg
 * expressions. Text is drawn with the bundled Inter font (`font.ts`).
 */
export const ffmpegRenderer: Renderer = {
  name: 'ffmpeg',
  render(runDir, plan) {
    const files = plan.output.files.map(({ format }) => ({
      format,
      file: renderPath(runDir, 'ffmpeg', format),
    }));
    return recordRender(
      runDir,
      'ffmpeg',
      files,
      () =>
        drawPlan(
          path.resolve(runDir, plan.source.file),
          plan,
          files.map(({ file }) => file),
        ),
      planChapters(plan),
    );
  },
};
