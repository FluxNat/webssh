const { test, expect } = require('playwright/test');
const { login, assertNoExternalRequests } = require('./helpers');

for (const finishWhileEditing of [true, false]) {
    test(`delayed highlighting survives editor cancellation (finish while editing: ${finishWhileEditing})`, async ({ page }) => {
        await login(page);
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        await page.route('**/vendor/highlight/highlight.min.js*', async route => {
            await gate;
            await route.continue();
        });
        try {
            await page.evaluate(() => {
                const preview = window.FilePreview;
                preview.currentSourceId = 'sftp-session:highlight-regression';
                preview.currentPath = '/example.js';
                preview.currentPreviewRequestId = 'preview-regression';
                preview.currentEditRequestId = 'edit-regression';
                preview.showContent('const original = 42;\n', 'example.js', false, 21, 21);
                preview.handleEditData({
                    source_id: preview.currentSourceId, path: preview.currentPath,
                    request_id: preview.currentEditRequestId,
                    content: 'const original = 42;\n', revision: 'original-revision',
                });
                document.getElementById('editorContent').value = 'const draft = 99;\n';
                preview.markDirty();
            });
            await expect(page.locator('script[data-preview-highlight]')).toHaveCount(1);
            if (finishWhileEditing) {
                release();
                await expect.poll(() => page.evaluate(() => Boolean(window.hljs))).toBe(true);
                await expect(page.locator('script[data-preview-highlight]')).toHaveCount(0);
                await expect(page.locator('#editorContent')).toHaveValue('const draft = 99;\n');
                expect(await page.evaluate(() => window.FilePreview.dirty)).toBe(true);
            }
            page.once('dialog', dialog => dialog.accept());
            await page.evaluate(() => window.FilePreview.cancelEdit());
            release();
            await expect(page.locator('#previewCode')).toHaveClass(/hljs/);
            await expect(page.locator('#previewCode')).toHaveText('const original = 42;');
            expect(await page.evaluate(() => window.FilePreview._previewFullContent))
                .toBe('const original = 42;\n');
            expect(await page.evaluate(() => window.FilePreview.editMode)).toBe(false);
        } finally { release(); }
    });
}

test('cold workspace startup records resource and interaction budgets', async ({ page }, testInfo) => {
    await login(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 80, downloadThroughput: 750000,
        uploadThroughput: 250000,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.reload({ waitUntil: 'load' });
    await expect.poll(() => page.evaluate(() => typeof window.openDefaultConnectionModal)).toBe('function');
    const result = await page.evaluate(() => {
        window.openDefaultConnectionModal();
        const resources = performance.getEntriesByType('resource');
        return {
            readyMs: performance.now(),
            domContentLoadedMs: performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd,
            scriptBytes: resources.filter(item => item.initiatorType === 'script')
                .reduce((total, item) => total + item.decodedBodySize, 0),
            scripts: resources.filter(item => item.initiatorType === 'script').length,
        };
    });
    await expect(page.locator('#hostInput')).toBeEditable();
    await testInfo.attach('workspace-startup.json', { body: JSON.stringify(result), contentType: 'application/json' });
    console.log('WORKSPACE_STARTUP', JSON.stringify(result));
    // Broad guard against a hung startup; comparative timings are recorded,
    // not asserted against a machine-dependent millisecond threshold.
    expect(result.readyMs).toBeLessThan(30000);
    await assertNoExternalRequests(page);
});

test('workspace loads syntax highlighting only when previewing text', async ({ page }) => {
    const requests = [];
    page.on('request', request => {
        if (request.url().includes('/vendor/highlight/')) requests.push(request.url());
    });
    await login(page);
    expect(requests).toEqual([]);
    await page.evaluate(() => window.FilePreview.showContent('const answer = 42;\n', 'a.js', false, 19, 19));
    await expect(page.locator('#previewCode')).toHaveClass(/hljs/);
    await expect(page.locator('#previewCode')).toHaveText('const answer = 42;');
    expect(requests.filter(url => url.includes('highlight.min.js'))).toHaveLength(1);
});

test('plain preview remains usable when highlighting fails and a later preview retries', async ({ page }) => {
    await login(page);
    await page.route('**/vendor/highlight/highlight.min.js*', route => route.abort());
    await page.evaluate(() => window.FilePreview.showContent('first', 'a.js', false, 5, 5));
    await expect(page.locator('#previewCode')).toHaveText('first');
    await expect.poll(() => page.evaluate(() => document.querySelector('script[data-preview-highlight]') === null)).toBe(true);
    await page.unroute('**/vendor/highlight/highlight.min.js*');
    await page.evaluate(() => window.FilePreview.showContent('const latest = true;', 'b.js', false, 20, 20));
    await expect(page.locator('#previewCode')).toHaveClass(/hljs/);
    await expect(page.locator('#previewCode')).toHaveText('const latest = true;');
});

test('a delayed highlighter only formats the latest preview', async ({ page }) => {
    await login(page);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/vendor/highlight/highlight.min.js*', async route => {
        await gate;
        await route.continue();
    });
    try {
        await page.evaluate(() => {
            window.FilePreview.showContent('old', 'a.py', false, 3, 3);
            window.FilePreview.showContent('const latest = true;', 'b.js', false, 20, 20);
        });
        await expect(page.locator('#previewCode')).toHaveText('const latest = true;');
    } finally { release(); }
    await expect(page.locator('#previewCode')).toHaveClass(/language-javascript/);
    await expect(page.locator('#previewCode')).toHaveClass(/hljs/);
    await expect(page.locator('#previewCode')).toHaveText('const latest = true;');
});
