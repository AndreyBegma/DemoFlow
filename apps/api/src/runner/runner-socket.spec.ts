import { randomUUID } from 'node:crypto';
import {
  decodeVideoChunk,
  encodeVideoChunk,
  parseClientMessage,
  VIDEO_CHUNK_MAX,
} from './runner-socket';

describe('video chunk frames', () => {
  const streamId = randomUUID();

  it('is 0x01, the 16 id bytes, then the file bytes', () => {
    const frame = encodeVideoChunk(streamId, Buffer.from('abc'));
    expect(frame.length).toBe(1 + 16 + 3);
    expect(frame[0]).toBe(0x01);
    expect(frame.subarray(1, 17).toString('hex')).toBe(
      streamId.replaceAll('-', ''),
    );
  });

  it('decodes what it encodes', () => {
    const bytes = Buffer.alloc(VIDEO_CHUNK_MAX, 7);
    expect(decodeVideoChunk(encodeVideoChunk(streamId, bytes))).toEqual({
      streamId,
      bytes,
    });
  });

  it.each([
    ['too short', Buffer.from([1, 2, 3])],
    ['only a header', encodeVideoChunk(streamId, Buffer.alloc(0))],
    [
      'past 32 KiB',
      encodeVideoChunk(streamId, Buffer.alloc(VIDEO_CHUNK_MAX + 1)),
    ],
    [
      'another version',
      Buffer.concat([Buffer.from([2]), Buffer.alloc(16), Buffer.from('x')]),
    ],
  ])('refuses a frame %s', (_label, frame) => {
    expect(decodeVideoChunk(frame)).toBeNull();
    expect(parseClientMessage(frame, true)).toEqual({
      ok: false,
      problem: 'binary frame',
    });
  });

  it('routes a binary chunk as a chunk', () => {
    const frame = encodeVideoChunk(streamId, Buffer.from('abc'));
    expect(parseClientMessage(frame, true)).toEqual({
      ok: true,
      chunk: { streamId, bytes: Buffer.from('abc') },
    });
  });
});

describe('video text messages', () => {
  const streamId = randomUUID();

  function parse(message: unknown) {
    return parseClientMessage(Buffer.from(JSON.stringify(message)), false);
  }

  it('reads a head, an end and an error', () => {
    for (const message of [
      { type: 'video.head', streamId, size: 2 ** 40, start: 0, end: 9 },
      { type: 'video.end', streamId },
      { type: 'video.error', streamId, code: 'bad-range', size: 10 },
    ]) {
      expect(parse(message)).toEqual({
        ok: true,
        message: expect.objectContaining(message),
      });
    }
  });

  it.each([
    ['a stream id that is not a UUID', { type: 'video.end', streamId: 'x' }],
    [
      'a negative offset',
      { type: 'video.head', streamId, size: 10, start: -1, end: 9 },
    ],
    ['an error without a code', { type: 'video.error', streamId }],
  ])('refuses %s', (_label, message) => {
    expect(parse(message).ok).toBe(false);
  });
});
