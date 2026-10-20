# Audit events

`LocalPasswordService` publishes an `AuthnEvent` for each step of change, set, reset, invite and expiry. Subscribe with an `AuthnEventSink` to alert on resets, keep an audit trail, or update account data. Login events come from the authn core, not from this package.

## How it works

1. A flow builds an event and `LocalPasswordService.audit(ctx, event)` stamps `at` (`ctx.now`), `ip` and `userAgent` from the context.
2. `publishAuthnEvent()` calls `publish(event)` on every registered `AuthnEventSink` (`Array.ofType`), one after the other, awaiting each.
3. A sink that throws is logged with its class name, the event type and the error name. The next sink still runs, and the flow goes on.

## Events

| Type | Outcome | Reason | Other fields | Emitted by |
| --- | --- | --- | --- | --- |
| `password.change` | `failure` | `policy` | `identity` | `change()`: the new password breaks the policy |
| `password.change` | `failure` | `session` | `identity` | `change()`: the session is missing, not active, or not the identity's |
| `password.change` | `failure` | `impersonation` | `identity`, `actor` (the impersonator), `session` | `change()` in an impersonated session |
| `password.change` | `failure` | `throttled` | `identity`, `session` | `change()`: the `reauth` throttle refused |
| `password.change` | `failure` | `wrong_password` | `identity`, `session` | `change()`: the old password does not match |
| `password.change` | `failure` | `stale` | `identity`, `session` | `change()`: another write landed first |
| `password.change` | `success` | | `identity`, `session` | `change()` |
| `password.change` | `success` | | `identity`, `actor?`, `data: { cause: 'set' }` | `set()` |
| `password.change` | `success` | | `identity`, `actor` (admin only), `data: { cause: 'admin' \| 'aged', expired: true }` | `expire()` |
| `password.reset.request` | `failure` | `unknown_login` | | `requestReset()`, deferred |
| `password.reset.request` | `failure` | `status` | `identity` | `requestReset()`, deferred: the account cannot reset |
| `password.reset.request` | `success` or `failure` | `no_mailer` on failure | `identity` | `requestReset()`, deferred |
| `password.reset.request` | `success` or `failure` | `no_mailer` on failure | `identity`, `actor?`, `data: { purpose: 'invite' }` | `invite()` |
| `throttle.block` | `failure` | `throttled` | `data: { flow: 'reset' }` | `requestReset()`, `redeemReset()` |
| `password.reset` | `failure` | `unknown_login` or `status` | `identity` with `status` | `redeemReset()` |
| `password.reset` | `failure` | `secret` | `identity` | `redeemReset()`: no matching secret |
| `password.reset` | `success` | | `identity` | `redeemReset()` with a reset secret |
| `invite.redeem` | `success` | | `identity`, `data: { via: 'reset' }` when a reset secret was used | `redeemReset()` on an invite-pending identity |

`session` is the hashed session handle, never the raw session id. No event holds a password, a hash, a login string or a secret.

There is no `password.expire` or invite-issue event type: an expiry is a `password.change` with `data.expired`, and an invite is a `password.reset.request` with `data.purpose: 'invite'`.

Not audited: a policy violation in `set()` or `redeemReset()`.

## Configuration

No key of this package. Sinks are registered, not configured; see the [authn core](../authn/README.md) for the shipped sinks and `authn.audit.*`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Event sink | `AuthnEventSink`, every registration, resolved per event with `Array.ofType` | whatever the app imports: `DbAuthnAuditSink` ([`@spinajs/authn-orm`](../authn-orm/06-audit-sink.md)), the `@spinajs/users` sinks | your sink | Add one with `@Injectable(AuthnEventSink)`. |

### Event sink: custom implementation

Alert the security team when a password is reset through a mailed link.

```ts sample
import { Injectable } from '@spinajs/di';
import { AuthnEventSink } from '@spinajs/authn';
import type { AuthnEvent } from '@spinajs/authn';

interface SecurityChannel {
  post(text: string): Promise<void>;
}

@Injectable(AuthnEventSink)
export class ResetAlertSink extends AuthnEventSink {
  public static channel: SecurityChannel = { post: async () => undefined };

  public async publish(e: AuthnEvent): Promise<void> {
    if (e.type === 'password.reset' && e.outcome === 'success' && e.identity) {
      await ResetAlertSink.channel.post(`Password reset for ${e.identity.type} ${e.identity.id} from ${e.ip ?? 'unknown ip'}`);
    }
  }
}
```

## Important behaviour

- **Sinks run in turn and are awaited.** A slow sink slows the password flow that published the event.
- **A failing sink never fails the flow.** Its error is logged by name only, never by message, which may echo the event.
- **Reset request events are deferred.** They are published after `requestReset()` has answered.
- **The reason is for audit only.** Clients get one answer for every failure.

## Best practices

- Keep `publish()` fast: hand slow work to a queue, which is safe here because events never carry secrets.
- Filter on `type` and `outcome` first; every sink gets every event, login events included.

## Related

- [Change and set](05-change-and-set.md), [Reset and invite](06-reset-and-invite.md), [Password expiry](08-password-expiry.md): the flows behind each event.
- [`@spinajs/authn-orm`](../authn-orm/06-audit-sink.md): the `authn_audit` table sink.
- [`@spinajs/users`](../users/08-authn-event-sinks.md): sinks that keep `PasswordSetAt` current and activate invited accounts.
