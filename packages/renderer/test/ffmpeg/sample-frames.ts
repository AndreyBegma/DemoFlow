import { runFfmpeg } from '../../src/index.ts';

/**
 * Frame indices in `[from, to)`: one every `step` frames from `from`, and
 * always `to - 1`. Ascending and distinct, so a frame `select` returns exactly
 * one frame per index (#44: `to - 1` used to repeat the last stepped index).
 */
export function sampleFrames(from: number, to: number, step: number): number[] {
  if (to <= from) return [];
  const numbers: number[] = [];
  for (let n = from; n < to - 1; n += step) numbers.push(n);
  numbers.push(to - 1);
  return numbers;
}

/**
 * An FFmpeg `select` expression that passes exactly the frames `numbers`
 * (ascending, distinct). Each run of consecutive frames is one
 * `between(n,a,b)` term, so a long run stays one term: one `eq(n,…)` per
 * frame grew past what FFmpeg can allocate once the end hold lengthened
 * the video (#365).
 */
export function selectFrames(numbers: readonly number[]): string {
  const terms: string[] = [];
  let start = 0;
  for (let i = 1; i <= numbers.length; i++) {
    if (i < numbers.length && numbers[i] === numbers[i - 1] + 1) continue;
    const from = numbers[start];
    const to = numbers[i - 1];
    terms.push(
      from === to ? `eq(n\\,${from})` : `between(n\\,${from}\\,${to})`,
    );
    start = i;
  }
  return terms.join('+');
}

/**
 * The number of video frames in `file`, counted by decoding it: with
 * `-c copy` the pinned FFmpeg reports no `frame=` progress.
 */
export async function countFrames(file: string): Promise<number> {
  const { stdout } = await runFfmpeg([
    '-i',
    file,
    '-map',
    '0:v:0',
    '-f',
    'null',
    '-progress',
    'pipe:1',
    '-nostats',
    '-',
  ]);
  const frames = [...stdout.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1];
  if (frames === undefined)
    throw new Error(`${file}: FFmpeg counted no frames`);
  return Number(frames);
}
