# Authn event sinks

`QueueAuthnEventSink` is the `AuthnEventSink` users registers so the user events follow what `@spinajs/authn` decides: it re-emits logins, password changes and impersonations as [user events](06-user-events.md). Add your own sink next to it to react to the same authn events.

`PasswordSetAt` and the activation of invited accounts do not come from an event sink: [`UserPasswordStateHook`](07-identity-and-password-stores.md#the-password-state), an action hook on authn-local's password flows, writes them.

## How it works

1. authn's audit (`AuthnAudit`) resolves every `AuthnEventSink` with `Array.chainOf(AuthnEventSink)` and hands each one every `AuthnEvent`, concurrently. A sink error is logged by the publisher and never fails the login.
2. `QueueAuthnEventSink.publish(e)` loads the `User` row (as `SYSTEM`, deleted rows included) and emits:

| authn event | Outcome | Emitted |
| --- | --- | --- |
| `login` | success | `UserLogged` |
| `login` | failure | `UserLoginFailed` with `UserIsBanned` (`banned`), `UserNotActive` (`inactive`, `deleted`) or `InvalidCredentials` (any other reason) |
| `password.change` | success | `UserPasswordExpired` when `data.expired`, else `UserPasswordChanged` |
| `password.reset` | success | `UserPasswordChanged` |
| `password.reset.request` | success | `UserPasswordChangeRequest` |
| `impersonation.start` | success | `UserImpersonationStarted(actor, identity)` |
| `impersonation.end`, `impersonation.expire` | success | `UserImpersonationEnded(actor, identity)` |

   An event whose identity (or impersonator) is not a stored user emits nothing. Errors propagate to the publisher, which logs their class.

```mermaid
sequenceDiagram
  participant L as authn-local redeemReset
  participant H as UserPasswordStateHook (after)
  participant A as authn (AuthnAudit)
  participant Q as QueueAuthnEventSink
  participant DB as users
  participant E as queue
  L->>A: invite.redeem (success)
  A->>Q: invite.redeem
  Note over Q: no mapping, nothing emitted
  L->>H: { status: 'reset', purpose: 'invite', id }
  H->>DB: PasswordSetAt = now
  H->>DB: IsActive = true WHERE invite pending
  H->>E: UserChanged, UserActivated
  A->>Q: login (success)
  Q->>E: UserLogged
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| User events | `AuthnEventSink` list, singleton | `QueueAuthnEventSink` | none, if no consumer needs the events | `DI.unregister(QueueAuthnEventSink)` to stop the events; subclass `publish()` to emit more. |
| Your reaction to authn events | `AuthnEventSink` list | | any number of sinks | `@Injectable(AuthnEventSink)` on your class; it runs next to the shipped ones. |

### Custom sink: stamp the last login time

`users.LastLoginAt` is a column nobody writes. A sink keeps it current.

```ts sample
import { Injectable } from '@spinajs/di';
import { AuthnEventSink } from '@spinajs/authn/contracts';
import type { AuthnEvent } from '@spinajs/authn/contracts';
import { AuthzService, SYSTEM } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { User } from '@spinajs/users';
import { DateTime } from 'luxon';

@Injectable(AuthnEventSink)
export class LastLoginSink extends AuthnEventSink {
  public async publish(e: AuthnEvent): Promise<void> {
    if (e.type !== 'login' || e.outcome !== 'success' || e.identity?.type !== 'user') {
      return;
    }

    const authz = (await DI.resolve(AuthzService)) as AuthzService;
    // As SYSTEM: the caller at login is anonymous.
    await authz.runAs(SYSTEM, 'last-login', async () => {
      await User.update({ LastLoginAt: DateTime.fromJSDate(e.at) }).where('Uuid', e.identity!.id);
    });
  }
}
```

### Replace the queue sink: emit only security events

```ts sample
import { DI } from '@spinajs/di';
import { AuthnEventSink } from '@spinajs/authn/contracts';
import type { AuthnEvent } from '@spinajs/authn/contracts';
import { QueueAuthnEventSink } from '@spinajs/users';

const SECURITY_EVENTS = new Set(['password.change', 'password.reset', 'impersonation.start', 'impersonation.end', 'impersonation.expire']);

export class SecurityOnlyQueueSink extends QueueAuthnEventSink {
  public async publish(e: AuthnEvent): Promise<void> {
    if (SECURITY_EVENTS.has(e.type)) {
      await super.publish(e);
    }
  }
}

DI.unregister(QueueAuthnEventSink);
DI.register(SecurityOnlyQueueSink).as(AuthnEventSink);
```

Unregister before the first authn event resolves the sink list.

## Important behaviour

- `QueueAuthnEventSink` maps `invite.redeem` to no event; `UserActivated` comes from [`UserPasswordStateHook`](07-identity-and-password-stores.md#the-password-state).
- A subclass of 3.0's `UserAccountSink` becomes a subclass of `UserPasswordStateHook`: see [Migrating from `UserAccountSink`](07-identity-and-password-stores.md#migrating-from-useraccountsink).
- MFA changes have no user event; they reach sinks as `mfa.enrol` and `mfa.disable`.

## Best practices

- Write sinks as idempotent and fast: they run on the login path, concurrently with the others.
- Run database work in a sink as `SYSTEM` (`AuthzService.runAs`), like the shipped sinks: the caller may be anonymous.
- Log error classes, not messages: a driver error message can carry the statement and its bindings.

## Patterns and antipatterns

```ts
// Don't: subclass and register next to the original; both run and every event is emitted twice
DI.register(SecurityOnlyQueueSink).as(AuthnEventSink);

// Do: remove the shipped one first
DI.unregister(QueueAuthnEventSink);
DI.register(SecurityOnlyQueueSink).as(AuthnEventSink);
```

## Related

- [User events](06-user-events.md): the events `QueueAuthnEventSink` emits.
- [Identity and password stores](07-identity-and-password-stores.md): `UserPasswordStateHook` writes `PasswordSetAt`, `UserPasswordAgeSource` reads it.
- [`@spinajs/authn`](../authn/README.md): `AuthnEvent` types and the audit flow.
- [Multiple implementations](../di/06-multiple-implementations.md): lists of services and `DI.unregister`.
