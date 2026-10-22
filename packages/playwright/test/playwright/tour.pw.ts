import { test } from './demoflow.ts';

// tour.demo.json. Playwright has no "scroll to bottom" action, so the test
// does it the way tests do: through `evaluate` and `mouse.wheel`.
test('tour', async ({ page }) => {
  await page.goto('/hover');
  await test.step('Hover', async () => {
    await page.getByTestId('hover-card').hover();
    await page.screenshot({
      path: test.info().outputPath('hover-tooltip.png'),
    });
  });

  await page.goto('/long');
  await test.step('Scrolling', async () => {
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    const log = page.getByTestId('log-panel');
    await log.hover();
    await page.mouse.wheel(0, 10_000);
  });

  await page.goto('/slow');
  await test.step('Slow report', async () => {
    await page.getByRole('button', { name: 'Load report' }).click();
    await page.getByText('Report ready').waitFor({ timeout: 10_000 });
    await page.screenshot({ path: test.info().outputPath('report-ready.png') });
  });
});
