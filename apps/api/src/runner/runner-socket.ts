import type { IncomingMessage } from 'node:http';
import { type ClassConstructor, plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  validateSync,
} from 'class-validator';
import type { RawData } from 'ws';
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

export type ServerMessage =
  | { type: 'hello'; runnerId: string; serverTime: string }
  | { type: 'ping'; at: number }
  | { type: 'pong'; at: number }
  | { type: 'rotate'; token: string }
  | { type: 'bye'; reason: string };

export type ClientMessage =
  | PingMessage
  | PongMessage
  | RotatedMessage
  | ByeMessage;

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

const CLIENT_MESSAGES: Record<
  ClientMessage['type'],
  ClassConstructor<ClientMessage>
> = {
  ping: PingMessage,
  pong: PongMessage,
  rotated: RotatedMessage,
  bye: ByeMessage,
};

export type ParsedMessage =
  | { ok: true; message: ClientMessage }
  | { ok: false; problem: string };

/**
 * One frame from a daemon, validated. Fields beyond the message's own are
 * dropped, so a newer daemon can add some; an unknown `type` is a problem the
 * caller logs and ignores.
 */
export function parseClientMessage(
  data: RawData,
  isBinary: boolean,
): ParsedMessage {
  if (isBinary) {
    return { ok: false, problem: 'binary frame' };
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
