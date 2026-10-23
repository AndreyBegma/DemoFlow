import { test } from './demoflow.ts';

// Spec 209: container scrolls from `page.mouse.wheel`, and
// `scrollIntoViewIfNeeded`, on test/harness/inline-pages.ts. The hover puts
// the pointer over the box the wheel scrolls.

test('id-only container', async ({ page }) => {
  await page.goto('/inline/scrolls');
  await page.locator('#by-id').hover();
  await page.mouse.wheel(0, 2_000);
});

test('container without testid or id', async ({ page }) => {
  await page.goto('/inline/scrolls');
  await page.locator('.anonymous').hover();
  await page.mouse.wheel(0, 2_000);
});

test('mid-container', async ({ page }) => {
  await page.goto('/inline/scrolls');
  await page.getByTestId('long-log').hover();
  await page.mouse.wheel(0, 100);
});

test('back to the top', async ({ page }) => {
  await page.goto('/inline/scrolls');
  await page.locator('#by-id').hover();
  await page.mouse.wheel(0, 2_000);
  await page.mouse.wheel(0, -2_000);
});

test('page scroll', async ({ page }) => {
  await page.goto('/inline/scrolls');
  await page.locator('#plain').hover();
  await page.mouse.wheel(0, 10_000);
});

test('scroll into view', async ({ page }) => {
  await page.goto('/inline/scrolls');
  await page.getByTestId('x').scrollIntoViewIfNeeded();
});
