# Ladders, tags and implied roles

Four tools for resource hierarchies such as org → project → file: ladders rank roles, `requiresTag` and `grantedAt` make a grant depend on how the role was assigned, and `implies` hands out one role with another. Most apps need none of them; an app with nested workspaces usually needs all four.

## How it works

1. At `init`, `LadderExtension` adds an edge from each ladder role to the role right below it, so a ladder role holds the grants and `implies` of every lower role. It checks both sides of ladder membership (design rule 9).
2. `ImpliesExtension` compiles each role's `implies`, passed on through `extends` and ladder edges.
3. Per check, in step `collect`: each live assignment adds the roles its role implies, then each ladder role gets its rank (`rankAssignments`).
4. Step `cap` may lower a rank ([Rules](07-rules.md)); step `aggregate` sets the effective role per ladder, the highest live rank, into `Vote.roles` (B31).
5. Step `grant` reaches grants through each assignment's effective role. A grant declared by a ladder role applies only on the ladder's `resourceTypes`.
6. Step `tag` checks `requiresTag`, step `provenance` checks `grantedAt`. A failed check refuses the grant with its reason; on a type-level request it narrows the grant to rows below an assignment that passes.

## Ladders

```ts
authz: {
  rbac: {
    ladders: { project: { roles: ['viewer', 'editor', 'maintainer'], resourceTypes: ['project', 'file'] } },
    roles: {
      viewer:     { ladder: 'project', grants: ['project:read'] },
      editor:     { ladder: 'project', grants: ['file:edit'] },
      maintainer: { ladder: 'project', grants: ['project:settings'] },
    },
  },
}
```

- `roles` lists the ladder weakest first; a role's rank is its index. `maintainer` holds the grants of `editor` and `viewer`.
- Every ladder role names its ladder in `ladder`, and the ladder lists it. One side alone fails boot, and so do a role in two ladders and a ladder role that `extends` a higher role of its own ladder.
- `resourceTypes` limits where the ladder roles' own grants apply. Without it they apply on every type.
- The effective role per ladder is the highest live one after rules; a check reports it in `decision.roles` (`{ project: 'editor' }`).
- A permission a higher role would grant is denied with `role_too_low` (`ladder`, `role` held, `needed`), not `no_access`.
- `assignment.grant` with `replaceLadder: true` revokes the subject's other roles of the ladder at that scope, so a promotion leaves one row.
- `@spinajs/teams` ships the ladder `team: ['team.member', 'team.admin', 'team.owner']`.

## Tags (`requiresTag`)

```ts
viewer: { ladder: 'project', grants: ['project:read', { permission: 'code:view', requiresTag: 'code' }] }
```

- The grant counts only when a live assignment that reaches it carries the tag: `assign(actor, { ..., role: 'viewer', tags: ['code'] })`.
- Missing tag: reason `tag_missing` with the tag.
- Tags change with `assignment.setTags`, `addTags` and `removeTags`. A `cap` rule with `stripTags: true` empties them.

## Provenance (`grantedAt`)

```ts
editor: { ladder: 'project', grants: ['file:edit', { permission: 'branch:create', grantedAt: ['project'] }] }
```

- The grant counts only for assignments made at scopes of those types. `editor` at `project:3` may create branches; `editor` given at `file:9` may not.
- For a ladder role's grant, the best rank among the ladder's assignments made at those types must reach the declaring role.
- No assignment at those types: reason `provenance` with the types as `needed`. One too low: `role_too_low`.

## Implied roles

```ts
'org.admin': {
  scopeTypes: ['org'],
  grants: ['org:manage'],
  implies: [{ role: 'maintainer', at: 'self-and-descendants', tags: ['code'], bypass: ['restrict', 'cap'] }],
},
```

| Key | Type | Meaning |
| --- | --- | --- |
| `role` | `string` | The implied role. |
| `at` | `'self-and-descendants' \| 'descendants'` | At the assignment's scope and below, or below it only. |
| `tags` | `string[]` | Tags the implied role carries (the assignment's own tags do not pass on). |
| `bypass` | `('restrict' \| 'cap')[]` | Rules the implied role skips. Never the ceiling. |

- The implied role has the assignment's scope and expiry. It skips `assignable` and `scopeTypes`: it is not an assignment.
- Implied roles do not chain: a role that is implied may not imply roles itself (boot error).
- Each implied role must pass `ceiling.roles` on its own.
- A `cap` that drops or clamps the implying assignment also drops the implied role, unless the implied role bypasses `cap`.
- `DefaultAdminGuard` counts implied roles when it judges escalation: granting `org.admin` hands out `maintainer` too.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.rbac.ladders.<name>.roles` | `string[]` | none | role names, weakest first, each once | The ranks. Required. |
| `authz.rbac.ladders.<name>.resourceTypes` | `string[]` | every type | non-empty list | Where the ladder roles' grants apply. |
| `authz.rbac.roles.<name>.ladder` | `string` | none | a ladder name | The ladder the role sits on. |
| `authz.rbac.roles.<name>.implies` | `ImpliedRole[]` | none | see above | Roles this role hands out. |
| `GrantDef.requiresTag` | `string` | none | a tag | See above. |
| `GrantDef.grantedAt` | `string[]` | none | scope types | See above. |

## Important behaviour

- **Lists.** A grant with both `requiresTag` and `grantedAt`, a relation combined with either, or a `requiresTag` an implied role also carries, makes the permission unlistable on that type (`rbacListSupport`).
- **Type-level requests.** `tag` and `provenance` narrow a grant to the rows below the assignments that pass, so a list and a check of each row agree.
- **`validUntil`.** The expiry of every assignment a check read bounds the vote, and so does the expiry of the last top-rank holder of a ladder.

## Best practices

- Put scope-wide administration in a non-ladder role (`org.admin`) that `implies` the ladder's top role at `self-and-descendants`; the ladder stays about one resource type.
- Use `grantedAt` for actions that only make sense at the container (`branch:create` at `project`), so a file-level share never grants them.

## Examples

### Workspace canvas: org admins maintain every project, file shares stay small

```ts
authz: {
  rbac: {
    ladders: { project: { roles: ['viewer', 'editor', 'maintainer'], resourceTypes: ['project', 'file'] } },
    roles: {
      viewer: { ladder: 'project', grants: ['project:read', { permission: 'code:view', requiresTag: 'code' }] },
      editor: { ladder: 'project', grants: ['file:edit', { permission: 'branch:create', grantedAt: ['project'] }] },
      maintainer: { ladder: 'project', grants: ['project:settings'] },
      'org.admin': { scopeTypes: ['org'], grants: ['org:manage'], implies: [{ role: 'maintainer', at: 'self-and-descendants', tags: ['code'], bypass: ['restrict', 'cap'] }] },
    },
    rules: [{ id: 'file-grant-cap', kind: 'cap', ladder: 'project', maxRole: 'editor', assignments: { scopeTypes: ['file'] } }],
  },
}
```

A role granted at a file is capped at `editor` ([Rules](07-rules.md)); an org admin is maintainer of every project with the `code` tag, past restrict and cap rules.

## Related

- [Roles and permissions](03-roles-and-permissions.md): grants, `extends` and `scopeTypes`.
- [Rules](07-rules.md): `cap` clamps ranks, `threshold` asks a minimum rank.
- [Admin guard](09-admin-guard.md): nobody grants a rank above their own.
