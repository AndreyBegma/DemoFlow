import { resolveRange, type VideoRange } from './range.ts';

/** Spec 191: at most 32 KiB of the file per binary frame. */
export const CHUNK_BYTES = 32 * 1024;
/** Spec 191: at most 512 KiB sent and not yet acknowledged, per stream. */
export const WINDOW_BYTES = 512 * 1024;
/** Byte 0 of a binary frame; bytes 1–16 are the stream id. */
export const FRAME_VERSION = 0x01;
export const FRAME_HEADER_BYTES = 17;

/** The socket, as a stream sees it: JSON text frames and binary frames. */
export interface RelaySender {
  send(message: Record<string, unknown>): void;
  sendBinary(data: Uint8Array): void;
}

/** The part of a `FileHandle` a stream uses; tests count opens and closes. */
export interface RelayFile {
  stat(): Promise<{ size: number; isFile(): boolean }>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export type StreamOutcome =
  | 'sent'
  | 'cancelled'
  | 'disconnected'
  | 'not-found'
  | 'bad-range'
  | 'io';

/** A UUID's 16 raw bytes, as the binary frame carries them. */
export function streamIdBytes(streamId: string): Uint8Array {
  const hex = streamId.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * One `video.open`, from the file handle to `video.end` (Decision 6). The
 * handle is closed exactly once, whichever way the stream ends.
 */
export class VideoStream {
  readonly streamId: string;
  private readonly header: Uint8Array;
  private readonly sender: RelaySender;
  private readonly onFinish: (outcome: StreamOutcome, sent: number) => void;
  private file: RelayFile | null = null;
  /** Settles once `begin`'s `open` has returned and a late handle is closed. */
  private opening: Promise<void> = Promise.resolve();
  private closed = false;
  private pumping = false;
  private position = 0;
  private end = -1;
  private unacked = 0;
  private sent = 0;

  constructor(
    streamId: string,
    sender: RelaySender,
    onFinish: (outcome: StreamOutcome, sent: number) => void,
  ) {
    this.streamId = streamId;
    this.header = streamIdBytes(streamId);
    this.sender = sender;
    this.onFinish = onFinish;
  }

  /** `open` gives the checked file, or `null` for `not-found`. */
  async begin(
    open: () => Promise<RelayFile | null>,
    range: VideoRange | null,
  ): Promise<void> {
    let opened = () => {};
    this.opening = new Promise((resolve) => {
      opened = resolve;
    });
    let file: RelayFile | null;
    try {
      file = await open();
    } catch {
      file = null;
    }
    if (this.closed) {
      // Cancelled while the file was being found: it never becomes ours.
      await file?.close().catch(() => {});
      opened();
      return;
    }
    opened();
    if (file === null) {
      await this.fail('not-found');
      return;
    }
    this.file = file;
    let size: number;
    try {
      const stats = await file.stat();
      if (!stats.isFile()) {
        await this.fail('not-found');
        return;
      }
      size = stats.size;
    } catch {
      await this.fail('io');
      return;
    }
    if (this.closed) return;
    const span = resolveRange(range, size);
    if (span === 'bad-range') {
      await this.fail('bad-range', size);
      return;
    }
    this.position = span.start;
    this.end = span.end;
    this.sender.send({
      type: 'video.head',
      streamId: this.streamId,
      size,
      ...span,
    });
    await this.pump();
  }

  /** `video.ack { bytes }`: one chunk the API has handed to its response. */
  ack(bytes: number): void {
    this.unacked = Math.max(0, this.unacked - bytes);
    void this.pump();
  }

  /**
   * Closes the handle, then sends `last` if given; idempotent. The file is
   * released before the API hears the stream is over.
   */
  async close(
    outcome: StreamOutcome,
    last?: Record<string, unknown>,
  ): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const file = this.file;
    this.file = null;
    try {
      await file?.close();
    } catch {
      // Already closed or gone: nothing left to release.
    }
    if (last !== undefined) this.sender.send(last);
    this.onFinish(outcome, this.sent);
  }

  /**
   * Resolves once this stream holds no handle: after `close`, and after a
   * file still being opened when it closed has been released too.
   */
  async released(): Promise<void> {
    await this.opening;
  }

  /** Ends the stream with `video.error { code }`, after releasing the file. */
  fail(
    code: Exclude<StreamOutcome, 'sent' | 'cancelled' | 'disconnected'>,
    size?: number,
  ): Promise<void> {
    return this.close(code, {
      type: 'video.error',
      streamId: this.streamId,
      code,
      ...(size === undefined ? {} : { size }),
    });
  }

  /** Sends chunks while the window allows; an `ack` resumes it. */
  private async pump(): Promise<void> {
    const file = this.file;
    if (this.pumping || this.closed || file === null) return;
    this.pumping = true;
    try {
      while (!this.closed && this.position <= this.end) {
        const length = Math.min(CHUNK_BYTES, this.end - this.position + 1);
        if (this.unacked + length > WINDOW_BYTES) return;
        const frame = new Uint8Array(FRAME_HEADER_BYTES + length);
        frame[0] = FRAME_VERSION;
        frame.set(this.header, 1);
        if (!(await this.fill(file, frame, this.position))) {
          await this.fail('io');
          return;
        }
        if (this.closed) return;
        this.position += length;
        this.unacked += length;
        this.sent += length;
        this.sender.sendBinary(frame);
      }
      await this.close('sent', { type: 'video.end', streamId: this.streamId });
    } finally {
      this.pumping = false;
    }
  }

  /** Reads the frame's data part in full; `false` on an error or a short file. */
  private async fill(
    file: RelayFile,
    frame: Uint8Array,
    position: number,
  ): Promise<boolean> {
    let offset = FRAME_HEADER_BYTES;
    try {
      while (offset < frame.length) {
        const { bytesRead } = await file.read(
          frame,
          offset,
          frame.length - offset,
          position + offset - FRAME_HEADER_BYTES,
        );
        if (bytesRead === 0) return false;
        offset += bytesRead;
      }
      return true;
    } catch {
      return false;
    }
  }
}
