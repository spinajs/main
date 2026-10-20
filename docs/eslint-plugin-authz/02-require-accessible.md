# The `require-accessible` rule

`@spinajs/authz/require-accessible` reports a multi-row read of an `@AccessResource` model that runs without `.accessible(permission)`, `.unscoped(reason)` or an enclosing `runAs(...)`. Rule type: `problem`. It needs type information. It is the edit-time twin of the `@spinajs/authz-orm` runtime guard.

**Why it matters.** `@spinajs/authz-orm` never filters a query on its own. A select without `.accessible()` returns every matching row, whatever the caller may read. The run-time guard throws only in the `test` env, warns in `development` and is off in production ([The runtime guard](../authz-orm/07-runtime-guard.md)). The rule catches the leak in the editor and in CI, before it reaches production.

## How it works

The rule visits every `CallExpression` (`requireAccessible.create()`).

1. **Root.** The call must be `<Model>.<member>(...)`, where `<Model>` is an identifier (`Task`) or a member expression (`models.Task`). `this.where(...)` and computed members (`Task['where']`) are skipped.
2. **Member filter.** `get` and `getOrFail` return at once (single-object loads). Members outside `QUERY_ROOTS`, `KEY_LIST_READS` and `READ_SHORTCUTS` are skipped, which includes writes such as `create`, `insert`, `update` and `destroy`.
3. **Model.** `isAccessResourceClass()` resolves the type of `<Model>` and looks for `@AccessResource(...)` on the class or any class it extends. Names in the `resources` option count too ([Configuration](#configuration)).
4. **`runAs` exemption.** When the call sits inside an arrow function or function expression passed as an argument to `runAs(...)` or `<anything>.runAs(...)`, the rule stops.
5. **Shortcut reads.** A root in `READ_SHORTCUTS`, or `find` / `findOrFail` with anything but a one-element array literal, is reported as `unscopedShortcut`. These return a promise at once, so there is no builder to scope.
6. **Builder chains.** For a root in `QUERY_ROOTS`, the rule collects the calls chained on it (`Task.where(...).populate(...).first()`):
   - `where('<primary key>', value)` with no other `*where*` member in the chain is a single-object load: not reported. The primary key is the `@Primary()` property `primaryKeyOf()` finds;
   - the first `.accessible(` or `.unscoped(` ends the check: not reported;
   - the first executing member before any of them is reported as `unscopedQuery`;
   - a chain with no executing member is reported when its last call is directly `await`ed.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `resources` | `string[]` | `[]` | unique, non-empty class names | Classes to treat as `@AccessResource` models even when no decorator is visible, matched by class name. |

```js
rules: { '@spinajs/authz/require-accessible': ['error', { resources: ['User', 'JobModel'] }] }
```

Decorators do not survive into `.d.ts` files. A model a package ships compiled, such as `User` from `@spinajs/users` or `JobModel` from `@spinajs/authz-queue`, is found only when listed in `resources`. A listed class matches by name alone, whatever module it comes from. Wiring the options into `eslint.config.mjs`: [Flat config setup](01-flat-config-setup.md#examples).

## What it reports

| Kind | Members | Message id |
| --- | --- | --- |
| Query roots (`QUERY_ROOTS`) | `where`, `query`, `select`, `all`, `whereExists`, `whereNotExists`, `populate` | `unscopedQuery`, when the chain executes |
| Executing members (`EXECUTING_MEMBERS`) | `first`, `firstOrFail`, `firstOrThrow`, `orThrow`, `all`, `execute`, `asRaw`, `resultExists`, `selectCount`, `then`, or `await` on the chain | `unscopedQuery` |
| Shortcut reads (`READ_SHORTCUTS`) | `getOrNew`, `getOrCreate`, `first`, `last`, `newest`, `oldest`, `count`, `exists` | `unscopedShortcut` |
| Key-list reads (`KEY_LIST_READS`) | `find`, `findOrFail`, except with a one-element array literal | `unscopedShortcut` |

Messages:

| Message id | Reported on | Text | Fix |
| --- | --- | --- | --- |
| `unscopedQuery` | The executing call, or the `await` of an unexecuted chain | `{{model}} is an @AccessResource model: this query reaches {{call}} without .accessible(permission), .unscoped(reason) or an enclosing runAs(SYSTEM, reason).` | Add `.accessible(permission)`, or `.unscoped(reason)` for a deliberate system read |
| `unscopedShortcut` | The shortcut call | `{{model}}.{{call}}() reads more than one primary key of an @AccessResource model with nothing to scope: call it inside runAs(SYSTEM, reason), or use {{model}}.query() with .accessible(permission).` | Run it inside `runAs(SYSTEM, reason)`, or query with `.query()...accessible(permission)` |

`{{model}}` is the source text of the model expression (`Task`, `models.Task`, an import alias `T`). `{{call}}` is `.first()`, `.then()`, `await` and so on. The rule reports at most once per root call.

## What it does not report

| Code | Why |
| --- | --- |
| `Task.get(id)`, `Task.getOrFail(id)` | One primary-key value: a single-object load. |
| `Task.find([id])`, `Task.findOrFail([id])` | A one-element array literal is one primary-key value. |
| `Task.where('id', id).first()`, `await Task.where('id', id)` | `'id'` is the `@Primary()` property of `Task` or a class it extends, the value is not an array or object literal, and no other `*where*` member follows. |
| `Task.query().accessible('task:read').all()` | Scoped by the access plan. |
| `Task.query().unscoped('nightly export').all()` | Unscoped on purpose; `authz-orm` audits it. |
| `runAs(SYSTEM, 'job', async () => Task.where(...).first())` | Inside a `runAs(...)` callback. |
| `Task.create(...)`, `Task.destroy(id)` | Writes are not checked. |
| `const q = Task.where('a', 1); return q;` | The chain is neither executed nor awaited where it is built. |
| `Note.where('a', 1).first()` | `Note` is not an access resource. |

Single-object loads match what the run-time guard lets through (`isSingleObjectLoad()` in `@spinajs/authz-orm`). The route's check-before covers them: `@Access(...)` with `fromModel(...)`, or `authz().assert(me, permission, row)` ([Single-object checks](../authz-orm/05-single-object-checks.md)). The rule does **not** check that this check exists.

## Important behaviour

- **The model is found by type, not by name.** An import alias (`import { Task as T }`), a namespace object (`models.Task`) and a subclass of an access resource are all checked.
- **Any decorator named `AccessResource` counts.** The rule resolves the decorator's symbol through import aliases and compares its name; it does not check the module it comes from. `@authz.AccessResource('task')` counts too.
- **Any `runAs` exempts.** The rule matches the callee name only; it does not check the principal. The run-time guard exempts the `SYSTEM` principal, not a user, so `authz().runAs(user, reason, fn)` passes lint and still throws in the `test` env.
- **Only inline callbacks are exempt.** `runAs(SYSTEM, 'job', loadAll)` does not exempt the body of `loadAll`, declared elsewhere.
- **`.accessible()` must come before the executing member.** `Task.where('a', 1).first().then(...)` is reported at `.first()`, whatever follows.
- **The primary-key exemption is strict.** The column must be a string literal equal to the `@Primary()` property name. `Task.where('id', [1, 2])`, `Task.where('id', id).where('a', 1)` and `Task.findOrFail(ids)` are reported.
- **A primary key declared only in a `.d.ts` base class is invisible**, and so is the one of a class listed in `resources`: `where('<pk>', id)` on such a model is reported. `get(id)` and `findOrFail([id])` are not.

## Suppressing the rule

Fix the query first. In order of preference:

1. Add `.accessible(permission)` when the caller's grants should decide the rows.
2. Add `.unscoped(reason)` when every row is the intended answer, such as an export for an admin route that is checked before. `authz-orm` writes an `unscoped` audit entry with the reason when `authz.audit.unscoped` is on.
3. Wrap code that has no user (a job, a CLI command, a migration) in `authz().runAs(SYSTEM, reason, fn)`. `runAs` is audited too.

An `eslint-disable` comment fits the cases the rule cannot see, and the run-time guard lets through. Always give the reason after `--`:

```ts
// Called only from runArchiveJob(), inside authz().runAs(SYSTEM, 'archive', ...)
export async function doneTasks() {
  // eslint-disable-next-line @spinajs/authz/require-accessible -- runs as SYSTEM, see runArchiveJob()
  return await Task.where('status', 'done');
}

// Invoice comes from a compiled package and is listed in `resources`; its @Primary() is not visible
// eslint-disable-next-line @spinajs/authz/require-accessible -- one primary key: a single-object load
const invoice = await Invoice.where('Id', id).firstOrFail();
```

A disable comment silences the rule only. The run-time guard still throws on that query in the `test` env unless it runs as `SYSTEM`, is a single-object load, or is scoped.

## What it misses

The rule reads one expression at a time. It does **not** report:

- a builder kept in a variable and executed later (`const q = Task.where(...); await q;`);
- a builder returned unexecuted from an `async` function (`return Task.query()`);
- `Promise.all` over builders;
- instance relations, and `populate()` of an access-resource child;
- queries built on `this` inside a model's own static methods.

The run-time guard catches these in the `test` env with an `AuthzConfigError`. Run your tests with it on.

## Patterns and antipatterns

```ts
// Don't: lists every task in the table, whatever the caller may read
const tasks = await Task.where('project_id', projectId);

// Do
const tasks = await Task.where('project_id', projectId).accessible('task:read');
```

```ts
// Don't: several keys in one read, with nothing to scope
const picked = await Task.findOrFail(ids);

// Do
const picked = await Task.query().whereIn('id', ids).accessible('task:read');
```

```ts
// Don't: count() runs at once, there is no builder to scope
const total = await Task.count();

// Do: a deliberate system read, with the reason in the audit
const total = await authz().runAs(SYSTEM, 'nightly report', () => Task.count());
```

```ts
// Don't: .within() narrows to a team, it does not authorize
const teamTasks = await Task.query().within({ type: 'team', id: teamId }).all();

// Do
const teamTasks = await Task.query().within({ type: 'team', id: teamId }).accessible('task:read').all();
```

```ts
// Don't: lint accepts any runAs, but the run-time guard exempts only SYSTEM and throws in the test env
const report = await authz().runAs(user, 'weekly-report', async () => await Task.where('status', 'open'));

// Do: acting as a user, the user's grants decide the rows
const report = await authz().runAs(user, 'weekly-report', async () => await Task.where('status', 'open').accessible('task:read'));
```

## Examples

### List a caller's open tasks, and archive done tasks in a nightly job

```ts sample
import { AccessResource } from '@spinajs/authz-orm';
import { SYSTEM, authz } from '@spinajs/authz';
import { Model, ModelBase, Primary } from '@spinajs/orm';

@AccessResource('task')
@Model('tasks')
export class Task extends ModelBase<Task> {
  @Primary()
  public id!: number;

  public status!: string;
}

// A route handler: the access plan of 'task:read' decides the rows
export async function openTasks() {
  return await Task.where('status', 'open').accessible('task:read');
}

// A single-object load: not reported; the route's check-before authorizes it
export async function taskById(id: number) {
  return await Task.where('id', id).first();
}

// A job has no user: it runs as SYSTEM, audited with its reason
export async function doneTasks() {
  return await authz().runAs(SYSTEM, 'nightly-archive', async () => await Task.where('status', 'done'));
}
```

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

- [Flat config setup](01-flat-config-setup.md): turn the rule on and set `resources`.
- [Access lists](../authz-orm/01-access-lists.md): `.accessible()`, `.unscoped()` and `.within()`.
- [The runtime guard](../authz-orm/07-runtime-guard.md): `AccessGuardMiddleware`, the run-time twin of this rule.
- [Checking permissions](../authz/03-checking-permissions.md): `authz().runAs(SYSTEM, reason, fn)`.
