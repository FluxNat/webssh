# Administration, Audit, and Diagnostics

WebSSH's administration interface combines account lifecycle controls, runtime diagnostics, security auditing, host-key visibility, and native backup operations. Administrative access is necessary but is not a substitute for recent reauthentication on sensitive actions.

## Administrative responsibilities

Administrators can:

- create, enable, disable, and remove local accounts;
- assign or remove administrator privileges;
- inspect runtime and connection diagnostics;
- export security audit records and update retention settings;
- manage native backup and restore operations;
- review host-key state and security-relevant configuration;
- link or unlink supported external identities under the applicable safeguards.

Disabling or deleting a user revokes live activity, including Socket.IO, SSH, pooled connections, and transfers. Deletion first quarantines the user's data directory and rolls back that move if the database operation fails.

## Administrator step-up

Sensitive Admin mutations require a fresh authorization bound to the current
server-side authentication session, exact action, exact target, and required
authentication assurance. Local administrators without MFA confirm their
password. MFA-enabled administrators use an enrolled Passkey or authenticator
app (TOTP). LDAP-managed administrators revalidate against LDAP.

Recent sufficient OIDC assurance can be reused. Otherwise WebSSH starts
provider reauthentication with `prompt=login`, `max_age=0`, and the configured
`acr_values`. The resulting opaque grant expires after at most five minutes,
works once, and is never stored in browser local/session storage. A grant for
one user or action cannot authorize another target or operation.

## Security audit log

Security-relevant actions are written to `DATA_DIR/logs/security_audit.log`. Rotation uses `AUDIT_LOG_MAX_BYTES` and `AUDIT_LOG_BACKUP_COUNT`; defaults are 10 MiB and five backups.

Audit records are intended for investigation and accountability. They do not contain passwords, authentication tokens, private-key material, or file contents. Protect the log directory because event metadata can still reveal usernames, hosts, IP addresses, and administrative activity.

## Audit export

The administrator export endpoint applies server-side filtering and scans at most 50,000 records per request. If a result is incomplete, WebSSH marks it as truncated in metadata and response headers. Narrow the time range or filters instead of assuming a truncated export is complete.

Retention updates are authenticated administrator operations and are themselves auditable. Rotation and retention protect local disk capacity; forward logs to an external system if the threat model requires tamper-resistant or longer-term retention.

## Live diagnostics

### Instance status

Administrators can open **Settings Center > Instance status** to inspect a
snapshot of this WebSSH process and open its management controls. Use **Refresh** to fetch new values.
The page does not poll in the background. It shows browser socket occupancy and
limits, capacity rejection counters, running and queued background jobs, and
pending/running/cancelling HTTP file transfers. Notices identify maintenance,
shutdown, a full socket registry, or waiting background work.

Background counts include long-running maintenance tasks. A job with a
cancellation request still counts as running or waiting until it finishes.
The configured HTTP thread reserve is not a measurement of currently idle
threads. Capacity rejection counters count reservation attempts, not unique
users, and reset when the process restarts; authentication and network failures
are not included. Snapshot sections are individually locked, not one atomic
transaction across all managers.

`GET /admin/api/operations` requires the enabled admin panel and an authenticated
administrator. Responses use `Cache-Control: no-store` and contain aggregate
counts only, without session identifiers, hosts, paths, tokens, or task names.
A failed refresh clears the displayed counts and offers a retry. Existing
`/health` and `/ready` contracts are unchanged.

### Runtime controls

**Manage connections** lists authenticated browser connections by account,
connection reference and creation time. **Disconnect browser** targets exactly
that connection. It cleans up socket-owned transfers and temporary file sources;
persistent SSH/tmux sessions remain. It does not revoke the login or prevent the
user from connecting again. Use account locking when access must be revoked.
Transport reservations that have not completed authentication are included in the
aggregate occupancy, but are not actionable browser entries.

**Manage transfers** lists pending, running and cancelling HTTP transfers with
account, reference, direction and age. **Cancel transfer** uses the normal
cooperative cancellation path: pending transfers finish immediately, while a
running transfer remains **Cancelling** until its request releases its resources.
Cancellation does not roll back bytes already written to the destination.

Both actions require confirmation and recent, action- and target-bound
reauthentication, enforce CSRF protection, and record their outcome in the audit
log. After an uncertain response, refresh and check the current state before
retrying. An expired or completed target cannot affect a different connection or
transfer.

**View tasks** shows task categories, state and age. System tasks cannot be stopped
from this list; use the existing backup controls for backup operations. Capacity
settings are shown with configuration guidance and require a controlled restart.
Keep one Gunicorn worker and at least four HTTP threads outside the socket limit.

`GET /admin/api/operations/details` requires the same administrator access as the
aggregate endpoint. Each list returns at most 200 entries and reports its total.
It exposes account names and action references, but no raw socket IDs, transfer
tokens, remote hosts, file paths or arbitrary task names. Detail responses are not
cached. Refresh is manual; a failed detail refresh removes stale action rows.

### Session diagnostics

Diagnostics expose bounded information about:

- admitted Socket.IO connections;
- active SSH and quick connections;
- transfers and temporary storage;
- background executor activity;
- runtime shutdown or maintenance state;
- configured capacity limits.

Use diagnostics to compare demand with `GUNICORN_THREADS`, socket admission, SSH quotas, transfer quotas, and background workers. Avoid treating a single counter as the entire capacity picture.

## Host-key administration

Host-key trust is stored per user. First-use trust, changed-key rejection, and explicit revocation are covered in [SSH Connections and Host Keys](SSH-Connections-and-Host-Keys). Administrators should not globally bypass a user's trust decision to resolve a connection error.

## Operational health

- `GET /health` proves process liveness.
- `GET /ready` checks whether the instance can accept work.

Readiness fails during maintenance, shutdown admission closure, database failure, or a failed data-directory probe. Details are in [Health Checks and Troubleshooting](Health-Checks-and-Troubleshooting).

## Administration checklist

1. Keep at least one tested local administrator and recovery path.
2. Require HTTPS and a trusted reverse proxy for Internet exposure.
3. Review disabled accounts, linked identities, and host-key changes regularly.
4. Export or forward audit data according to the required retention period.
5. Test native backups and restores on a separate instance.
6. Monitor capacity and temporary disk usage before raising quotas.
7. Apply upgrades only after reviewing configuration changes and release notes.
