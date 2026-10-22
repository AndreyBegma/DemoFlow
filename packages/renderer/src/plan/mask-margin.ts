/** Source frames a mask is padded by on each side when the clock offset is measured (#185). */
export const MEASURED_MASK_MARGIN_FRAMES = 3;

/**
 * How early a mask starts and how late it ends, around the page's own frames
 * mapped through a measured sync offset (#185).
 *
 * The page's edges are exact: the mask watch stamps the frame the page drew
 * without the field, within 1 ms of the page's own frame clock. The video is
 * not. Playwright hands FFmpeg each screencast frame at its own timestamp and
 * FFmpeg resamples to 25 fps, so a frame lands up to half a slot either side
 * of its time; the screencast delivers each frame with its own delay too. The
 * offset is measured on one frame (the sync mark's clear) and absorbs that
 * frame's error, not the difference to the field's frame: up to a slot of
 * rounding plus the difference in delivery.
 *
 * Measured on login, 10 runs each on ubuntu, macOS and Windows (GitHub
 * Actions run 39806282102): the field's first frame without it lands −26 to
 * +29 ms off its mapped stamp, and past +40 ms once on Windows CI (#185, frame
 * 171 of release PR #184). One frame of padding (40 ms) left 10 ms. Three
 * frames (120 ms at 25 fps) hold a slot of rounding and 80 ms of delivery
 * difference, above the 0–48 ms of offset jitter measured on Windows (#150).
 * A mask up for a frame too long is safe; a field shown for a frame leaks.
 */
export function measuredMaskMarginMs(sourceFps: number): number {
  return (MEASURED_MASK_MARGIN_FRAMES * 1000) / sourceFps;
}
