# Tuple administration

Importing `@spinajs/authz-rebac` plugs tuples into `AuthzAdmin`: the commands `tuple.write` and `tuple.delete`, the query `tuples`, and the tuple part of `scope.forget`. The batch pipeline (validation, permission, guard, transaction, change publication) is the core's: see [AuthzAdmin](../authz/10-authz-admin.md).

## How it works

### The writable store

Commands and queries work on the domain's one `MemoryTupleStore` or `DbTupleStore` registered as `TupleStore`. Register the instance the `RebacModel` reads. None registered: `AuthzConfigError` (`scope.forget` then has nothing to forget); two: `AuthzConfigError`.

### `tuple.write` and `tuple.delete`

```ts
{ kind: 'tuple.write', tuple: { object: { type: 'doc', id: 'd1' }, relation: 'viewer', subject: { object: { type: 'group', id: 'eng' }, relation: 'member' } } }
{ kind: 'tuple.delete', tuple: { object: { type: 'doc', id: 'd1' }, relation: 'viewer', subject: { type: 'user', id: 'dave' } } }
```

1. **Validate**: the tuple's shape (`invalid_command`, field `tuple`). For a write, every `RebacModel` of the domain must admit it: `unknown_relation` (field `tuple.object` or `tuple.relation`) or `subject_not_allowed` (field `tuple.subject`); for a `DbTupleStore` the values must fit the columns.
2. **Permission**: `authz:tuples.manage` on the tuple's object (mappable in `authz.admin.permissions`).
3. **Apply**: the write joins the batch transaction; a memory write undoes itself on rollback.
4. **Result**: `affected: 1`, the tags `rebac`, `rebac:<namespace>`, `model:<name>` of every `RebacModel`, and the event `TupleChanged { object, relation, subject, op }`. Writing a stored tuple or deleting a missing one is `affected: 0`, without tags or event.

### The `tuples` query

```ts
await admin.list(actor, { kind: 'tuples', scope: { type: 'doc', id: 'd1' }, relation: 'viewer', page: { limit: 50, offset: 0 } });
```

`scope` is the object, or a namespace (`{ type: 'doc' }`); `relation` and `subject` narrow further. `AuthzAdmin` checks `authz:tuples.read` at the scope, `$global` without one. Pages go by offset.

### `scope.forget`

Removes the tuples whose object is the forgotten node, one `TupleChanged` each.

### HTTP

`import '@spinajs/authz-rebac/http'` registers `RebacCommandSchemas`, so `POST /authz/commands` of `@spinajs/authz-http-admin` accepts and documents both commands. `@spinajs/authz-http-admin` is an optional peer dependency.

## See also

- [Tuple stores](03-tuple-stores.md)
- [Namespaces](02-namespaces.md#tuples-that-fit)
