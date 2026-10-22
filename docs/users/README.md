# `@spinajs/users`

User identity for SpinaJS: the `users` and `users_metadata` tables, lifecycle actions (create, activate, ban, delete), lifecycle mails and queue events, and the services that plug these users into `@spinajs/authn` and `@spinajs/authz`.

It does **not** serve HTTP routes (that is `@spinajs/users-http`), authenticate anybody (`@spinajs/authn`, `@spinajs/authn-local`), hash passwords (authn-local's `PasswordService`) or store role assignments (`@spinajs/authz-rbac`). It implements the hooks those packages leave open: identity store, password store, principal factory, impersonation and credential admin guards, role source.

## Install

```sh
npm install @spinajs/users
```

Import it once in the application entry. No authn package depends on it, so without the import authn has no `IdentityStore`, no `PasswordCredentialStore` and no `PrincipalFactory`:

```ts
import '@spinajs/users';
```

Every service below registers on that import (`@Injectable`), and `RbacBootstrapper` finishes the setup when the bootstrappers run.

## Features

| Feature | What it does |
| --- | --- |
| [User model and metadata](01-user-model.md) | `User`, `UserBase`, `UserMetadata`, query scopes, reserved metadata keys, the `users` schema and its migration. |
| [Custom user model](02-custom-user-model.md) | Swap the model class every users and authz lookup uses (`RBAC_USER_MODEL`, `userModel()`), add columns and scopes. |
| [User actions](03-user-actions.md) | `create`, `activate`, `deactivate`, `ban`, `unban`, `deleteUser`, `expirePassword`, metadata and lookup helpers. |
| [Create middleware](04-create-middleware.md) | `users.actions.create.beforeCreate` / `afterCreate`: functions that change a user while `create()` runs. |
| [Lifecycle mails](05-lifecycle-mails.md) | `users.email.*` templates, `sendUserEmail()`, and the `PasswordMailer` users registers for authn-local. |
| [User events](06-user-events.md) | `UserCreated`, `UserBanned`, `UserLogged` and the other queue events, who emits them, and where they are routed. |
| [Identity and password stores](07-identity-and-password-stores.md) | `UserIdentityStore`, `UserPasswordStore`, `UserPasswordAgeSource`, `UserAccountStatusSource`: users as authn identities. |
| [Authn event sinks](08-authn-event-sinks.md) | `UserAccountSink` and `QueueAuthnEventSink`: keep the `users` row and the user events in step with authn. |
| [Principal factory](09-principal-factory.md) | `UserPrincipalFactory` builds `user:<Uuid>` and `agent:<id>` principals for authn, jobs and CLI code. |
| [Principal attribute providers](10-principal-attribute-providers.md) | `PrincipalAttributeProvider`: derive ABAC attributes from the user record. |
| [Authz resources and relations](11-authz-resources-and-relations.md) | The `user` resource, the `self` and `owner` relations, the permissions and roles users ships. |
| [Default roles](12-default-roles.md) | `authz.rbac.defaultRoles` for new users and the boot check that validates it. |
| [Impersonation and credential admin guards](13-impersonation-and-credential-admin-guards.md) | `AuthzImpersonationGuard`, `ImpersonationGuardStartHook`, `AuthzCredentialAdminGuard`, `AuthzTargetGuard`: who may act as or on another user. |
| [Role switch and access response](14-role-switch-and-access-response.md) | `RbacRoleSource` for role switch and MFA, `OrderedActiveRoleHook` for the role a new session starts on, `AccessResponseExtension` adding `Access` to authn answers. |
| [User profile](15-user-profile.md) | `UserProfileProvider` picked by `users.user.profile`, `BasicProfileProvider`. |
| [Jobs run as their initiator](16-jobs-run-as-initiator.md) | `@spinajs/users/queue`: `UserInitiatorPrincipalFactory` reloads the user a job runs as. |
| [Self-service registration](18-self-service-registration.md) | `UserIdentityRegistrar` over `create()`, behind `users.registration.enabled`: what `POST /auth/register` of authn-http calls. |
| [CLI commands](17-cli-commands.md) | `rbac:user-create`, `rbac:user-find`, `rbac:user-activate`, `rbac:user-ban`, `rbac:user-delete`. |

## Quick start

Create a user with a password, ban it for an hour and read it back:

```ts sample
import '@spinajs/users';
import { ban, create, getUser } from '@spinajs/users';

export async function onboardAndSuspend(): Promise<boolean> {
  const { User: user } = await create({ Email: 'ada@acme.com', Login: 'ada', Password: 'Correct-Horse-42' }, ['user']);

  await ban(user, 'chargeback under review', 60 * 60);

  const reloaded = await getUser(user.Uuid);
  return reloaded.IsBanned;
}
```

`create()` needs the authz host booted with the RBAC stores (it grants roles through `AuthzAdmin`) and authn-local's `PasswordService`, which importing users brings in.

## Related packages

- [`@spinajs/authn`](../authn/README.md): the contracts users implements (`IdentityStore`, `PrincipalFactory`, guards, sinks).
- [`@spinajs/authz`](../authz/README.md): the engine that checks the `user` resource and the relations users registers.
- [`@spinajs/orm`](../orm/README.md): models, metadata relations and migrations behind `User`.
- [`@spinajs/email`](../email/README.md): sends the lifecycle mails and provides `EmailPasswordMailer`.
- [`@spinajs/queue`](../queue/README.md): carries the user events.
- [`@spinajs/cli`](../cli/README.md): runs the `rbac:user-*` commands.
- [`@spinajs/users-http`](../users-http/README.md): the HTTP routes over these actions.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): role assignments and `AccountStatusSource`.
