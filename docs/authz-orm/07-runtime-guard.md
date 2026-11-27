# The runtime guard

`AccessGuardMiddleware` catches a multi-row select of an `@AccessResource` model that nobody authorized, and the update or delete a relation list's `sync()` builds on one. In the `test` env it throws, so CI fails; in `development` it warns once per call site; in production it is off.

It only reads the builder. It never adds a filter: a flagged query still runs unfiltered where the guard is off. Pair it with the ESLint rule of `@spinajs/eslint-plugin-authz`, which flags the same at edit time.

## How it works

1. `afterQueryCreation(query)` runs when a select builder of an `@AccessResource` model is created. In `warn` mode only, it records the call site: the first stack frame outside `di`, `util`, `orm`, any `orm-<name>` package, `authz` and `authz-orm` (their `src` or `lib` folders) that is not the `at async Promise.all (index N)` frame of `Promise.all()`, `allSettled()`, `any()` or `race()`.
2. `beforeQueryExecution(query)` lets a select through when any of these holds:
   - the builder is marked `.accessible(permission)` or `.unscoped(reason)`;
   - the current principal is `SYSTEM` (inside `authz().runAs(SYSTEM, reason, fn)`);
   - the request runs a route marked `@Unscoped(reason)` (authz-http stores the reason in the authz request storage);
   - the query is a single-object load (see below);
   - the query is the many-to-many select of existing links that a relation list's `sync()` or `update()` runs ([`relationSyncOf(query)`](../orm/05-query-builder.md#statements-of-a-relation-lists-sync-and-update) answers for it). Its rows never reach the caller.
3. Otherwise `guardMode()` decides: `throw` raises `AuthzConfigError` (`a select of <Model> (@AccessResource '<type>') runs without .accessible(permission), .unscoped(reason) or runAs(SYSTEM)`), `warn` logs the same once per call site, `off` does nothing.
4. An update or delete is checked only when `relationSyncOf(query)` answers for it: the one-to-many orphan delete (the soft-delete stamp for a `@SoftDelete` target) and the many-to-many orphan delete of junction rows. On an `@AccessResource` model it passes on the same marks, `SYSTEM` and route `@Unscoped`; there is no single-object exemption. Otherwise `throw` raises `AuthzConfigError` (`sync() of <Owner>.<relation> writes <Model> (@AccessResource '<type>') without .accessible(permission), .unscoped(reason) or runAs(SYSTEM)`) before the statement runs, inside the transaction of `sync()`, so nothing of that call is written, its inserts included. `warn` logs the same once per call site, `off` does nothing.

### A relation list's `sync()`

Mark the statements `sync()` builds through its callback, or run it as `SYSTEM`:

```ts
// nothing authorized, Comment is @AccessResource
await post.Comments.sync();
// test: AuthzConfigError   dev: warning   production: runs

// authorized: the callback marks every write statement sync() builds
await post.Comments.sync(function () {
  this.accessible('comment:delete');
});
// a row sync() must write that the caller may not touch: AccessDenied, the whole sync rolls back

// background job
await authz().runAs(SYSTEM, 'nightly import', () => post.Comments.sync());
```

`.accessible(permission)` in the `sync()` callback refuses instead of narrowing ([Access lists](01-access-lists.md#important-behaviour)).

### Single-object loads

A select whose where statements are exactly one primary-key equality is a single-object load: `where('id', 42)`, `get(42)`, `getOrFail(42)`, `findOrFail([42])`. The route's `@Access` or your `assert()` covers it, so the guard leaves it alone.

Inside a route whose `@Access` decision is conditional (its residual is not `TRUE`: a type-level rule, or `conditional: 'action'`), no check covered that row, so the guard flags a single-object load like any other select. Outside a request, where no decision is stored, single-object loads pass as before.

- The `IS NULL` statements the ORM adds for `@SoftDelete` and `@Archived` columns do not count.
- `whereIn(pk, [one value])` counts as one equality; two values do not.
- Any other statement, a second key, or an `OR` makes it a list.
- The `OR` counts wherever it stands after the first statement, the `IS NULL` statements included. The ORM joins where statements without grouping them, so on a `@SoftDelete` model `Task.query().orWhere('id', 42)` reads `deleted_at IS NULL OR id = 42`: every live row. `Task.where('id', 42).orWhere('deleted_at', null)` is a list for the same reason. An `orWhere()` that is the only statement (`Task.query().withDeleted().withArchived().orWhere('id', 42)`) is still one equality.
- On a composite primary key every key column needs its own equality, joined by `AND`: `Line.where('order_id', 'o1').where('id', 'l2')` is a single-object load, `Line.where('order_id', 'o1')` is a list (it reads every line of the order). `get([...])` and `findOrFail([[...]])` bind a composite key inside a nested group, which the guard does not look into, so they are lists too. Bind the whole key with top-level `where()` calls, or read with `.accessible(permission)`. The authz domain boot refuses an `@AccessResource` model with a composite key with an `AuthzConfigError`; the rule covers queries that run before a domain booted.

## `guardMode()`

| Env (`process.env.APP_ENV` in the configuration) | Mode | Effect |
| --- | --- | --- |
| `test` | `'throw'` | `AuthzConfigError` |
| `dev`, or `development` named by an env source | `'warn'` | one warning per call site (`authz-orm` log) |
| `production`, `prod`, any other value, unset | `'off'` | nothing |

The env is normalized with `normalizeEnvironment()` from `@spinajs/configuration`. A `development` value that is only the configuration's fallback, named by no env source (the configuration's `Env`, the DI-registered `process.env`, `APP_ENV` or `NODE_ENV`), counts as unset. A forgotten env therefore never warns in production.

## Configuration

The guard has no `authz.orm` keys. It reads the app env; `authz.audit.unscoped` controls the audit entry of `.unscoped(reason)` ([Access lists](01-access-lists.md#builder-methods)).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AccessGuardMiddleware` | `QueryMiddleware`, registered by `@Injectable(QueryMiddleware)` on import; order 95 | `AccessGuardMiddleware` | none | Not meant to be replaced. Pick its mode through the env. |
| `guardMode(config?)` | exported function | | | Read the mode the guard uses, for example in a test setup. |

## Important behaviour

- **Selects, and the write statements of a relation's `sync()`.** Updates and deletes the application builds itself (`Task.update(...)`, `Task.destroy(...)`) are not guarded; mark them with `.accessible()` yourself.
- **Only `@AccessResource` models are guarded in a `sync()`.** A one-to-many target or a many-to-many junction model that is not an `@AccessResource` is never flagged; authorize the owner with `authz().assert()` before the call.
- **The inserts of a `sync()` are not covered.** Access lists filter rows that exist; the rows `sync()` inserts or upserts pass neither the guard nor `.accessible()`.
- **`.within()` and `.withAccess()` alone do not satisfy it.** `.within()` narrows and `.withAccess()` annotates; neither authorizes.
- **hasMany relations are selects too.** A hasMany `populate()` of an `@AccessResource` model builds its own select; call `.accessible()` in the populate callback. A belongsTo or many-to-many populate runs no select of its own and a `@Recursive` one would filter its root rows only, so `.accessible()` in their callbacks throws `AuthzConfigError` ([Access lists](01-access-lists.md#important-behaviour)).
- **The select of existing links is not flagged.** A many-to-many `sync()` or `update()` reads its junction rows to tell existing links from missing ones; the guard lets that read through, so `update()` of a list with an `@AccessResource` junction model needs no mark.
- **The call site is taken only in `warn` mode.** In `throw` and `off` mode no stack is captured. For a select it is taken when the builder is created; for a `sync()` statement it is taken when the guard is about to warn, from the async stack, which holds the app's `async` function that awaited `sync()`.
- **Behind a queue of outermost transactions the app's line is lost.** SQLite runs one outermost transaction at a time through a queue whose `.then()` ends the async stack, so a `sync()` that opens its own transaction there has no app frame on it: the warning names `unknown call site` and comes once per owner and relation instead of once per line. With an unknown call site the warning is keyed by owner and relation, so a second unguarded call site of the same relation stays silent in `warn` mode; the `test` env still throws at every one. A `sync()` inside the app's own transaction (a savepoint), and drivers that run transactions concurrently, keep the app's line.
- **Plain models are ignored.** A select of a model without `@AccessResource` is never flagged.

## Best practices

- Run the test suite with `APP_ENV=test`, so every unauthorized list fails a test.
- Prefer `.accessible()` over `.unscoped(reason)`; keep `.unscoped()` for admin exports and background jobs, with a reason an auditor understands.
- Add `@spinajs/eslint-plugin-authz` (rule `@spinajs/authz/require-accessible`) to catch the same calls before they run ([`@spinajs/eslint-plugin-authz`](../eslint-plugin-authz/README.md)).

## Patterns and antipatterns

```ts
// Don't: a list of tasks with no access decision; in the test env this throws AuthzConfigError
const tasks = await Task.where('status', 'open');

// Do: filter by the caller's access, or state why the list is unfiltered
const tasks = await Task.where('status', 'open').accessible('task:read');
const all = await Task.where('status', 'open').unscoped('nightly SLA report');
```

## Examples

### Run a nightly report over every task

```ts sample
import { SYSTEM, authz } from '@spinajs/authz';
import { AccessResource } from '@spinajs/authz-orm';
import { Model, ModelBase, Primary } from '@spinajs/orm';

@AccessResource('task')
@Model('tasks')
export class Task extends ModelBase<Task> {
  @Primary()
  public id!: number;

  public status!: string;
}

export async function overdueReport() {
  // runAs is audited with its reason; the guard lets SYSTEM through
  return await authz().runAs(SYSTEM, 'nightly overdue report', async () => await Task.where('status', 'overdue'));
}
```

## Related

- [Access lists](01-access-lists.md): `.accessible()` and `.unscoped()`.
- [Single-object checks](05-single-object-checks.md): what covers a primary-key load.
- [`@spinajs/eslint-plugin-authz`](../eslint-plugin-authz/README.md): the same rule at edit time.
- [`@spinajs/authz`](../authz/01-check-flow.md#concepts): `SYSTEM`, `UNATTENDED` and `runAs`.
