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

describe('artifacts messages (spec #233)', () => {
  const requestId = randomUUID();

  function parse(message: unknown) {
    return parseClientMessage(Buffer.from(JSON.stringify(message)), false);
  }

  it('reads a deleted and both error codes', () => {
    for (const message of [
      { type: 'artifacts.deleted', requestId },
      { type: 'artifacts.error', requestId, code: 'not-found' },
      { type: 'artifacts.error', requestId, code: 'io' },
    ]) {
      expect(parse(message)).toEqual({
        ok: true,
        message: expect.objectContaining(message),
      });
    }
  });

  it.each([
    [
      'a request id that is not a UUID',
      { type: 'artifacts.deleted', requestId: 'x' },
    ],
    [
      'a UUID that is not v4',
      {
        type: 'artifacts.deleted',
        requestId: '00000000-0000-1000-8000-000000000000',
      },
    ],
    ['an error without a code', { type: 'artifacts.error', requestId }],
    [
      'an unknown error code',
      { type: 'artifacts.error', requestId, code: 'busy' },
    ],
  ])('refuses %s', (_label, message) => {
    expect(parse(message).ok).toBe(false);
  });
});

describe('launch messages (spec #247)', () => {
  const requestId = randomUUID();
  const scenario = { id: 'demoflow/checkout.demo.json', name: 'Checkout' };

  function parse(message: unknown) {
    return parseClientMessage(Buffer.from(JSON.stringify(message)), false);
  }

  function listed(fields: Record<string, unknown>) {
    return {
      type: 'scenarios.listed',
      requestId,
      scenarios: [scenario],
      truncated: false,
      skipped: 0,
      ...fields,
    };
  }

  it('reads every Runner message', () => {
    for (const message of [
      listed({}),
      listed({ scenarios: [], truncated: true, skipped: 3 }),
      { type: 'scenarios.error', requestId, code: 'project-unknown' },
      { type: 'run.started', requestId, scenarioName: 'Checkout' },
      { type: 'run.error', requestId, code: 'busy' },
      { type: 'run.finished', requestId, outcome: 'passed', runId: 'r-1' },
      { type: 'run.finished', requestId, outcome: 'cancelled', runId: null },
    ]) {
      expect(parse(message)).toEqual({
        ok: true,
        message: expect.objectContaining(message),
      });
    }
  });

  it('takes any error code up to 64 characters, so a newer one still ends the request', () => {
    expect(
      parse({ type: 'run.error', requestId, code: 'x'.repeat(64) }).ok,
    ).toBe(true);
    expect(
      parse({ type: 'scenarios.error', requestId, code: 'x'.repeat(65) }).ok,
    ).toBe(false);
  });

  it('drops fields a scenario entry does not have', () => {
    const parsed = parse(
      listed({ scenarios: [{ ...scenario, steps: ['secret'] }] }),
    );
    expect(parsed).toEqual({
      ok: true,
      message: expect.objectContaining({ scenarios: [scenario] }),
    });
  });

  it('takes 100 entries', () => {
    expect(
      parse(listed({ scenarios: Array.from({ length: 100 }, () => scenario) }))
        .ok,
    ).toBe(true);
  });

  it.each([
    ['a request id that is not a UUID v4', listed({ requestId: 'x' })],
    [
      '101 entries',
      listed({ scenarios: Array.from({ length: 101 }, () => scenario) }),
    ],
    [
      'an entry whose id breaks the rule',
      listed({ scenarios: [{ id: '../x.demo.json', name: 'x' }] }),
    ],
    ['an entry without a name', listed({ scenarios: [{ id: scenario.id }] })],
    [
      'an entry with a 201-character name',
      listed({ scenarios: [{ id: scenario.id, name: 'n'.repeat(201) }] }),
    ],
    ['an entry that is not an object', listed({ scenarios: ['x'] })],
    ['scenarios that are not an array', listed({ scenarios: scenario })],
    ['a truncated that is not a boolean', listed({ truncated: 'yes' })],
    ['a negative skipped', listed({ skipped: -1 })],
    ['a fractional skipped', listed({ skipped: 1.5 })],
    [
      'a started without a name',
      { type: 'run.started', requestId, scenarioName: '' },
    ],
    [
      'an unknown outcome',
      { type: 'run.finished', requestId, outcome: 'lost', runId: null },
    ],
    [
      'a finished without a run id',
      { type: 'run.finished', requestId, outcome: 'passed' },
    ],
    [
      'a run id past 64 characters',
      {
        type: 'run.finished',
        requestId,
        outcome: 'passed',
        runId: 'r'.repeat(65),
      },
    ],
    [
      'a run id that is not a string',
      { type: 'run.finished', requestId, outcome: 'passed', runId: 7 },
    ],
  ])('refuses %s', (_label, message) => {
    expect(parse(message).ok).toBe(false);
  });
});

describe('launches.sync (spec #284)', () => {
  function sync(fields: Record<string, unknown>) {
    return parseClientMessage(
      Buffer.from(JSON.stringify({ type: 'launches.sync', ...fields })),
      false,
    );
  }

  function ids(count: number): string[] {
    return Array.from({ length: count }, () => randomUUID());
  }

  it.each([0, 1, 16])('reads %i launch ids', (count) => {
    const running = ids(count);
    expect(sync({ running })).toEqual({
      ok: true,
      message: expect.objectContaining({ type: 'launches.sync', running }),
    });
  });

  it.each([
    ['17 entries', { running: ids(17) }],
    ['an entry that is not a UUID', { running: [randomUUID(), 'x'] }],
    [
      'an entry that is not a UUID v4',
      { running: ['6ba7b810-9dad-11d1-80b4-00c04fd430c8'] },
    ],
    ['an entry that is not a string', { running: [7] }],
    ['running that is not an array', { running: randomUUID() }],
    ['no running', {}],
  ])('refuses %s', (_label, fields) => {
    expect(sync(fields).ok).toBe(false);
  });
});
