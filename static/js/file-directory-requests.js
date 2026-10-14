// Directory request lifecycle shared by both file panes.
// The workspace supplies panes, socket, source identity/capability helpers,
// request IDs, error rendering and translation. Request/cursor state stays
// on its pane so late replies and timeouts cannot affect another source.
class FileDirectoryRequests {
    requestHomeDirectory(pane) {
        const state = this.panes[pane];
        const requestId = this.nextRequestId(pane, 'home');
        state.pendingHomeRequestId = requestId;
        this.socket.emit('get_home_directory', {
            source_id: this.getPaneSourceId(state),
            request_id: requestId,
        });
        return requestId;
    }

    requestDirectory(pane, path) {
        const state = this.panes[pane];
        return this.requestDirectoryForState(pane, state, path);
    }

    cancelDirectoryCursor(sourceId, cursor) {
        if (!sourceId
                || !this.isDirectoryContinuationCursor(cursor)
                || !this.socket?.emit) return false;
        try {
            this.socket.emit('cancel_directory_listing', {
                source_id: sourceId,
                request_id: this.nextRequestId('directory', 'cancel'),
                cursor,
            });
            return true;
        } catch {
            return false;
        }
    }

    cancelDirectoryRequest(sourceId, listingRequestId) {
        if (!sourceId
                || !this.isDirectoryRequestId(listingRequestId)
                || !this.socket?.emit) return false;
        try {
            this.socket.emit('cancel_directory_listing', {
                source_id: sourceId,
                request_id: this.nextRequestId('directory', 'cancel'),
                listing_request_id: listingRequestId,
            });
            return true;
        } catch {
            return false;
        }
    }

    cancelDirectoryListingForState(state, options = {}) {
        if (!state) return false;
        const sourceId = this.getPaneSourceId(state);
        let emitted = false;
        if (state.pendingDirectoryCursor === 0) {
            emitted = this.cancelDirectoryRequest(
                sourceId,
                state.pendingDirectoryRequestId,
            ) || emitted;
        }
        const cursors = new Set([
            state.nextDirectoryCursor,
            state.pendingDirectoryCursor,
        ].filter(cursor => this.isDirectoryContinuationCursor(cursor)));
        cursors.forEach(cursor => {
            emitted = this.cancelDirectoryCursor(sourceId, cursor) || emitted;
        });
        if (state.loadingTimeout) clearTimeout(state.loadingTimeout);
        const shouldRefresh = options.refreshOnNextOpen === true
            && Boolean(sourceId)
            && this.sourceCan(state, 'list');
        state.loadingTimeout = null;
        state.loading = false;
        state.loadingMore = false;
        state.pendingDirectoryRequestId = null;
        state.pendingDirectoryPath = null;
        state.pendingDirectoryCursor = 0;
        state.nextDirectoryCursor = null;
        state.directoryContinuationView = null;
        state.directoryNeedsRefresh = shouldRefresh;
        return emitted;
    }

    resumeDirectoryListingIfNeeded(pane, state) {
        if (!state?.directoryNeedsRefresh
                || !this.getPaneSourceId(state)
                || !this.sourceCan(state, 'list')) return false;
        const requestId = this.requestDirectoryForState(
            pane,
            state,
            state.path || '/',
        );
        if (!requestId) {
            state.directoryNeedsRefresh = true;
            return false;
        }
        this.setLoadingTimeout(pane);
        return true;
    }

    requestDirectoryForState(pane, state, path) {
        this.cancelDirectoryListingForState(state);
        state.selected?.clear();
        state.path = path;
        state.loading = true;
        state.loadingMore = false;
        state.directoryContinuationView = null;
        state.nextDirectoryCursor = null;
        state.directoryNeedsRefresh = false;
        const requestId = this.nextRequestId(pane, 'directory');
        state.pendingDirectoryRequestId = requestId;
        state.pendingDirectoryPath = path;
        state.pendingDirectoryCursor = 0;
        const sourceId = this.getPaneSourceId(state);
        try {
            this.socket.emit('list_directory', {
                source_id: sourceId,
                remote_path: path,
                request_id: requestId,
                cursor: 0,
            });
        } catch {
            this.consumePaneDirectoryError({
                operation: 'list_directory',
                source_id: sourceId,
                request_id: requestId,
                path,
                cursor: 0,
            }, this.t('fm.sourceUnavailable', 'This file source is no longer available'));
            return null;
        }
        return requestId;
    }

    requestNextDirectoryPage(pane) {
        const state = this.panes[pane];
        const cursor = state?.nextDirectoryCursor;
        if (!this.isDirectoryContinuationCursor(cursor) || state.loadingMore) return false;
        if (state.loadingTimeout) {
            clearTimeout(state.loadingTimeout);
            state.loadingTimeout = null;
        }
        const requestId = this.nextRequestId(pane, 'directory-page');
        const requestPath = state.path;
        state.loadingMore = true;
        state.pendingDirectoryRequestId = requestId;
        state.pendingDirectoryPath = requestPath;
        state.pendingDirectoryCursor = cursor;
        const sourceId = this.getPaneSourceId(state);
        this.capturePaneContinuationView(pane, state, requestId, cursor);
        try {
            this.socket.emit('list_directory', {
                source_id: sourceId,
                remote_path: requestPath,
                request_id: requestId,
                cursor,
            });
        } catch {
            this.consumePaneDirectoryError({
                operation: 'list_directory',
                source_id: sourceId,
                request_id: requestId,
                path: requestPath,
                cursor,
            }, this.t('fm.sourceUnavailable', 'This file source is no longer available'));
            return true;
        }
        this.setLoadingTimeout(pane);
        return true;
    }

    paneListElement(pane) {
        return document.getElementById(`fm${this.capitalize(pane)}List`);
    }

    capturePaneContinuationView(pane, state, requestId, cursor) {
        const container = this.paneListElement(pane);
        if (!container) {
            state.directoryContinuationView = null;
            return;
        }
        const loadMore = container.querySelector?.('[data-load-more]') || null;
        state.directoryContinuationView = {
            requestId,
            cursor,
            scrollTop: Number(container.scrollTop) || 0,
            restoreFocus: document.activeElement === loadMore,
        };
        container.setAttribute?.('aria-busy', 'true');
        if (loadMore) {
            loadMore.disabled = true;
            loadMore.setAttribute?.('aria-busy', 'true');
            loadMore.textContent = this.t('fm.loading', 'Loading...');
        }
    }

    restorePaneContinuationView(pane, state, data) {
        const view = state.directoryContinuationView;
        if (!view
            || view.requestId !== data?.request_id
            || view.cursor !== (data?.cursor ?? 0)) return false;
        state.directoryContinuationView = null;
        const container = this.paneListElement(pane);
        if (!container) return false;
        container.scrollTop = view.scrollTop;
        if (view.restoreFocus) {
            const loadMore = container.querySelector?.('[data-load-more]') || null;
            const focusTarget = loadMore || container;
            if (!loadMore) container.setAttribute?.('tabindex', '-1');
            focusTarget.focus?.({ preventScroll: true });
            container.scrollTop = view.scrollTop;
        }
        return true;
    }

    isDirectoryContinuationCursor(cursor) {
        if (Number.isInteger(cursor)) return cursor > 0;
        return typeof cursor === 'string'
            && cursor.length >= 1
            && cursor.length <= 160
            && /^[A-Za-z0-9._-]+$/.test(cursor);
    }

    isDirectoryRequestId(requestId) {
        return typeof requestId === 'string'
            && requestId.length >= 1
            && requestId.length <= 128
            && /^[A-Za-z0-9:._-]+$/.test(requestId);
    }

    setLoadingTimeout(pane, timeout = 10000, targetState = null) {
        const state = targetState || this.panes[pane];
        if (!state?.loading && !state?.loadingMore) return false;

        if (state.loadingTimeout) {
            clearTimeout(state.loadingTimeout);
            state.loadingTimeout = null;
        }

        const sourceId = this.getPaneSourceId(state);
        const requestId = state.pendingDirectoryRequestId;
        const requestPath = state.pendingDirectoryPath;
        const requestCursor = state.pendingDirectoryCursor;
        if (!sourceId || !requestId || !requestPath) return false;

        const loadingTimeout = setTimeout(() => {
            if (state.loadingTimeout !== loadingTimeout
                    || this.getPaneSourceId(state) !== sourceId
                    || state.pendingDirectoryRequestId !== requestId
                    || state.pendingDirectoryPath !== requestPath
                    || state.pendingDirectoryCursor !== requestCursor
                    || (!state.loading && !state.loadingMore)) return;
            this.consumePaneDirectoryError({
                operation: 'list_directory',
                source_id: sourceId,
                request_id: requestId,
                path: requestPath,
                cursor: requestCursor,
            }, this.t(
                'fm.connectionTimeout',
                'Connection timeout - could not load directory',
            ));
        }, timeout);
        state.loadingTimeout = loadingTimeout;
        return true;
    }

}

window.FileDirectoryRequests = FileDirectoryRequests;
