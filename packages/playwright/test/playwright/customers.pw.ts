import { expect, type Page, test } from './demoflow.ts';

// customers.demo.json. The helper and the `test.step` blocks are on purpose:
// real suites are shaped like this.
async function search(page: Page, query: string): Promise<void> {
  await page.getByLabel('Search customers').fill(query);
}

test('create a customer', async ({ page }) => {
  await page.goto('/customers');

  await test.step('Customers', async () => {
    await search(page, 'Ada');
    await search(page, '');
  });

  await test.step('Create', async () => {
    await page.getByRole('button', { name: 'New customer' }).click();
    await page.getByLabel('Name').fill('Ada Lovelace');
    await page.getByLabel('Email').fill('ada@example.com');
    await page.getByLabel('Plan').selectOption('Pro');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
  });

  await expect(page.locator('tbody')).toContainText('Ada Lovelace');
  await expect(page.getByText('ada@example.com')).toBeVisible();
});
