# `require-accessible` rule

`@spinajs/authz/require-accessible` reports a select on an `@AccessResource` model that reads more than one row without `.accessible(permission)`, `.unscoped(reason)` or an enclosing `runAs(SYSTEM, reason)`. It is the edit-time twin of the `@spinajs/authz-orm` runtime guard.

## How it works

1. On every call `X.<member>(...)`, the rule checks the member name. `get` and `getOrFail` stop here: they load one primary key.
2. It resolves `X` through the type checker. `isAccessResourceClass()` accepts it when the class, or a class it extends, has `@AccessResource(...)`, however the decorator or class is imported or renamed, or when the class name is in `resources`.
3. A call inside a function or arrow passed to `runAs(...)` or `x.runAs(...)`, such as `authz().runAs(SYSTEM, reason, fn)`, is exempt.
4. A read shortcut (`getOrNew`, `getOrCreate`, `first`, `last`, `newest`, `oldest`, `count`, `exists`, or `find` / `findOrFail` with anything but a one-element array literal) is reported as `unscopedShortcut`.
5. A query root (`where`, `query`, `select`, `all`, `whereExists`, `whereNotExists`, `populate`) starts a chain. `where('<primary key>', value)` with no other `where*` call in the chain is exempt; the primary key is the `@Primary()` property found by `primaryKeyOf()`.
6. The rule walks the chained calls. `.accessible(` or `.unscoped(` ends the walk with no report.
7. An executing member (`first`, `firstOrFail`, `firstOrThrow`, `orThrow`, `all`, `execute`, `asRaw`, `resultExists`, `selectCount`, `then`) reached first is reported as `unscopedQuery`. A chain with no executing member is reported when it is awaited.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `resources` | `string[]` | `[]` | unique, non-empty class names | Classes to treat as `@AccessResource` models, matched by class name |

```js
rules: { '@spinajs/authz/require-accessible': ['error', { resources: ['User', 'JobModel'] }] }
```

Decorators do not survive into `.d.ts` files. A model a package ships compiled, such as `User` from `@spinajs/users` or `JobModel` from `@spinajs/authz-queue`, is found only when listed in `resources`.

## Messages

| Message id | Reported on | Fix |
| --- | --- | --- |
| `unscopedQuery` | The executing call, or the `await` of an unexecuted chain | Add `.accessible(permission)`, or `.unscoped(reason)` for a deliberate system read |
| `unscopedShortcut` | The shortcut call | Run it inside `runAs(SYSTEM, reason)`, or query with `.query()...accessible(permission)` |

## Important behaviour

- Single-object loads are not reported: `get(id)`, `getOrFail(id)`, `find([id])`, `findOrFail([id])`, and a lone primary-key `where`. The route's `@Access` check covers them.
- Writes (`create`, `insert`, `update`, `destroy`) are not checked.
- The rule misses a builder kept in a variable and executed later, a builder returned unexecuted from an `async` function, `Promise.all` over builders, instance relations, and `populate()` of an access-resource child. The runtime guard, which throws `AuthzConfigError` in the `test` env, catches those.
- A primary key declared only in a `.d.ts` base class is invisible, so `where('<pk>', id)` on such a model is reported.

## Patterns and antipatterns

```ts
// Don't: lists every task, whatever the caller may read
const tasks = await Task.where('status', 'open');

// Do
const tasks = await Task.where('status', 'open').accessible('task:read');
```

```ts
// Don't: count() runs at once, there is no builder to scope
const total = await Task.count();

// Do: a deliberate system read, with the reason in the audit
const total = await authz().runAs(SYSTEM, 'nightly report', () => Task.count());
```

## Examples

### Paginate the caller's tasks

```ts
const page = await Task.where('project_id', projectId)
  .accessible('task:read', { onNone: 'empty' })
  .orderBy('created_at')
  .take(50);
```

`onNone: 'empty'` returns no rows to a caller who can never hold `task:read`, instead of `AccessDenied`.

### Export every archived task in a backup job

```ts
const archived = await Task.where('archived', true).unscoped('nightly backup export');
```

`.unscoped(reason)` needs a non-empty reason and is audited when `authz.audit.unscoped` is on.

## Related

- [Flat config setup](01-flat-config-setup.md): turn the rule on.
- [`@spinajs/authz`, ORM adapter](../authz/README.md#orm-spinajsauthz-orm): `.accessible()`, `.unscoped()`, `runAs()` and the runtime guard.
