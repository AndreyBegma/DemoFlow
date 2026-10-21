import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

/** Decision 1: rotated at 5 MB, three files kept in total. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_FILES = 3;

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, message: string): void;
}

const TOKEN = /dfr_[A-Za-z0-9_-]+/g;

/** A second guard: no message is built from the token, and none may carry one. */
export function redact(text: string): string {
  return text.replace(TOKEN, 'dfr_***');
}

/**
 * `runner.log`: one `<ISO time> <level> <message>` line per call, opened and
 * closed each time so a rotation never leaves the writer on a renamed file.
 */
export function fileLogger(
  file: string,
  options: {
    now?: () => Date;
    maxBytes?: number;
    echo?: (line: string) => void;
  } = {},
): Logger {
  const now = options.now ?? (() => new Date());
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  mkdirSync(path.dirname(file), { recursive: true });
  return {
    log(level, message) {
      const line = `${now().toISOString()} ${level} ${redact(message).replace(/\r?\n/g, ' ')}\n`;
      rotateIfFull(file, Buffer.byteLength(line), maxBytes);
      appendFileSync(file, line);
      options.echo?.(line);
    },
  };
}

/** `runner.log` → `.1` → `.2`; the oldest is dropped. */
export function rotateIfFull(
  file: string,
  incoming: number,
  maxBytes: number = LOG_MAX_BYTES,
): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size === 0 || size + incoming <= maxBytes) return;
  rmSync(`${file}.${LOG_FILES - 1}`, { force: true });
  for (let index = LOG_FILES - 2; index >= 1; index--) {
    try {
      renameSync(`${file}.${index}`, `${file}.${index + 1}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  renameSync(file, `${file}.1`);
}
