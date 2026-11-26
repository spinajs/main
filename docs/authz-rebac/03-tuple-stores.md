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

Subject keys (`subjectKey`): `type:id` for a principal or an object, `type:id#relation` for a subject set; `:` in the type and `#` in the id are escaped, so keys never collide.

### `MemoryTupleStore`

Process memory: tests, demos and small apps. `writeNow` writes synchronously and tells what changed; `onWrite(fn)` notifies on every write (the model bumps its version).

### `DbTupleStore`

`authz_rebac_tuple` on the ORM connection alias `authz` (default connection `default`, set `db.Aliases.authz` to move it). Apply the migration `AuthzRebac_2026_10_21_00_00_00` with [`npx spinajs migrate-up`](../orm/10-migrations.md#deploying-migrations). The store is built with `new`, not by DI, so it does not inject the `Orm`: `RebacModel.init` resolves the `Orm` from the domain's container when its store is a `DbTupleStore` (configured, registered as `TupleStore` or passed in the options). That boot fails while the migration is [pending](../orm/10-migrations.md#deploying-migrations). Code that uses the store outside the model resolves the `Orm` before its first read.

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

Indexes: `authz_rebac_tuple_object (namespace, object_id, relation)` for checks and list sub-queries, `authz_rebac_tuple_subject (subject_key)` for reverse reads.

- `write` runs in its own transaction; `writeIn(tx, add, remove, actor)` joins an `AuthzAdmin` transaction and reports how many tuples it added and removed.
- A value wider than its column fails with `AuthzConfigError` naming the column.
- `write` refuses an added tuple that the namespaces of a `RebacModel` over the store cannot hold (`NamespaceSchema.problem`: `unknown_relation`, `subject_not_allowed`) with `AuthzConfigError`. `RebacModel.init` binds its namespaces with `checkAgainst(schema)`; `dispose` unbinds them.
- A concurrent insert of the same tuple counts as already present, or as a conflict if it stored another caveat. The stored tuples a call removes go in one `DELETE` per 500, the new ones in one `INSERT` per 100 (1,300 bind parameters, under the 2,100 of SQL Server), each insert in a savepoint so that a lost race does not abort the transaction on Postgres; a batch that lost a race is repeated one row at a time. A tuple repeated in a call, or stored already, is written once. A caveat conflict among a call's additions, or with a stored tuple, is refused before any of them is inserted.
- A tuple that lost such a race is read again to compare caveats: under a shared row lock on MySQL, PostgreSQL and PGlite (on MySQL a plain read keeps the transaction's snapshot and misses the other writer's row), with a plain read on SQLite and SQL Server, which take no such lock. A transaction whose snapshot still cannot see that tuple (PostgreSQL `REPEATABLE READ` or `SERIALIZABLE`, SQL Server `SNAPSHOT`) fails with `ConcurrencyConflict` of `@spinajs/exceptions`, which `AuthzAdmin` passes on after its rollback and `@spinajs/http` answers with 409: retry the write.
- The statements of a call run one after another, never side by side. `write` is all or nothing: a statement that fails rolls the whole call back. `writeIn` runs them in the caller's transaction and does not undo the ones before a failure itself: roll the transaction back when it throws, as `AuthzAdmin` does. A caller that catches the error and commits keeps the removals and the inserted batches before the failure, without their changelog entries.
- With row history on the table (`@spinajs/authz-replay/rebac`, or your own `registerHistory(TupleRecord)`), each statement is one capture of its rows. A statement never carries more rows than `db.WriteCapture.MaxRows` (default `0`, no limit): with the key set below 500 or 100 the store cuts its deletes and inserts to that size, so the capture never refuses a tuple write for its size.

### Conditional tuples

The caveat is not part of the tuple's identity (`tuple_key` ignores it, as OpenFGA does). Both stores:

- treat writing a stored tuple with the same caveat (equal name and context) as a no-op;
- refuse another caveat, or a caveat on a stored unconditional tuple, with `TupleCaveatConflict`, before changing anything;
- remove before they add, so `write([withNewCaveat], [old])` changes a caveat; the changelog gets `remove` (the stored tuple) then `add`;
- delete by key, ignoring the caveat a delete carries.

See [Conditional tuples](06-conditional-tuples.md).

## See also

- [Tuple administration](05-tuple-administration.md)
