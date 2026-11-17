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
  then `audit().trail('logins').of({ type: 'user', id })`. The identity is the event's subject only on a trail that
  leaves it alone: the subject column cannot be masked, so a trail with an `omit`, `mask` or `hash` path that reaches
  `data.identity` (`data.identity`, `data.identity.id`, `data.*`) records no subject, and such an event carries
  `data.subjectOmitted: true`, as does one whose identity is too wide for the column. `trail.of(...)` does not find it.
- A trail with `onFailure: 'reject'` makes the recorder a blocking listener: a login, or any other authentication
  success, whose event cannot be written after the trail's retries fails with HTTP 503 (`AuthnListenerFailed`), and a
  session it had just issued is revoked. Failed attempts and the per-request use of a token or a key are recorded but
  never stopped. The default trails continue and never block. A rejecting trail makes its store a dependency of every
  login.
- Every write on a rejecting trail must fit in `authn.audit.listenerTimeoutMs` (default 2000 ms), retries included:
  with the default `retry` (3 tries, 100 ms apart) the waits cost 200 ms, so each try may take about 600 ms. A trail
  whose retries add up to more than the timeout is refused by the timeout first, and the login with it.
- The listener is blocking exactly when its trail's `onFailure` is `reject`. A trail configuration it cannot read
  (an unknown trail, a store that is not registered) fails the boot in `ready()`; one that breaks after the boot makes
  every authentication success answer 503: the recorder fails closed.
- After `authn.audit.listenerTimeoutMs` the login is refused, but the write it gave up on keeps going in the audit
  core, with its retries. A refused login may therefore show in the trail both as its success and as its `listener_failed`
  failure: pair them by time and identity.
- On a rejecting trail each `token.use` and `key.use` is one confirmed write per API request. It is detached, so the
  request does not wait, but during an outage each one logs a warning.
