import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('imports, resolves declarations, exports and reconciles through the UI', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('demo-admin-2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Exception queue', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Import extract', exact: true }).first().click();
  await page.getByRole('button', { name: 'Use example extract' }).click();
  await page.getByRole('button', { name: 'Import and validate' }).click();
  await expect(page.getByRole('heading', { name: 'Batch control', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Customer records', exact: true }).click();
  await page.getByPlaceholder('Customer name or ID').fill('SYN-0001');
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic 001 Pty Ltd' })).toBeVisible();
  await page.getByLabel('Declaration evidence reference').fill('SYNTHETIC-CUSTOMER-EVIDENCE');
  await page.getByRole('button', { name: 'Signatories', exact: false }).first().click();
  await page.getByLabel('Verified identity evidence').fill('SYNTHETIC-ID-EVIDENCE');
  await page.getByRole('button', { name: 'Save and validate' }).click();
  await expect(
    page.getByText('Saved SYN-0001. CBS ready. Lease released.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close record', exact: true }).click();
  await page.getByRole('button', { name: 'Batch control', exact: true }).click();
  await page.getByRole('button', { name: 'Release ready', exact: true }).first().click();
  await page.getByRole('button', { name: 'Customer records', exact: true }).click();
  await page.getByPlaceholder('Customer name or ID').fill('SYN-0001');
  await expect(page.getByRole('table').getByText('Reconciled', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download bundle' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('SYN-0001-migration.zip');
  await page.screenshot({ path: 'test-results/record-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Close record', exact: true }).click();
  await page
    .getByRole('button', { name: /Exception queue/ })
    .first()
    .click();
  await page.screenshot({ path: 'test-results/queue-desktop.png', fullPage: true });
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  expect(errors).toEqual([]);
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.screenshot({ path: 'test-results/queue-tablet.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('a second operator sees the current holder and cannot edit', async ({ browser }) => {
  const first = await browser.newContext(),
    second = await browser.newContext();
  try {
    const a = await first.newPage(),
      b = await second.newPage();
    for (const [page, username, password] of [
      [a, 'admin', 'demo-admin-2026'],
      [b, 'operator', 'demo-operator-2026'],
    ] as const) {
      await page.goto('http://127.0.0.1:5173');
      await page.getByLabel('Username').fill(username);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('button', { name: 'Customer records', exact: true }).click();
      await page.getByPlaceholder('Customer name or ID').fill('SYN-0002');
      await page.getByRole('button', { name: 'Open record', exact: true }).click();
    }
    await expect(b.getByRole('button', { name: 'Save and validate' })).toBeDisabled();
    await expect(b.getByLabel('Declaration evidence reference')).toHaveAttribute('readonly', '');
    await expect(b.getByRole('status')).toContainText('In use by');
    await a.getByRole('button', { name: 'Close record', exact: true }).click();
    await b.getByRole('button', { name: 'Acquire edit lease' }).click();
    await expect(b.getByRole('button', { name: 'Save and validate' })).toBeEnabled();
  } finally {
    await first.close();
    await second.close();
  }
});
