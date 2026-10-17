# Create middleware

Functions in configuration that `create()` runs on the new user: `beforeCreate` before the row is inserted, `afterCreate` after it exists with its password, roles and metadata. Use them to set fields `create()` does not take, or to mirror a new account into another system.

## How it works

1. `create()` validates its input, checks uniqueness and dry-runs the role grants (see [User actions](03-user-actions.md#createdata-roles-actor--system)).
2. It reads `users.actions.create.beforeCreate` with `cfg(path, [])`. A value that is not an array counts as no middleware.
3. It calls each function in list order with the `User` built so far and continues with what the function returns (sync or async).
4. It inserts the returned user, sets the password or the invite marker, grants the roles and writes `data.Metadata`.
5. It runs `users.actions.create.afterCreate` the same way.
6. It emits `UserCreated` and sends the invite or the `created` mail for the user the last `afterCreate` returned.

Errors:

- A `beforeCreate` throw stops `create()` before the insert; nothing is written and the error propagates as is.
- An `afterCreate` throw leaves the account in place; `create()` throws `UserCreatedIncomplete` with the account's `Uuid`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `users.actions.create.beforeCreate` | `CreateMiddleware[]` | `[]` | functions `(u: User) => User \| Promise<User>` | Run before the insert. |
| `users.actions.create.afterCreate` | `CreateMiddleware[]` | `[]` | same | Run after the insert, roles and metadata. |

The values are functions, so they live in a `.ts` or `.js` config file of your app. Arrays from several config files are concatenated, so a package or a module can add its own entries.

```ts
// config/users.ts in your app
import type { User } from '@spinajs/users';

export default {
  users: {
    actions: {
      create: {
        beforeCreate: [(u: User) => { u.IsActive = true; return u; }],
        afterCreate: [],
      },
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Create hooks | config keys `users.actions.create.beforeCreate` / `afterCreate`, read on every `create()` | none (empty lists) | any number of functions | Add functions in a config file, or `Configuration.set(path, [...])` at runtime. |

### Custom middleware: activate accounts from a trusted domain

Accounts created for `@acme.com` addresses skip the activation step. The middleware sets `IsActive` before the insert, so no `activate()` call and no second mail are needed.

```ts sample
import type { CreateMiddleware, User } from '@spinajs/users';

const TRUSTED_DOMAIN = '@acme.com';

export const activateTrustedDomain: CreateMiddleware = (u: User) => {
  if (u.Email.toLowerCase().endsWith(TRUSTED_DOMAIN)) {
    u.IsActive = true;
  }
  return u;
};

// config/users.ts in your app
export default {
  users: {
    actions: {
      create: {
        beforeCreate: [activateTrustedDomain],
      },
    },
  },
};
```

## Important behaviour

- `beforeCreate` gets a base `User`, also when the application registered its own [user model](02-custom-user-model.md).
- Uniqueness is checked **before** `beforeCreate`. A middleware that changes `Login` or `Email` can hit the unique index and fail with a driver error instead of `UserAlreadyExists`.
- Protected metadata is refused before `beforeCreate` runs, so a refused request never reaches a middleware that writes to another system.
- `afterCreate` runs before `UserCreated` is emitted and before the invite is sent. A slow `afterCreate` delays the invite mail.
- A middleware must return the user. Returning `undefined` makes the next step fail.

## Best practices

- Keep `beforeCreate` to field changes on the `User`; do side effects (HTTP calls, other databases) in `afterCreate`, where the account is known to exist.
- Make `afterCreate` idempotent: on `UserCreatedIncomplete` a caller may retry parts of the flow.
- Use `data.Metadata` of `create()` for per-call metadata; middleware is for rules that apply to every account.

## Patterns and antipatterns

```ts
// Don't: a side effect in beforeCreate runs even when the insert or the password set then fails
beforeCreate: [async (u: User) => { await crm.createContact(u.Email); return u; }],

// Do: mirror the account once it exists
afterCreate: [async (u: User) => { await crm.createContact(u.Email); return u; }],
```

## Examples

### Mirror new accounts into a CRM

```ts sample
import type { CreateMiddleware, User } from '@spinajs/users';

interface CrmClient {
  upsertContact(contact: { externalId: string; email: string; name: string }): Promise<void>;
}

export function mirrorToCrm(crm: CrmClient): CreateMiddleware {
  return async (u: User) => {
    await crm.upsertContact({ externalId: u.Uuid, email: u.Email, name: u.Login });
    return u;
  };
}
```

Register it from a config file: `afterCreate: [mirrorToCrm(crmClient)]`.

## Related

- [User actions](03-user-actions.md): the full `create()` flow.
- [Config files](../configuration/03-config-files.md): where the middleware lists are declared and how arrays merge.
