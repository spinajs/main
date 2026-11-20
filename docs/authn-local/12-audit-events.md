# Audit events

`LocalPasswordService` publishes an `AuthnEvent` for each step of change, set, reset, invite and expiry. Subscribe with an `AuthnEventListener` to alert on resets, keep an audit trail, or update account data. Login events come from the authn core, not from this package.

## How it works

1. A flow builds the event body and calls `LocalPasswordService.audit(ctx, body)`.
2. `audit()` calls `AuthnAudit.publishIn(ctx, body)`, which stamps `at` (`ctx.now`), `ip` and `userAgent` from the context. A service built with `deps` publishes through `AuthnAudit.over(deps.listeners)` instead.
3. `AuthnAudit` delivers a frozen copy to every `AuthnEventListener` concurrently, each call bounded by `authn.audit.listenerTimeoutMs`, and waits for all of them. A listener that throws or times out is logged with its class name, the event type and the error class; the flow goes on unless the listener is blocking. See [Audit and events](../authn/06-audit-events.md).

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
| `password.change` | `failure` | `hook:<code>` or `hook_error` | `identity`, `session` | `change()`: an `authn.password.change` [action hook](16-action-hooks.md) refused or failed |
| `password.change` | `failure` | `hook:<code>` or `hook_error` | `identity`, `actor?`, `data: { cause: 'set' }` | `set()`: an `authn.password.set` hook refused or failed |
| `password.change` | `failure` | `hook:<code>` or `hook_error` | `identity`, `actor` (admin only), `data: { cause, expired: false }` | `expire()`: an `authn.password.expire` hook refused or failed |
| `password.reset.request` | `failure` | `hook:<code>` or `hook_error` | | `requestReset()`: an `authn.password.reset.request` hook refused or failed |
| `password.reset.request` | `failure` | `hook:<code>` or `hook_error` | `identity`, `actor?`, `data: { purpose: 'invite' }` | `invite()`: an `authn.password.invite` hook refused or failed |
| `password.reset` | `failure` | `hook:<code>` or `hook_error` | | `redeemReset()`: an `authn.password.reset.redeem` hook refused or failed |
| `address.verify.request`, `address.verify` | | | | [Address verification](14-address-verification.md#audit-events) |
| `code.request` | | | | [Email codes](15-email-codes.md#audit-events) |

`session` is the hashed session handle, never the raw session id. No event holds a password, a hash, a login string or a secret.

There is no `password.expire` or invite-issue event type: an expiry is a `password.change` with `data.expired`, and an invite is a `password.reset.request` with `data.purpose: 'invite'`.

Not audited: a policy violation in `set()` or `redeemReset()`.

## Configuration

No key of this package. Listeners are registered, not configured; `authn.audit.listenerTimeoutMs` (default `2000`) of the [authn core](../authn/06-audit-events.md) bounds each listener call.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Event listener | `AuthnEventListener`, every registration in the container's lineage, collected by `AuthnAudit` when it is resolved (`Array.chainOf`) | whatever the app imports, such as `QueueAuthnEventListener` of `@spinajs/users` or `AuthnAuditRecorder` of [`@spinajs/audit-authn`](../../packages/audit-authn/README.md) | your listener | Add one with `@Injectable(AuthnEventListener)`. |

### Event listener: custom implementation

Alert the security team when a password is reset through a mailed link.

```ts sample
import { Injectable } from '@spinajs/di';
import { AuthnEventListener } from '@spinajs/authn';
import type { AuthnEvent } from '@spinajs/authn';

interface SecurityChannel {
  post(text: string): Promise<void>;
}

@Injectable(AuthnEventListener)
export class ResetAlerts extends AuthnEventListener {
  public static channel: SecurityChannel = { post: async () => undefined };

  public async on(e: AuthnEvent): Promise<void> {
    if (e.type === 'password.reset' && e.outcome === 'success' && e.identity) {
      await ResetAlerts.channel.post(`Password reset for ${e.identity.type} ${e.identity.id} from ${e.ip ?? 'unknown ip'}`);
    }
  }
}
```

## Important behaviour

- **Listeners run concurrently and are awaited.** A slow listener slows the password flow that published the event, by at most `authn.audit.listenerTimeoutMs`.
- **A failing listener never fails the flow, unless it is [blocking](../authn/06-audit-events.md#blocking-listeners).** Its error is logged by class only, never by message, which may echo the event.
- **Register listeners before the first event.** `AuthnAudit` collects the listeners once per container, when it is resolved.
- **Reset request events are deferred.** They are published after `requestReset()` has answered.
- **The reason is for audit only.** Clients get one answer for every failure.

## Best practices

- Keep `on()` fast: hand slow work to a queue, which is safe here because events never carry secrets.
- Filter on `type` and `outcome` first; every listener gets every event, login events included.

## Related

- [Change and set](05-change-and-set.md), [Reset and invite](06-reset-and-invite.md), [Password expiry](08-password-expiry.md): the flows behind each event.
- [`@spinajs/audit-authn`](../../packages/audit-authn/README.md): records the events in the audit trail; a [login history](../authn-orm/06-audit-sink.md) is a table trail.
- [`@spinajs/users`](../users/08-authn-event-sinks.md): the users listener of authn events. `PasswordSetAt` and invite activation follow the [action hooks](16-action-hooks.md) instead, through [`UserPasswordStateHook`](../users/07-identity-and-password-stores.md#the-password-state).
