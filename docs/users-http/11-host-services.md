# Host services

The routes of this package resolve services that other packages define and implement: who may administer whose credentials, which accounts are in service, where sessions and tokens live. This page lists each one, how it is found, what users-http does without it, and how to plug in your own. The contracts themselves are documented by their packages.

## How it works

Most services are resolved per call from the root container, not injected at boot, so a registration made before the first request takes effect. `UserPrincipalFactory` and `UserProfileProvider` are injected when their class is built. A lookup of an abstract contract behaves one of three ways when nothing is registered:

- **refuse**: the route answers `403` (credential admin rule);
- **off**: the route answers `404` (session issuer, token service);
- **empty**: the route or check carries on with nothing (role source, profile policy, account status source).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Used by | Without it | How to replace or extend |
| --- | --- | --- | --- | --- | --- |
| `CredentialAdminRule` | Abstract `ActionHook` of `@spinajs/authn/hooks`, on `authn.admin.credentials`; the DI `Hooks` runner runs it, `withCredentialAdmin()` per call | users' `AuthzCredentialAdminRule` | delete, deactivate, ban, the session routes (`'sessions'`), an `Email` / `Login` change of another account (`'password-reset'`) | every call `403 forbidden` | `@Injectable(ActionHook)` on a class of your own; see below |
| `AccountStatusSource` | Abstract class of `@spinajs/authz-rbac`; `DI.getRegisteredTypes()`, then `resolve()` per call | users' `UserAccountStatusSource` | `AccountStanding` witness search | no witness; the last privileged account stays; one warning | `@Injectable(AccountStatusSource)` on a subclass; see below |
| `SessionIssuer` | Abstract class of `@spinajs/authn/contracts`; `hasImplementation()` per call | authn-session's issuer | `GET` and `DELETE /users/security/sessions/...` | `404 not_found` | Register your issuer; `list(identity)` and `revokeHandle(identity, handle)` are called |
| `TokenService` | Abstract class of `@spinajs/authn/contracts`; checked by registered types, never resolved | authn-token's | `GET /user/tokens/*` | `404 not_found` | Install authn-token or register your own |
| `TokenProfilePolicy` | String name `'TokenProfilePolicy'`; resolved per call | authn-token's `NoTokenProfilesPolicy` | `GET /user/tokens/profiles`, `?profile=` of `GET /user/tokens/roles` | `[]` | See [Own account routes](03-own-account.md#tokenprofilepolicy-offer-report-only-tokens) |
| `RoleSource` | Abstract class of `@spinajs/authn/contracts`; resolved per call | users' `RbacRoleSource` | `GET /user/tokens/roles` | `[]` | `@Injectable(RoleSource)` |
| `FreshAuth` | Policy class of `@spinajs/authn-http`; resolved per call, run in the handler | `FreshAuth` | delete, deactivate, ban, session revoke, identity change | the class itself | Configure `authn.freshAuth.maxAgeSeconds` |
| `AuthnAudit` | Class of `@spinajs/authn`; resolved per revoke | `AuthnAudit` | session revoke (`session.revoke`) | the class itself | Subscribe to its events |
| `AuthzService` | Class of `@spinajs/authz`; resolved per call | authz's | every row decision, `runAs(SYSTEM)`, `admin()` | the class itself | Configure authz |
| `AssignmentStore`, `RoleStore` | Abstract classes of `@spinajs/authz-rbac`; resolved per call | authz-rbac's stores | roles of a user, assignable roles, witness search | `RoleStore` missing: `500` (`AuthzConfigError`) | Register the authz-rbac stores (`registerRbacStores`) |
| `UserPrincipalFactory` | Class of `@spinajs/users`; `@Autoinject` into `AccountStanding` | users' | principals the account guard checks | the class itself | `DI.register(Mine).as(UserPrincipalFactory)` |
| `UserProfileProvider` | Named service of `@spinajs/users`, `users.user.profile` | `BasicProfileProvider` | `GET /users/profile/:login` | `500` | See [Admin profile route](09-admin-profile.md) |
| User model | DI value `'RbacUserModel'` (`RBAC_USER_MODEL`), read by `userModel()` | `User` | every user query | `User` | `DI.register(MyUser).asValue(RBAC_USER_MODEL, true)`; queries run as `SYSTEM`, so an `@AccessResource` model does not narrow them |

### `CredentialAdminRule`: protect a break-glass account

users' rule answers every action the same way: `users:credentials` at GLOBAL, a target whose rights the caller's strictly contain, no protected role, never the caller's own account. To refuse every credential action on the accounts you keep for emergencies, add a rule of your own beside it. Every rule is a before hook of `authn.admin.credentials`, and every one must allow, so the shipped rules still hold for the rest. Any answer but `{ ok: true }` refuses; the codes `forbidden`, `protected_role`, `escalation` and `not_found` reach the client.

```ts sample
import type { IdentityRef } from '@spinajs/authn/contracts';
import { CredentialAdminRule } from '@spinajs/authn/hooks';
import type { CredentialAdminVerdict } from '@spinajs/authn/hooks';
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';

@Injectable(ActionHook)
export class BreakGlassRule extends CredentialAdminRule {
  /** Uuids of the emergency accounts. */
  @Config('app.users.breakGlass', { defaultValue: [] })
  protected BreakGlass: string[];

  public async allowed(_actor: unknown, target: IdentityRef): Promise<CredentialAdminVerdict> {
    return target.type === 'user' && this.BreakGlass.includes(target.id) ? { ok: false, code: 'protected_role' } : { ok: true };
  }
}
```

`@spinajs/authn-http`'s credential admin routes run the same action, so the account is protected there too. Register a rule as a class, before anything resolves `Hooks`: the runner reads its hooks once.

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

- A `CredentialAdminRule` answer is trusted only when it is exactly `{ ok: true }`; anything else, including a rule that answers past its types, refuses. An unknown code becomes `forbidden`. A rule that throws answers `403 action_refused` with `hook_error`.
- `withCredentialAdmin()` fails closed: an effect that no rule admitted in its run is refused `403 forbidden`, also when a rule was registered after the hooks runner resolved.
- `AccountStanding` trusts only answers that are exactly `true` in a `Map`; a source that returns anything else, or throws, counts no witness.
- users-http never imports authn-token: the profile policy is found by name so that loading users-http does not register token strategies.

## Best practices

- Narrow the credential admin rule with a rule of your own beside `AuthzCredentialAdminRule`, and extend `UserAccountStatusSource` calling `super`, rather than writing either from scratch; they hold the escalation and invite rules.
- Register replacements with `@Injectable(<abstract>)` in a module imported at startup. These services are resolved per call, so no ordering against the controllers applies. A credential admin rule is the exception: as an `ActionHook` it must be registered before `Hooks` resolves.
- Keep the credential admin rule registered in production: without it, delete, deactivate, ban and the session routes refuse everyone.

## Related

- [`@spinajs/authn`](../authn/README.md): [`CredentialAdminRule`](../authn/14-action-hooks.md#authnadmincredentials-and-credentialadminrule), `SessionIssuer`, `TokenService`, `RoleSource`.
- [`@spinajs/authz`](../authz/README.md): `AuthzService` and `AuthzAdmin`.
- [`@spinajs/users`](../users/README.md): `AuthzCredentialAdminRule`, `UserAccountStatusSource`, `UserPrincipalFactory`, `RBAC_USER_MODEL`.
- [Account guard](08-account-guard.md): how the witness search uses the status source.
