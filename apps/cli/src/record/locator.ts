import type { Locator } from '@demoflow/core';
import { resolveLocator } from '@demoflow/engine';
import type { ElementHandle, Page } from 'playwright';
import type { Candidates } from './capture-script.ts';

export interface ChosenLocator {
  locator: Locator;
  /** Set for a `css` fallback: the panel shows it (spec #79). */
  warning?: string;
}

/** Longer names and texts make a scenario unreadable; the next kind is tried. */
const MAX_NAME = 80;

export const CSS_WARNING =
  'css locator: no role, label, placeholder, test id or text is unique here';

type AriaRole = Parameters<Page['getByRole']>[0];

/**
 * The first locator, in the scenario format's order of preference (`role` +
 * `name`, `label`, `placeholder`, `testId`, `text`, `css`), that resolves —
 * through the engine's own mapping — to exactly one element, and to this one.
 * A recorded locator therefore finds the same element when the scenario runs
 * on the same page. `null` when not even a css path is unique.
 */
export async function chooseLocator(
  page: Page,
  element: ElementHandle,
  candidates: Candidates,
): Promise<ChosenLocator | null> {
  for (const locator of await proposals(page, element, candidates)) {
    for (const variant of [locator, exactly(locator)]) {
      if (variant !== null && (await pointsAt(page, variant, element))) {
        return 'css' in variant
          ? { locator: variant, warning: CSS_WARNING }
          : { locator: variant };
      }
    }
  }
  return null;
}

async function proposals(
  page: Page,
  element: ElementHandle,
  candidates: Candidates,
): Promise<Locator[]> {
  const list: Locator[] = [];
  if (candidates.role !== undefined) {
    const name = await accessibleName(page, candidates.role, element);
    if (name !== null && name.length <= MAX_NAME) {
      list.push(
        name === ''
          ? { role: candidates.role }
          : { role: candidates.role, name },
      );
    }
  }
  for (const label of candidates.labels) {
    if (label.length <= MAX_NAME) list.push({ label });
  }
  if (candidates.placeholder !== undefined) {
    list.push({ placeholder: candidates.placeholder });
  }
  if (candidates.testId !== undefined) list.push({ testId: candidates.testId });
  if (candidates.text !== undefined) list.push({ text: candidates.text });
  list.push({ css: candidates.css });
  return list;
}

/** The same locator matching whole strings only, for kinds that take `exact`. */
function exactly(locator: Locator): Locator | null {
  if ('testId' in locator || 'css' in locator) return null;
  if ('role' in locator && locator.name === undefined) return null;
  return { ...locator, exact: true };
}

/**
 * The element's accessible name as Playwright computes it — read from its
 * aria snapshot, so the name matches what `getByRole` will match. `null` when
 * the element does not have this role in Playwright's eyes.
 */
async function accessibleName(
  page: Page,
  role: string,
  element: ElementHandle,
): Promise<string | null> {
  try {
    const all = page.getByRole(role as AriaRole);
    const index = await all.evaluateAll(
      (elements, target) => elements.indexOf(target as never),
      element,
    );
    if (index < 0) return null;
    const snapshot = await all.nth(index).ariaSnapshot({ timeout: 1_000 });
    return parseSnapshotName(snapshot, role);
  } catch {
    return null;
  }
}

/** `- button "New customer"` → `New customer`; `- heading [level=1]` → ``. */
export function parseSnapshotName(
  snapshot: string,
  role: string,
): string | null {
  const first = snapshot.split('\n')[0]?.trim() ?? '';
  if (!first.startsWith(`- ${role}`)) return null;
  const rest = first.slice(`- ${role}`.length);
  const quoted = /^ ("(?:[^"\\]|\\.)*")/.exec(rest);
  if (quoted?.[1] === undefined) return '';
  try {
    const name: unknown = JSON.parse(quoted[1]);
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

async function pointsAt(
  page: Page,
  locator: Locator,
  element: ElementHandle,
): Promise<boolean> {
  try {
    return await resolveLocator(page, locator).evaluateAll(
      (elements, target) =>
        elements.length === 1 && elements[0] === (target as never),
      element,
    );
  } catch {
    // An unknown role or an invalid selector: not this candidate.
    return false;
  }
}
