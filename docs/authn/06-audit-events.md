# Audit events

Every authentication fact (a login, a failed code, a throttle refusal, an impersonation) becomes an `AuthnEvent`. `AuthnAudit` hands each event to every registered `AuthnEventSink`. Subscribe by registering a sink; there is no other event bus.

## How it works

1. A core service (`DefaultAuthnService`, `AuthnImpersonationService`, `AccountLinkService`) or another authn package (`authn-local`, `authn-token`, `authn-keys`, `authn-totp`) injects `AuthnAudit` and calls `publish(event)`, or `publishIn(ctx, body)`, which stamps `at`, `ip` and `userAgent` from the `AuthnContext`. Every emitter goes through `AuthnAudit`; `@spinajs/authn/audit` exports it without registering anything.
2. `AuthnAudit` makes one deep-frozen copy of the event (`frozenCopy`).
3. It delivers the copy to every sink concurrently, each call bounded by `authn.audit.listenerTimeoutMs`.
4. A sink that throws or times out is logged on the `authn-audit` log by its class name and the event type, never with the error message or event values. `publish` never rejects because of a sink, unless the sink is a [blocking listener](#blocking-listeners).
5. `publish` resolves when every sink has settled or timed out. A login waits for the slowest sink, not for the sum.

### Delivery modes

| Call | Returns | Used for |
| --- | --- | --- |
| `publish(event)`, `publishIn(ctx, body)` | A promise that resolves when every sink has settled or timed out | Every failure event, and every event of a login, an MFA step, a session or an admin action |
| `publishDetached(ctx, body)` | Nothing, at once | The success `token.use` and `key.use` events of `DefaultAuthnService` |

A detached delivery runs the same way: every sink gets the same frozen copy, each bounded by `listenerTimeoutMs`, and a failure or timeout is logged the same way. Only the caller does not wait, so a slow sink never adds latency to a request authenticated by a token or a key. A failed token or key use is still awaited: the request that failed waits for its audit event.

`settled()` resolves when every detached delivery started so far has settled or timed out. Tests await it before they read a sink; `AuthnAudit.dispose()` awaits it, so disposing the container on shutdown does not drop the events still in flight. An event still in flight when the process dies without that dispose is lost.

The sinks are every `AuthnEventSink` registered in the container and its ancestors (`Array.chainOf`), resolved when `AuthnAudit` boots. With no sink, boot logs a warning.

A sink failure after a state change (a stored token, a confirmed TOTP enrolment) never fails the request. `AuthnAudit.over(listeners, { listenerTimeoutMs, log })` gives the same delivery over explicit listeners, for services built with `new` in tests: the `sinks` deps of `authn-local` and `authn-totp`, the `audit` dep of `DefaultKeyRegistry`, the constructor argument of `DbTokenService`.

## Blocking listeners

A listener whose `blocking` getter answers `true` is one an operation must not go on without, such as a recorder whose trail must hold every login. `AuthnAudit` asks the getter on every event and applies these rules; no listener can change them:

1. Only an event with `outcome: 'success'` that is published with `publish` or `publishIn` can be stopped. It goes to the blocking listeners first, concurrently among themselves. When one of them throws or runs out of `authn.audit.listenerTimeoutMs`, the publish rejects with `AuthnListenerFailed` and no listener that is not blocking gets the event: no webhook and no queue event goes out for a login that did not stand. The other blocking listeners got it at the same time, so one of them may have recorded a success that was then refused. A `blocking` getter that throws counts as a blocking listener that failed.
2. When every blocking listener took the event, the other listeners get it as before: concurrently, each bounded by the timeout, failures logged.
3. An event with `outcome: 'failure'` is never stopped. A blocking listener still gets it, bounded and logged like any other, so a wrong password answers its 401 also while the listener's store is down.
4. A detached event (`publishDetached`) is never stopped: the operation that raised it has returned. A blocking listener gets it like any other.
5. The timeout is the one of every listener, and running out of it counts as a failure: a blocking listener that does not answer has not taken the event.

```ts
@Injectable(AuthnEventListener)
export class LedgerListener extends AuthnEventListener {
  public override get blocking(): boolean {
    return true;
  }

  public async on(e: AuthnEvent): Promise<void> {
    await ledger.append(e);
  }
}
```

`AuthnListenerFailed` is a `CodedHttpException` with status 503 and the code `authn_listener_failed`; `@spinajs/http` answers it as a problem document with that status. Its message, the document's `detail`, names neither the listener nor the event: `listener` and `eventType` are fields of the exception for the log, and what the listener threw stays in `inner`. The response carries none of them.

Where `DefaultAuthnService` announces a session it has just issued or elevated, a stopped announcement revokes that session before the failure goes on: the login (`login`, `session.issue`), the MFA challenge (the pending session), the MFA completion (`mfa.verify`, `login`) and the step-up (`mfa.verify`, `session.rotate`). No session cookie is set, because the login route sets it only from a result `authenticate` returned. A stopped step-up leaves the user with no session at all, since the reissue already moved the old one. When the revocation itself fails, it is logged on `authn-audit` and the 503 stands; no client holds that session, which lives until it expires.

An announcement of two events is published one event after the other, so the second can be stopped after every listener took the first as a success. Then each event up to the stopped one is published again with `outcome: 'failure'` and `reason: 'listener_failed'`: a listener that took `login` as a success learns that it did not stand, and the refusal is recorded.

`AuthnImpersonationService` revokes the session it issued when its `impersonation.start` or `impersonation.end` event is stopped, publishes that event again as a failure with `reason: 'listener_failed'`, and rejects with `AuthnListenerFailed` (503). The session it swapped out was revoked before the event, so a stopped start leaves the administrator logged out, and a stopped end leaves the impersonator with no session.

What can be stopped: every success event an emitter awaits through `publishIn` or `publish`. What cannot: the success `token.use` and `key.use` of a request authenticated by a token or a key, which `DefaultAuthnService` publishes detached, so such a request is never refused or delayed for its record. An emitter that must be stoppable uses `publishIn`.

Operations that do not issue a session are not undone. A password change, a token creation or a logout whose success event is stopped rejects with 503 after its effect is committed: the state has changed, and the record is missing, which is what the 503 reports. A stopped `token.create`, `mfa.enrol` or `key.register` also loses the one-time secret the client would have received: the token is stored and nobody holds it, the recovery codes are never shown. A stopped password change in `@spinajs/authn-local` has already rotated the session, so the rotated session stays alive, nobody holds it, and the user is logged out.

Latency: a login publishes two success events one after the other, so each blocking listener is awaited twice, and a listener that does not answer costs `authn.audit.listenerTimeoutMs` before the login is refused.

## The event

| Field | Meaning |
| --- | --- |
| `type` | One of the event types below |
| `at` | `ctx.now` of the call |
| `outcome` | `success` or `failure` |
| `identity` | The `IdentityRef` the event is about; the target of an impersonation |
| `actor` | Who acted: the impersonator |
| `strategy` | The strategy name |
| `reason` | The real failure or end reason. Audit only: HTTP answers one shape |
| `ip`, `userAgent` | From `AuthnContext` |
| `session` | The hashed session handle, never the raw id |
| `data` | Extra facts, such as `{ error: '<class name>' }` or `{ steps: [...] }` |

Events never carry passwords, tokens, codes, secrets or raw session ids.

Event types (`AuthnEventType`):

| Group | Types |
| --- | --- |
| Login | `login`, `logout`, `reauth`, `throttle.block` |
| MFA | `mfa.challenge`, `mfa.verify`, `mfa.enrol`, `mfa.disable` |
| Session | `session.issue`, `session.rotate`, `session.revoke`, `session.expire` |
| Password | `password.change`, `password.reset.request`, `password.reset`, `invite.redeem` |
| Tokens and keys | `token.create`, `token.use`, `token.revoke`, `token.rotate`, `token.update`, `key.register`, `key.use`, `key.revoke` |
| Identity links | `identity.link`, `identity.unlink` |
| Impersonation | `impersonation.start`, `impersonation.end`, `impersonation.expire` |
| Email codes | `code.request` |
| Refused by an action hook | `role.switch`, `request.refuse` |

The reasons the core writes are listed in [Authentication flow](01-authentication-flow.md#results-and-failure-reasons).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.audit.listenerTimeoutMs` | `integer` | `2000` | 1 to 60000 | How long one sink may take per event |
| `authn.audit.hashIdentifiers` | `boolean` | `true` | `true`, `false` | `LogAuthnAuditSink` writes identifiers as keyed hashes. Only `false` writes them raw |
| `authn.audit.hashKey.secret` | `string \| null` | unset | At least 32 characters | HMAC key of `LogAuthnAuditSink` and of `DbAuthnThrottle`. Unset: a random key per process, which `DbAuthnThrottle` refuses outside development and test |

```ts
authn: {
  audit: { hashIdentifiers: true, listenerTimeoutMs: 2000, hashKey: { secret: '<32+ characters, from a secret reference>' } },
}
```

An unknown key under `authn.audit` fails the boot.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthnEventSink` | `AuthnEventSink`, every registration of the lineage | `LogAuthnAuditSink`, per child container | `DbAuthnAuditSink` ([authn-orm](../authn-orm/README.md)), `QueueAuthnEventSink` ([users](../users/README.md)), `SseSessionEndSink` (`@spinajs/authz-http`) | Add one with `@Injectable(AuthnEventSink)` |
| `AuthnAudit` | Class token, per child container | `AuthnAudit` | None | Not meant to be replaced |

`LogAuthnAuditSink` writes one line per event on the `authn-audit` log, `info` for a success and `warn` for a failure. It never writes `data` or the user agent. It hashes `identity`, `actor`, `ip` and `session` with `authn.audit.hashKey.secret`. A value holding `@` may be an email: it is hashed even with `hashIdentifiers: false`, and a `type`, `strategy` or `reason` holding `@` is written as `?`.

`DbAuthnAuditSink` stores raw identity refs, IP and user agent in `authn_audit`; it does not hash. `QueueAuthnEventSink` re-emits the user queue events such as `UserLogged` and `UserLoginFailed`.

### AuthnEventSink: custom implementation

Forward failed logins and throttle refusals to a security monitoring system:

```ts sample
import { Injectable } from '@spinajs/di';
import { AuthnEventSink } from '@spinajs/authn';
import type { AuthnEvent } from '@spinajs/authn';

@Injectable(AuthnEventSink)
export class SecurityMonitorSink extends AuthnEventSink {
  async publish(e: AuthnEvent): Promise<void> {
    if (e.outcome !== 'failure' || (e.type !== 'login' && e.type !== 'throttle.block')) return;
    await fetch('https://siem.example.com/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: e.type, reason: e.reason, at: e.at.toISOString(), ip: e.ip, identity: e.identity }),
    });
  }
}
```

Import the module before the app boots: `AuthnAudit` lists the sinks when it resolves.

## Important behaviour

- Every sink gets every event. There is no sampling: each `token.use` and `key.use` success is published too, detached.
- A sink may see a detached `token.use` success after the response to its request has gone out.
- Sinks run concurrently. No sink may rely on another sink having run first.
- All sinks get the same deep-frozen copy, so a sink cannot change what another sees or what the caller holds.
- A sink failure never fails a login, unless the sink is a [blocking listener](#blocking-listeners).
- A child container that registers its own sink keeps its ancestors' sinks.

## Best practices

- Keep a sink fast or hand the event to a queue: the login waits up to `listenerTimeoutMs` for it. Token and key successes do not wait, but each one still holds a delivery open until the sink settles.
- In a test that reads a sink after a token or key success, `await audit.settled()` first.
- Set `authn.audit.hashKey.secret` in production, so hashed identifiers stay comparable across restarts and instances.
- Read `reason` only in sinks. Never send it to the client.

## Patterns and antipatterns

```ts
// Don't: a second in-process bus for authentication facts; two places decide delivery and failure
events.emit('user-logged-in', identity);

// Do: register an AuthnEventSink; AuthnAudit already delivers every event to it
@Injectable(AuthnEventSink)
class LoginCounter extends AuthnEventSink {
  async publish(e: AuthnEvent) { if (e.type === 'login' && e.outcome === 'success') metrics.increment('logins'); }
}
```

## Related

- [Authentication flow](01-authentication-flow.md): the events of a login.
- [`@spinajs/authn-orm`](../authn-orm/README.md): `DbAuthnAuditSink` and the `authn_audit` table.
- [`@spinajs/users`](../users/README.md): the sinks that re-emit authn events as user queue events.
