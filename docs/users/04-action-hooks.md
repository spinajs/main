# Action hooks

The [user actions](03-user-actions.md) run through the [`@spinajs/hooks`](../hooks/README.md) runner. A hook can refuse an action, change the inputs the action declares mutable, or observe it after it ran, without wrapping or replacing the action. This replaces the 2.x `users.actions.create.beforeCreate` / `afterCreate` config middleware.

## How it works

1. The action runs its own checks first: argument validation, uniqueness, protected metadata, the role dry run, "already banned".
2. It calls `Hooks.run` with the action's input. Without a matching hook it runs at once and builds no input.
3. The `before` hooks run. One of them may refuse (`ctx.refuse(code)`): the action throws `ActionRefused` and changes nothing.
4. A `before` hook may change a mutable key. The action runs again the checks that guard that key, on the changed value. A hook can narrow an action, never widen it.
5. The action runs. Its revocations, queue events and state writes run inline, as without hooks; no hook can stop them once the action proceeds.
6. The `after` hooks see the input and the output. A failing `after` hook is logged and never fails the action.

Hooks never get an ORM model. `user` is a `UserView`: the user's columns as plain data, the password hash left out, dates as `Date`s. `actor` is an `ActorView`: `type`, `id`, `authenticated`, `source` and `attributes` of the principal, without its `identity` (the acting user's model); the action itself still acts as the principal it was given. Every input key is a frozen copy, a mutable key a plain copy, and the `after` hooks get a frozen copy of the output. The action acts on its own values, so a write in place in a hook reaches nothing but the keys it may change. No input carries a password.

## Actions

| Action | Function | Input | Mutable | Checked again when changed | Output |
| --- | --- | --- | --- | --- | --- |
| `users.create` | `create()`, after its checks, before the insert | `data` (`Email`, `Login`, `Id?`, `Metadata?`; no password), `roles`, `user` (the unsaved `UserDraft`), `actor` | `user`, `data`, `roles` | email and login checks, reserved login, password policy and uniqueness for a changed email or login, `assertNoProtectedMetadata`, the role dry run | `{ User, Invited }` |
| `users.update` | `updateUser()` | `user`, `data` | `data` | uniqueness of a changed `Email` or `Login` | `UserView` |
| `users.activate` | `activate()` of an inactive account | `user` | none | | `UserView` |
| `users.deactivate` | `deactivate()` | `user` | none | | `UserView` |
| `users.ban` | `ban()`, after "already banned" | `user`, `reason`, `duration` | `reason`, `duration` | the reason (string, at most 255) and the duration (seconds, above 0) | `UserView` |
| `users.unban` | `unban()`, after "not banned" | `user` | none | | `UserView` |
| `users.delete` | `deleteUser()` | `user` | none | | none |
| `users.metadata.set` | `setUserMeta()` | `user`, `meta` (`{ key, value }[]`) | `meta` | `assertNoProtectedMetadata` | `UserView` |
| `users.password.expire` | `expirePassword()` | `user`, `actor` | none | | none |

Every action is refusable and throws `ActionRefused` (`action`, `code`) when refused, or `ActionHookFailed` when a `before` hook threw or timed out. [users-http](../users-http/README.md) answers a refusal of the route's own action with 403 `{ error: 'action_refused', code }` (`hook_error` for a failed hook).

The input and output types are exported from `@spinajs/users`: `UserView`, `UserDraft`, `ActorView`, `UsersCreateData`, `UsersCreateInput`, `UsersCreateOutput`, `UsersUpdateInput`, `UsersUserInput`, `UsersBanInput`, `UsersMetadataSetInput`, `UsersPasswordExpireInput`. `userView(user)` builds a `UserView` from a model, `actorView(principal)` an `ActorView`.

### `users.create` in detail

- A column a hook sets on `user` is on the inserted row (`IsActive`, `EmailVerifiedAt`, a column of your own). `Uuid`, the password marker, `PasswordSetAt` and `DeletedAt` stay `create()`'s. A column set on `user` wins over the same field in `data`.
- `roles` are the roles asked for, or `authz.rbac.defaultRoles` when none were. A hook that empties the list gets `authz.rbac.defaultRoles` again: a hook cannot create an account with no role while default roles are configured. Narrow the list instead, or refuse.
- `create()` writes `data.Metadata` itself, without the `users.metadata.set` hooks: the keys were checked with the create input, and a hook must not refuse an account that is already inserted.
- `Invited` is `true` when no password was given: the account got authn-local's invite instead of the `created` mail.
- Nothing is written before the `before` hooks ran, so a refused create leaves no row. A duplicate, a protected key or a refused role is refused before any hook runs.
- A failing `after` hook no longer makes `UserCreatedIncomplete`. That error stays for `create()`'s own later steps (the metadata, the event, the invite).

### `users.activate` on an active account

`activate()` of an account that is already active only drops `user:invite:pending`. It runs no hook, emits nothing and sends no mail.

## The shipped hooks

| Hook | Actions | What it does |
| --- | --- | --- |
| `UserLifecycleMailHook` | `users.create`, `.activate`, `.deactivate`, `.ban`, `.unban`, `.delete`, `.password.expire` (after) | Sends the [lifecycle mail](05-lifecycle-mails.md) of the action. On by default. |
| `UserPasswordStateHook` | `authn.password.change`, `.set`, `.reset.redeem` (after) | Writes `PasswordSetAt` and activates an invited account. See [Identity and password stores](07-identity-and-password-stores.md#the-password-state). |

Both are registered by users with `@Injectable(ActionHook)` on import.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Hook runner | `Hooks`, singleton | `DefaultHooks` (`@spinajs/hooks`) | | See [Declaring actions](../hooks/02-declaring-actions.md). |
| Your hooks | `ActionHook` list, read when `Hooks` resolves | `UserLifecycleMailHook`, `UserPasswordStateHook` | any number | `@Injectable(ActionHook)` or `DI.register(MyHook).as(ActionHook)` before the app boots. |
| Lifecycle mails | `UserLifecycleMailHook` | itself | your subclass | Override `send(user, mail)`; or `DI.unregister(UserLifecycleMailHook)` before boot for no lifecycle mail at all. |

### Activate accounts from a trusted domain

Accounts created for `@acme.com` addresses skip the activation step. The hook sets `IsActive` on the unsaved user, so no `activate()` call and no second mail are needed.

```ts sample
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import '@spinajs/users';

const TRUSTED_DOMAIN = '@acme.com';

export class ActivateTrustedDomain extends ActionHook<'users.create'> {
  readonly actions: readonly ActionPattern[] = ['users.create'];

  public before(ctx: BeforeContext<'users.create'>): void {
    if (ctx.input.user.Email.toLowerCase().endsWith(TRUSTED_DOMAIN)) {
      ctx.input.user.IsActive = true;
    }
  }
}
```

Register it with `DI.register(ActivateTrustedDomain).as(ActionHook)` before the app boots.

### Mirror new accounts into a CRM

The `after` hook runs once the account exists with its password or invite, roles and metadata.

```ts sample
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, AfterContext } from '@spinajs/hooks';
import '@spinajs/users';

interface CrmClient {
  upsertContact(contact: { externalId: string; email: string; name: string }): Promise<void>;
}

export class MirrorToCrm extends ActionHook<'users.create'> {
  public static crm: CrmClient = { upsertContact: async () => undefined };

  readonly actions: readonly ActionPattern[] = ['users.create'];

  public async after(ctx: AfterContext<'users.create'>): Promise<void> {
    const u = ctx.output.User;
    await MirrorToCrm.crm.upsertContact({ externalId: u.Uuid, email: u.Email, name: u.Login });
  }
}
```

### Refuse bans of service accounts

```ts sample
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import '@spinajs/users';

export class KeepServiceAccounts extends ActionHook<'users.ban' | 'users.delete'> {
  readonly actions: readonly ActionPattern[] = ['users.ban', 'users.delete'];

  public before(ctx: BeforeContext<'users.ban' | 'users.delete'>): void {
    if (ctx.input.user.Login.startsWith('svc-')) {
      ctx.refuse('service_account');
    }
  }
}
```

### Replace one mail, or turn them off

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import { UserLifecycleMailHook, sendUserEmail } from '@spinajs/users';
import type { User } from '@spinajs/users';

interface Chat {
  post(text: string): Promise<void>;
}

// Bans go to the moderators' channel instead of the user's inbox; every other mail as shipped.
@Injectable(ActionHook)
export class ModeratedMails extends UserLifecycleMailHook {
  public static chat: Chat = { post: async () => undefined };

  protected async send(u: User, mail: Parameters<typeof sendUserEmail>[1]): Promise<void> {
    if (mail === 'banned') {
      await ModeratedMails.chat.post(`${u.Login} was banned`);
      return;
    }
    await super.send(u, mail);
  }
}

// Only one lifecycle mail hook: unregister the shipped one before the app boots.
DI.unregister(UserLifecycleMailHook);
```

To send no lifecycle mail at all, call only `DI.unregister(UserLifecycleMailHook)`. Hook types are read when `Hooks` resolves, so unregister before the app boots; a change after that is not seen.

## Important behaviour

- **Checks first.** A request that is refused by `create()`'s own checks (a taken email, a protected key, a refused role) never reaches a hook, so a hook that writes to another system does not fire for it.
- **Narrow, never widen.** What a hook changes is checked again. `Uuid`, `Id` and `Password` of an update, and `Uuid` and the password marker of a new user, stay the action's.
- **Security steps are not hookable.** Once a ban, a deactivation or a delete proceeds, its session and token revocation, its user events and its state writes run inline. A refusal can only come before them.
- **A refused registration** (`POST /auth/register`) through a `users.create` hook reaches the route as the nested `ActionRefused`; the registrar spends the hash a taken address costs, and the route answers 202 as for any taken address.
- **A refused activation during a registration** (`users.registration.activate: true`, a `users.activate` hook that refuses) leaves the created account inactive: the account exists, the registrar passes the refusal on, and the route answers it as a nested refusal, 202 with `identity.register` audited as failed. An administrator activates the account later.
- **Where `users.update` runs.** Only `updateUser()` runs it; among the admin routes that is `PATCH /users/:uuid/restore`. `PATCH /users/:user` of [users-http](../users-http/06-user-administration.md) writes the row itself (`target.update()`), so `users.update` hooks do not run there.
- **After hooks cannot fail an action.** Their errors are logged on the `hooks` log by class.
- **Copies.** A `users.create` hook that changes nothing leaves `create()` with its own values, Luxon dates and metadata objects included.

## Migrating from the create middleware

| 2.x and 3.0 | 3.x |
| --- | --- |
| `users.actions.create.beforeCreate: [(u) => { ...; return u; }]` | an `ActionHook` on `users.create` with a `before` that changes `ctx.input.user`, `data` or `roles`, or refuses |
| `users.actions.create.afterCreate: [(u) => { ...; return u; }]` | an `ActionHook` on `users.create` with an `after` that reads `ctx.output.User` |
| an `afterCreate` throw: `UserCreatedIncomplete` | an `after` throw: logged, `create()` resolves |
| `CreateMiddleware` type | removed |

Before:

```ts
// config/users.ts
export default {
  users: {
    actions: {
      create: {
        beforeCreate: [(u: User) => { u.IsActive = true; return u; }],
      },
    },
  },
};
```

After:

```ts
@Injectable(ActionHook)
export class ActivateOnCreate extends ActionHook<'users.create'> {
  readonly actions: readonly ActionPattern[] = ['users.create'];

  public before(ctx: BeforeContext<'users.create'>): void {
    ctx.input.user.IsActive = true;
  }
}
```

A config that still declares `users.actions` changes nothing. [authz-convert](../authz-convert/05-findings-and-refusals.md) reports such lists as `create-middleware` findings.

## Related

- [User actions](03-user-actions.md): what each action does.
- [Lifecycle mails](05-lifecycle-mails.md): the mails `UserLifecycleMailHook` sends.
- [Writing a hook](../hooks/01-writing-a-hook.md): the `ActionHook` contract, order, timeouts.
- [authn-local action hooks](../authn-local/16-action-hooks.md): the `authn.password.*` actions `UserPasswordStateHook` hooks into.
