import {
  type BrowserDeps,
  defaultBrowserDeps,
  ensureChromium,
} from './browser.ts';
import { EXIT_STAGE_FAILED } from './errors.ts';
import type { Io } from './io.ts';

/** `demoflow setup`: installs Chromium now instead of on the first run. */
export async function setupCommand(
  io: Io,
  deps: BrowserDeps = defaultBrowserDeps,
): Promise<number> {
  const outcome = await ensureChromium(io, deps);
  if (outcome === 'failed') return EXIT_STAGE_FAILED;
  io.stdout(
    `Chromium ${outcome === 'present' ? 'is installed' : 'installed'}: ${deps.executablePath()}\n`,
  );
  return 0;
}
