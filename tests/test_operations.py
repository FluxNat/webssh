"""Aggregate operational status must not disclose session contents."""

import threading

import pytest

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
    assert set(data) == {'sockets', 'jobs', 'transfers', 'maintenance', 'sessions'}
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


def test_admin_details_are_bounded_and_exclude_transfer_secrets(app, client, monkeypatch):
    from app import operations
    from app.transfer_manager import TransferManager
    from tests.test_admin_routes import _prepare_role
    from tests.test_transfer_manager import make_quota_manager

    owner = _prepare_role(app, client, 'admin')
    manager = TransferManager(quota_manager=make_quota_manager())
    record = manager.create(str(owner), 'sftp-session:secret-source', 'download', {'path': '/private/path'})
    token = record.token
    monkeypatch.setattr(operations, 'transfer_manager', manager)
    response = client.get('/admin/api/operations/details')
    assert response.status_code == 200
    assert response.headers['Cache-Control'] == 'no-store'
    data = response.get_json()
    assert data['transfers']['items'][0]['id'] == record.transfer_id
    assert data['transfers']['items'][0]['username'] == 'targetuser'
    assert data['transfers']['total'] == 1
    assert all(value not in response.get_data(as_text=True) for value in (token, 'secret-source', '/private/path'))
    assert manager.admin_details(limit=0)['items'] == []
    assert manager.admin_details(limit=0)['total'] == 1


def test_transfer_admin_cancel_requires_exact_one_use_step_up(app, client, monkeypatch):
    from app import operations
    from app.transfer_manager import TransferManager, TransferState
    from tests.test_admin_routes import _prepare_role
    from tests.step_up_helpers import password_step_up_headers
    from tests.test_transfer_manager import make_quota_manager

    owner = _prepare_role(app, client, 'admin')
    manager = TransferManager(quota_manager=make_quota_manager())
    record = manager.create(str(owner), 'sftp-session:one', 'download', {})
    other = manager.create(str(owner), 'sftp-session:two', 'download', {})
    manager.consume_token(record.token, str(owner))
    monkeypatch.setattr(operations, 'transfer_manager', manager)
    path = f'/admin/api/operations/transfers/{record.transfer_id}/cancel'
    assert client.post(path).status_code == 403
    assert record.state is TransferState.RUNNING
    headers, _ = password_step_up_headers(client, 'operations.transfer.cancel', other.transfer_id)
    assert client.post(path, headers=headers).status_code == 403
    headers, _ = password_step_up_headers(client, 'operations.transfer.cancel', record.transfer_id)
    response = client.post(path, headers=headers)
    assert response.status_code == 200
    assert response.get_json()['state'] == 'cancelling'
    assert record.state is TransferState.CANCELLING
    assert record.cancel_event.is_set()
    assert other.state is TransferState.PENDING
    assert client.post(path, headers=headers).status_code == 403


def test_disconnect_targets_exact_browser_and_audits_without_socket_secret(app, client, monkeypatch):
    from app import operations, socket_events
    from app.models import SocketSession, db
    from app.socket_capacity import SocketCapacityRegistry
    from tests.test_admin_routes import _prepare_role
    from tests.step_up_helpers import password_step_up_headers

    owner = _prepare_role(app, client, 'admin')
    capacity = SocketCapacityRegistry()
    sid = 'private-live-socket'
    capacity.reserve(owner, sid, 10, 10)
    monkeypatch.setattr(operations, 'socket_capacity', capacity)
    with app.app_context():
        db.session.add(SocketSession(user_id=owner, socket_sid=sid))
        db.session.commit()
    data = client.get('/admin/api/operations/details').get_json()
    ref = data['connections']['items'][0]['id']
    assert sid not in str(data)
    assert len(ref) == 64
    calls, audits = [], []
    monkeypatch.setattr(socket_events, 'disconnect_socket_transport', lambda server, target: calls.append(target) or True)
    monkeypatch.setattr(operations, 'log_security_event', lambda event, **fields: audits.append((event, fields)))
    path = f'/admin/api/operations/connections/{ref}/disconnect'
    assert client.post(path).status_code == 403
    headers, _ = password_step_up_headers(client, 'operations.connection.disconnect', ref)
    assert client.post(path, headers=headers).status_code == 200
    assert calls == [sid]
    assert audits[0][0] == 'ADMIN_CONNECTION_DISCONNECT'
    assert sid not in str(audits)
    capacity.release(sid)
    headers, _ = password_step_up_headers(client, 'operations.connection.disconnect', ref)
    assert client.post(path, headers=headers).status_code == 404
    assert calls == [sid]


@pytest.mark.parametrize('path', [
    '/admin/api/operations/details',
    '/admin/api/operations/connections/unknown/disconnect',
    '/admin/api/operations/transfers/unknown/cancel',
])
@pytest.mark.parametrize('role', ['anonymous', 'normal', 'locked'])
def test_operations_controls_reject_non_admin(app, client, path, role):
    from tests.test_admin_routes import _prepare_role
    _prepare_role(app, client, role)
    response = client.get(path) if path.endswith('details') else client.post(path)
    assert response.status_code in (302, 401, 403)


def test_runtime_details_never_expose_arbitrary_job_names():
    runtime = RuntimeLifecycle(1)
    release = threading.Event()
    try:
        runtime.start_job('private-host:/secret/key', lambda cancel: release.wait(5))
        result = runtime.admin_details(limit=1)
        assert result['total'] == 1
        assert result['items'][0]['kind'] == 'other'
        assert result['items'][0]['age_seconds'] >= 0
        assert 'private' not in str(result)
    finally:
        release.set()
        runtime.begin_shutdown(2)


def test_operations_mutations_require_csrf_even_with_valid_grant(app, client):
    from tests.test_admin_routes import _prepare_role
    from tests.step_up_helpers import password_step_up_headers
    _prepare_role(app, client, 'admin')
    headers, _ = password_step_up_headers(client, 'operations.transfer.cancel', 'unknown')
    app.config['WTF_CSRF_ENABLED'] = True
    response = client.post('/admin/api/operations/transfers/unknown/cancel', headers=headers)
    assert response.status_code == 400


def test_admin_transfer_cancel_does_not_release_running_io_early():
    from app.transfer_manager import TransferManager
    from tests.test_transfer_manager import make_quota_manager
    manager = TransferManager(quota_manager=make_quota_manager())
    pending = manager.create('42', 'sftp-session:a', 'upload', {})
    running = manager.create('42', 'sftp-session:b', 'download', {})
    manager.consume_token(running.token, '42')
    assert manager.cancel_for_admin(pending.transfer_id).state == 'cancelled'
    assert manager.cancel_for_admin(running.transfer_id).state == 'cancelling'
    assert not running.request_done_event.is_set()
    assert manager.cancel_for_admin(running.transfer_id).state == 'cancelling'
    manager.finish_cancelled(running.transfer_id, '42')
    # The HTTP request owns completion signalling, including its final cleanup.
    assert not running.request_done_event.is_set()
    assert running.state.value == 'cancelled'
    assert manager.cancel_for_admin(running.transfer_id).state == 'unavailable'


def test_transfer_action_failure_is_sanitized_and_audited(app, client, monkeypatch):
    from app import operations
    from tests.test_admin_routes import _prepare_role
    from tests.step_up_helpers import password_step_up_headers
    _prepare_role(app, client, 'admin')
    def fail(_transfer_id):
        raise RuntimeError('private host and secret path')
    monkeypatch.setattr(operations.transfer_manager, 'cancel_for_admin', fail)
    events = []
    monkeypatch.setattr(operations, 'log_security_event', lambda event, **fields: events.append((event, fields)))
    headers, _ = password_step_up_headers(client, 'operations.transfer.cancel', 'target')
    response = client.post('/admin/api/operations/transfers/target/cancel', headers=headers)
    assert response.status_code == 503
    assert response.get_json()['code'] == 'action_unconfirmed'
    assert 'private' not in response.get_data(as_text=True)
    assert 'private' not in str(events)
    assert events[0][0] == 'ADMIN_TRANSFER_CANCEL_FAILED'


def test_operations_counts_live_ssh_independently_of_browser_and_stale_database(app, client, monkeypatch):
    from app import ssh_manager
    from app.models import SSHSession, db
    from tests.test_admin_routes import _prepare_role

    owner = _prepare_role(app, client, 'admin')
    monkeypatch.setattr(ssh_manager, 'sessions', {
        'live-ssh': {'user_id': owner, 'connected': True, 'host': 'edge.example',
                     'port': 22, 'username': 'ops', 'use_tmux': True,
                     'output_buffer': ['secret-terminal-content'], 'client': object()},
        'closed-ssh': {'user_id': owner, 'connected': False},
    })
    with app.app_context():
        db.session.add(SSHSession(session_id='stale-db', user_id=owner,
                                  host='stale.example', port=22, username='ops', connected=True))
        db.session.commit()
    data = client.get('/admin/api/operations').get_json()
    assert data['sockets']['active'] == 0
    assert data['sessions'] == {'active': 1, 'users': 1, 'tmux': 1}
    details = client.get('/admin/api/operations/details').get_json()['sessions']
    assert details['total'] == 1
    row = details['items'][0]
    assert row['username'] == 'targetuser'
    assert row['target'] == 'ops@edge.example:22'
    assert row['tmux'] is True
    assert 'secret-terminal-content' not in str(details)
    assert 'stale.example' not in str(details)
    assert 'live-ssh' not in str(details)
    ssh_manager.sessions.clear()
    assert client.get('/admin/api/operations').get_json()['sessions']['active'] == 0


def test_operations_session_details_limit_does_not_truncate_totals(app, client, monkeypatch):
    from app import ssh_manager
    from tests.test_admin_routes import _prepare_role

    owner = _prepare_role(app, client, 'admin')
    monkeypatch.setattr(ssh_manager, 'sessions', {
        f'session-{number}': {'user_id': owner, 'connected': True, 'host': 'edge.example',
                             'port': 22, 'username': 'ops', 'use_tmux': False}
        for number in range(205)
    })
    details = client.get('/admin/api/operations/details').get_json()['sessions']
    assert details['total'] == 205
    assert len(details['items']) == 200
    assert client.get('/admin/api/operations').get_json()['sessions']['active'] == 205
