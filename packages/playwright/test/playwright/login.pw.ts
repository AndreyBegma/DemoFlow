import { expect, test } from './demoflow.ts';

// login.demo.json, as a team would write it: the password comes from the
// environment, never from the file.
test('sign in', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel('Password').fill(process.env.FIXTURE_PASSWORD ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toHaveText(
    'Welcome, ada@example.com',
  );
});
