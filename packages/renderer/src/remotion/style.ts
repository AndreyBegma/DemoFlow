/**
 * The look both renderers share (spec 4, set by the orchestrator so the owner
 * compares renderers, not styles). Output pixels at `scale` 1; the cursor,
 * ring and mask blur grow with the frame's `scale`.
 */
export const STYLE = {
  background: '#000',
  mask: { blurPx: 12, wash: 'rgba(128,128,128,0.35)' },
  cursor: { heightPx: 28, fill: '#fff', outline: '#111', outlinePx: 2 },
  ring: { stroke: '#fff', strokePx: 4, fromRadiusPx: 12, toRadiusPx: 36 },
  caption: {
    background: 'rgba(0,0,0,0.6)',
    paddingPx: 16,
    radiusPx: 12,
    bottomPx: 64,
    maxWidthPx: 1600,
    color: '#fff',
    fontPx: 40,
  },
  watermark: {
    marginPx: 24,
    // Not in the shared table; the badge needs some.
    padding: { xPx: 16, yPx: 8 },
    fill: '#d93025',
    text: 'FAILED',
    color: '#fff',
    fontPx: 32,
  },
  endCard: { background: '#111', color: '#fff', fontPx: 48, maxWidthPx: 1600 },
  fontFamily: 'sans-serif',
} as const;
