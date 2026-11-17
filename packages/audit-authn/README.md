# `@spinajs/audit-authn`

Records the authentication events of `@spinajs/authn` in the audit trail (`@spinajs/audit`). Importing the package
registers `AuthnAuditRecorder`, an `AuthnEventListener`; `@spinajs/authn` itself records nothing and depends on no
audit package.

- Each `AuthnEvent` becomes a `security` event: `action` is the event type, `outcome` `ok` or `failed`, and `data`
  holds `identity`, `actor` (the impersonator or acting admin), `strategy`, `reason`, `session`, `ip`, `userAgent`
  and `detail`.
- `audit.authn.trail` names the trail; unset, it is the built-in `security` trail, which writes one line per event on
  the logger `audit.security` with every identifier as a keyed hash (`audit.hashKey.secret`).
- For a login history that can be queried, point it at a table trail:
  `audit: { trails: { logins: { store: 'TableAuditStore', table: 'audit_logins', retentionDays: 365 } }, authn: { trail: 'logins' } }`,
  then `audit().trail('logins').of({ type: 'user', id })`. The identity is the event's subject on a trail that does
  not hash `data.identity`.
- A trail with `onFailure: 'reject'` makes the recorder a blocking listener: a login, or any other authentication
  success, whose event cannot be written after the trail's retries fails with HTTP 503 (`AuthnListenerFailed`), and a
  session it had just issued is revoked. Failed attempts and the per-request use of a token or a key are recorded but
  never stopped. The default trails continue and never block. A rejecting trail makes its store a dependency of every
  login.
- Every write on a rejecting trail must fit in `authn.audit.listenerTimeoutMs` (default 2000 ms), retries included:
  with the default `retry` (3 tries, 100 ms apart) the waits cost 200 ms, so each try may take about 600 ms. A trail
  whose retries add up to more than the timeout is refused by the timeout first, and the login with it.
