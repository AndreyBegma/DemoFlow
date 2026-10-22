import { revokeSelf, ServerError } from '../auth/client.ts';
import { deleteCredentials, readCredentials } from '../auth/credentials.ts';
import type { Io } from './io.ts';
import { type AuthDeps, defaultAuthDeps } from './login.ts';

/**
 * `demoflow logout`: stops the runner daemon, revokes the token on the server,
 * then deletes the file (spec 151, Decision 1).
 */
export async function logoutCommand(
  io: Io,
  deps: AuthDeps = defaultAuthDeps(),
): Promise<number> {
  await deps.runner.stop(io);
  const stored = readCredentials(deps.host);
  if (stored === null) {
    io.stdout('Not logged in\n');
    return 0;
  }
  let revoked = true;
  try {
    await revokeSelf(stored.server, stored.token, deps.fetch);
  } catch (error) {
    if (!(error instanceof ServerError)) throw error;
    revoked = false;
  }
  deleteCredentials(deps.host);
  if (revoked) {
    io.stdout('Logged out\n');
  } else {
    io.stdout(
      `Logged out on this machine, but ${stored.server} could not be reached: ` +
        `the machine is still listed under /app/machines until you revoke it there\n`,
    );
  }
  return 0;
}
