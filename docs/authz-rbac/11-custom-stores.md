# Custom stores

The RBAC model reads roles, assignments, rules, links and set memberships through abstract ports, and the `AuthzAdmin` write handlers write through their admin variants. `authz.rbac.stores.*` names the classes; `registerRbacStores` binds them. Replace a store to keep roles in another system, assignments in another database, or everything in memory for tests.

## How it works

1. A store class registers in DI under its class name: `@Injectable()` with no argument does that. The shipped stores carry it, so importing `@spinajs/authz-rbac` registers `ConfigRoleStore`, `ConfigRuleStore`, `DbAssignmentStore`, `DbMembershipStore`, `DbRuleStore` and `DbLinkStore` by name only.
2. `registerRbacStores(container, configuration)` (called by `registerRbac`) reads each `authz.rbac.stores.<kind>`, or the default of `RBAC_STORE_DEFAULTS` when the key is unset.
3. For each name it takes the last class registered under that name (`storeClass`) and checks it extends the port. It registers the class under the port and, when it extends the admin port too, under that one.
4. Any bad name (not registered, a factory, the wrong port) throws `AuthzConfigError` naming the key, and nothing is registered.
5. `registerRbac` resolves the stores from the container and hands them to `RbacModel`. The write handlers resolve the admin ports per command from the admin call's container.

| Kind | `authz.rbac.stores.<kind>` default | Read port | Admin port | How many |
| --- | --- | --- | --- | --- |
| `roles` | `['ConfigRoleStore']` | `RoleStore` | none | exactly one |
| `assignments` | `['DbAssignmentStore']` | `AssignmentStore` | `AdminAssignmentStore` | exactly one |
| `rules` | `['ConfigRuleStore']` | `RuleStore` | `AdminRuleStore` | one in memory and one other at most; `[]` turns rules off |
| `links` | `['DbLinkStore']` | `LinkStore` | `AdminLinkStore` | at most one |
| `membership` | `['DbMembershipStore']` next to `DbAssignmentStore`, else `[]` | `MembershipStore` | `AdminMembershipStore` | at most one |

The defaults live in code, not in the package config file: config arrays concatenate, so a default listed there could never be removed.

## The ports

| Port | Methods | Notes |
| --- | --- | --- |
| `RoleStore` | `name`, `load(): { roles, ladders }`, `version(): string` | `version` must change whenever `load` would answer differently; the model reloads on a new version. |
| `AssignmentStore` | `name`, `forSubjects(subjects, at)`, `holders(role, scope, at)`, `byId(id)` | `forSubjects` answers the rows live at `at`. `byId` answers expired rows too. |
| `AdminAssignmentStore` | + `assign`, `revoke`, `update`, `find`, `forSubjectKeys`, `forgetScope` | `assign` upserts by subject, role and scope and keeps the id. Every write takes the batch's `AuthzTx`. |
| `RuleStore` | `name`, `forPath(path, at)`, `version()` | An in-memory store also has `all()` and `rulesOn(path, at)`; the model then reads it without IO and checks it at boot. |
| `AdminRuleStore` | + `byId`, `assertStorable`, `put`, `delete`, `find`, `forgetScope` | |
| `LinkStore` | `byToken(token)`, `byId(id)` | |
| `AdminLinkStore` | + `create`, `revoke`, `update`, `find`, `forgetScope` | `create` writes the link and its assignment to `link:<id>`; the token is returned once. |
| `MembershipStore` | `setsOf(memberKeys, at)`, `membersOf(setKey, at)` | Keys are `SubjectKey`s: `type:id` or `type:id#role`. |
| `AdminMembershipStore` | + `name`, `rowsOf`, `allMembersOf`, `memberKeys`, `replace` | The closure table; `replace` runs in the batch transaction. |
| `SubjectResolver` | `subjects(principal)` | Not a store: passed as `RbacModelOptions.subjects`. See [below](#subjectresolver). |

`SubjectKey` format: `type:id` for a principal, `type:id#role` for a set, `type:*` for a wildcard. In the id, `%`, `#` and `*` are escaped as `%25`, `%23`, `%2A`. Keys longer than 200 characters are refused on write.

## Shipped implementations

| Class | Ports | Registered | Use |
| --- | --- | --- | --- |
| `ConfigRoleStore` | `RoleStore` | by name | `authz.rbac.roles` and `authz.rbac.ladders` ([Roles and permissions](03-roles-and-permissions.md)). |
| `ConfigRuleStore` | `RuleStore` (in memory) | by name | `authz.rbac.rules` ([Rules](07-rules.md)). |
| `DbAssignmentStore`, `DbMembershipStore`, `DbRuleStore`, `DbLinkStore` | read and admin ports | by name, `@PerChildInstance` | ORM records on the `authz` connection ([Database storage](02-database-storage.md)). |
| `MemoryRoleStore` | `RoleStore` | not registered | Tests; `set(roles, ladders)` replaces the roles and changes the version. |
| `MemoryAssignmentStore` | `AssignmentStore` | not registered | Read-only tests; `add`, `remove`, `all`. |
| `MemoryAdminAssignmentStore`, `MemoryLinkStore`, `MemoryRuleStore`, `MemoryMembershipStore` | admin ports | not registered | Tests and hosts without a database, next to `MemoryAuthzAdminBackend`. |

The DB stores write only inside a `DbAuthzAdminBackend` transaction. Set `authz.admin.backend: 'DbAuthzAdminBackend'` whenever an admin port is a DB store.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Each store | its port, registered by `registerRbacStores` in the domain container; lifetime from the class decorator | see the table above | the shipped ones, your own | Register your class under its name (`@Injectable()`), list it in `authz.rbac.stores.<kind>`. Register it before `registerRbac` runs. |
| `SubjectResolver` | `RbacModelOptions.subjects`; not DI | `RbacSubjectResolver` | your own | Build `RbacModel` yourself; see below. |

### `RoleStore`: roles from a JSON file managed by another team

```ts sample
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { RoleStore } from '@spinajs/authz-rbac';
import type { LadderDef, RoleDef } from '@spinajs/authz-rbac';
import { Injectable } from '@spinajs/di';

const FILE = '/etc/myapp/roles.json';

@Injectable()
export class JsonFileRoleStore extends RoleStore {
  readonly name = 'JsonFileRoleStore';

  async load(): Promise<{ roles: readonly RoleDef[]; ladders: readonly LadderDef[] }> {
    const raw = JSON.parse(await readFile(FILE, 'utf8')) as { roles: Omit<RoleDef, 'source'>[]; ladders?: LadderDef[] };
    return { roles: raw.roles.map((r) => ({ ...r, source: FILE })), ladders: raw.ladders ?? [] };
  }

  async version(): Promise<string> {
    return createHash('sha256').update(await readFile(FILE)).digest('hex');
  }
}

// config: authz.rbac.stores.roles: ['JsonFileRoleStore']
```

The model re-reads `version()` every `authz.rbac.cache.rolesCheckSeconds` and reloads when it changed. `AuthzAdmin` reads every `RoleStore` the domain registers to validate grants, so keep one roles store.

### Extend a DB store

Subclass a DB store to add a rule before a write and keep its transaction handling and version bump through `super`; see [Database storage](02-database-storage.md#a-store-with-an-extra-rule-custom-implementation).

### `SubjectResolver`

`registerRbac` always uses `RbacSubjectResolver`. To change who a principal speaks for, build the model yourself and pass `subjects`. Extend `RbacSubjectResolver` rather than implementing the port from scratch: its `memberships` method is what makes subject sets work.

```ts
import { AuthorizationModel, AuthzContributor } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { RbacContributor, RbacModel, RbacSubjectResolver } from '@spinajs/authz-rbac';
import type { AssignmentSubject } from '@spinajs/authz-rbac';

class DepartmentSubjects extends RbacSubjectResolver {
  subjects(p: Principal): readonly AssignmentSubject[] {
    const dept = p.attributes?.department;
    const base = super.subjects(p);
    return typeof dept === 'string' ? [...base, { set: { role: 'department.member', scope: { type: 'department', id: dept } } }] : base;
  }
}

const model = new RbacModel({ roles, assignments, membership, rules, links, subjects: new DepartmentSubjects() });
container.register(() => model).as(AuthorizationModel);
container.register(() => new RbacContributor(model)).as(AuthzContributor);
```

## Important behaviour

- **Only the domain's own stores.** `registerRbac` reads the stores its `registerRbacStores` call registered in that container, so a parent domain's store never slips in for a kind the config turned off. The membership store may come from a parent.
- **Last registration wins.** Two classes registered under one name: the later one is used.
- **Fail closed.** A store that throws makes the vote a `model_error` deny; a failed assignment read is never cached.
- **Rows go frozen.** The model deep-freezes cached rows; a store may keep and reuse its own objects.

## Best practices

- Make `version()` cheap; it runs every `rolesCheckSeconds`.
- Return only live rows from `forSubjects`, but keep a row with an unreadable `expiresAt`: the model refuses it loudly instead of dropping it.
- Use the memory stores in unit tests and the DB stores in integration tests; `@spinajs/authz-testing` holds conformance suites.

## Related

- [Database storage](02-database-storage.md): the DB stores and their tables.
- [How a check resolves](05-check-resolution.md): when the model calls each store.
- [Storage overview](../authz/storage-and-check-flow.md#store-ports): every authz store port across packages.
