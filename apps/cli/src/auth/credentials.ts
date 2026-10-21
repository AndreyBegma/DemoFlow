import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { CliError, globalConfigPath } from '../config/index.ts';
import { type HostEnvironment, pathFor } from '../config/platform.ts';

/** What `demoflow login` leaves on the machine (spec 135, CLI). */
export interface Credentials {
  server: string;
  token: string;
  runnerId: string;
}

/** `credentials.json` next to the global `config.json`. */
export function credentialsPath(host: HostEnvironment): string {
  const p = pathFor(host.platform);
  return p.join(p.dirname(globalConfigPath(host)), 'credentials.json');
}

/** A missing file is `null`; a malformed one is `invalid-credentials`. */
export function readCredentials(host: HostEnvironment): Credentials | null {
  const file = credentialsPath(host);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw invalid(file, error instanceof Error ? error.message : String(error));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's message can quote the file's text, which holds the token.
    throw invalid(file, 'not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalid(file, 'expected a JSON object');
  }
  const { server, token, runnerId } = raw as Record<string, unknown>;
  if (
    typeof server !== 'string' ||
    typeof token !== 'string' ||
    typeof runnerId !== 'string' ||
    server === '' ||
    token === ''
  ) {
    throw invalid(file, 'expected "server", "token" and "runnerId" strings');
  }
  return { server, token, runnerId };
}

/** Mode 0600 through a temp file and a rename, so a reader never sees half a token. */
export function writeCredentials(
  host: HostEnvironment,
  credentials: Credentials,
): void {
  const file = credentialsPath(host);
  const p = pathFor(host.platform);
  mkdirSync(p.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(credentials, null, 2)}\n`, {
      mode: 0o600,
    });
    // `mode` is masked by the umask and ignored on an existing file.
    if (host.platform !== 'win32') chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function deleteCredentials(host: HostEnvironment): void {
  rmSync(credentialsPath(host), { force: true });
}

function invalid(file: string, reason: string): CliError {
  return new CliError(
    'invalid-credentials',
    `credentials file ${file} is invalid: ${reason}; delete it and run demoflow login`,
  );
}
