"""Read-only, administrator-only process capacity overview."""

from flask import Blueprint, current_app, jsonify
from flask_login import login_required

import config
from .decorators import admin_required
from .maintenance_mode import is_active
from .transfer_routes import transfer_manager


operations_blueprint = Blueprint('operations', __name__)


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
        'jobs': current_app.extensions['runtime_lifecycle'].snapshot(),
        'transfers': transfer_manager.snapshot(),
        'maintenance': is_active(),
    })
    response.headers['Cache-Control'] = 'no-store'
    return response
