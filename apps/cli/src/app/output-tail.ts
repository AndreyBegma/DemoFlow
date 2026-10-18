const DEFAULT_LINES = 20;

/** Keeps the last lines of a stream of text chunks, split anywhere. */
export interface OutputTail {
  push(chunk: string): void;
  /** The last lines, oldest first; a trailing partial line counts as a line. */
  lines(): string[];
}

export function outputTail(max: number = DEFAULT_LINES): OutputTail {
  let lines: string[] = [];
  // The line still being written: it has not seen its newline yet.
  let partial = '';
  return {
    push(chunk) {
      const parts = `${partial}${chunk}`.split(/\r?\n/);
      partial = parts.pop() ?? '';
      lines.push(...parts);
      if (lines.length > max) lines = lines.slice(-max);
    },
    lines() {
      const all = partial === '' ? lines : [...lines, partial];
      return all.slice(-max);
    },
  };
}
