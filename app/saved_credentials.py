"""Opt-in encrypted SSH passwords for saved connections.

A stored password belongs to one saved connection and is bound to the exact
destination (host, port and username) it was saved for. Editing a
connection's destination therefore never replays its password against a
different server, and deleting the connection deletes the password.

Ciphertext uses a per-user Fernet key derived from SECRET_KEY in a domain
separate from stored SSH keys. Plaintext never leaves the server: profile
responses only state whether a usable password exists.
"""

from datetime import datetime, timezone
import json

from cryptography.fernet import Fernet, InvalidToken

import config

from .audit_logger import log_error, log_warning
from .key_encryption import _derive_key
from .network_policy import canonicalize_hostname
from .storage_utils import atomic_write_bytes, load_json_strict, storage_lock


SCHEMA_VERSION = 1
MAX_PASSWORD_BYTES = 4096
_KEY_DOMAIN = 'saved-ssh-password-v1'
_ENTRY_FIELDS = {'ciphertext', 'host', 'port', 'username', 'updated_at'}


def _store_path(user_id):
    from .models import User, db

    user = db.session.get(User, user_id)
    if user is None:
        return None
    return user.get_data_dir() / 'saved_credentials.json'


def _fernet(user_id):
    return Fernet(_derive_key(config.SECRET_KEY, f'{user_id}:{_KEY_DOMAIN}'))


def _valid_entry(entry):
    return (
        isinstance(entry, dict)
        and set(entry) == _ENTRY_FIELDS
        and isinstance(entry['ciphertext'], str)
        and isinstance(entry['host'], str)
        and type(entry['port']) is int
        and isinstance(entry['username'], str)
        and isinstance(entry['updated_at'], str)
    )


def _valid_document(value):
    return (
        isinstance(value, dict)
        and value.get('schema_version') == SCHEMA_VERSION
        and isinstance(value.get('credentials'), dict)
        and all(
            isinstance(profile_id, str) and _valid_entry(entry)
            for profile_id, entry in value['credentials'].items()
        )
    )


def _empty_document():
    return {'schema_version': SCHEMA_VERSION, 'credentials': {}}


def _load_with_lock_held(user_id):
    path = _store_path(user_id)
    if path is None:
        return None, _empty_document()
    return path, load_json_strict(path, _empty_document, _valid_document)


def _save_with_lock_held(path, document):
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(
        path,
        json.dumps(document, indent=2).encode('utf-8'),
        mode=0o600,
    )


def _canonical_host(host):
    try:
        return canonicalize_hostname(host)
    except ValueError:
        return ''


def _destination(profile):
    try:
        port = int(profile.get('port') or 22)
    except (TypeError, ValueError):
        port = 0
    return (
        _canonical_host(profile.get('host')),
        port,
        str(profile.get('username') or ''),
    )


def _entry_matches(entry, profile):
    return (
        isinstance(profile, dict)
        and profile.get('auth_type') == 'password'
        and _destination(entry) != ('', 0, '')
        and _destination(entry) == _destination(profile)
    )


def matches_destination(profile, host, port, username):
    """Return whether a requested destination is the profile's destination."""
    requested = _destination({'host': host, 'port': port, 'username': username})
    return (
        isinstance(profile, dict)
        and requested[0] != ''
        and requested == _destination(profile)
    )


def validate_password(password):
    """Return an error for a password that cannot be stored."""
    if not isinstance(password, str) or not password:
        return 'Password required'
    if len(password.encode('utf-8', 'surrogatepass')) > MAX_PASSWORD_BYTES:
        return 'Password is too long to save'
    return None


def saved_profile_ids(user_id, profiles):
    """Return ids of profiles with a password bound to their destination."""
    if not any(
        isinstance(profile, dict) and profile.get('auth_type') == 'password'
        for profile in profiles
    ):
        return set()
    with storage_lock(f'saved-credentials:{user_id}'):
        _path, document = _load_with_lock_held(user_id)
    credentials = document['credentials']
    return {
        profile.get('id')
        for profile in profiles
        if isinstance(profile, dict)
        and profile.get('id') in credentials
        and _entry_matches(credentials[profile['id']], profile)
    }


def has_saved_password(user_id, profile):
    return bool(saved_profile_ids(user_id, [profile]))


def store_password(user_id, profile, password):
    """Encrypt and bind ``password`` to one saved password profile."""
    error = validate_password(password)
    if error:
        return False, error
    if not isinstance(profile, dict) or not isinstance(profile.get('id'), str):
        return False, 'Saved connection not found'
    if profile.get('auth_type') != 'password':
        return False, 'Only password connections can remember a password'
    host, port, username = _destination(profile)
    if not host or not username or not 1 <= port <= 65535:
        return False, 'Saved connection is incomplete'
    try:
        ciphertext = _fernet(user_id).encrypt(password.encode('utf-8'))
        with storage_lock(f'saved-credentials:{user_id}'):
            path, document = _load_with_lock_held(user_id)
            if path is None:
                return False, 'User not found'
            document['credentials'][profile['id']] = {
                'ciphertext': ciphertext.decode('ascii'),
                'host': host,
                'port': port,
                'username': username,
                'updated_at': datetime.now(timezone.utc).isoformat(),
            }
            _save_with_lock_held(path, document)
        return True, None
    except Exception as exc:
        log_error(
            'Failed to save connection password',
            user_id=user_id,
            error=type(exc).__name__,
        )
        return False, 'Failed to save password'


def delete_password(user_id, profile_id):
    """Forget the password of one saved connection, if any."""
    if not isinstance(profile_id, str):
        return False
    try:
        with storage_lock(f'saved-credentials:{user_id}'):
            path, document = _load_with_lock_held(user_id)
            if path is None or profile_id not in document['credentials']:
                return False
            del document['credentials'][profile_id]
            _save_with_lock_held(path, document)
        return True
    except Exception as exc:
        log_error(
            'Failed to delete connection password',
            user_id=user_id,
            error=type(exc).__name__,
        )
        return False


def resolve_password(user_id, profile, host, port, username):
    """Return the stored password only for the profile's exact destination.

    The requested destination must equal the saved connection's destination,
    which in turn must equal the destination the password was saved for.
    """
    if not isinstance(profile, dict) or not isinstance(profile.get('id'), str):
        return None
    if not matches_destination(profile, host, port, username):
        return None
    with storage_lock(f'saved-credentials:{user_id}'):
        _path, document = _load_with_lock_held(user_id)
    entry = document['credentials'].get(profile['id'])
    if entry is None or not _entry_matches(entry, profile):
        return None
    try:
        return _fernet(user_id).decrypt(
            entry['ciphertext'].encode('ascii')
        ).decode('utf-8')
    except (InvalidToken, UnicodeError, ValueError):
        # A rotated SECRET_KEY makes old ciphertext unreadable. The user is
        # asked for the password again instead of failing the connection.
        log_warning(
            'Saved connection password could not be decrypted',
            user_id=user_id,
        )
        return None
