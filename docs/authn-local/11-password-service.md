# Password service

`LocalPasswordService` is this package's `PasswordService`: the one object behind change, set, check, policy, reset, invite and expiry. This page covers how it finds its collaborators, how to test it without a container, and how to replace or extend it. Each flow has its own page.

## How it works

1. Importing `@spinajs/authn-local` registers `LocalPasswordService` with `@Injectable(PasswordService)`.
2. Callers resolve `PasswordService`: authn-http's password routes, `@spinajs/users`' actions, the CLI and your code.
3. The collaborators are `@Autoinject` properties: the container that resolves the service fills them when it builds it. `SecretStore`, `PasswordMailer` and `TokenService` are optional and stay `undefined` when that container has no registration.

| Collaborator | Injected as | Used by | When missing |
| --- | --- | --- | --- |
| `IdentityStore` | `Identities` | reset, invite, expiry mail | The bare abstract class is injected; the first call that uses it fails |
| `PasswordCredentialStore` | `Passwords` | change, set, reset, expiry | The same |
| `PasswordHasher` | `Hasher` | change, set, reset | Registered by this package |
| `LocalPasswordPolicy` | `Policy` | change, set, reset, check, policy | Registered by this package |
| `SessionIssuer` | `Sessions` | change, set, reset, expiry | The bare abstract class is injected; the first call that uses it fails |
| `AuthnThrottle` | `Throttle` | change, reset | The same |
| `SecretStore` | `Secrets`, optional | reset, invite, expiry mail | `redeemReset()` throws `InvalidOperation`; so do `invite()` and the reset mails once a `PasswordMailer` is registered (the deferred part of `requestReset()` logs it) |
| `PasswordMailer` | `Mailer`, optional | reset, invite, expiry mail | No mail, no secret, a warning |
| `TokenService` | `Tokens`, optional | set, reset, admin expiry | No tokens to revoke |
| `AuthnAudit` | `Audit` | every audited step | Never missing: a concrete class of `@spinajs/authn`, one per container; with no `AuthnEventSink` it logs a warning and publishes to nobody |

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
| `verifyAndChange`, `setNow`, `redeemNow`, `inviteNow`, `expireNow`, `requestVerificationNow`, `redeemVerificationNow` | The part of each flow that runs inside its [action hooks](16-action-hooks.md), after the flow's own checks. |
| `runHooked(action, input, impl, opts)` | `Hooks.run`, or `impl` alone for a service built with `deps` and no `hooks`. |
| `verifiedHash(id, password)` | The stored hash the password matches, or `null`; one argon2 verify. |
| `storePassword(id, password, expected?)` | Hashes and writes, as a compare-and-set when `expected` is given. |
| `revokeTokensOf(id, ctx, actor?)` | Revokes tokens unless `revokeTokens` is `false`. |
| `audit(ctx, body)` | Publishes through `auditor().publishIn(ctx, body)`, which stamps `at`, `ip` and `userAgent`. |
| `identities()`, `passwords()`, `hasher()`, `secrets()`, `mailer()`, `tokens()`, `auditor()`, `sessions()`, `throttle()`, `policyComponent()` | Collaborator lookups: the `deps` field, else the injected property. |

### Password service: reacting to a flow

Tell the user by a separate channel whenever their password changes. An `after` hook on `authn.password.change` sees every change and its result, and needs no subclass:

```ts sample
import { DI } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, AfterContext } from '@spinajs/hooks';
import type { IdentityRef } from '@spinajs/authn';
import '@spinajs/authn-local';

interface SecurityNotices {
  passwordChanged(identity: IdentityRef, ip?: string): Promise<void>;
}

export class PasswordChangedNotice extends ActionHook<'authn.password.change'> {
  public static notices: SecurityNotices = { passwordChanged: async () => undefined };

  readonly actions: readonly ActionPattern[] = ['authn.password.change'];

  public async after(ctx: AfterContext<'authn.password.change'>): Promise<void> {
    if (ctx.output.status === 'changed') {
      await PasswordChangedNotice.notices.passwordChanged(ctx.input.id, ctx.input.ctx.ip);
    }
  }
}

DI.register(PasswordChangedNotice).as(ActionHook);
```

A `before` hook can refuse the change instead. [Action hooks](16-action-hooks.md) lists every action of this service, its input and its refused answer.

### Password service: custom implementation

Subclass `LocalPasswordService` only to replace a flow itself, for example a change that also writes to a legacy store. Call `super` for the parts you keep, so the checks, the hooks and the audit still run:

```ts sample
import { DI } from '@spinajs/di';
import { PasswordService } from '@spinajs/authn';
import type { AuthnContext, IdentityRef, PasswordChangeResult, SessionHandle } from '@spinajs/authn';
import { LocalPasswordService } from '@spinajs/authn-local';

interface LegacyPasswords {
  changed(identity: IdentityRef): Promise<void>;
}

export class LegacySyncPasswordService extends LocalPasswordService {
  public static legacy: LegacyPasswords = { changed: async () => undefined };

  public async change(id: IdentityRef, oldPassword: string, newPassword: string, session: SessionHandle, ctx: AuthnContext): Promise<PasswordChangeResult> {
    const result = await super.change(id, oldPassword, newPassword, session, ctx);
    if (result.status === 'changed') {
      await LegacySyncPasswordService.legacy.changed(id);
    }
    return result;
  }
}

DI.register(LegacySyncPasswordService).as(PasswordService);
```

For a reaction to every password event, including reset and expiry, an [`AuthnEventSink`](12-audit-events.md) or a hook on `authn.password.*` is simpler than a subclass.

### Test seam

`new LocalPasswordService(deps)` (`LocalPasswordServiceDeps`) takes every collaborator from `deps` and never touches the container. A setting left out of `deps` falls back to `AUTHN_LOCAL_DEFAULTS`, the schema defaults of `authn.local`:

| `deps` field | Required | Default |
| --- | --- | --- |
| `identities`, `passwords`, `sessions`, `throttle`, `hasher`, `policy` | yes | |
| `sinks` | yes | published to through `AuthnAudit.over(sinks, { log })` |
| `tokens` | yes | `null`: no tokens to revoke |
| `secrets` | for reset and invite | missing: those flows throw `InvalidOperation` |
| `mailer` | no | none: no mail, no secret |
| `log` | no | silent |
| `revokeTokens`, `resetTtlSeconds`, `resetUrl`, `inviteTtlSeconds` | no | `true`, `3600`, `''`, `900` |
| `hooks` | no | none: no [action hook](16-action-hooks.md) runs |

`@spinajs/authn-testing` ships fakes for these contracts.

## Important behaviour

- **Collaborators are injected when the service is built,** from the container that resolves it. Register an optional one (`SecretStore`, `PasswordMailer`, `TokenService`) before `PasswordService` is first resolved; a later registration does not reach a service already built.
- **Secret store, mailer and token service are optional;** the other collaborators are required by the flows that use them. Without a `SecretStore` the reset and invite flows throw `InvalidOperation`.
- **Deferred work runs in process.** `requestReset()` work is scheduled with `setImmediate`; a process that exits right after the answer can drop it. Call `drain()` before shutdown.
- **Audit never fails a flow.** `AuthnAudit` runs every sink with a timeout and logs a sink that fails or times out by its class and error class.

## Best practices

- Extend `LocalPasswordService` rather than writing a `PasswordService` from scratch: the timing, compare-and-set and enumeration guarantees live in its flows.
- In tests, build the service with `deps` and call `drain()` before asserting on mails or events from `requestReset()`.

## Patterns and antipatterns

```ts
// Don't: DI.resolve reads the root container, not the one that built the service.
protected async passwords(): Promise<PasswordCredentialStore> {
  return DI.resolve(AuditedPasswordStore);
}

// Do: inject the replacement and return it from the lookup.
@Autoinject(AuditedPasswordStore)
protected Audited: AuditedPasswordStore;

protected async passwords(): Promise<PasswordCredentialStore> {
  return this.Audited;
}
```

## Related

- [Audit events](12-audit-events.md): what the service publishes.
- [`@spinajs/authn`](../authn/README.md): the `PasswordService` contract and the sessions, throttle and tokens it calls.
- [`@spinajs/users`](../users/03-user-actions.md): the actions that call the service.
