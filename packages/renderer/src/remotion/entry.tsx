// The bundle's entry point: `@remotion/bundler` builds this file for the browser.
import type { ReactNode } from 'react';
import { Composition, registerRoot } from 'remotion';
import { frameCount } from '../plan/frame.ts';
import { DemoVideo } from './composition.tsx';
import { COMPOSITION_ID, type DemoVideoProps } from './props.ts';

function Root(): ReactNode {
  return (
    <Composition
      id={COMPOSITION_ID}
      component={DemoVideo}
      // Replaced by the render's `inputProps`; the metadata comes from the plan.
      defaultProps={{} as DemoVideoProps}
      calculateMetadata={({ props }) => ({
        width: props.plan.output.width,
        height: props.plan.output.height,
        fps: props.plan.output.fps,
        durationInFrames: frameCount(props.plan),
      })}
    />
  );
}

registerRoot(Root);
