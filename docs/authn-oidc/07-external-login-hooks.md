# External login hooks

An `ExternalLoginHook` runs your code on every successful OIDC login, with the local identity and the mapped claims. Use it to sync IdP groups into authorization data, update a profile, or refuse a login on a claim. `ExternalLoginHook` is a contract of `@spinajs/authn`; this page covers what an OIDC login hands it.

## How it works

1. `OidcStrategy.verify()` answers the mapped `OidcExternalSubject` (see [Claims mapping](04-claims-mapping.md)).
2. `DefaultAuthnService` resolves the identity (see [Identity linking](05-identity-linking.md)) and checks its status.
3. It resolves `Array.chainOf(ExternalLoginHook)` in its container, so hooks of every ancestor container run too. It resolves them per login, so a hook registered late still runs.
4. It calls `afterLogin(identity, external)` on each hook in turn and awaits it.
5. The first hook that throws stops the chain. The login fails with the opaque answer, no session is issued, and the core audits one `login` failure with reason `hook_error` and the error's class name.
6. When every hook passes, the core writes a pending email link, asks the `MfaPolicy` and issues the session.

Hooks run for an interactive strategy that answers an external subject. Among the shipped strategies that is `oidc:<name>` only.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Login hook | `ExternalLoginHook` (`@spinajs/authn/contracts`), resolved as a list with `Array.chainOf` | none | your hooks | `@Injectable(ExternalLoginHook)` on a subclass, or `DI.register(MyHook).as(ExternalLoginHook)`. Every registration runs. |

The contract:

```ts
abstract class ExternalLoginHook {
  abstract afterLogin(identity: IdentityRef, external: ExternalSubject): Promise<void>;
}
```

For an OIDC login, `external` is an `OidcExternalSubject`: `provider` is `oidc:<name>`, and `claims` holds `name`, `groups` and `raw`.

### Login hook: custom implementation

```ts sample
import { ExternalLoginHook } from '@spinajs/authn/contracts';
import type { ExternalSubject, IdentityRef } from '@spinajs/authn/contracts';
import type { OidcExternalSubject } from '@spinajs/authn-oidc';
import { Injectable } from '@spinajs/di';

const isOidc = (e: ExternalSubject): e is OidcExternalSubject => e.provider.startsWith('oidc:');

/** Refuses a sign-in from a user the IdP placed in the "suspended" group. */
@Injectable(ExternalLoginHook)
export class SuspendedGroupGuard extends ExternalLoginHook {
  public async afterLogin(_identity: IdentityRef, external: ExternalSubject): Promise<void> {
    if (!isOidc(external)) return;
    if (external.claims.groups?.includes('suspended')) {
      throw new Error('suspended at the identity provider');
    }
  }
}
```

## Important behaviour

- **Before MFA and the session.** A hook sees a login that passed every check, but no session exists yet.
- **A throw fails the login.** The client gets the same answer as for a wrong password; the audit records `hook_error`.
- **No rollback.** Hooks that ran before the failing one keep their effects. An identity that JIT created for this login stays, with its link. A login matched by verified email is not linked when a hook fails.
- **`groups` absent is not `[]`.** An unmapped or missing groups claim leaves `claims.groups` out; treat that as "unknown", not "no groups".
- **`raw` holds the validated ID token claims and the userinfo claims it lacks**, never a token.
- **`authn` never imports `authz`.** Group sync to authorization is your hook's job.

## Best practices

- Make hooks idempotent: a later hook may fail the login after yours ran, and the user retries.
- Check `external.provider` before you read OIDC claims; another external strategy may run hooks one day.
- Keep hooks fast: the user waits on the callback while they run.

## Patterns and antipatterns

```ts
// Don't: an unmapped or missing claim reads as "no groups" and removes every membership
const groups = (external as OidcExternalSubject).claims.groups ?? [];
await syncMemberships(identity, groups);

// Do: leave memberships alone when the IdP said nothing
const groups = (external as OidcExternalSubject).claims.groups;
if (groups !== undefined) await syncMemberships(identity, groups);
```

## Examples

### Keep the display name in step with the IdP

```ts sample
import { ExternalLoginHook } from '@spinajs/authn/contracts';
import type { ExternalSubject, IdentityRef } from '@spinajs/authn/contracts';
import type { OidcExternalSubject } from '@spinajs/authn-oidc';
import { Injectable } from '@spinajs/di';

/** Stand-in for your profile repository. */
const displayNames = new Map<string, string>();

@Injectable(ExternalLoginHook)
export class DisplayNameSync extends ExternalLoginHook {
  public async afterLogin(identity: IdentityRef, external: ExternalSubject): Promise<void> {
    if (!external.provider.startsWith('oidc:')) return;
    const name = (external as OidcExternalSubject).claims.name;
    if (name !== undefined && displayNames.get(identity.id) !== name) {
      displayNames.set(identity.id, name);
    }
  }
}
```

## Related

- [`@spinajs/authn`, How a login runs](../authn/01-authentication-flow.md): where hooks sit in the core flow.
- [Claims mapping](04-claims-mapping.md): what `external.claims` holds.
- [Identity linking](05-identity-linking.md): which identity the hook receives.
