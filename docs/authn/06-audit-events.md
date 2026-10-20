# Audit events

Every authentication fact (a login, a failed code, a throttle refusal, an impersonation) becomes an `AuthnEvent`. `AuthnAudit` hands each event to every registered `AuthnEventSink`. Subscribe by registering a sink; there is no other event bus.

## How it works

1. A core service (`DefaultAuthnService`, `AuthnImpersonationService`, `AccountLinkService`) or another authn package (`authn-local`, `authn-token`, `authn-keys`, `authn-totp`) injects `AuthnAudit` and calls `publish(event)`, or `publishIn(ctx, body)`, which stamps `at`, `ip` and `userAgent` from the `AuthnContext`. Every emitter goes through `AuthnAudit`; `@spinajs/authn/audit` exports it without registering anything.
2. `AuthnAudit` makes one deep-frozen copy of the event (`frozenCopy`).
3. It delivers the copy to every sink concurrently, each call bounded by `authn.audit.sinkTimeoutMs`.
4. A sink that throws or times out is logged on the `authn-audit` log by its class name and the event type, never with the error message or event values. `publish` never rejects because of a sink.
5. `publish` resolves when every sink has settled or timed out. A login waits for the slowest sink, not for the sum.

The sinks are every `AuthnEventSink` registered in the container and its ancestors (`Array.chainOf`), resolved when `AuthnAudit` boots. With no sink, boot logs a warning.

A sink failure after a state change (a stored token, a confirmed TOTP enrolment) never fails the request. `AuthnAudit.over(sinks, { sinkTimeoutMs, log })` gives the same delivery over explicit sinks, for services built with `new` in tests: the `sinks` deps of `authn-local` and `authn-totp`, the `audit` dep of `DefaultKeyRegistry`, the constructor argument of `DbTokenService`.

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
| Tokens and keys | `token.create`, `token.use`, `token.revoke`, `key.register`, `key.use`, `key.revoke` |
| Identity links | `identity.link`, `identity.unlink` |
| Impersonation | `impersonation.start`, `impersonation.end`, `impersonation.expire` |

The reasons the core writes are listed in [Authentication flow](01-authentication-flow.md#results-and-failure-reasons).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.audit.sinkTimeoutMs` | `integer` | `2000` | 1 to 60000 | How long one sink may take per event |
| `authn.audit.hashIdentifiers` | `boolean` | `true` | `true`, `false` | `LogAuthnAuditSink` writes identifiers as keyed hashes. Only `false` writes them raw |
| `authn.audit.hashKey.secret` | `string \| null` | unset | At least 32 characters | HMAC key of `LogAuthnAuditSink` and of `DbAuthnThrottle`. Unset: a random key per process, which `DbAuthnThrottle` refuses outside development and test |

```ts
authn: {
  audit: { hashIdentifiers: true, sinkTimeoutMs: 2000, hashKey: { secret: '<32+ characters, from a secret reference>' } },
}
```

An unknown key under `authn.audit` fails the boot.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthnEventSink` | `AuthnEventSink`, every registration of the lineage | `LogAuthnAuditSink`, per child container | `DbAuthnAuditSink` ([authn-orm](../authn-orm/README.md)), `QueueAuthnEventSink` and `UserAccountSink` ([users](../users/README.md)), `SseSessionEndSink` (`@spinajs/authz-http`) | Add one with `@Injectable(AuthnEventSink)` |
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

- Every sink gets every event. There is no sampling: each `token.use` and `key.use` success is published too.
- Sinks run concurrently. No sink may rely on another sink having run first.
- All sinks get the same deep-frozen copy, so a sink cannot change what another sees or what the caller holds.
- A sink failure never fails a login.
- A child container that registers its own sink keeps its ancestors' sinks.

## Best practices

- Keep a sink fast or hand the event to a queue: the login waits up to `sinkTimeoutMs` for it.
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
