import { test } from './demoflow.ts';

// Spec 209: `demoflow.scene` records a scene marker where it is called.
test('scene', async ({ page, demoflow }) => {
  await page.goto('/inline/buttons');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  demoflow.scene('Checkout');
  await page.getByRole('button', { name: 'Checkout' }).click();
});
