import type { BrowserContext } from 'playwright';
import type { Annotations } from './annotations.ts';
import type { MarkedMasks } from './marked-masks.ts';
import { installNavigationProbe } from './pending-navigation.ts';
import { installReadySignal } from './ready.ts';

/**
 * The scripts every document of the run gets, before its own (#117, #197,
 * #201): one place, so each script's install order is visible. The annotation
 * binding goes in before the script that defines `window.demoflow`, which
 * grabs it.
 */
export async function installPageScripts(
  context: BrowserContext,
  marked: MarkedMasks,
  annotations: Annotations,
): Promise<void> {
  await installNavigationProbe(context);
  await marked.install(context);
  await annotations.install(context);
  await installReadySignal(context);
}
