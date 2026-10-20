# The runtime guard

`AccessGuardMiddleware` catches a multi-row select of an `@AccessResource` model that nobody authorized. In the `test` env it throws, so CI fails; in `development` it warns once per call site; in production it is off.

It only reads the builder. It never adds a filter: a flagged query still runs unfiltered where the guard is off. Pair it with the ESLint rule of `@spinajs/eslint-plugin-authz`, which flags the same at edit time.

## How it works

1. `afterQueryCreation(query)` runs when a select builder of an `@AccessResource` model is created. In `warn` mode only, it records the call site: the first stack frame outside `di`, `util`, `orm`, any `orm-<name>` package, `authz` and `authz-orm` (their `src` or `lib` folders).
2. `beforeQueryExecution(query)` lets the query through when any of these holds:
   - the builder is marked `.accessible(permission)` or `.unscoped(reason)`;
   - the current principal is `SYSTEM` (inside `authz().runAs(SYSTEM, reason, fn)`);
   - the request runs a route marked `@Unscoped(reason)` (authz-http stores the reason in the authz request storage);
   - the query is a single-object load (see below).
3. Otherwise `guardMode()` decides: `throw` raises `AuthzConfigError` (`a select of <Model> (@AccessResource '<type>') runs without .accessible(permission), .unscoped(reason) or runAs(SYSTEM)`), `warn` logs the same once per call site, `off` does nothing.

### Single-object loads

A select whose where statements are exactly one primary-key equality is a single-object load: `where('id', 42)`, `get(42)`, `getOrFail(42)`, `findOrFail([42])`. The route's `@Access` or your `assert()` covers it, so the guard leaves it alone.

- The `IS NULL` statements the ORM adds for `@SoftDelete` and `@Archived` columns do not count.
- `whereIn(pk, [one value])` counts as one equality; two values do not.
- Any other statement, a second key, or an `OR` makes it a list.

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

- **Selects only.** Updates and deletes are not guarded; mark them with `.accessible()` yourself.
- **`.within()` and `.withAccess()` alone do not satisfy it.** `.within()` narrows and `.withAccess()` annotates; neither authorizes.
- **Relations are selects too.** A `populate()` of an `@AccessResource` model builds its own select; call `.accessible()` in the populate callback ([Access lists](01-access-lists.md#important-behaviour)).
- **The call site is taken only in `warn` mode.** In `throw` and `off` mode no stack is captured.
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
