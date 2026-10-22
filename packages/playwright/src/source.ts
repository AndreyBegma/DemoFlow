import { toSlashes } from './paths.ts';

// `<file>:<line>` of the test code that made a call (spec 208, Decision 4):
// the first stack frame in the test file.

const FRAME_LOCATION =
  /\(?((?:file:\/\/\/?)?(?:[A-Za-z]:)?[^():]+):(\d+):\d+\)?$/;

/** The line of the first frame of `stack` in `testFile`, or `undefined`. */
export function lineIn(stack: string, testFile: string): number | undefined {
  const wanted = comparable(testFile);
  for (const frame of stack.split(/\r?\n/).slice(1)) {
    const match = FRAME_LOCATION.exec(frame.trim());
    if (match === null) continue;
    if (comparable(match[1] ?? '') === wanted) return Number(match[2]);
  }
  return undefined;
}

function comparable(file: string): string {
  const slashes = toSlashes(file);
  // Windows paths are case-insensitive, and drive letters come in both cases.
  return process.platform === 'win32' ? slashes.toLowerCase() : slashes;
}
