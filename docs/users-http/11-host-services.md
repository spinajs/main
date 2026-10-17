# Host services

The routes of this package resolve services that other packages define and implement: who may administer whose credentials, which accounts are in service, where sessions and tokens live. This page lists each one, how it is found, what users-http does without it, and how to plug in your own. The contracts themselves are documented by their packages.

## How it works

Most services are resolved per call from the root container, not injected at boot, so a registration made before the first request takes effect. `UserPrincipalFactory` and `UserProfileProvider` are injected when their class is built. A lookup of an abstract contract behaves one of three ways when nothing is registered:

- **refuse**: the route answers `403` (credential admin guard);
- **off**: the route answers `404` (session issuer, token service);
- **empty**: the route or check carries on with nothing (role source, profile policy, account status source).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Used by | Without it | How to replace or extend |
| --- | --- | --- | --- | --- | --- |
| `CredentialAdminGuard` | Abstract class of `@spinajs/authn/contracts`; `hasRegistered()`, then `resolve()` per call | users' `AuthzCredentialAdminGuard` | delete, deactivate, ban, the session routes (`'sessions'`), an `Email` / `Login` change of another account (`'password-reset'`) | every call `403 forbidden` | `@Injectable(CredentialAdminGuard)` on a subclass; see below |
| `AccountStatusSource` | Abstract class of `@spinajs/authz-rbac`; `DI.getRegisteredTypes()`, then `resolve()` per call | users' `UserAccountStatusSource` | `DefaultAccountGuard` witness search | no witness; the last privileged account stays; one warning | `@Injectable(AccountStatusSource)` on a subclass; see below |
| `SessionIssuer` | Abstract class of `@spinajs/authn/contracts`; `hasRegistered()` per call | authn-session's issuer | `GET` and `DELETE /users/security/sessions/...` | `404 not_found` | Register your issuer; `list(identity)` and `revokeHandle(identity, handle)` are called |
| `TokenService` | Abstract class of `@spinajs/authn/contracts`; checked by registered types, never resolved | authn-token's | `GET /user/tokens/*` | `404 not_found` | Install authn-token or register your own |
| `TokenProfilePolicy` | String name `'TokenProfilePolicy'`; resolved per call | authn-token's `NoTokenProfilesPolicy` | `GET /user/tokens/profiles`, `?profile=` of `GET /user/tokens/roles` | `[]` | See [Own account routes](03-own-account.md#tokenprofilepolicy-offer-report-only-tokens) |
| `RoleSource` | Abstract class of `@spinajs/authn/contracts`; resolved per call | users' `RbacRoleSource` | `GET /user/tokens/roles` | `[]` | `@Injectable(RoleSource)` |
| `FreshAuth` | Policy class of `@spinajs/authn-http`; resolved per call, run in the handler | `FreshAuth` | delete, deactivate, ban, session revoke, identity change | the class itself | Configure `authn.freshAuth.maxAgeSeconds` |
| `AuthnAudit` | Class of `@spinajs/authn`; resolved per revoke | `AuthnAudit` | session revoke (`session.revoke`) | the class itself | Subscribe to its events |
| `AuthzService` | Class of `@spinajs/authz`; resolved per call | authz's | every row decision, `runAs(SYSTEM)`, `admin()` | the class itself | Configure authz |
| `AssignmentStore`, `RoleStore` | Abstract classes of `@spinajs/authz-rbac`; resolved per call | authz-rbac's stores | roles of a user, assignable roles, witness search | `RoleStore` missing: `500` (`AuthzConfigError`) | Register the authz-rbac stores (`registerRbacStores`) |
| `UserPrincipalFactory` | Class of `@spinajs/users`; `@Autoinject` into `DefaultAccountGuard` | users' | principals the account guard checks | the class itself | `DI.register(Mine).as(UserPrincipalFactory)` |
| `UserProfileProvider` | Named service of `@spinajs/users`, `users.user.profile` | `BasicProfileProvider` | `GET /users/profile/:login` | `500` | See [Admin profile route](09-admin-profile.md) |
| User model | DI value `'RbacUserModel'` (`RBAC_USER_MODEL`), read by `userModel()` | `User` | every user query | `User` | `DI.register(MyUser).asValue(RBAC_USER_MODEL, true)`; queries run as `SYSTEM`, so an `@AccessResource` model does not narrow them |

### `CredentialAdminGuard`: protect a break-glass account

users' guard answers every action the same way: `users:credentials` at GLOBAL, a target whose rights the caller's strictly contain, no protected role, never the caller's own account. Extend it to refuse every credential action on accounts you keep for emergencies, and keep its rules for the rest. Any answer but `{ ok: true }` refuses; the codes `forbidden`, `protected_role`, `escalation` and `not_found` reach the client.

```ts sample
import { CredentialAdminGuard } from '@spinajs/authn/contracts';
import type { CredentialAdminAction, IdentityRef, Principal } from '@spinajs/authn/contracts';
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { AuthzCredentialAdminGuard } from '@spinajs/users';

type Verdict = Awaited<ReturnType<CredentialAdminGuard['allowed']>>;

@Injectable(CredentialAdminGuard)
export class BreakGlassCredentialAdminGuard extends AuthzCredentialAdminGuard {
  /** Uuids of the emergency accounts. */
  @Config('app.users.breakGlass', { defaultValue: [] })
  protected BreakGlass: string[];

  public async allowed(actor: Principal, target: IdentityRef, action: CredentialAdminAction): Promise<Verdict> {
    if (target.type === 'user' && this.BreakGlass.includes(target.id)) {
      return { ok: false, code: 'protected_role' };
    }
    return super.allowed(actor, target, action);
  }
}
```

The same guard answers `@spinajs/authn-http`'s credential admin routes, so the account is protected there too.

### `AccountStatusSource`: keep service accounts out of the witness search

users' source counts an account in service when its row is active, unbanned, undeleted, with no pending invite and no expired password. An integration account may hold `users:update` but cannot repair anything. Extend the source so such accounts never count as the remaining administrator.

```ts sample
import type { PrincipalRef } from '@spinajs/authz';
import { principalKey } from '@spinajs/authz';
import { AccountStatusSource } from '@spinajs/authz-rbac';
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { UserAccountStatusSource } from '@spinajs/users';

@Injectable(AccountStatusSource)
export class HumanAccountStatusSource extends UserAccountStatusSource {
  /** Uuids of accounts used by integrations, never by a person. */
  @Config('app.users.integrationAccounts', { defaultValue: [] })
  protected Integrations: string[];

  public async inService(refs: readonly PrincipalRef[]): Promise<ReadonlyMap<string, boolean>> {
    const answers = new Map(await super.inService(refs));
    for (const ref of refs) {
      if (ref.type === 'user' && this.Integrations.includes(ref.id)) {
        answers.set(principalKey(ref), false);
      }
    }
    return answers;
  }
}
```

`AuthzAdmin`'s own last-holder check reads the same source, so role changes through `AuthzAdmin` follow the rule as well.

## Important behaviour

- A `CredentialAdminGuard` answer is trusted only when it is exactly `{ ok: true }`; anything else, including a guard that answers past its types, refuses. An unknown code becomes `forbidden`.
- `DefaultAccountGuard` trusts only answers that are exactly `true` in a `Map`; a source that returns anything else, or throws, counts no witness.
- The token routes tell a bare abstract class (recorded by an earlier resolve of an unregistered token) from a real implementation, and ignore the bare one.
- users-http never imports authn-token: the profile policy is found by name so that loading users-http does not register token strategies.

## Best practices

- Extend the shipped implementations (`AuthzCredentialAdminGuard`, `UserAccountStatusSource`) and call `super`, rather than writing a guard or source from scratch; they hold the escalation and invite rules.
- Register replacements with `@Injectable(<abstract>)` in a module imported at startup; these services are resolved per call, so no ordering against the controllers applies.
- Keep the credential admin guard registered in production: without it, delete, deactivate, ban and the session routes refuse everyone.

## Related

- [`@spinajs/authn`](../authn/README.md): `CredentialAdminGuard`, `SessionIssuer`, `TokenService`, `RoleSource`.
- [`@spinajs/authz`](../authz/README.md): `AuthzService` and `AuthzAdmin`.
- [`@spinajs/users`](../users/README.md): `AuthzCredentialAdminGuard`, `UserAccountStatusSource`, `UserPrincipalFactory`, `RBAC_USER_MODEL`.
- [Account guard](08-account-guard.md): how the witness search uses the status source.
