import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import type { RunnerConnections } from '../runner/runner-connections.service';
import type { ServerMessage } from '../runner/runner-socket';
import { FakeClock } from '../test/test-app';
import { VideoRelay } from './video-relay.service';

/** A response whose buffer is "full" while `full` is set. */
class FakeResponse extends EventEmitter {
  full = false;
  headersSent = false;
  written: Buffer[] = [];

  writeHead(): this {
    this.headersSent = true;
    return this;
  }

  write(bytes: Buffer): boolean {
    this.written.push(bytes);
    return !this.full;
  }

  end(): this {
    return this;
  }

  destroy(): this {
    return this;
  }
}

describe('VideoRelay flow control', () => {
  const sent: ServerMessage[] = [];
  const connections = {
    sendTo: (_runnerId: string, message: ServerMessage) => {
      sent.push(message);
      return true;
    },
    setVideoSink: () => {},
  };

  function opened(): {
    relay: VideoRelay;
    res: FakeResponse;
    streamId: string;
  } {
    sent.length = 0;
    const relay = new VideoRelay(
      connections as unknown as RunnerConnections,
      new FakeClock(),
    );
    const res = new FakeResponse();
    relay.open({
      runnerId: 'r1',
      runId: 'run1',
      format: 'mp4',
      range: null,
      res: res as unknown as Response,
    });
    const [open] = sent.splice(0);
    if (open?.type !== 'video.open') {
      throw new Error('no video.open');
    }
    relay.message('r1', {
      type: 'video.head',
      streamId: open.streamId,
      size: 30,
      start: 0,
      end: 29,
    });
    return { relay, res, streamId: open.streamId };
  }

  it('acknowledges a chunk the response took at once', () => {
    const { relay, streamId } = opened();
    relay.chunk('r1', { streamId, bytes: Buffer.alloc(10) });
    expect(sent).toEqual([{ type: 'video.ack', streamId, bytes: 10 }]);
  });

  it('holds the acks of a full response until it drains, one per chunk', () => {
    const { relay, res, streamId } = opened();
    res.full = true;
    relay.chunk('r1', { streamId, bytes: Buffer.alloc(10) });
    res.full = false;
    relay.chunk('r1', { streamId, bytes: Buffer.alloc(7) });
    expect(sent).toEqual([]);

    res.emit('drain');

    expect(sent).toEqual([
      { type: 'video.ack', streamId, bytes: 10 },
      { type: 'video.ack', streamId, bytes: 7 },
    ]);
    expect(res.written.map((bytes) => bytes.length)).toEqual([10, 7]);
  });

  it('answers chunks for a stream of another machine with false', () => {
    const { relay, streamId } = opened();
    expect(relay.chunk('r2', { streamId, bytes: Buffer.alloc(1) })).toBe(false);
    expect(sent).toEqual([]);
  });
});
