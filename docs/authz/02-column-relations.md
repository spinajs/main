# Column relations

A column relation names a column of the row that holds a principal id, such as `Task.assignee_id`. It
works like `owner`: an RBAC grant with that relation allows the principals the column names, for
single checks and for `list: true` permissions through `.accessible()`.

Use it when the link is a plain column of the row. When the link lives in no column ("team editor of
task 7"), assign a role on the resource instead (see [RBAC model](./README.md#the-rbac-model)).

## How it works

1. `@Relation(name, opts?)` on a property, or `registerAccessResource(model, type, { relations })`,
   stores the column (and optional type column) under `name` for the model's resource type. It throws
   `AuthzConfigError` for `owner` and `self`, which keep `@Owner()` and `@Self()`.
2. A grant `{ permission: 'task:read', relation: 'assignee' }` makes `RbacModel` ask the resolver of
   `assignee` whether the principal holds it on the row. The ORM resolver reads the column from the
   loaded row; it is never copied.
3. For a `list: true` permission, `RbacModel.listPlan` returns a term and `.accessible()` renders it
   as `relation.column`: the column is one of the principal's ids.
4. At boot the domain refuses a `list: true` permission whose grant relation is neither `owner`,
   `self` nor listable (`AuthzConfigError`: `lists support owner, self and listable column relations (@Relation)`).

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Relation(name, opts?)` | property | `typeColumn?: string` | The property's column holds the principal id of relation `name`. |

`registerAccessResource(model, type, { relations })` declares the same for a model you do not own.
Each entry is a column name, or `{ column, typeColumn? }`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `RelationResolver` (`type`, `relation`, `holds`, `listable?`) | `DI.register(...).as(RelationResolver)` | one `listable` resolver per declared column relation (`@spinajs/authz-orm`) | your own resolver | Set `listable` only if `.accessible()` can render the relation; otherwise the permission cannot be `list: true`. |

## Important behaviour

- Without `typeColumn`, the column holds `user` ids and matches `user` principals only.
- With `typeColumn`, the principal's type must equal that column and the id must equal the main column.
- A grant whose relation has only a custom, non-listable `RelationResolver` still works for single
  objects. Its permission cannot be `list: true`; boot refuses it.
- `owner` and `self` are unchanged and cannot be declared with `@Relation`.

## Patterns and antipatterns

```ts
// Don't: a relation in no column, forced into a column
@Relation('teamEditor') public team_id: number;

// Do: assign the role `editor` on task:7 to the subject set team:42#member
```

## Examples

### Assignee of a task

```ts sample
import { AccessResource, Owner, Relation } from '@spinajs/authz-orm';
import { ModelBase } from '@spinajs/orm';

@AccessResource('task')
export class Task extends ModelBase {
  @Owner() public owner_id: string;
  @Relation('assignee') public assignee_id: string;
}

// config: the role grants read to the assignee, on one object and in lists
export default {
  authz: {
    permissions: { 'task:read': { list: true } },
    rbac: {
      roles: {
        member: { grants: [{ permission: 'task:read', relation: 'assignee' }] },
      },
    },
  },
};

// await Task.where('status', 'open').accessible('task:read')  // only rows where assignee_id is me
```

### A model you do not own, with a typed column

```ts sample
import { registerAccessResource } from '@spinajs/authz-orm';

// the reviewer can be any principal type: both columns must match
registerAccessResource(JobModel, 'job', {
  relations: { reviewer: { column: 'ReviewerId', typeColumn: 'ReviewerType' } },
});
```

## Related

- [Declaring resources](../../packages/authz-orm/README.md#declaring-resources): `@Owner`, `@Parent`,
  `@Self` and `@Relation` in `@spinajs/authz-orm`.
- [Fresh checks](./01-fresh-checks.md): a sibling feature page.
