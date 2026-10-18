import type { Box, TimelineEvent } from '@demoflow/core';
import type { Point } from './pointer.ts';

/**
 * Spike #85: a `zoomed` capture measures boxes, points and scroll offsets in
 * the zoomed viewport. Divided by the zoom they are CSS pixels of the
 * scenario's viewport again, as the timeline requires (ADR-0004 §1).
 */
export function unzoomEvent(event: TimelineEvent, zoom: number): TimelineEvent {
  if (zoom === 1) return event;
  const point = (p: Point): Point => ({ x: p.x / zoom, y: p.y / zoom });
  const box = (b: Box): Box => ({
    x: b.x / zoom,
    y: b.y / zoom,
    width: b.width / zoom,
    height: b.height / zoom,
  });
  const { target, pointer, scroll, maskVisibility } = event;
  return {
    ...event,
    ...(target === undefined ? {} : { target: { box: box(target.box) } }),
    ...(pointer === undefined
      ? {}
      : { pointer: { from: point(pointer.from), to: point(pointer.to) } }),
    ...(scroll === undefined
      ? {}
      : {
          scroll: {
            before: point(scroll.before),
            after: point(scroll.after),
            ...(scroll.container === undefined
              ? {}
              : { container: box(scroll.container) }),
          },
        }),
    ...(maskVisibility === undefined
      ? {}
      : {
          maskVisibility: maskVisibility.map((interval) => ({
            ...interval,
            box: box(interval.box),
          })),
        }),
  };
}
