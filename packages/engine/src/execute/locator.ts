import type { Locator } from '@demoflow/core';
import type { Page, Locator as PlaywrightLocator } from 'playwright';

type AriaRole = Parameters<Page['getByRole']>[0];

/** Maps a scenario locator one-to-one onto Playwright (ADR-0003 §3). */
export function resolveLocator(
  page: Page,
  locator: Locator,
): PlaywrightLocator {
  if ('role' in locator) {
    // The scenario schema accepts any role name; Playwright rejects an unknown one when it runs.
    return page.getByRole(locator.role as AriaRole, {
      name: locator.name,
      exact: locator.exact,
    });
  }
  if ('label' in locator) {
    return page.getByLabel(locator.label, { exact: locator.exact });
  }
  if ('testId' in locator) return page.getByTestId(locator.testId);
  if ('text' in locator) {
    return page.getByText(locator.text, { exact: locator.exact });
  }
  if ('placeholder' in locator) {
    return page.getByPlaceholder(locator.placeholder, {
      exact: locator.exact,
    });
  }
  return page.locator(locator.css);
}

export function describeLocator(locator: Locator): string {
  return JSON.stringify(locator);
}
