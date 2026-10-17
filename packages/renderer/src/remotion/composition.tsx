import type { CSSProperties, ReactNode } from 'react';
import {
  AbsoluteFill,
  Freeze,
  OffthreadVideo,
  useCurrentFrame,
} from 'remotion';
import { frameAt } from '../plan/frame.ts';
import type { Point } from '../plan/types.ts';
import type { DemoVideoProps } from './props.ts';
import { STYLE } from './style.ts';

/**
 * Draws `frameAt(plan, frame)` and nothing else: the plan is the one
 * interpretation of the timeline (spec 4), the composition only draws it.
 */
export function DemoVideo({ plan, src }: DemoVideoProps): ReactNode {
  const state = frameAt(plan, useCurrentFrame());
  const { crop, content, scale } = state;
  return (
    <AbsoluteFill
      style={{ background: STYLE.background, fontFamily: STYLE.fontFamily }}
    >
      {state.sourceMs !== null && (
        <div style={{ ...place(content), overflow: 'hidden' }}>
          {/* `Freeze` pins the media clock: Remotion asks its compositor for the source frame at exactly `sourceMs`. */}
          <Freeze frame={(state.sourceMs / 1000) * plan.output.fps}>
            <OffthreadVideo
              src={src}
              muted
              style={{
                position: 'absolute',
                left: -crop.x * (content.width / crop.width),
                top: -crop.y * (content.height / crop.height),
                width: plan.source.width * (content.width / crop.width),
                height: plan.source.height * (content.height / crop.height),
                maxWidth: 'none',
              }}
            />
          </Freeze>
        </div>
      )}
      {state.masks.map((box) => (
        <div
          key={`${box.x},${box.y}`}
          style={{
            ...place(box),
            backdropFilter: `blur(${STYLE.mask.blurPx * scale}px)`,
            background: STYLE.mask.wash,
          }}
        />
      ))}
      {state.rings.map(({ point, progress }) => (
        <Ring
          key={`${point.x},${point.y}`}
          point={point}
          progress={progress}
          scale={scale}
        />
      ))}
      {state.cursor !== undefined && (
        <Cursor point={state.cursor} scale={scale} />
      )}
      {state.caption !== undefined && <Caption text={state.caption} />}
      {state.endCard !== undefined && <EndCard text={state.endCard} />}
      {state.watermark && <Watermark />}
    </AbsoluteFill>
  );
}

function place(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): CSSProperties {
  return {
    position: 'absolute',
    left: box.x,
    top: box.y,
    width: box.width,
    height: box.height,
  };
}

/** An arrow pointer, 18 units tall, its tip at the origin. */
const ARROW = 'M0 0 L0 16 L4.2 12.2 L7 18 L9.6 16.8 L6.9 11.2 L12 11.2 Z';
const ARROW_UNITS = 18;

function Cursor({ point, scale }: { point: Point; scale: number }): ReactNode {
  const height = STYLE.cursor.heightPx * scale;
  const unit = height / ARROW_UNITS;
  const outline = STYLE.cursor.outlinePx * scale;
  // Room for the outline on every side, so the tip stays at `point`.
  const pad = outline;
  return (
    <svg
      role="presentation"
      width={(12 / ARROW_UNITS) * height + 2 * pad}
      height={height + 2 * pad}
      style={{ position: 'absolute', left: point.x - pad, top: point.y - pad }}
    >
      <path
        d={ARROW}
        transform={`translate(${pad} ${pad}) scale(${unit})`}
        fill={STYLE.cursor.fill}
        stroke={STYLE.cursor.outline}
        strokeWidth={outline / unit}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Ring({
  point,
  progress,
  scale,
}: {
  point: Point;
  progress: number;
  scale: number;
}): ReactNode {
  const { fromRadiusPx, toRadiusPx, strokePx, stroke } = STYLE.ring;
  const radius =
    (fromRadiusPx + (toRadiusPx - fromRadiusPx) * progress) * scale;
  const width = strokePx * scale;
  const size = 2 * (radius + width);
  return (
    <svg
      role="presentation"
      width={size}
      height={size}
      style={{
        position: 'absolute',
        left: point.x - size / 2,
        top: point.y - size / 2,
        opacity: 1 - progress,
      }}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={stroke}
        strokeWidth={width}
      />
    </svg>
  );
}

function Caption({ text }: { text: string }): ReactNode {
  const style = STYLE.caption;
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'flex-end',
        alignItems: 'center',
        paddingBottom: style.bottomPx,
      }}
    >
      <div
        style={{
          maxWidth: style.maxWidthPx,
          padding: style.paddingPx,
          borderRadius: style.radiusPx,
          background: style.background,
          color: style.color,
          fontSize: style.fontPx,
          textAlign: 'center',
          boxSizing: 'border-box',
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
}

function Watermark(): ReactNode {
  const style = STYLE.watermark;
  return (
    <div
      style={{
        position: 'absolute',
        top: style.marginPx,
        right: style.marginPx,
        padding: `${style.padding.yPx}px ${style.padding.xPx}px`,
        background: style.fill,
        color: style.color,
        fontSize: style.fontPx,
        fontWeight: 'bold',
        lineHeight: 1,
      }}
    >
      {style.text}
    </div>
  );
}

function EndCard({ text }: { text: string }): ReactNode {
  const style = STYLE.endCard;
  return (
    <AbsoluteFill
      style={{
        background: style.background,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div
        style={{
          maxWidth: style.maxWidthPx,
          color: style.color,
          fontSize: style.fontPx,
          textAlign: 'center',
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
}
