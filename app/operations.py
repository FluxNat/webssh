"""Administrator process diagnostics and narrowly scoped runtime actions."""

import hashlib

from flask import Blueprint, current_app, jsonify
from flask_login import current_user, login_required

import config
from .decorators import admin_required, step_up_required
from .audit_logger import log_security_event
from .maintenance_mode import is_active
from .models import SSHSession, SocketSession, User, db
from . import ssh_manager
from .ssh_manager import admin_session_snapshot
from .socket_capacity import socket_capacity
from .transfer_routes import transfer_manager


operations_blueprint = Blueprint('operations', __name__)


@operations_blueprint.after_request
def no_store(response):
    response.headers['Cache-Control'] = 'no-store'
    return response


def _connection_ref(sid):
    return hashlib.sha256(('admin-connection:' + sid).encode('utf-8')).hexdigest()


def _session_ref(session_id):
    return hashlib.sha256(('admin-ssh:' + session_id).encode('utf-8')).hexdigest()


def _connections():
    sids = socket_capacity.sids()
    if not sids:
        return []
    return db.session.query(SocketSession, User.username).join(
        User, User.id == SocketSession.user_id,
    ).filter(SocketSession.socket_sid.in_(sids)).order_by(SocketSession.created_at).all()


def _ssh_sessions():
    summary, items = admin_session_snapshot()
    owner_ids = {item['user_id'] for item in items if item['user_id'] is not None}
    owners = dict(db.session.query(User.id, User.username).filter(User.id.in_(owner_ids)).all())
    ids = [item['session_id'] for item in items]
    dates = dict(db.session.query(SSHSession.session_id, SSHSession.created_at).filter(
        SSHSession.session_id.in_(ids),
    ).all())
    result = []
    for item in items:
        session_id = item['session_id']
        created = dates.get(session_id)
        result.append({
            'target': item['target'],
            'tmux': item['tmux'],
            'id': _session_ref(session_id),
            'username': owners.get(item['user_id']),
            'created_at': created.isoformat() + 'Z' if created else None,
        })
    return {'total': summary['active'], 'items': result}


@operations_blueprint.get('/admin/api/operations/details')
@admin_required
@login_required
def operations_details():
    rows = _connections()
    connections = {'total': len(rows), 'items': [{
        'id': _connection_ref(row.socket_sid),
        'username': username,
        'created_at': row.created_at.isoformat() + 'Z' if row.created_at else None,
    } for row, username in rows[:200]]}
    transfers = transfer_manager.admin_details()
    owner_ids = {int(item['user_id']) for item in transfers['items'] if str(item['user_id']).isdigit()}
    owners = dict(db.session.query(User.id, User.username).filter(User.id.in_(owner_ids)).all())
    for item in transfers['items']:
        owner_id = item.pop('user_id')
        item['username'] = owners.get(int(owner_id)) if str(owner_id).isdigit() else None
    return jsonify({
        'connections': connections,
        'sessions': _ssh_sessions(),
        'transfers': transfers,
        'jobs': current_app.extensions['runtime_lifecycle'].admin_details(),
    })


@operations_blueprint.post('/admin/api/operations/connections/<connection_ref>/disconnect')
@admin_required
@login_required
@step_up_required('operations.connection.disconnect', lambda connection_ref: connection_ref)
def disconnect_connection(connection_ref):
    from . import socketio
    from .socket_events import disconnect_socket_transport

    match = next((row for row, _username in _connections() if _connection_ref(row.socket_sid) == connection_ref), None)
    if match is None:
        return jsonify({'code': 'unavailable', 'error': 'Connection is no longer active'}), 404
    try:
        disconnected = disconnect_socket_transport(socketio.server, match.socket_sid)
    except Exception as error:
        log_security_event('ADMIN_CONNECTION_DISCONNECT_FAILED', admin_id=current_user.id,
                           target_user_id=match.user_id, error_type=type(error).__name__)
        return jsonify({'code': 'action_unconfirmed', 'error': 'Could not confirm disconnection'}), 503
    log_security_event('ADMIN_CONNECTION_DISCONNECT', admin_id=current_user.id,
                       target_user_id=match.user_id, connection_ref=connection_ref,
                       outcome='disconnected' if disconnected else 'unavailable')
    return jsonify({'state': 'disconnected' if disconnected else 'unavailable'})


@operations_blueprint.post('/admin/api/operations/sessions/<session_ref>/disconnect')
@admin_required
@login_required
@step_up_required('operations.session.disconnect', lambda session_ref: session_ref)
def disconnect_ssh_session(session_ref):
    from . import socketio

    _, sessions = admin_session_snapshot()
    match = next((item for item in sessions if _session_ref(item['session_id']) == session_ref), None)
    if match is None or match['user_id'] is None:
        return jsonify({'code': 'unavailable', 'error': 'Session is no longer active'}), 404
    try:
        # Detach tmux; an administrator must not terminate remote tmux workloads.
        def notify_owner():
            socketio.emit('ssh_disconnected', {
                'session_id': match['session_id'],
                'reason': 'Administrator disconnected SSH connection',
            }, room=f"user_{match['user_id']}")

        if not ssh_manager.close_session(match['session_id'], kill_tmux=False, on_disconnect=notify_owner):
            raise RuntimeError('Disconnection could not be confirmed')
        SSHSession.query.filter_by(session_id=match['session_id'], user_id=match['user_id']).update(
            {'connected': False}, synchronize_session=False,
        )
        db.session.commit()
    except Exception as error:
        db.session.rollback()
        log_security_event('ADMIN_SSH_DISCONNECT_FAILED', admin_id=current_user.id,
                           target_user_id=match['user_id'], session_ref=session_ref,
                           error_type=type(error).__name__)
        return jsonify({'code': 'action_unconfirmed', 'error': 'Could not confirm disconnection'}), 503
    log_security_event('ADMIN_SSH_DISCONNECT', admin_id=current_user.id,
                       target_user_id=match['user_id'], session_ref=session_ref)
    return jsonify({'state': 'disconnected'})


@operations_blueprint.post('/admin/api/operations/transfers/<transfer_id>/cancel')
@admin_required
@login_required
@step_up_required('operations.transfer.cancel', lambda transfer_id: transfer_id)
def cancel_transfer(transfer_id):
    try:
        result = transfer_manager.cancel_for_admin(transfer_id)
    except Exception as error:
        log_security_event('ADMIN_TRANSFER_CANCEL_FAILED', admin_id=current_user.id,
                           transfer_id=transfer_id, error_type=type(error).__name__)
        return jsonify({'code': 'action_unconfirmed', 'error': 'Could not confirm cancellation'}), 503
    log_security_event('ADMIN_TRANSFER_CANCEL', admin_id=current_user.id,
                       transfer_id=transfer_id, outcome=result.state)
    return jsonify({'accepted': result.accepted, 'state': result.state}), (404 if result.state == 'unavailable' else 200)


@operations_blueprint.get('/admin/api/operations')
@admin_required
@login_required
def operations_status():
    capacity = current_app.extensions['engineio_socket_capacity']
    sockets = capacity.snapshot()
    sockets.update({
        'limit': config.MAX_SOCKET_CONNECTIONS,
        'per_user_limit': config.MAX_SOCKET_CONNECTIONS_PER_USER,
        'http_reserve': config.GUNICORN_THREADS - config.MAX_SOCKET_CONNECTIONS,
    })
    response = jsonify({
        'sockets': sockets,
        'sessions': admin_session_snapshot(limit=0)[0],
        'jobs': current_app.extensions['runtime_lifecycle'].snapshot(),
        'transfers': transfer_manager.snapshot(),
        'maintenance': is_active(),
    })
    response.headers['Cache-Control'] = 'no-store'
    return response
