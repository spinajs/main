# Resource adapters and resolvers

Adapters and resolvers tell the engine about resources: what type an object is, where it sits in the resource tree, which relations hold on it and what attributes its nodes carry. The core ships none for real resources; `@spinajs/authz-orm` and `@spinajs/authz-fs` are adapters. Write your own for resources that live elsewhere, such as an external API or a fixed tree.

## How it works

1. **Ref.** `check()` hands an object resource to each `ResourceAdapter` in turn; the first whose `accepts(object)` is true answers `refOf(object)`, and the object becomes the subject.
2. **Ancestors.** For a ref with an id, the engine asks the adapter of its type, else the `ScopeResolver` of its type, for `ancestors(ref)`: the whole path `[self, parent, ..., GLOBAL]`, or `null` for an unknown resource (denied `unknown_resource`). A type with neither answers `[ref, GLOBAL]`. The answer is memoised per request.
3. **Relations.** A residual op `{ op: 'relation', relation }` is settled on the row by the `RelationResolver` registered for `(type, relation)`: `holds(principal, ref, subject)`.
4. **Attributes.** `ctx.attributes(ref)` and `scope.<type>.*` condition refs read a node's attributes: the schema defaults of the type, then the adapter's `scopeAttributes(ref)` (else the resolver's `attributes(ref)`), then the `ScopeAttributeStore` row. Later layers win. `null` from the adapter or resolver means an unknown node.
5. **Rows.** `checkAll()` and the conditional allows of authz-http's `@Access` load rows through `loadMany()` or `load()`; `attribute(subject, field)` reads a field of a row for `cmp` residuals.
6. **Contributions.** At boot each `AuthzContributor` declares what its package needs (permissions, relations, scope types, list types, attribute schemas), so a missing piece fails boot instead of a check ([Boot checks](04-host-boot-and-configuration.md#boot-checks)).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ResourceAdapter` | `ResourceAdapter`, every registration of the container chain | none in the core | `OrmResourceAdapter` ([authz-orm](../authz-orm/README.md)), `FsResourceAdapter` ([authz-fs](../authz-fs/README.md)) | `@Injectable(ResourceAdapter)`; one adapter per type (rule 3). |
| `ScopeResolver` | `ScopeResolver`, every registration | none | your own | `DI.register(MyResolver).as(ScopeResolver)`; one resolver per type. |
| `RelationResolver` | `RelationResolver`, every registration; also from an adapter's `relations()` or a model's `ctx.registerRelation()` | none | `owner`, `self` and every `@Relation` column from authz-orm ([Column relations](12-column-relations.md)), `fs_acl` relations from authz-fs | One resolver per `(type, relation)`. Set `listable` only when an adapter renders the relation in lists (authz-orm's `relation.column` term does for its column relations); a permission granted through a relation without a `listable` resolver cannot be `list: true`. |
| `ScopeAttributeStore` | `ScopeAttributeStore`, the domain's registration (optional) | none | `DbScopeAttributeStore` ([authz-orm](../authz-orm/README.md)), `MemoryScopeAttributeStore` | Register one instance under `ScopeAttributeStore` and `WritableScopeAttributeStore`. |
| `AuthzContributor` | `AuthzContributor`, every registration | `ConfigScopeAttributeSchemas` | one per authz package | `@Injectable(AuthzContributor)`; return an `AuthzContribution`. |

### `ResourceAdapter` members

| Member | Required | Meaning |
| --- | --- | --- |
| `kind` | yes | A name for logs and the `adapter:<kind>` permission source. |
| `types` | yes | The resource types it serves. |
| `accepts(target)` | yes | Is this object one of mine? |
| `refOf(target)` | yes | The object's `{ type, id }`. |
| `ancestors(ref)` | yes | `[self, parent, ..., GLOBAL]`, or `null`. |
| `ancestorsMany(refs)`, `loadMany(refs)` | no | Batched forms for `checkAll`, keyed by `resourceKey(ref)`. |
| `load(ref)` | no | The row of a ref, for a conditional allow of `@Access` and for `checkAll`. Without it, `@Access` denies a conditional allow on that type with `unknown_resource`. |
| `attribute(subject, field)` | no | Reads a row field for residuals; default reads own properties. |
| `scopeAttributes(ref)` | no | Attributes of a node for `scope.<type>.*`. |
| `relations()` | no | Its `RelationResolver`s. |
| `permissions()` | no | Permissions to register in the adapter's domain. |
| `operations()` | no | Named operations mapped to permissions, for adapters that check by operation. |
| `compiles` | no | Filter ops it renders into its query language; set it when the adapter filters lists. |

### `ScopeResolver`: custom implementation

A resolver places refs of a type in the tree without an adapter, for resources that are not rows. Its attributes may also decide `resource.*` conditions without a row.

```ts sample
import { DI } from '@spinajs/di';
import { GLOBAL, ScopeResolver } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';

/** Git branches, id '<projectId>/<branch>': a branch sits under its project. */
export class BranchScopeResolver extends ScopeResolver {
  readonly types = ['branch'];

  async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    const [project, branch] = (ref.id ?? '').split('/');
    if (!project || !branch) return null;
    return [ref, { type: 'project', id: project }, GLOBAL];
  }

  async attributes(ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null> {
    const branch = (ref.id ?? '').split('/')[1];
    return branch ? { name: branch, protected: branch === 'main' } : null;
  }
}

DI.register(BranchScopeResolver).as(ScopeResolver);
```

An RBAC role assigned at `project:42` now applies to `branch:42/main`, and an ABAC policy can deny pushes with `when: { attr: 'resource.protected', eq: true }`.

### `RelationResolver`: custom implementation

```ts sample
import { DI } from '@spinajs/di';
import { RelationResolver } from '@spinajs/authz';
import type { Principal, ResourceRef } from '@spinajs/authz';

/** The `assignee` relation on tasks: the row's assignee_id is the principal. */
export class TaskAssigneeRelation extends RelationResolver {
  readonly type = 'task';
  readonly relation = 'assignee';

  holds(principal: Principal, _ref: ResourceRef, subject?: unknown): boolean {
    return (subject as { assignee_id?: string } | undefined)?.assignee_id === principal.id;
  }
}

DI.register(TaskAssigneeRelation).as(RelationResolver);
```

A grant with `relation: 'assignee'` on `task:update` then permits a task's assignee. Without the row, the decision stays conditional.

## Scope attributes

Scope attributes are authorization data on resource nodes: an org's policies, a project's settings. Conditions read them as `scope.<type>.*`.

- Declare a schema per type in `authz.scopes.attributes.<type>` (or through a contributor's `scopeAttributeSchemas`). Two schemas for one type fail.
- The schema is a JSON schema for AJV 8 in strict mode: an unknown keyword or any `format` fails to compile.
- `defaults` fill every node of the type before the adapter's and the store's values.
- Writes go through `AuthzAdmin` (`scope.setAttributes`, `scope.replaceAttributes`, `scope.forget`) and are validated against the schema ([AuthzAdmin](10-authz-admin.md)).

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.scopes.attributes.<type>.schema` | `object` | required | a JSON schema | Shape of the attributes of `<type>` nodes. |
| `authz.scopes.attributes.<type>.defaults` | `object` | `{}` | | Values every node has until one is written. |
| `authz.scopes.attributes` | `null` | | | Turns off a section a shipped config sets. |

```ts
export default {
  authz: {
    scopes: {
      attributes: {
        org: {
          schema: { type: 'object', properties: { policies: { type: 'object', properties: { viewers_may_download: { type: 'boolean' } } } } },
          defaults: { policies: { viewers_may_download: true } },
        },
      },
    },
  },
};
```

`MemoryScopeAttributeStore` keeps attributes in memory for tests and apps without a database. It is not registered by default, and its writes need the `MemoryAuthzAdminBackend` transaction.

## Contributors

An `AuthzContributor` feeds a domain's boot checks. `contribute(domain)` returns an `AuthzContribution`:

| Field | Checked by | Meaning |
| --- | --- | --- |
| `permissionRefs` | rule 7 | Permissions (and the type) the package checks. |
| `relationRefs` | rule 8 | Relations the package's grants use. |
| `scopeRefs` | rule 10 | Scope types the package's conditions read. |
| `joinTypes` | rule 6 | Types joined in queries, which need a sync model. |
| `listTypes` | rule 12 | Types a list query can scope. |
| `scopeAttributeSchemas` | engine and `AuthzAdmin` | `{ scopeType, schema, defaults }` per type. |

```ts sample
import { Injectable, Singleton } from '@spinajs/di';
import { AuthzContributor } from '@spinajs/authz';
import type { AuthzContribution } from '@spinajs/authz';

/** Boot fails unless 'task:update' is registered and the 'assignee' relation has a resolver. */
@Singleton()
@Injectable(AuthzContributor)
export class TasksContributor extends AuthzContributor {
  contribute(_domain: string): AuthzContribution {
    return {
      permissionRefs: [{ permission: 'task:update', type: 'task', source: 'tasks' }],
      relationRefs: [{ type: 'task', relation: 'assignee', source: 'tasks' }],
    };
  }
}
```

## Important behaviour

- **An adapter or resolver registered after boot is not seen.** The engine indexes them by type at boot; a type an adapter starts listing later throws until a reboot.
- **Ancestors are the whole path.** The engine does not ask a parent for its own ancestors; return every level up to `GLOBAL`.
- **Failures fail closed.** A throwing `ancestors()` or attribute load makes the asking model indeterminate; a load past `authz.engine.modelTimeoutMs` makes the node unknown.
- **Permissions of an adapter register only in the domain that registers the adapter**; child domains inherit them through the parent's registry.

## Related

- [`@spinajs/authz-orm`](../authz-orm/README.md): the ORM adapter, the ancestor table and `DbScopeAttributeStore`.
- [`@spinajs/authz-fs`](../authz-fs/README.md): the file system adapter.
- [Conditions](07-conditions.md): `scope.*` and `resource.*` reads.
- [AuthzAdmin](10-authz-admin.md): writing scope attributes.
