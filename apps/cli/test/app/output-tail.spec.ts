import { describe, expect, it } from 'vitest';
import { outputTail } from '../../src/app/output-tail.ts';

describe('outputTail', () => {
  it('keeps the last lines, oldest first', () => {
    const tail = outputTail(3);
    tail.push('a\nb\nc\nd\ne\n');
    expect(tail.lines()).toEqual(['c', 'd', 'e']);
  });

  it('joins a line split across chunks and keeps a trailing partial line', () => {
    const tail = outputTail(5);
    tail.push('hel');
    tail.push('lo\r\nwor');
    expect(tail.lines()).toEqual(['hello', 'wor']);
    tail.push('ld\n');
    expect(tail.lines()).toEqual(['hello', 'world']);
  });

  it('is empty before any output', () => {
    expect(outputTail().lines()).toEqual([]);
  });
});
