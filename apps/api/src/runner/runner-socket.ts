import type { IncomingMessage } from 'node:http';
import { applyDecorators } from '@nestjs/common';
import {
  type ClassConstructor,
  plainToInstance,
  Type,
} from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
  validateSync,
} from 'class-validator';
import type { RawData } from 'ws';
import { IsTimeZone } from '../checks/schedules/time-zone';
import { CADENCES, type Cadence, TIME_OF_DAY, WEEKDAYS } from '../checks/slots';
import { IsScenarioId } from '../launches/scenario-id';
import { PATH_MAX, type RunFormat } from '../projects/projects.dto';
import type { RunnerContext } from './runner-token';

/**
 * The runner socket's protocol (spec #151, ADR-0007 Decision 3): JSON
 * `{ type, … }` both ways over `GET /runner` with `Upgrade: websocket`.
 */
export const RUNNER_SOCKET_PATH = '/runner';
export const RUNNER_SOCKET_MAX_PAYLOAD = 64 * 1024;

/** Each side pings this often (Decision 6). */
export const PING_INTERVAL_MS = 25 * 1000;
/** Silence this long closes the socket and marks the machine offline. */
export const IDLE_TIMEOUT_MS = 60 * 1000;
/** How often the heartbeat runs; well under both limits above. */
export const HEARTBEAT_TICK_MS = 5 * 1000;
/** `lastSeenAt` reaches the database at most this often per machine. */
export const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;

/** Close codes the daemon acts on. Only `REVOKED` means "do not reconnect". */
export const CLOSE_REVOKED = 4401;
export const CLOSE_HEARTBEAT_TIMEOUT = 4408;
export const CLOSE_REPLACED = 4409;
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_NORMAL = 1000;

/** A run's video over the socket (spec #191): one binary frame carries this much at most. */
export const VIDEO_CHUNK_MAX = 32 * 1024;
/** Bytes a daemon may have sent and not yet seen acknowledged, per stream. */
export const VIDEO_CREDIT = 512 * 1024;
/** Streams a daemon serves at once; the fifth is `busy`. */
export const MAX_STREAMS_PER_RUNNER = 4;
/** Byte 0 of a binary chunk. */
export const VIDEO_FRAME_VERSION = 0x01;
const VIDEO_FRAME_HEADER = 1 + 16;

/** `bytes=a-b` (inclusive), `bytes=a-` (`end` omitted), `bytes=-n`, or the whole file. */
export type VideoRange = { start: number; end?: number } | { suffix: number };

export type ServerMessage =
  | { type: 'hello'; runnerId: string; serverTime: string }
  | { type: 'ping'; at: number }
  | { type: 'pong'; at: number }
  | { type: 'rotate'; token: string }
  | { type: 'bye'; reason: string }
  | {
      type: 'video.open';
      streamId: string;
      runId: string;
      format: string;
      range: VideoRange | null;
      /** The share's poster instead of the render (spec #347), only to a daemon with `share`. */
      asset?: VideoAsset;
    }
  | { type: 'video.ack'; streamId: string; bytes: number }
  | { type: 'video.cancel'; streamId: string }
  | { type: 'artifacts.delete'; requestId: string; runId: string }
  | { type: 'scenarios.list'; requestId: string; rootPath: string }
  | {
      type: 'run.start';
      requestId: string;
      rootPath: string;
      scenarioId: string;
      /** Only when the browser chose formats (spec #325): the default frame is unchanged. */
      options?: RunStartOptions;
    }
  | { type: 'run.cancel'; requestId: string }
  /** A check pass of the whole project (spec 360), cancelled with `run.cancel`. */
  | {
      type: 'check.start';
      requestId: string;
      rootPath: string;
      exclude: string[];
    }
  | { type: 'share.prepare'; requestId: string; runId: string; format: string };

/** What `video.open` may ask for besides the render itself (spec #347). */
export type VideoAsset = 'poster';

/** What a website-started run may choose (ADR-0017): the output formats, nothing else. */
export interface RunStartOptions {
  formats: RunFormat[];
}

export type ClientMessage =
  | PingMessage
  | PongMessage
  | RotatedMessage
  | ByeMessage
  | VideoMessage
  | ArtifactsMessage
  | LaunchMessage
  | ShareMessage
  | SchedulesMessage;

export type VideoMessage =
  | VideoHeadMessage
  | VideoEndMessage
  | VideoErrorMessage;

/** A Runner's answer to `artifacts.delete` (spec #233). */
export type ArtifactsMessage = ArtifactsDeletedMessage | ArtifactsErrorMessage;

/** `not-found`: the machine does not know the run; `io`: deletion failed part-way. */
export const ARTIFACTS_ERROR_CODES = ['not-found', 'io'] as const;
export type ArtifactsErrorCode = (typeof ARTIFACTS_ERROR_CODES)[number];

/**
 * A Runner's answers to `scenarios.list` and `run.*` (spec #247), and the
 * launches it still runs on a new socket (spec #284).
 */
export type LaunchMessage =
  | ScenariosListedMessage
  | ScenariosErrorMessage
  | RunStartedMessage
  | RunErrorMessage
  | RunFinishedMessage
  | RunProgressMessage
  | LaunchesSyncMessage
  | CheckMessage;

/** A machine's project-config schedules (spec 361, Decision 6). */
export type SchedulesMessage = SchedulesSyncMessage;

/** A Runner's answers to `check.start` (spec 360, Decision 6). */
export type CheckMessage =
  | CheckStartedMessage
  | CheckFinishedMessage
  | CheckErrorMessage;

/** A Runner's answer to `share.prepare` (spec #347, Decision 4). */
export type ShareMessage = SharePreparedMessage | ShareErrorMessage;

/** `share.prepared` limits (Decision 4). */
export const SHARE_DESCRIPTION_MAX = 2000;
export const SHARE_CHAPTERS_MAX = 100;
export const SHARE_CHAPTER_TITLE_MAX = 200;
export const SHARE_POSTER_MAX_BYTES = 1024 * 1024;

/** `scenarios.listed` carries this many entries at most. */
export const MAX_LISTED_SCENARIOS = 100;
/** `launches.sync` carries this many launch ids at most. */
export const MAX_SYNCED_LAUNCHES = 16;
export const RUN_OUTCOMES = [
  'passed',
  'failed',
  'cancelled',
  'timed-out',
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];
/** Where a running child is (spec #301): starting the app, running the steps, rendering. */
export const RUN_PHASES = ['app', 'steps', 'rendering'] as const;
export type RunPhase = (typeof RUN_PHASES)[number];
/** `run.progress` counts this many expanded steps at most. */
export const MAX_PROGRESS_STEPS = 10_000;
/** The `run.start` options this API knows a daemon may accept (spec #325). */
export const RUN_OPTIONS = ['formats'] as const;
export type RunOption = (typeof RUN_OPTIONS)[number];
/** `launches.sync` announces this many options at most, each this long at most. */
export const MAX_RUN_OPTIONS = 8;
export const RUN_OPTION_MAX_LENGTH = 32;
/**
 * The capabilities this API knows a daemon may announce (ADR-0019 §7): `share`
 * answers `share.prepare` and `video.open` with an `asset`.
 */
export const FEATURES = ['share'] as const;
export type Feature = (typeof FEATURES)[number];
/** `launches.sync` announces this many features at most, each this long at most. */
export const MAX_FEATURES = 8;
export const FEATURE_MAX_LENGTH = 32;
/** `schedules.sync` carries this many projects at most (spec 361, Decision 6). */
export const MAX_SYNCED_SCHEDULES = 500;
/** A schedule excludes this many scenarios at most (ADR-0021 §5). */
export const MAX_SCHEDULE_EXCLUDES = 100;
/** `check.finished` counts this many scenarios at most. */
const MAX_CHECK_COUNT = 100_000;

class PingMessage {
  @IsIn(['ping'])
  type!: 'ping';

  @IsInt()
  @Min(0)
  at!: number;
}

class PongMessage {
  @IsIn(['pong'])
  type!: 'pong';

  @IsInt()
  @Min(0)
  at!: number;
}

class RotatedMessage {
  @IsIn(['rotated'])
  type!: 'rotated';
}

class ByeMessage {
  @IsIn(['bye'])
  type!: 'bye';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

/** A byte count or offset: a file can outgrow 32 bits. */
const IsByteCount = () =>
  applyDecorators(IsInt(), Min(0), Max(Number.MAX_SAFE_INTEGER));

class VideoHeadMessage {
  @IsIn(['video.head'])
  type!: 'video.head';

  @IsUUID('4')
  streamId!: string;

  /** The whole file's size. */
  @IsByteCount()
  size!: number;

  /** The inclusive bytes the daemon will send. */
  @IsByteCount()
  start!: number;

  @IsByteCount()
  end!: number;
}

class VideoEndMessage {
  @IsIn(['video.end'])
  type!: 'video.end';

  @IsUUID('4')
  streamId!: string;
}

class VideoErrorMessage {
  @IsIn(['video.error'])
  type!: 'video.error';

  @IsUUID('4')
  streamId!: string;

  /**
   * `not-found`, `bad-range`, `busy` or `io`. Any string, so a code a newer
   * daemon adds still ends the stream instead of being dropped.
   */
  @IsString()
  @MaxLength(64)
  code!: string;

  /** With `bad-range`. */
  @IsOptional()
  @IsByteCount()
  size?: number;
}

/** The run's directory no longer exists on the machine, including "already gone". */
class ArtifactsDeletedMessage {
  @IsIn(['artifacts.deleted'])
  type!: 'artifacts.deleted';

  @IsUUID('4')
  requestId!: string;
}

class ArtifactsErrorMessage {
  @IsIn(['artifacts.error'])
  type!: 'artifacts.error';

  @IsUUID('4')
  requestId!: string;

  @IsIn(ARTIFACTS_ERROR_CODES)
  code!: ArtifactsErrorCode;
}

class ListedScenario {
  @IsScenarioId()
  id!: string;

  @IsString()
  @Length(1, 200)
  name!: string;
}

/** At most 100 entries, sorted by `id`; `skipped` counts files that failed to parse. */
class ScenariosListedMessage {
  @IsIn(['scenarios.listed'])
  type!: 'scenarios.listed';

  @IsUUID('4')
  requestId!: string;

  @IsArray()
  @ArrayMaxSize(MAX_LISTED_SCENARIOS)
  @ValidateNested({ each: true })
  @Type(() => ListedScenario)
  scenarios!: ListedScenario[];

  @IsBoolean()
  truncated!: boolean;

  @IsInt()
  @Min(0)
  skipped!: number;
}

/**
 * `project-unknown` or `io`. Any string, so a code a newer daemon adds still
 * ends the request instead of being dropped; the API maps it to `runner-error`.
 */
class ScenariosErrorMessage {
  @IsIn(['scenarios.error'])
  type!: 'scenarios.error';

  @IsUUID('4')
  requestId!: string;

  @IsString()
  @MaxLength(64)
  code!: string;
}

/** The `demoflow run` child is running. `requestId` is the launch id. */
class RunStartedMessage {
  @IsIn(['run.started'])
  type!: 'run.started';

  @IsUUID('4')
  requestId!: string;

  @IsString()
  @Length(1, 200)
  scenarioName!: string;
}

/** Sent instead of `run.started`; any code string, as for `scenarios.error`. */
class RunErrorMessage {
  @IsIn(['run.error'])
  type!: 'run.error';

  @IsUUID('4')
  requestId!: string;

  @IsString()
  @MaxLength(64)
  code!: string;
}

/** `runId` is the server run id the child's report got, or null without one. */
class RunFinishedMessage {
  @IsIn(['run.finished'])
  type!: 'run.finished';

  @IsUUID('4')
  requestId!: string;

  @IsIn(RUN_OUTCOMES)
  outcome!: RunOutcome;

  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  runId!: string | null;
}

/** A step count of `run.progress`, or null outside the `steps` phase. */
const IsProgressCount = () =>
  applyDecorators(
    ValidateIf((_, value) => value !== null),
    IsInt(),
    Min(1),
    Max(MAX_PROGRESS_STEPS),
  );

/**
 * The child's latest phase while it runs (spec #301, Decision 1): `step` of
 * `steps` during `steps`, both null otherwise — the service checks the pair.
 */
class RunProgressMessage {
  @IsIn(['run.progress'])
  type!: 'run.progress';

  @IsUUID('4')
  requestId!: string;

  @IsIn(RUN_PHASES)
  phase!: RunPhase;

  @IsProgressCount()
  step!: number | null;

  @IsProgressCount()
  steps!: number | null;
}

/**
 * The daemon's first frame on every socket (spec #284, Decision 1): the
 * launch ids whose child it still has, possibly none, the `run.start`
 * options it accepts (spec #325) and its features (spec #347). Unknown
 * options and features pass here and are dropped when the frame is routed.
 */
class LaunchesSyncMessage {
  @IsIn(['launches.sync'])
  type!: 'launches.sync';

  @IsArray()
  @ArrayMaxSize(MAX_SYNCED_LAUNCHES)
  @IsUUID('4', { each: true })
  running!: string[];

  /** Absent from a daemon before #326: it accepts none. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RUN_OPTIONS)
  @IsString({ each: true })
  @MaxLength(RUN_OPTION_MAX_LENGTH, { each: true })
  runOptions?: string[];

  /** Absent from a daemon before #349: it can do none. Unknown ones are dropped. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_FEATURES)
  @IsString({ each: true })
  @MaxLength(FEATURE_MAX_LENGTH, { each: true })
  features?: string[];

  /** `true` from a daemon that answers `check.start` (spec 360); absent before. */
  @IsOptional()
  @IsBoolean()
  checks?: boolean;
}

/** The `demoflow run --check` child is running. `requestId` is the launch id. */
class CheckStartedMessage {
  @IsIn(['check.started'])
  type!: 'check.started';

  @IsUUID('4')
  requestId!: string;
}

/** The pass ended; both counts are 0 when it was cancelled, timed out or crashed. */
class CheckFinishedMessage {
  @IsIn(['check.finished'])
  type!: 'check.finished';

  @IsUUID('4')
  requestId!: string;

  @IsInt()
  @Min(0)
  @Max(MAX_CHECK_COUNT)
  passed!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_CHECK_COUNT)
  failed!: number;
}

/** Sent instead of `check.started`; any code string, as for `run.error`. */
class CheckErrorMessage {
  @IsIn(['check.error'])
  type!: 'check.error';

  @IsUUID('4')
  requestId!: string;

  @IsString()
  @MaxLength(64)
  code!: string;
}

/** A project config's `schedule` block (spec 361, Decision 1). */
export class SyncedSchedule {
  @IsIn(CADENCES)
  cadence!: Cadence;

  @ValidateIf((schedule: SyncedSchedule) => schedule.cadence === 'weekly')
  @IsIn(WEEKDAYS)
  weekday?: string;

  @Matches(TIME_OF_DAY)
  at!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SCHEDULE_EXCLUDES)
  @IsScenarioId({ each: true })
  exclude?: string[];
}

class SyncedProject {
  @IsString()
  @Length(1, PATH_MAX)
  rootPath!: string;

  @ValidateIf((_, value) => value !== null)
  @ValidateNested()
  @Type(() => SyncedSchedule)
  schedule!: SyncedSchedule | null;
}

/**
 * The schedules of a machine's project configs (spec 361, Decision 6), with
 * the machine's time zone: sent after `launches.sync` and on every change.
 */
class SchedulesSyncMessage {
  @IsIn(['schedules.sync'])
  type!: 'schedules.sync';

  @IsTimeZone()
  zone!: string;

  @IsArray()
  @ArrayMaxSize(MAX_SYNCED_SCHEDULES)
  @ValidateNested({ each: true })
  @Type(() => SyncedProject)
  projects!: SyncedProject[];
}

class ShareChapter {
  @IsString()
  @Length(1, SHARE_CHAPTER_TITLE_MAX)
  title!: string;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  atMs!: number;
}

/** The daemon has the render and its poster; the bytes follow over `video.open`. */
class SharePreparedMessage {
  @IsIn(['share.prepared'])
  type!: 'share.prepared';

  @IsUUID('4')
  requestId!: string;

  /** The scenario's description, read from its file at share time (ADR-0019 §2). */
  @IsOptional()
  @IsString()
  @MaxLength(SHARE_DESCRIPTION_MAX)
  description?: string;

  @IsArray()
  @ArrayMaxSize(SHARE_CHAPTERS_MAX)
  @ValidateNested({ each: true })
  @Type(() => ShareChapter)
  chapters!: ShareChapter[];

  @IsInt()
  @Min(1)
  @Max(SHARE_POSTER_MAX_BYTES)
  posterSize!: number;
}

/**
 * `not-found`, `no-render` or `io`. Any string, so a code a newer daemon adds
 * still ends the request instead of being dropped.
 */
class ShareErrorMessage {
  @IsIn(['share.error'])
  type!: 'share.error';

  @IsUUID('4')
  requestId!: string;

  @IsString()
  @MaxLength(64)
  code!: string;
}

const CLIENT_MESSAGES: Record<
  ClientMessage['type'],
  ClassConstructor<ClientMessage>
> = {
  ping: PingMessage,
  pong: PongMessage,
  rotated: RotatedMessage,
  bye: ByeMessage,
  'video.head': VideoHeadMessage,
  'video.end': VideoEndMessage,
  'video.error': VideoErrorMessage,
  'artifacts.deleted': ArtifactsDeletedMessage,
  'artifacts.error': ArtifactsErrorMessage,
  'scenarios.listed': ScenariosListedMessage,
  'scenarios.error': ScenariosErrorMessage,
  'run.started': RunStartedMessage,
  'run.error': RunErrorMessage,
  'run.finished': RunFinishedMessage,
  'run.progress': RunProgressMessage,
  'launches.sync': LaunchesSyncMessage,
  'check.started': CheckStartedMessage,
  'check.finished': CheckFinishedMessage,
  'check.error': CheckErrorMessage,
  'schedules.sync': SchedulesSyncMessage,
  'share.prepared': SharePreparedMessage,
  'share.error': ShareErrorMessage,
};

/** A binary frame: part of a stream's file, in order. */
export interface VideoChunk {
  streamId: string;
  bytes: Buffer;
}

export type ParsedMessage =
  | { ok: true; message: ClientMessage }
  | { ok: true; chunk: VideoChunk }
  | { ok: false; problem: string };

/** `0x01`, the stream id as 16 raw bytes, then up to `VIDEO_CHUNK_MAX` of the file. */
export function encodeVideoChunk(streamId: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([VIDEO_FRAME_VERSION]),
    Buffer.from(streamId.replaceAll('-', ''), 'hex'),
    bytes,
  ]);
}

/** The inverse of `encodeVideoChunk`; null for a frame that is not one. */
export function decodeVideoChunk(data: RawData): VideoChunk | null {
  const frame = toBuffer(data);
  if (
    frame.length <= VIDEO_FRAME_HEADER ||
    frame.length > VIDEO_FRAME_HEADER + VIDEO_CHUNK_MAX ||
    frame[0] !== VIDEO_FRAME_VERSION
  ) {
    return null;
  }
  const hex = frame.subarray(1, VIDEO_FRAME_HEADER).toString('hex');
  return {
    streamId: [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-'),
    bytes: frame.subarray(VIDEO_FRAME_HEADER),
  };
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

/**
 * One frame from a daemon, validated. Fields beyond the message's own are
 * dropped, so a newer daemon can add some; an unknown `type` is a problem the
 * caller logs and ignores. A binary frame is a video chunk or a problem.
 */
export function parseClientMessage(
  data: RawData,
  isBinary: boolean,
): ParsedMessage {
  if (isBinary) {
    const chunk = decodeVideoChunk(data);
    return chunk ? { ok: true, chunk } : { ok: false, problem: 'binary frame' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data.toString());
  } catch {
    return { ok: false, problem: 'not JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, problem: 'not an object' };
  }
  const type: unknown = (raw as { type?: unknown }).type;
  if (typeof type !== 'string' || !Object.hasOwn(CLIENT_MESSAGES, type)) {
    return {
      ok: false,
      problem: `unknown type ${JSON.stringify(type)?.slice(0, 40)}`,
    };
  }
  const shape = CLIENT_MESSAGES[type as ClientMessage['type']];
  const message = plainToInstance(shape, raw);
  const errors = validateSync(message, { whitelist: true });
  if (errors.length > 0) {
    return { ok: false, problem: `invalid ${type}` };
  }
  return { ok: true, message };
}

/** The upgrade request once `RunnerSocketAdapter` has let it through. */
export interface RunnerUpgradeRequest extends IncomingMessage {
  runnerAuth?: RunnerContext;
  /** The client address, resolved with the app's `trust proxy` setting. */
  runnerIp?: string;
}
