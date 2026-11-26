# Declaring access resources

`@AccessResource(type)` turns an ORM model into an authz resource type. `@Parent`, `@Owner` and `@Self` name the columns that place a row in the resource tree and tie it to a principal. `registerAccessResource()` does the same for a model class your package does not own.

Declare every model whose rows a permission protects. The declaration drives single-object checks, `.accessible()` lists, the ancestor table and the runtime guard.

## How it works

1. The decorators run when the class is defined. `@Parent`, `@Owner` and `@Self` run first and store property metadata for the class. `@AccessResource(type)` then calls `register(model, type)` in the package registry (`registry.ts`).
2. `registerAccessResource(model, type, opts)` calls the same `register()` with the columns as options. A second call with the same arguments is a no-op; with other arguments it throws `AuthzConfigError`.
3. `entryOf(model)` builds the model's `ResourceEntry` on first use and caches it until the registry changes. It walks the class chain base first, so a subclass inherits the entry of its nearest registered ancestor, adds its own `@Parent` columns and may override `@Owner` and `@Self`. The id column is the model's primary key (`@Primary()`).
4. At the authz domain boot, the engine reads `OrmResourceAdapter.types` (every registered type) and `OrmResourceAdapter.permissions()`, which adds `<type>:read`, `<type>:create`, `<type>:update` and `<type>:delete` for each type ([Single-object checks](05-single-object-checks.md)).
5. `AuthzOrmContributor` passes the registered types to the domain as `listTypes`, so boot rule 12 refuses a `list: true` permission on any other type ([the authz guide](../authz/01-check-flow.md#concepts)).
6. `OrmResourceAdapter.relations()` gives the engine one `owner` resolver for each type with an owner column and one `self` resolver for each type with a self column.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@AccessResource(type)` | class | `type`: a non-empty resource type, not `'$global'` | Registers the class as resource `type`. Several classes may share one type. |
| `@Parent(type, opts?)` | property | `type`: the parent's resource type. `opts.nullable?: boolean` | The column holds the id of the parent resource of `type`. A model may have several `@Parent` columns; a self-reference (`@Parent('folder')` on `Folder`) builds a tree of any depth. One `@Parent` per property. |
| `@Owner(opts?)` | property | `opts.typeColumn?: string`: a column holding the owner's principal type | The `owner` relation: the column holds the owner's principal id. Without `typeColumn` the owner is a `user` principal. One `@Owner` per model. |
| `@Self()` | property | none | The `self` relation: the row is the `user` principal whose id the column holds. One `@Self` per model. |

The column name is the property name. A symbol property throws `AuthzConfigError`.

`@Owner`, `@Self` and `@Parent` without `@AccessResource` (or `registerAccessResource()`) on the class or an ancestor have no effect.

## `registerAccessResource(model, type, opts?)`

| Option | Type | Meaning |
| --- | --- | --- |
| `parents` | `readonly { column: string; type: ResourceType }[]` | The `@Parent` columns. |
| `owner` | `string \| { column: string; typeColumn?: string }` | The `owner` column, alone or with a principal type column. `typeColumn` must differ from `column`. |
| `self` | `string` | The `self` column. |

Any other option key throws `AuthzConfigError` (`unknown option '<key>'`).

When a class has both decorators and a registration, they merge. A column declared both ways must name the same parent type, and an owner or self declared both ways must name the same columns; a conflict throws `AuthzConfigError`.

## Registry lookups

| Export | Returns |
| --- | --- |
| `entryOf(model)` | The `ResourceEntry` of the model or its nearest registered ancestor, or `undefined`. |
| `classesOf(type)` | The registered classes of `type`, in registration order. |
| `registeredTypes()` | Every registered type, in first-registration order. |
| `typesAbove(type)` | The parent types of `type`'s classes, transitively, nearest first. It never lists `type` itself, even for a self-referencing `@Parent`. |

`ResourceEntry`:

| Member | Type | Meaning |
| --- | --- | --- |
| `registered` | class | The registered class; for a subclass, its nearest registered ancestor. |
| `type` | `ResourceType` | The resource type. |
| `parents` | `readonly ParentEntry[]` | `{ property, column, type, nullable }` per `@Parent` column. |
| `owner` | `{ property, column, typeColumn? }` or absent | The `owner` relation columns. |
| `self` | `{ column }` or absent | The `self` relation column. |
| `idColumn` | `string` | The primary key column. A model without one throws `AuthzConfigError` here. |

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `authz.orm.requireHistory` | `boolean` | `false` | Refuse a write of an `@AccessResource` model that no history observer records ([Writes that must reach the history](#writes-that-must-reach-the-history)). |

Declaring resources has no other config keys. The section `authz.orm` keeps only the keys its schema declares: any other key under it (a misspelt `requireHistory`, or a key of the application's own) is removed when the configuration is validated. A misspelt `requireHistory` therefore leaves the check off, and nothing says so: the configuration does not yet log the keys it removes. The permissions resources add still need `list: true` before `.accessible()` or `.withAccess()` uses them ([Access lists](01-access-lists.md#configuration)).

## Writes that must reach the history

Decision replay rebuilds a resource's relations (its `@Parent`, `@Owner` and `@Relation` columns) from the row history `@spinajs/authz-replay` records. A process that writes resource rows without that package, or before the package registered the model, makes changes the history never sees, while the coverage another process recorded says the table is complete. Set `authz.orm.requireHistory` in the configuration every process shares, and such a write fails instead. The key is off by default, and it is read by each process on its own: a process whose configuration lacks it is not checked.

```ts
export default {
  authz: { orm: { requireHistory: true } },
};
```

```ts
// a worker that imports @spinajs/authz-orm but not @spinajs/authz-replay
await Doc.update({ folder_id: 'f2' }).where('id', 'd1');
// rejects with UnrecordedResourceWrite (an AuthzConfigError) before the statement runs:
// authz-orm: an update of Doc (resource 'doc') is not recorded by any history observer, and authz.orm.requireHistory refuses it; …
```

| Write | Judged |
| --- | --- |
| an insert or a delete of the model | always |
| an update, `reparent()`, a relation list's `sync()` | when it writes a `@Parent`, `@Owner` or `@Relation` column, the type column of one, or the primary key; an update of any other column (`@Self`, a soft delete, a restore) passes |
| a model with `{ changelog: false }`, or without relation columns | never |
| a builder without a model (`driver.update()`, `insertChunked`, `deleteChunked`, `purgeBatch`), raw SQL, `Model.truncate()`, a cascade or trigger in the database | never: the write capture does not see them |
| a model class on the same table that is no access resource in this process | never |

A write passes when a `WriteObserver` with `keepsHistory: true` takes the statement and records every relation and type column of the model: its interest's `columns` minus its `unrecorded` ([Write capture](../orm/25-write-capture.md#an-observer)). An interest without `unrecorded` makes no claim about what it records and counts as recording nothing; an observer that keeps every column it reads sets `unrecorded: []`. The row history observer of `@spinajs/orm-history` sets it on every interest, and `@spinajs/authz-replay` registers every `@AccessResource` model with it. A history that does not record a relation column does not satisfy the key: with `@History({ columns })` that leaves one out, `@History({ exclude })` that names one, or a `@Hidden()` relation column the history masks, every judged write of the model is refused. List every relation and type column in `columns`, exclude none, and give a hidden one `hidden: 'record'`.

The message of the `UnrecordedResourceWrite` says which case it is:

| Case | Message |
| --- | --- |
| no history observer takes the write, also an update that a column-mode history skips because it writes none of the listed columns | `… is not recorded by any history observer …`; it names the model and the resource type, no column, and gives both remedies: import `@spinajs/authz-replay`, or opt the model out with `{ changelog: false }` |
| a history observer takes it but does not record some relation or type columns | `… is kept by a history observer that does not record <columns> …`; it names the model, the resource type and those columns |
| a history observer takes it with no `unrecorded` in its interest | `… is taken by the history observer <class>, which does not say which columns it records …`; it names the observer's class and asks its `interest()` to set `unrecorded` |

The check runs before the statement is sent and adds no query. `null`, or a value of the key that is no boolean, refuses every judged write; with the key unset or `false` nothing is checked.

The guard is registered when `@spinajs/authz-orm` is imported, so it also runs in a CLI command, a seed or a queue worker that boots no authz domain. It knows a model as a resource only where the model was registered in that process: prefer the decorator on the class, and when a model is registered with `registerAccessResource()` in another module (the queue's job model, by `@spinajs/authz-queue/jobs`), import that module in every process that writes the model. A run without refusals shows that every model write of a registered resource was recorded in the processes that have the key; it says nothing about the writes in the last two rows of the table.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Resource registry | module state, not in DI; one per process | `registry.ts` | none | Not replaceable. Declare models with the decorators or `registerAccessResource()`. |
| `AuthzOrmContributor` | `AuthzContributor`, `@Singleton()`, registered when `@spinajs/authz-orm` is imported | `AuthzOrmContributor` | none | Not meant to be replaced. It runs `checkResourceConnections()` and returns `{ listTypes: registeredTypes() }` at every domain boot once the `Orm` is resolved. |
| `ResourceHistoryGuard` | `WriteObserver`, singleton, registered when `@spinajs/authz-orm` is imported | `ResourceHistoryGuard` | none | Not meant to be replaced. With `authz.orm.requireHistory` on it refuses a resource write that no history observer takes with every relation and type column recorded; with it off it takes no statement. |

## Important behaviour

- **Register before the domain boots.** Decorate at import, or call `registerAccessResource()` in a `Bootstrapper`. The authz contract refuses a type an adapter starts listing after boot: using it throws `AuthzConfigError`.
- **Permission names keep the type's case.** `@AccessResource('task')` adds `task:read`, never `Task:read`. Permissions compare exactly.
- **Several models, one type.** The adapter loads a ref by trying the classes of its type in registration order; the first class with a row of that id wins. The four permissions are added once per type.
- **The owner is read from the row, never copied.** A check reads the `@Owner` column of the row it loads, so the answer follows the current value. Without `typeColumn` only a `user` principal can be the owner; with it, the principal's type must equal the row's type column too.
- **`self` holds for `user` principals only.**
- **`nullable` is recorded, not enforced.** `ParentEntry.nullable` is `true` for `@Parent(type, { nullable: true })`. Every reader treats a `NULL` parent column as "no parent" (a root), with or without the flag. <!-- TODO(docs-hook): verify whether authz:ancestors-verify is meant to report NULL parent columns without nullable; the api.ts doc comment says so, the code does not read the flag -->
- **Bad declarations fail early.** An empty type, `'$global'`, an options value that is not an object, an empty column name, a second `@Owner` or `@Self` on another property, or a second `@Parent` on one property throws `AuthzConfigError` when the class is defined. A conflict between decorators and a registration throws at `registerAccessResource()` or on the model's first use.
- **One copy per process.** Loading `@spinajs/authz-orm` twice (two installs) throws `AuthzConfigError` on the second load: the second registry would leave the ORM's builders unwrapped.
- **`typesAbove()` follows the registered classes.** It reads the `@Parent` types of each class of a type, then of each class of those types; a type with no registered class adds no types above it. The CLI uses it to load every table a type's ancestors come from.

## Best practices

- Put `@AccessResource` on the model class that owns the table; use `registerAccessResource()` only for a class from another package.
- Name the type after the permission prefix the app already uses, in the same case.
- Declare `@Owner({ typeColumn })` when rows can be created by services, agents or other non-`user` principals; without it those owners never match.
- Keep every `@AccessResource` model on the connection `db.Aliases.authz` names ([The `authz` connection and records](03-authz-connection-and-records.md)).

## Patterns and antipatterns

```ts
// Don't: the owner is declared twice on different columns; registerAccessResource throws AuthzConfigError
@AccessResource('report')
@Model('reports')
class Report extends ModelBase<Report> {
  @Owner() public author_id!: string;
}
registerAccessResource(Report, 'report', { owner: 'created_by' });

// Do: one declaration per relation
@AccessResource('report')
@Model('reports')
class Report extends ModelBase<Report> {
  @Owner() public author_id!: string;
}
```

## Examples

### Protect a new model

Four steps make a new `Invoice` model a protected resource:

1. Decorate the model with `@AccessResource('invoice')`, its parent column with `@Parent`, and its author column with `@Owner()`.
2. Grant roles on `invoice:*` in RBAC, or write ABAC policies ([the authz guide](../authz-rbac/README.md)).
3. Declare `invoice:read` (and every permission a list filters by) `list: true`.
4. Check single rows with `authz().assert()` or `@Access`, and list rows with `.accessible()`.

```ts sample
import { authz, currentPrincipal } from '@spinajs/authz';
import { AccessResource, Owner, Parent } from '@spinajs/authz-orm';
import { Model, ModelBase, Primary } from '@spinajs/orm';

@AccessResource('invoice')
@Model('invoices')
export class Invoice extends ModelBase<Invoice> {
  @Primary()
  public id!: number;

  @Parent('project')
  public project_id!: number;

  @Owner()
  public author_id!: string;

  public status!: string;
}

// config: authz: { permissions: { 'invoice:read': { list: true } } }

export async function openInvoices() {
  return await Invoice.where('status', 'open').accessible('invoice:read');
}

export async function approveInvoice(id: number) {
  const invoice = await Invoice.getOrFail(id);
  await authz().assert(currentPrincipal(), 'invoice:update', invoice);
  invoice.status = 'approved';
  await invoice.update();
}
```

### Declare a folder tree with two parents

```ts sample
import { AccessResource, Parent } from '@spinajs/authz-orm';
import { Model, ModelBase, Primary } from '@spinajs/orm';

@AccessResource('folder')
@Model('folders')
export class Folder extends ModelBase<Folder> {
  @Primary()
  public id!: number;

  // NULL for a top-level folder: any depth of folders above
  @Parent('folder', { nullable: true })
  public parent_id!: number | null;

  // a second chain: the project and everything above it
  @Parent('project')
  public project_id!: number;

  public name!: string;
}
```

A row's ancestors are both chains: its parent folders and the project with its ancestors.

### Protect a model from another package, owned by any principal type

```ts sample
import { registerAccessResource } from '@spinajs/authz-orm';
import { Model, ModelBase, Primary } from '@spinajs/orm';

@Model('export_jobs')
export class ExportJob extends ModelBase<ExportJob> {
  @Primary()
  public id!: number;

  public project_id!: number;

  public initiator_id!: string;

  public initiator_type!: string;
}

// The owner holds for the principal whose type and id both match the row.
registerAccessResource(ExportJob, 'export', {
  parents: [{ column: 'project_id', type: 'project' }],
  owner: { column: 'initiator_id', typeColumn: 'initiator_type' },
});
```

## Migration

From 2.x query scoping and `3.0.0-rc.1`: `@ScopeColumn` becomes `@Parent`, `@OrmScope` relations become role assignments on the resource, and every multi-row select calls `.accessible()`. Step by step: [the migration guide, section 12](../authz/migration-guide.md#12-from-query-scoping-2x-and-300-rc1).

```ts
// Before
@ScopeColumn('project_id', 'project') public project_id: number;

// After
@Parent('project') public project_id: number;
```

## Related

- [Single-object checks](05-single-object-checks.md): how the adapter uses the declaration on a check.
- [The ancestor table](06-ancestor-table.md): how `@Parent` columns become ancestor rows.
- [Access lists](01-access-lists.md): `.accessible()` on a declared model.
- [`@spinajs/authz`](../authz/01-check-flow.md#concepts): resources, permissions and relations.
