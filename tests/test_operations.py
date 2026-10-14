"""Aggregate operational status must not disclose session contents."""

import threading

from app.runtime_lifecycle import RuntimeLifecycle
from app.socket_capacity import SocketCapacityRegistry


def test_runtime_snapshot_distinguishes_running_queued_and_cancelled():
    runtime = RuntimeLifecycle(1)
    started = threading.Event()
    release = threading.Event()

    def blocking(cancel):
        started.set()
        release.wait(5)

    try:
        first = runtime.start_job('private-host', blocking, owner_id=91)
        assert started.wait(2)
        second = runtime.start_job('private-path', lambda cancel: None)
        snapshot = runtime.snapshot()
        assert snapshot == {'workers': 1, 'running': 1, 'queued': 1,
                            'cancelling': 0, 'accepting_work': True}
        second.cancel()
        assert runtime.snapshot()['queued'] == 1
        assert runtime.snapshot()['cancelling'] == 1
        first.cancel()
        assert runtime.snapshot()['cancelling'] == 2
        assert 'private' not in str(snapshot)
    finally:
        release.set()
        runtime.begin_shutdown(3)
    assert runtime.snapshot()['running'] == 0
    assert runtime.snapshot()['accepting_work'] is False


def test_capacity_snapshot_counts_reasons_without_identities():
    capacity = SocketCapacityRegistry()
    assert capacity.reserve(1, 'secret-a', 2, 1)
    assert not capacity.reserve(1, 'secret-b', 2, 1)
    assert capacity.reserve(2, 'secret-c', 2, 1)
    assert not capacity.reserve(3, 'secret-d', 2, 1)
    assert capacity.reserve(2, 'secret-c', 2, 1)
    assert capacity.snapshot() == {'active': 2, 'rejected_total': 1,
                                   'rejected_per_user': 1}
    capacity.release('secret-a')
    assert capacity.snapshot()['active'] == 1


def test_operations_admin_only_and_no_store(app, client):
    from tests.test_admin_routes import _prepare_role

    _prepare_role(app, client, 'admin')
    response = client.get('/admin/api/operations')
    assert response.status_code == 200
    assert response.headers['Cache-Control'] == 'no-store'
    data = response.get_json()
    assert set(data) == {'sockets', 'jobs', 'transfers', 'maintenance'}
    assert data['sockets']['limit'] > 0
    assert data['sockets']['http_reserve'] >= 4
    assert set(data['transfers']) == {'pending', 'running', 'cancelling'}


def test_operations_denies_non_admin(app, client):
    from tests.test_admin_routes import _prepare_role

    _prepare_role(app, client, 'normal')
    assert client.get('/admin/api/operations').status_code == 403


def test_operations_denies_anonymous(client):
    assert client.get('/admin/api/operations').status_code in (302, 401)


def test_operations_disabled_panel_is_not_available(app, client, monkeypatch):
    import config
    from tests.test_admin_routes import _prepare_role

    _prepare_role(app, client, 'admin')
    monkeypatch.setattr(config, 'ADMIN_PANEL_ENABLED', False)
    assert client.get('/admin/api/operations').status_code == 404


def test_transfer_snapshot_tracks_pending_completion_without_metadata():
    from app.transfer_manager import TransferManager
    from tests.test_transfer_manager import make_quota_manager

    manager = TransferManager(quota_manager=make_quota_manager())
    record = manager.create('42', 'sftp-session:private', 'download', {'path': '/private'})
    assert manager.snapshot() == {'pending': 1, 'running': 0, 'cancelling': 0}
    manager.fail(record.transfer_id, '42')
    assert manager.snapshot() == {'pending': 0, 'running': 0, 'cancelling': 0}


def test_transfer_snapshot_tracks_cancellation_until_io_finishes():
    from app.transfer_manager import TransferManager
    from tests.test_transfer_manager import make_quota_manager

    manager = TransferManager(quota_manager=make_quota_manager())
    record = manager.create('42', 'sftp-session:private', 'download', {})
    manager.consume_token(record.token, '42')
    assert manager.snapshot() == {'pending': 0, 'running': 1, 'cancelling': 0}
    manager.cancel(record.transfer_id, '42')
    assert manager.snapshot() == {'pending': 0, 'running': 0, 'cancelling': 1}
    manager.finish_cancelled(record.transfer_id, '42')
    assert manager.snapshot() == {'pending': 0, 'running': 0, 'cancelling': 0}
