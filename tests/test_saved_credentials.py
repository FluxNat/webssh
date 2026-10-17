"""Opt-in encrypted SSH passwords for saved connections."""
import json
import threading
import time

import pytest


pytestmark = pytest.mark.usefixtures('direct_socket_authentication')


def create_socket_user(app, username):
    from app.auth import register_socket_session, register_user
    from app.models import db

    with app.app_context():
        user, error = register_user(username, 'socket-password-123')
        assert error is None
        register_socket_session(user.id, f'{username}-socket')
        db.session.commit()
        return user.id, f'{username}-socket'


def call_socket_handler(app, monkeypatch, handler, sid, payload=None):
    from flask import request
    import app.socket_events as socket_events

    emitted = []
    monkeypatch.setattr(
        socket_events,
        'emit',
        lambda event, data=None, **kwargs: emitted.append((event, data)),
    )
    with app.test_request_context('/socket.io'):
        request.sid = sid
        acknowledgement = handler() if payload is None else handler(payload)
    return acknowledgement, emitted


def password_profile(**overrides):
    return {
        'name': 'Production',
        'host': 'example.com',
        'port': 22,
        'username': 'deploy',
        'auth_type': 'password',
        **overrides,
    }


def wait_for(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def test_password_is_encrypted_and_bound_to_its_destination(app):
    from app import profile_manager, saved_credentials

    user_id, _sid = create_socket_user(app, 'vault_binding')
    with app.app_context():
        profile, error = profile_manager.upsert_profile(user_id, password_profile())
        assert error is None

        stored, error = saved_credentials.store_password(
            user_id, profile, 'correct horse battery staple',
        )
        assert (stored, error) == (True, None)

        raw = (
            profile_manager.get_user_profiles_file(user_id).parent
            / 'saved_credentials.json'
        ).read_text(encoding='utf-8')
        assert 'correct horse battery staple' not in raw
        assert 'correct horse battery staple' not in json.dumps(
            profile_manager.load_profiles(user_id)
        )

        assert saved_credentials.resolve_password(
            user_id, profile, 'EXAMPLE.com.', 22, 'deploy',
        ) == 'correct horse battery staple'
        for host, port, username in (
            ('attacker.example', 22, 'deploy'),
            ('example.com', 2222, 'deploy'),
            ('example.com', 22, 'root'),
        ):
            assert saved_credentials.resolve_password(
                user_id, profile, host, port, username,
            ) is None

        moved = {**profile, 'host': 'other.example'}
        assert saved_credentials.has_saved_password(user_id, moved) is False
        assert saved_credentials.resolve_password(
            user_id, moved, 'other.example', 22, 'deploy',
        ) is None


def test_passwords_are_isolated_between_users(app):
    from app import profile_manager, saved_credentials

    owner_id, _sid = create_socket_user(app, 'vault_owner')
    other_id, _other_sid = create_socket_user(app, 'vault_other')
    with app.app_context():
        profile, _error = profile_manager.upsert_profile(owner_id, password_profile())
        saved_credentials.store_password(owner_id, profile, 'owner-secret')

        assert saved_credentials.resolve_password(
            other_id, profile, 'example.com', 22, 'deploy',
        ) is None


def test_save_profile_remembers_and_forgets_password(app, monkeypatch):
    import app.socket_events as socket_events

    _user_id, sid = create_socket_user(app, 'vault_socket_save')
    saved, emitted = call_socket_handler(
        app, monkeypatch, socket_events.handle_save_profile, sid,
        password_profile(remember_password=True, password='s3cret'),
    )
    assert saved['success'] is True
    assert saved['profile']['has_saved_password'] is True
    assert 'password' not in saved['profile']
    assert all('s3cret' not in json.dumps(data) for _event, data in emitted)

    profile_id = saved['profile']['id']
    _listed, emitted = call_socket_handler(
        app, monkeypatch, socket_events.handle_list_profiles, sid,
    )
    listed = next(data for event, data in emitted if event == 'profiles_list')
    assert listed['profiles'][0]['has_saved_password'] is True

    kept, _emitted = call_socket_handler(
        app, monkeypatch, socket_events.handle_save_profile, sid,
        password_profile(id=profile_id, name='Renamed'),
    )
    assert kept['profile']['has_saved_password'] is True

    moved, _emitted = call_socket_handler(
        app, monkeypatch, socket_events.handle_save_profile, sid,
        password_profile(id=profile_id, host='moved.example'),
    )
    assert 'has_saved_password' not in moved['profile']

    call_socket_handler(
        app, monkeypatch, socket_events.handle_save_profile, sid,
        password_profile(
            id=profile_id, host='moved.example',
            remember_password=True, password='again',
        ),
    )
    forgotten, _emitted = call_socket_handler(
        app, monkeypatch, socket_events.handle_save_profile, sid,
        password_profile(
            id=profile_id, host='moved.example', remember_password=False,
        ),
    )
    assert 'has_saved_password' not in forgotten['profile']


def test_new_profile_requires_password_to_remember(app, monkeypatch):
    import app.socket_events as socket_events

    _user_id, sid = create_socket_user(app, 'vault_requires_password')
    result, _emitted = call_socket_handler(
        app, monkeypatch, socket_events.handle_save_profile, sid,
        password_profile(remember_password=True, password=''),
    )
    assert result == {'success': False, 'error': 'Password required'}


def test_deleting_profile_deletes_password(app, monkeypatch):
    import app.socket_events as socket_events
    from app import saved_credentials

    user_id, sid = create_socket_user(app, 'vault_delete')
    saved, _emitted = call_socket_handler(
        app, monkeypatch, socket_events.handle_save_profile, sid,
        password_profile(remember_password=True, password='s3cret'),
    )
    profile = saved['profile']
    call_socket_handler(
        app, monkeypatch, socket_events.handle_delete_profile, sid,
        {'profile_id': profile['id']},
    )
    with app.app_context():
        assert saved_credentials.delete_password(user_id, profile['id']) is False


def _connect(app, monkeypatch, sid, payload, create):
    from flask import request
    from app import ssh_manager
    import app.socket_events as socket_events

    emitted = []
    monkeypatch.setattr(
        socket_events,
        'emit',
        lambda event, data=None, **kwargs: emitted.append((event, data)),
    )
    monkeypatch.setattr(
        socket_events,
        '_validate_ssh_params',
        lambda host, port, username, **_kwargs: (
            host, int(port), username, None
        ),
    )
    monkeypatch.setattr(ssh_manager, 'create_ssh_connection', create)
    with app.test_request_context('/socket.io'):
        request.sid = sid
        socket_events.handle_ssh_connect(payload)
    return emitted


def test_connect_uses_saved_password_only_for_saved_destination(app, monkeypatch):
    import app.socket_events as socket_events

    _user_id, sid = create_socket_user(app, 'vault_connect')
    saved, _emitted = call_socket_handler(
        app, monkeypatch, socket_events.handle_save_profile, sid,
        password_profile(remember_password=True, password='s3cret'),
    )
    profile_id = saved['profile']['id']
    passwords = []
    attempted = threading.Event()

    def record(**kwargs):
        passwords.append(kwargs['password'])
        attempted.set()
        return None, 'Authentication failed'

    _connect(app, monkeypatch, sid, {
        'host': 'example.com', 'port': 22, 'username': 'deploy',
        'auth_type': 'password', 'profile_id': profile_id,
        'use_saved_password': True, 'client_request_id': 'saved-ok',
    }, record)
    assert attempted.wait(3)
    assert passwords == ['s3cret']

    emitted = _connect(app, monkeypatch, sid, {
        'host': 'attacker.example', 'port': 22, 'username': 'deploy',
        'auth_type': 'password', 'profile_id': profile_id,
        'use_saved_password': True, 'client_request_id': 'saved-redirect',
    }, record)
    errors = [data for event, data in emitted if event == 'ssh_error']
    assert errors[0]['code'] == 'saved_password_unavailable'
    assert passwords == ['s3cret']


def test_connect_remembers_password_after_successful_login(app, monkeypatch):
    from app import profile_manager, saved_credentials, ssh_manager
    import app.socket_events as socket_events

    user_id, sid = create_socket_user(app, 'vault_remember')
    with app.app_context():
        profile, _error = profile_manager.upsert_profile(user_id, password_profile())
    monkeypatch.setattr(
        ssh_manager, 'get_session', lambda _session_id: {'use_tmux': False},
    )

    emitted = _connect(app, monkeypatch, sid, {
        'host': 'example.com', 'port': 22, 'username': 'deploy',
        'auth_type': 'password', 'password': 'typed-secret',
        'profile_id': profile['id'], 'remember_password': True,
        'client_request_id': 'remember-ok',
    }, lambda **_kwargs: ('remember-session', None))

    assert wait_for(lambda: any(
        event == 'profile_password_saved' for event, _data in emitted
    ))
    saved_event = next(
        data for event, data in emitted if event == 'profile_password_saved'
    )
    assert saved_event == {
        'profile_id': profile['id'], 'success': True, 'error': None,
    }
    with app.app_context():
        assert saved_credentials.resolve_password(
            user_id, profile, 'example.com', 22, 'deploy',
        ) == 'typed-secret'


def test_failed_login_does_not_remember_password(app, monkeypatch):
    from app import profile_manager, saved_credentials

    user_id, sid = create_socket_user(app, 'vault_failed_login')
    with app.app_context():
        profile, _error = profile_manager.upsert_profile(user_id, password_profile())
    attempted = threading.Event()

    def fail(**_kwargs):
        attempted.set()
        return None, 'Authentication failed'

    _connect(app, monkeypatch, sid, {
        'host': 'example.com', 'port': 22, 'username': 'deploy',
        'auth_type': 'password', 'password': 'wrong',
        'profile_id': profile['id'], 'remember_password': True,
        'client_request_id': 'remember-fail',
    }, fail)
    assert attempted.wait(3)
    time.sleep(0.1)
    with app.app_context():
        assert saved_credentials.has_saved_password(user_id, profile) is False
