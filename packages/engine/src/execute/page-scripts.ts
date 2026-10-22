import type { BrowserContext } from 'playwright';
import type { MarkedMasks } from './marked-masks.ts';
import { installNavigationProbe } from './pending-navigation.ts';

/**
 * The scripts every document of the run gets, before its own (#117, #197):
 * one place, so each script's install order is visible.
 */
export async function installPageScripts(
  context: BrowserContext,
  marked: MarkedMasks,
): Promise<void> {
  await installNavigationProbe(context);
  await marked.install(context);
}
