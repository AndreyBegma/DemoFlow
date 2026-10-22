import { types } from 'node:util';
import { expect as playwrightExpect } from '@playwright/test';
import { expect, test } from './demoflow.ts';

// Run without DEMOFLOW_RECORD (or with =0) only: nothing is wrapped.
test('passes through', async ({ page }) => {
  playwrightExpect(types.isProxy(page)).toBe(false);
  playwrightExpect(expect).toBe(playwrightExpect);
  await page.goto('/login');
  await expect(page.getByLabel('Email')).toBeVisible();
});
