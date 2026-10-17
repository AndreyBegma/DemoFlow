// Shared by the Node side and the bundle. Plain `.ts`, so Node can load it
// from source (it strips types from `.ts`, not from `.tsx`).
import type { RenderPlan } from '../plan/types.ts';

export const COMPOSITION_ID = 'demoflow';

/** Props of the composition: the plan and where its source video is served. */
export type DemoVideoProps = {
  plan: RenderPlan;
  /** `plan.source.file`, as a URL the render can fetch. */
  src: string;
};
