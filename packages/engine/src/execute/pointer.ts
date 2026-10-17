import type { Box, Viewport } from '@demoflow/core';

export interface Point {
  x: number;
  y: number;
}

/** Spec 3: `steps = clamp(round(distance / 12), 8, 40)`. */
export function moveSteps(from: Point, to: Point): number {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.min(40, Math.max(8, Math.round(distance / 12)));
}

export function viewportCentre(viewport: Viewport): Point {
  return { x: viewport.width / 2, y: viewport.height / 2 };
}

export function boxCentre(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
