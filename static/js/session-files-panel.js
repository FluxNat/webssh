(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root && root.document) {
        root.SessionFilesPanelModule = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function createController(options = {}) {
        const manager = options.manager;
        const container = options.container;
        const status = options.status || null;
        const translate = options.translate || ((_key, fallback) => fallback);
        if (!manager) {
            throw new Error('SFTPFileManager instance is required');
        }
        if (typeof manager.openEmbedded !== 'function') {
            throw new Error('SFTPFileManager must support openEmbedded');
        }
        if (!container) {
            throw new Error('Embedded SFTP container is required');
        }

        function recoveryStatus(state) {
            if (!status) return;
            status.hidden = state === 'ready';
            status.classList?.toggle('session-files-recovery', state !== 'ready');
            if (state === 'ready') return;
            const key = state === 'reconnecting' ? 'workspace.toolsReconnecting'
                : state === 'refreshing' ? 'workspace.toolsRefreshing' : 'workspace.toolsRefreshFailed';
            const fallback = state === 'reconnecting' ? 'Reconnecting — displayed data may be out of date.'
                : state === 'refreshing' ? 'Refreshing — displayed data may be out of date.' : 'Could not refresh. Displayed data is out of date.';
            status.textContent = translate(key, fallback);
            if (state === 'error' && status.ownerDocument) {
                const retry = status.ownerDocument.createElement('button');
                retry.type = 'button';
                retry.className = 'btn btn-secondary btn-small';
                retry.textContent = translate('workspace.toolsRetry', 'Reload');
                retry.addEventListener('click', () => manager.refreshPane('left'));
                status.appendChild(retry);
            }
        }
        manager.onEmbeddedRecoveryChange = recoveryStatus;

        function targetLabel(session = {}) {
            const endpoint = [session.username, session.host].filter(Boolean).join('@');
            return endpoint || session.host || 'active session';
        }

        function showMount() {
            container.hidden = false;
            if (status) status.hidden = true;
        }

        function setStatus(nextStatus, session = {}) {
            if (!status) return;
            if (manager.isEmbeddedOpen?.()) manager.closeEmbedded();
            container.hidden = true;
            status.hidden = false;
            const target = targetLabel(session);
            const checking = ['unknown', 'probing'].includes(nextStatus);
            const resourceShortage = nextStatus === 'resource_shortage';
            const key = nextStatus === 'reconnecting' ? 'workspace.toolsReconnecting' : resourceShortage
                ? 'workspace.sftpResourceShortage'
                : checking
                    ? 'workspace.sftpChecking'
                    : 'workspace.sftpUnavailable';
            const fallback = nextStatus === 'reconnecting' ? 'Reconnecting — displayed data may be out of date.' : resourceShortage
                ? 'The SSH server has no free channel capacity for SFTP on {target}. PixShell will retry automatically in about one minute.'
                : checking
                    ? 'Checking SFTP for {target}...'
                    : 'SFTP is not available for {target}.';
            const translated = translate(key, fallback);
            const message = translated && translated !== key ? translated : fallback;
            status.textContent = String(message)
                .replace('{target}', target);
        }

        return {
            open(sessionId, session = {}) {
                showMount();
                manager.openEmbedded(container, sessionId, session);
            },

            follow(sessionId, session = {}) {
                showMount();
                manager.followEmbedded(sessionId, session);
            },

            close() {
                manager.closeEmbedded();
            },

            isOpen() {
                return Boolean(manager.isEmbeddedOpen?.());
            },

            setStatus,

            setTransportReady(ready) {
                manager.setEmbeddedTransportReady?.(ready);
            },

            setDisconnected(sessionId) {
                manager.handleEmbeddedDisconnect?.(sessionId);
            },
        };
    }

    return { createController };
}));
