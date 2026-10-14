const { test, expect } = require('playwright/test');
const { login } = require('./helpers');

test('admin operations refreshes aggregate state and leaves personal settings usable', async ({ page }, testInfo) => {
    await login(page);
    await page.goto('/settings#operations');
    await expect(page.locator('#tab-operations')).toBeVisible();
    await expect(page.locator('[data-operation="sockets.limit"]')).toHaveText(/\d+/);
    await expect(page.locator('#operationsStatus')).toContainText('Updated');
    const response = page.waitForResponse(url => url.url().includes('/admin/api/operations'));
    await page.locator('#operationsRefresh').click();
    expect((await response).status()).toBe(200);
    await expect(page.locator('#operationsRefresh')).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('operations-desktop.png'), fullPage: true });
    await page.locator('[data-account-section="preferences"]').click();
    await expect(page.locator('#tab-operations')).toBeHidden();
    await expect(page.locator('[data-account-panel="preferences"]')).toBeVisible();
});

test('instance status works in German on a narrow screen', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.goto('/settings#preferences');
    await page.locator('#settingsLanguageSelect').selectOption('de');
    await page.locator('#settingsMobileSection').selectOption('operations');
    await expect(page.locator('#operationsTitle')).toHaveText('Instanzstatus');
    await expect(page.locator('#operationsStatus')).toContainText('Aktualisiert');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath('operations-mobile-de.png'), fullPage: true });
    await page.locator('[data-operation="transfers.cancelling"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-operation="transfers.cancelling"]')).toBeVisible();
});

test('operations errors discard stale counts and permit a retry', async ({ page }) => {
    await login(page);
    await page.goto('/settings#operations');
    await expect(page.locator('#operationsStatus')).toContainText('Updated');
    await page.route('**/admin/api/operations', route => route.fulfill({ status: 503, body: '{}' }));
    await page.locator('#operationsRefresh').click();
    await expect(page.locator('#operationsStatus')).toContainText('Could not load');
    await expect(page.locator('[data-operation="sockets.active"]')).toHaveText('—');
    await expect(page.locator('#operationsRefresh')).toBeEnabled();
    await page.unroute('**/admin/api/operations');
    await page.locator('#operationsRefresh').click();
    await expect(page.locator('#operationsStatus')).toContainText('Updated');
});

test('non-admin account has no operations navigation or API access', async ({ page }) => {
    await login(page, 'e2e_user');
    await page.goto('/settings#operations');
    await expect(page.locator('[data-tab="operations"]')).toHaveCount(0);
    const response = await page.request.get('/admin/api/operations');
    expect(response.status()).toBe(403);
});

test('maintenance response explains why current counts are unavailable', async ({ page }) => {
    await login(page);
    await page.goto('/settings#operations');
    await expect(page.locator('#operationsStatus')).toContainText('Updated');
    await page.route('**/admin/api/operations', route => route.fulfill({
        status: 503, contentType: 'application/json',
        body: JSON.stringify({ code: 'maintenance', error: 'WebSSH is in restore maintenance mode' }),
    }));
    await page.locator('#operationsRefresh').click();
    await expect(page.locator('#operationsNotice')).toHaveText('Maintenance mode');
    await expect(page.locator('#operationsStatus')).toHaveText('Maintenance mode');
    await expect(page.locator('[data-operation="sockets.active"]')).toHaveText('—');
});

test('a login page after authentication expiry cannot appear as a fresh snapshot', async ({ page }) => {
    await login(page);
    await page.goto('/settings#operations');
    await expect(page.locator('#operationsStatus')).toContainText('Updated');
    await page.route('**/admin/api/operations', route => route.fulfill({
        status: 200, contentType: 'text/html', body: '<html><body>Sign in</body></html>',
    }));
    await page.locator('#operationsRefresh').click();
    await expect(page.locator('#operationsStatus')).toContainText('Could not load');
    await expect(page.locator('[data-operation="sockets.active"]')).toHaveText('—');
});
