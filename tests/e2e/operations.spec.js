const { test, expect } = require('playwright/test');
const { login } = require('./helpers');

test('administrator disconnects one browser after confirmation and reauthentication', async ({ page, browser }) => {
    const otherContext = await browser.newContext({ baseURL: 'http://127.0.0.1:' + (process.env.WEBSSH_E2E_PORT || '4173') });
    try {
        const other = await otherContext.newPage();
        await login(other, 'e2e_user');
        await expect.poll(() => other.evaluate(() => window.socket.connected)).toBe(true);
        await login(page);
        await page.goto('/settings#operations');
        await page.locator('#operationsTransportDiagnostics summary').click();
        await page.locator('[data-operation-view="connections"]').click();
        const row = page.locator('#operationsDetailRows tr').filter({ hasText: 'e2e_user' });
        await expect(row).toHaveCount(1);
        page.once('dialog', dialog => dialog.dismiss());
        await row.getByRole('button', { name: 'Disconnect browser' }).click();
        expect(await other.evaluate(() => window.socket.connected)).toBe(true);
        page.once('dialog', dialog => dialog.accept());
        await row.getByRole('button', { name: 'Disconnect browser' }).click();
        await page.locator('#stepUpPassword').fill('browser-password');
        await page.locator('#stepUpSubmit').click();
        await expect(page.locator('#operationsActionStatus')).toContainText('Browser disconnected');
        await expect.poll(() => other.evaluate(() => window.socket.connected)).toBe(false);
        await expect(page.locator('#operationsDetailRows')).not.toContainText('e2e_user');
    } finally { await otherContext.close(); }
});

test('transfer cancellation retains cancelling state and renders user text safely', async ({ page }) => {
    await login(page);
    let cancelling = false;
    await page.route('**/admin/api/operations/details', route => route.fulfill({
        json: {
            sessions: { total: 0, items: [] }, connections: { total: 0, items: [] }, jobs: { total: 0, items: [] },
            transfers: { total: 1, items: [{ id: 'transfer-test', username: '<img src=x onerror=alert(1)>',
                direction: 'download', state: cancelling ? 'cancelling' : 'running', age_seconds: 12 }] },
        },
    }));
    await page.route('**/admin/api/operations/transfers/transfer-test/cancel', route => {
        expect(route.request().method()).toBe('POST');
        expect(route.request().headers()['x-webssh-step-up']).toBeTruthy();
        cancelling = true;
        return route.fulfill({ json: { accepted: true, state: 'cancelling' } });
    });
    await page.goto('/settings#operations');
    await page.locator('[data-operation-view="transfers"]').click();
    await expect(page.locator('#operationsDetailRows')).toContainText('<img src=x onerror=alert(1)>');
    await expect(page.locator('#operationsDetailRows img')).toHaveCount(0);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Cancel transfer', exact: true }).click();
    await page.locator('#stepUpPassword').fill('browser-password');
    await page.locator('#stepUpSubmit').click();
    await expect(page.locator('#operationsActionStatus')).toContainText('Cancellation requested');
    await expect(page.getByRole('button', { name: 'Cancel transfer', exact: true })).toBeDisabled();
});

test('task details and capacity guidance remain usable on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.goto('/settings#operations');
    await page.locator('#operationsTransportDiagnostics summary').click();
    await page.locator('[data-operation-view="jobs"]').click();
    await expect(page.locator('#operationsDetailsHint')).toContainText('System tasks');
    await expect(page.locator('#operationsDetailRows button')).toHaveCount(0);
    await page.locator('#operationsConfiguration summary').click();
    await expect(page.locator('#operationsConfiguration')).toContainText('MAX_SOCKET_CONNECTIONS');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

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


test('failed detail refresh removes stale action rows and allows retry', async ({ page }) => {
    await login(page);
    let failed = false;
    await page.route('**/admin/api/operations/details', route => route.fulfill(failed
        ? { status: 503, json: {} }
        : { json: { sessions: { total: 0, items: [] }, connections: { total: 0, items: [] }, jobs: { total: 0, items: [] },
            transfers: { total: 1, items: [{ id: 'pending-transfer', username: 'test-user',
                direction: 'upload', state: 'pending', age_seconds: 1 }] } } }));
    await page.goto('/settings#operations');
    await page.locator('[data-operation-view="transfers"]').click();
    await expect(page.locator('#operationsDetailRows tr')).toHaveCount(1);
    failed = true;
    await page.locator('#operationsDetailsRefresh').click();
    await expect(page.locator('#operationsDetailsStatus')).toContainText('Could not load');
    await expect(page.locator('#operationsDetailRows tr')).toHaveCount(0);
    failed = false;
    await page.locator('#operationsDetailsRefresh').click();
    await expect(page.locator('#operationsDetailRows tr')).toHaveCount(1);
});


test('same-tab Settings keeps SSH sessions visible without a browser transport', async ({ page }, testInfo) => {
    await login(page);
    await expect.poll(() => page.evaluate(() => window.socket.connected)).toBe(true);
    await page.route('**/admin/api/operations', async route => {
        const response = await route.fetch();
        const data = await response.json();
        await route.fulfill({ json: { ...data, sessions: { active: 1, users: 1, tmux: 1 } } });
    });
    await page.route('**/admin/api/operations/details', async route => {
        const response = await route.fetch();
        const data = await response.json();
        await route.fulfill({ json: { ...data, sessions: { total: 1, items: [{
            id: 'session-reference', username: 'e2e_admin', target: 'ops@edge.example:22',
            tmux: true, created_at: '2026-10-15T08:00:00Z',
        }] } } });
    });
    const href = await page.locator('#accountSettingsBtn').getAttribute('href');
    await page.goto(href.replace('#preferences', '#operations'));
    await expect(page.locator('[data-operation="sessions.active"]')).toHaveText('1');
    await expect(page.locator('#operationsDetailRows')).toContainText('ops@edge.example:22');
    await expect(page.locator('#operationsDetailRows')).toContainText('e2e_admin');
    await expect(page.locator('#operationsDetailRows button')).toHaveCount(0);
    await expect.poll(async () => (await (await page.request.get('/admin/api/operations')).json()).sockets.active).toBe(0);
    await expect(page.locator('#operationsTransportDiagnostics')).not.toHaveAttribute('open');
    await page.screenshot({ path: testInfo.outputPath('instance-status-sessions.png'), fullPage: true });
});
