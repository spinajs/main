# Password service

`LocalPasswordService` is this package's `PasswordService`: the one object behind change, set, check, policy, reset, invite and expiry. This page covers how it finds its collaborators, how to test it without a container, and how to replace or extend it. Each flow has its own page.

## How it works

1. Importing `@spinajs/authn-local` registers `LocalPasswordService` with `@Injectable(PasswordService)`.
2. Callers resolve `PasswordService`: authn-http's password routes, `@spinajs/users`' actions, the CLI and your code.
3. Each method resolves its collaborators from the container when it runs, not at construction. The service can therefore be resolved before the stores and sessions are ready.

| Collaborator | Resolved with | Used by | When missing |
| --- | --- | --- | --- |
| `IdentityStore` | `DI.resolve()` | reset, invite, expiry mail | Resolve error |
| `PasswordCredentialStore` | `DI.resolve()` | change, set, reset, expiry | Resolve error |
| `PasswordHasher` | `DI.resolve()` | change, set, reset | Resolve error |
| `LocalPasswordPolicy` | `DI.resolve()` | change, set, reset, check, policy | Resolve error |
| `SessionIssuer` | `DI.resolve()` | change, set, reset, expiry | Resolve error |
| `AuthnThrottle` | `DI.resolve()` | change, reset | Resolve error |
| `SecretStore` | `DI.resolve()` | reset, invite, expiry mail | Resolve error |
| `PasswordMailer` | `DI.check()`, then `DI.resolve()` | reset, invite, expiry mail | No mail, no secret, a warning |
| `TokenService` | `DI.check()`, then `DI.resolve()` | set, reset, admin expiry | No tokens to revoke |
| `AuthnEventSink` list | `DI.check()`, then `Array.ofType` | every audited step | No events |

| Method | Page |
| --- | --- |
| `change()`, `set()` | [Change and set](05-change-and-set.md) |
| `check()`, `policy()` | [Password policy](03-password-policy.md) |
| `requestReset()`, `redeemReset()`, `invite()` | [Reset and invite](06-reset-and-invite.md) |
| `expire()` | [Password expiry](08-password-expiry.md) |
| `drain()` | Waits for every deferred reset job scheduled so far, including jobs scheduled while it waits. For tests and shutdown. |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.local.reset.revokeTokens` | `true \| false` | `true` | `true`, `false` | `set()`, reset and admin expiry revoke every token. |
| `authn.local.reset.ttlSeconds` | `integer` | `3600` | `>= 1` | Reset secret lifetime. |
| `authn.local.reset.url` | `string` | `''` | a URL | Passed to the mailer. |
| `authn.local.invite.ttlSeconds` | `integer` | `900` | `>= 1` | Invite secret lifetime. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Password service | `PasswordService` (`@spinajs/authn`), singleton, `@Injectable(PasswordService)` on import | `LocalPasswordService` | your `PasswordService` | `DI.register(MyService).as(PasswordService)` after importing `@spinajs/authn-local` and `@spinajs/users`; the last registration wins. Subclass `LocalPasswordService` to keep the flows. |

Protected methods meant for a subclass:

| Method | Default |
| --- | --- |
| `mail(id, purpose, ttlSeconds)` | Issues the secret and calls the `PasswordMailer`; answers whether it sent. |
| `mailResetAfterExpiry(id)` | Mails a reset to an eligible identity after an expiry; logs failures. |
| `sendReset(login, ctx)` | The deferred part of `requestReset()`. |
| `verifiedHash(id, password)` | The stored hash the password matches, or `null`; one argon2 verify. |
| `storePassword(id, password, expected?)` | Hashes and writes, as a compare-and-set when `expected` is given. |
| `revokeTokensOf(id, ctx, actor?)` | Revokes tokens unless `revokeTokens` is `false`. |
| `audit(ctx, event)` | Stamps `at`, `ip` and `userAgent` and publishes to every sink. |
| `identities()`, `passwords()`, `hasher()`, `secrets()`, `mailer()`, `tokens()`, `sinks()`, `sessions()`, `throttle()`, `policyComponent()` | Collaborator lookups. |

### Password service: custom implementation

Tell the user by a separate channel whenever their password changes.

```ts sample
import { DI } from '@spinajs/di';
import { PasswordService } from '@spinajs/authn';
import type { AuthnContext, IdentityRef, PasswordChangeResult, SessionHandle } from '@spinajs/authn';
import { LocalPasswordService } from '@spinajs/authn-local';

interface SecurityNotices {
  passwordChanged(identity: IdentityRef, ip?: string): Promise<void>;
}

export class NotifyingPasswordService extends LocalPasswordService {
  public static notices: SecurityNotices = { passwordChanged: async () => undefined };

  public async change(id: IdentityRef, oldPassword: string, newPassword: string, session: SessionHandle, ctx: AuthnContext): Promise<PasswordChangeResult> {
    const result = await super.change(id, oldPassword, newPassword, session, ctx);
    if (result.status === 'changed') {
      await NotifyingPasswordService.notices.passwordChanged(id, ctx.ip);
    }
    return result;
  }
}

DI.register(NotifyingPasswordService).as(PasswordService);
```

For a reaction to every password event, including reset and expiry, an [`AuthnEventSink`](12-audit-events.md) is simpler than a subclass.

### Test seam

`new LocalPasswordService(deps)` takes every collaborator from `deps` and never touches the container:

| `deps` field | Required | Default |
| --- | --- | --- |
| `identities`, `passwords`, `sessions`, `throttle`, `hasher`, `policy`, `sinks` | yes | |
| `tokens` | yes | `null`: no tokens to revoke |
| `secrets` | for reset and invite | missing: those flows throw `InvalidOperation` |
| `mailer` | no | none: no mail, no secret |
| `log` | no | silent |
| `revokeTokens`, `resetTtlSeconds`, `resetUrl`, `inviteTtlSeconds` | no | `true`, `3600`, `''`, `900` |

`@spinajs/authn-testing` ships fakes for these contracts.

## Important behaviour

- **Collaborators are looked up on use,** so a missing store fails the first call that needs it, not the boot.
- **Mailer, token service and sinks are optional;** the other collaborators are required by the flows that use them.
- **Deferred work runs in process.** `requestReset()` work is scheduled with `setImmediate`; a process that exits right after the answer can drop it. Call `drain()` before shutdown.
- **Audit never fails a flow.** A failing sink is logged by its class and error name.

## Best practices

- Extend `LocalPasswordService` rather than writing a `PasswordService` from scratch: the timing, compare-and-set and enumeration guarantees live in its flows.
- In tests, build the service with `deps` and call `drain()` before asserting on mails or events from `requestReset()`.

## Patterns and antipatterns

```ts
// Don't: resolving the collaborators in the constructor breaks an app where the stores boot later.
constructor() {
  super();
  this.store = DI.get(PasswordCredentialStore)!;
}

// Do: override the lookup, which runs on use.
protected async passwords(): Promise<PasswordCredentialStore> {
  return DI.resolve(AuditedPasswordStore);
}
```

## Related

- [Audit events](12-audit-events.md): what the service publishes.
- [`@spinajs/authn`](../authn/README.md): the `PasswordService` contract and the sessions, throttle and tokens it calls.
- [`@spinajs/users`](../users/03-user-actions.md): the actions that call the service.
