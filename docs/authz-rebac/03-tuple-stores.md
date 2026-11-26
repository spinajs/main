# Tuple stores

A tuple is `object#relation@subject`:

```ts
interface SubjectSet { readonly object: ResourceRef; readonly relation: string }
type TupleSubject = PrincipalRef | SubjectSet;
interface TupleCaveat { readonly name: string; readonly context?: Readonly<Record<string, CaveatValue>> }
interface Tuple { readonly object: ResourceRef; readonly relation: string; readonly subject: TupleSubject; readonly caveat?: TupleCaveat }
```

`object.type` is the namespace and `object.id` is required. A subject is a principal (`{ type: 'user', id: 'alice' }`), an object named as a subject (`{ type: 'folder', id: 'f1' }`, for parent links), or a subject set (`{ object: { type: 'group', id: 'eng' }, relation: 'member' }`).

## How it works

### `TupleStore`

| Method | |
| --- | --- |
| `read(object, relation)` | The tuples of `object#relation`. |
| `reverse(subject, relation, objectType)` | The objects of a type holding `#relation@subject`, the subject matched exactly. |
| `reverseMany(subjects, relation, objectType)` | `reverse` for many subjects, without duplicates. |
| `write(add, remove, actor)` | Removes, then adds; idempotent; returns a new opaque version. |
| `find(query, page?)` | By object (or namespace), relation and subject, ordered by object, relation and subject key. |
| `caveats` | Whether the store keeps `Tuple.caveat`; `false` by default, `true` for both stores here. |
| `reverseTuples(subjects, relation, objectType)` | The tuples `#relation@s` for the subjects, caveats included. The default calls `reverseMany`, then `read` once per object: a custom store that keeps caveats should override it. |
| `caveatsOn(objectType, relation, subjects)` | The distinct caveats among those tuples; the default runs one `find` per subject. |

Both stores here also have `withSubjectObject(ref)`: the tuples whose subject is `ref` itself or a subject set of it (`#viewer@group:eng#member`, `#parent@folder:f1`), in `find` order. `scope.forget` uses it; it is not part of `TupleStore`, so a store of your own does not need it. On `DbTupleStore` it filters `subject_type` and `subject_id`, which the index `authz_rebac_tuple_subject_object` covers.

Subject keys (`subjectKey`): `type:id` for a principal or an object, `type:id#relation` for a subject set; `:` in the type and `#` in the id are escaped, so keys never collide.

### `MemoryTupleStore`

Process memory: tests, demos and small apps. `writeNow` writes synchronously and tells what changed; `onWrite(fn)` notifies on every write (the model bumps its version).

### `DbTupleStore`

`authz_rebac_tuple` on the ORM connection alias `authz` (default connection `default`, set `db.Aliases.authz` to move it). Apply the migrations (`AuthzRebac_2026_10_21_00_00_00` and the later ones of the package) with [`npx spinajs migrate-up`](../orm/10-migrations.md#deploying-migrations). The store is built with `new`, not by DI, so it does not inject the `Orm`: `RebacModel.init` resolves the `Orm` from the domain's container when its store is a `DbTupleStore` (configured, registered as `TupleStore` or passed in the options). That boot fails while the migration is [pending](../orm/10-migrations.md#deploying-migrations). Code that uses the store outside the model resolves the `Orm` before its first read.

| Column | Type | |
| --- | --- | --- |
| `tuple_key` | varchar(64), primary key | sha256 of namespace, object id, relation and subject key |
| `namespace` | varchar(64) | |
| `object_id` | varchar(128) | |
| `relation` | varchar(64) | |
| `subject_key` | varchar(320) | |
| `subject_type`, `subject_id`, `subject_relation` | varchar(64), varchar(128), varchar(64) | `subject_relation` is `''` for a direct subject |
| `created_by`, `created_at` | varchar(100), datetime | |
| `caveat`, `caveat_key`, `caveat_context` | varchar(64), varchar(64), text, all nullable | the caveat name, sha256 of name and canonical context, the canonical context JSON (4096 characters at most); `NULL` for an unconditional tuple. Added by `AuthzRebacCaveats_2026_11_06_00_00_00`. |

Indexes: `authz_rebac_tuple_object (namespace, object_id, relation)` for checks and list sub-queries, `authz_rebac_tuple_subject (subject_key)` for reverse reads, and `authz_rebac_tuple_subject_object (subject_type, subject_id)` for the subject side of `scope.forget`, which runs on every delete of an `@AccessResource` row. The last one comes with `AuthzRebacSubjectIndex_2026_11_26_00_00_00`. Without it each forget scans the whole table: about 100 ms at a million tuples on PostgreSQL, against under 1 ms with it.

On PostgreSQL that migration's `CREATE INDEX` blocks writes to `authz_rebac_tuple` for as long as it builds: 2.9 to 3.6 s at a million tuples, measured. To keep writes going on a large table, build the index by hand before you run the migration, outside a transaction:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS authz_rebac_tuple_subject_object ON authz_rebac_tuple (subject_type, subject_id);
```

When the connection sets `Options.Schema`, the driver puts that schema on the search path of its own sessions only. In `psql`, qualify the table with it (the index lands in the table's schema), and the index name in the two statements below (`my_schema.authz_rebac_tuple_subject_object`):

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS authz_rebac_tuple_subject_object ON my_schema.authz_rebac_tuple (subject_type, subject_id);
```

The migration then finds the index by its name and leaves it alone. A `CONCURRENTLY` build that fails or is cancelled leaves an INVALID index under that name: the planner never uses it, and rerunning the `IF NOT EXISTS` statement does not repair it. Check it once the build has ended:

```sql
SELECT indisvalid FROM pg_index WHERE indexrelid = 'authz_rebac_tuple_subject_object'::regclass;
```

`false`: drop it, then build it again by hand or leave the build to the migration.

```sql
DROP INDEX CONCURRENTLY IF EXISTS authz_rebac_tuple_subject_object;
```

`up` refuses an invalid index too: it throws, naming the index and that `DROP INDEX CONCURRENTLY`, and the migration is recorded as failed. After the drop, record it with `npx spinajs migrate-resolve --name AuthzRebacSubjectIndex_2026_11_26_00_00_00 --rolled-back` and run `migrate-up` again ([status and resolve](../orm/10-migrations.md#status-and-resolve)). MySQL (InnoDB) builds a secondary index without blocking writes, so it needs no such step.

- `write` runs in its own transaction; `writeIn(tx, add, remove, actor)` joins an `AuthzAdmin` transaction and reports how many tuples it added and removed.
- A value wider than its column fails with `AuthzConfigError` naming the column.
- `write` refuses an added tuple that the namespaces of a `RebacModel` over the store cannot hold (`NamespaceSchema.problem`: `unknown_relation`, `subject_not_allowed`) with `AuthzConfigError`. `RebacModel.init` binds its namespaces with `checkAgainst(schema)`; `dispose` unbinds them.
- A concurrent insert of the same tuple counts as already present, or as a conflict if it stored another caveat. Each insert runs in a savepoint so that a lost race does not abort the transaction on Postgres; that is three statements per added tuple on every driver, which bulk writes and imports pay.

### Conditional tuples

The caveat is not part of the tuple's identity (`tuple_key` ignores it, as OpenFGA does). Both stores:

- treat writing a stored tuple with the same caveat (equal name and context) as a no-op;
- refuse another caveat, or a caveat on a stored unconditional tuple, with `TupleCaveatConflict`, before changing anything;
- remove before they add, so `write([withNewCaveat], [old])` changes a caveat; the changelog gets `remove` (the stored tuple) then `add`;
- delete by key, ignoring the caveat a delete carries.

See [Conditional tuples](06-conditional-tuples.md).

## See also

- [Tuple administration](05-tuple-administration.md)
