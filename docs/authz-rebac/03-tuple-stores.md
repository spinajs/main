# Tuple stores

A tuple is `object#relation@subject`:

```ts
interface SubjectSet { readonly object: ResourceRef; readonly relation: string }
type TupleSubject = PrincipalRef | SubjectSet;
interface Tuple { readonly object: ResourceRef; readonly relation: string; readonly subject: TupleSubject }
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

Subject keys (`subjectKey`): `type:id` for a principal or an object, `type:id#relation` for a subject set; `:` in the type and `#` in the id are escaped, so keys never collide.

### `MemoryTupleStore`

Process memory: tests, demos and small apps. `writeNow` writes synchronously and tells what changed; `onWrite(fn)` notifies on every write (the model bumps its version).

### `DbTupleStore`

`authz_rebac_tuple` on the ORM connection alias `authz` (default connection `default`, set `db.Aliases.authz` to move it). Run the migration `AuthzRebac_2026_10_21_00_00_00`.

| Column | Type | |
| --- | --- | --- |
| `tuple_key` | varchar(64), primary key | sha256 of namespace, object id, relation and subject key |
| `namespace` | varchar(64) | |
| `object_id` | varchar(128) | |
| `relation` | varchar(64) | |
| `subject_key` | varchar(320) | |
| `subject_type`, `subject_id`, `subject_relation` | varchar(64), varchar(128), varchar(64) | `subject_relation` is `''` for a direct subject |
| `created_by`, `created_at` | varchar(100), datetime | |

Indexes: `authz_rebac_tuple_object (namespace, object_id, relation)` for checks and list sub-queries, `authz_rebac_tuple_subject (subject_key)` for reverse reads.

- `write` runs in its own transaction; `writeIn(tx, add, remove, actor)` joins an `AuthzAdmin` transaction and reports how many tuples it added and removed.
- A value wider than its column fails with `AuthzConfigError` naming the column.
- A concurrent insert of the same tuple counts as already present.

## See also

- [Tuple administration](05-tuple-administration.md)
