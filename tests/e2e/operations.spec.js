const { createHash } = require('node:crypto');
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
        body: JSON.stringify({ code: 'maintenance', error: 'PixShell is in restore maintenance mode' }),
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
    await expect(page.locator('#operationsDetailRows tr:not(.operations-entry-details)').filter({ hasText: 'test-user' })).toHaveCount(1);
    failed = true;
    await page.locator('#operationsRefresh').click();
    await expect(page.locator('#operationsDetailsStatus')).toContainText('Could not load');
    await expect(page.locator('#operationsDetailRows button')).toHaveCount(0);
    failed = false;
    await page.locator('#operationsRefresh').click();
    await expect(page.locator('#operationsDetailRows tr:not(.operations-entry-details)').filter({ hasText: 'test-user' })).toHaveCount(1);
});


test('same-tab Settings keeps SSH sessions visible while another browser stays connected', async ({ page, browser }, testInfo) => {
    const otherContext = await browser.newContext({ baseURL: 'http://127.0.0.1:' + (process.env.WEBSSH_E2E_PORT || '4173') });
    try {
        const other = await otherContext.newPage();
        await login(other, 'e2e_user');
        await expect.poll(() => other.evaluate(() => window.socket.connected)).toBe(true);
        await login(page);
        await expect.poll(() => page.evaluate(() => window.socket.connected)).toBe(true);
        const ownRef = createHash('sha256').update('admin-connection:' + await page.evaluate(() => window.socket.id)).digest('hex');
        const otherRef = createHash('sha256').update('admin-connection:' + await other.evaluate(() => window.socket.id)).digest('hex');
        const connectionRefs = async () => {
            const response = await page.request.get('/admin/api/operations/details');
            expect(response.ok()).toBe(true);
            return (await response.json()).connections.items.map(item => item.id);
        };
        await expect.poll(connectionRefs).toEqual(expect.arrayContaining([ownRef, otherRef]));
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
        await expect(page.locator('#operationsDetailRows').getByRole('button', { name: 'Disconnect SSH', exact: true })).toHaveCount(1);
        await expect.poll(async () => {
            const refs = await connectionRefs();
            return { own: refs.includes(ownRef), other: refs.includes(otherRef) };
        }).toEqual({ own: false, other: true });
        expect(await page.evaluate(() => window.socket?.connected === true)).toBe(false);
        expect(await other.evaluate(() => window.socket.connected)).toBe(true);
        await expect(page.locator('#operationsTransportDiagnostics')).not.toHaveAttribute('open');
        await page.screenshot({ path: testInfo.outputPath('instance-status-sessions.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
        await page.locator('#operationsDetailRows').getByRole('button', { name: 'Details', exact: true }).click();
        await expect(page.locator('.operations-entry-details')).toBeVisible();
        await page.locator('#operationsDetailRows').getByRole('button', { name: 'Details', exact: true }).click();
        await expect(page.locator('.operations-entry-details')).toBeHidden();
        await page.screenshot({ path: testInfo.outputPath('instance-status-sessions-mobile.png'), fullPage: true });
    } finally {
        await otherContext.close();
    }
});


test('SSH administration exposes target and safe actions with one shared refresh', async ({ page }) => {
    await login(page);
    let disconnected = false;
    let detailsRequests = 0;
    await page.route('**/admin/api/operations/details', route => {
        detailsRequests += 1;
        return route.fulfill({ json: {
            sessions: { total: disconnected ? 0 : 1, items: disconnected ? [] : [{
                id: 'ssh-reference', username: 'e2e_user', target: 'ops@edge.example:22',
                tmux: true, created_at: '2026-10-15T08:00:00Z',
            }] }, connections: { total: 0, items: [] }, transfers: { total: 0, items: [] }, jobs: { total: 0, items: [] },
        } });
    });
    await page.route('**/admin/api/operations/sessions/ssh-reference/disconnect', route => {
        expect(route.request().method()).toBe('POST');
        expect(route.request().headers()['x-webssh-step-up']).toBeTruthy();
        disconnected = true;
        return route.fulfill({ json: { state: 'disconnected' } });
    });
    await page.goto('/settings#operations');
    await expect(page.getByRole('columnheader', { name: 'SSH target', exact: true })).toBeVisible();
    const row = page.locator('#operationsDetailRows tr').filter({ hasText: 'ops@edge.example:22' });
    await expect(row).toContainText('e2e_user');
    await expect(row).not.toContainText('ssh-reference');
    await row.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(page.locator('#operationsDetailRows')).toContainText('ssh-reference');
    const before = detailsRequests;
    await page.locator('#operationsRefresh').click();
    await expect.poll(() => detailsRequests).toBeGreaterThan(before);
    await expect(page.locator('#operationsRefresh')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(1);
    page.once('dialog', dialog => {
        expect(dialog.message()).toContain('ops@edge.example:22');
        expect(dialog.message()).toContain('e2e_user');
        expect(dialog.message()).toContain('tmux');
        return dialog.dismiss();
    });
    await row.getByRole('button', { name: 'Disconnect SSH', exact: true }).click();
    expect(disconnected).toBe(false);
    page.once('dialog', dialog => dialog.accept());
    await row.getByRole('button', { name: 'Disconnect SSH', exact: true }).click();
    await page.locator('#stepUpPassword').fill('browser-password');
    await page.locator('#stepUpSubmit').click();
    await expect(page.locator('#operationsActionStatus')).toContainText('SSH connection disconnected');
    await expect(page.locator('#operationsDetailRows')).not.toContainText('ops@edge.example:22');
});


test('admin SSH disconnect updates the real registry and only the selected session in another browser', async ({ page, browser }) => {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:' + (process.env.WEBSSH_E2E_PORT || '4173') });
    const other = await context.newPage();
    try {
        await login(other, 'e2e_user');
        const seeded = await other.evaluate(() => new Promise(resolve => window.socket.emit('e2e_workspace_restore', { count: 2 }, resolve)));
        expect(seeded.ok).toBe(true);
        await other.reload();
        await expect(other.locator('.session-tab')).toHaveCount(2);
        await other.evaluate(() => { window.adminDisconnects = []; window.socket.on('ssh_disconnected', data => window.adminDisconnects.push(data.session_id)); });
        await login(page);
        await page.goto('/settings#operations');
        const ref = createHash('sha256').update('admin-ssh:' + seeded.session_ids[0]).digest('hex');
        const rows = page.locator('#operationsDetailRows > tr:not(.operations-entry-details)').filter({ hasText: 'e2e_user' });
        await expect(rows).toHaveCount(2);
        await rows.first().getByRole('button', { name: 'Details', exact: true }).click();
        await expect(page.locator('#operationsDetailRows')).toContainText(ref);
        page.once('dialog', dialog => dialog.accept());
        await rows.first().getByRole('button', { name: 'Disconnect SSH', exact: true }).click();
        await page.locator('#stepUpPassword').fill('browser-password');
        await page.locator('#stepUpSubmit').click();
        await expect(page.locator('#operationsActionStatus')).toContainText('SSH connection disconnected');
        await expect.poll(() => other.evaluate(() => window.adminDisconnects)).toEqual([seeded.session_ids[0]]);
        await expect(rows).toHaveCount(1);
        const response = await page.request.get('/admin/api/operations/details');
        const ids = (await response.json()).sessions.items.map(item => item.id);
        expect(ids).not.toContain(ref);
        expect(ids).toContain(createHash('sha256').update('admin-ssh:' + seeded.session_ids[1]).digest('hex'));
        expect(await other.evaluate(() => window.socket.connected)).toBe(true);
        await other.reload();
        await expect(other.locator('.session-tab')).toHaveCount(1);
    } finally {
        if (!other.isClosed()) {
            await other.evaluate(() => new Promise(resolve => window.socket.emit('e2e_workspace_restore', { count: 0 }, resolve))).catch(() => {});
        }
        await context.close();
    }
});
