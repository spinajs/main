# Role assignments

Grant a role to a subject at a scope, change the tags or expiry of a grant, revoke it and list grants, each as one `AuthzAdmin` command. A subject is a principal (`{ type: 'user', id: '42' }`) or a subject set (`{ set: { role: 'group.member', scope: { type: 'group', id: 'g1' } } }`).

Permissions are not granted one by one: a role carries them. To give a user a permission, grant a role that holds it; to take it away, revoke that assignment. Roles are declared in the RBAC model, see [the RBAC model](../authz-rbac/README.md).

## How it works

| Route | Command | Body | Query |
| --- | --- | --- | --- |
| `GET /authz/assignments` | `list({ kind: 'assignments' })` | none | `scope`, `subject`, `role`, `includeExpired`, `limit`, `offset` |
| `POST /authz/assignments` | `assignment.grant` | `{ subject, role, scope, tags?, expiresAt?, replaceLadder? }` | `reason`, `idempotencyKey`, `dryRun` |
| `PATCH /authz/assignments/:id` | `assignment.setTags`, `addTags`, `removeTags`, `setExpiry` | `{ tags?, addTags?, removeTags?, expiresAt? }`, at least one key | `reason`, `idempotencyKey`, `dryRun` |
| `DELETE /authz/assignments/:id` | `assignment.revoke` | none | `reason`, `idempotencyKey`, `dryRun` |

Grant:

1. `AuthzAdminController.grant()` takes the body object (else `400 invalid_request`) and sets `kind: 'assignment.grant'`, overriding any `kind` in the body.
2. `decodeCommand` turns an ISO 8601 `expiresAt` into a `Date`. A string that is not a full date-time, such as `2027-01-01`, stays a string and `AuthzAdmin` refuses it with `400 invalid_command`, `field: 'expiresAt'`.
3. `AuthzAdmin` validates the role (`unknown_role`, `not_assignable`, `wrong_scope_type`), checks `authz:assignments.manage` at `scope` (`forbidden`) and runs the guard (`escalation`, `protected_role`).
4. The answer is `{ results: [{ ok: true, kind: 'assignment.grant', id, affected }] }`. An identical grant answers `200` with the existing row's `id` and adds no row.

Patch:

1. `patchAssignment()` refuses a key other than `tags`, `addTags`, `removeTags` and `expiresAt` with `400 invalid_request`, `field` set to that key. An empty body answers `400 invalid_request`.
2. It builds one command per key, always in the order `setTags`, `addTags`, `removeTags`, `setExpiry`, and runs them as one batch.
3. `tags` replaces the tags; `addTags` and `removeTags` change them; `expiresAt: null` clears the expiry.

Revoke:

1. `revoke()` runs `{ kind: 'assignment.revoke', id }`.
2. `AuthzAdmin` checks `authz:assignments.manage` at the assignment's scope, and the guard refuses `self_lockout`, `last_holder` or `protected_role`. An unknown id answers `404 not_found`.

List:

1. `readAssignmentsQuery` parses the query (`400 invalid_query` with the `field` on a malformed value).
2. `AuthzAdmin.list` checks `authz:assignments.read` at `scope`, or at `$global` without one, and answers `{ items, total }`.

## Important behaviour

- **Expired rows are hidden by default.** Pass `includeExpired=true` to list them.
- **A link's grant is an assignment too.** List it with `subject=link:<linkId>`.
- **The guard switches** live in `authz.admin.guard.*` (`preventEscalation`, `preventSelfLockout`, `preventLastPrivilegedRemoval`, `protectSystemRole`, `keepHolders`). With `protectSystemRole` on, a row of a role with `assignable: false` cannot be revoked or patched (`403 protected_role`); a grant of such a role is refused by validation (`400 not_assignable`) whatever the switch says.
- **There is no "roles I may assign" route.** Ask with a dry run grant: `200` means the caller may, `403 escalation` means it may not.
- **The events** `RoleAssigned` and `RoleRevoked` carry the request principal as actor.

## Best practices

- Revoke by id from the list answer; use `assignment.revokeWhere` in a [batch](02-command-batches.md) to revoke every role of a subject at a scope.
- Grant groups, not users, when many users share access: grant the role to `set:group.member@group:<id>` and manage membership with `set.addMember`.
- Use `replaceLadder: true` to move a subject up or down a ladder (`viewer` to `editor`) in one grant instead of a grant plus a revoke.

## Patterns and antipatterns

```ts
// Don't: send the PATCH keys you want to keep unchanged; tags replaces the whole set
await patch(`/authz/assignments/${id}`, { tags: [], expiresAt: newExpiry });

// Do: send only what changes
await patch(`/authz/assignments/${id}`, { expiresAt: newExpiry });
```

## Examples

### Grant a role until a date, then extend it

```ts sample
type Results = { results?: { ok: boolean; id?: string; error?: { code: string; field?: string } }[]; error?: { code: string } };

async function call(baseUrl: string, bearer: string, method: string, path: string, body?: unknown): Promise<Results> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answer = (await res.json()) as Results;
  if (res.status !== 200) throw new Error(`${method} ${path}: ${res.status} ${answer.results?.at(-1)?.error?.code ?? answer.error?.code}`);
  return answer;
}

export async function grantContractorAccess(baseUrl: string, bearer: string, userId: string, projectId: string): Promise<string> {
  const granted = await call(baseUrl, bearer, 'POST', '/authz/assignments?reason=contract%20start', {
    subject: { type: 'user', id: userId },
    role: 'editor',
    scope: { type: 'project', id: projectId },
    tags: ['contractor'],
    expiresAt: '2027-06-30T23:59:59Z',
  });
  const id = granted.results![0].id!;

  await call(baseUrl, bearer, 'PATCH', `/authz/assignments/${encodeURIComponent(id)}?reason=contract%20extended`, { expiresAt: '2027-12-31T23:59:59Z' });
  return id;
}
```

### Revoke every assignment of a user on a project

```ts sample
export async function removeFromProject(baseUrl: string, bearer: string, userId: string, projectId: string): Promise<number> {
  const headers = { Authorization: `Bearer ${bearer}` };
  const query = new URLSearchParams({ scope: `project:${projectId}`, subject: `user:${userId}` });
  const list = (await (await fetch(`${baseUrl}/authz/assignments?${query}`, { headers })).json()) as { items: { id: string }[] };

  for (const row of list.items) {
    const res = await fetch(`${baseUrl}/authz/assignments/${encodeURIComponent(row.id)}?reason=left%20project`, { method: 'DELETE', headers });
    if (res.status !== 200) throw new Error(`revoke ${row.id}: ${res.status}`);
  }
  return list.items.length;
}
```

## Related

- [Admin routes](01-admin-routes.md): encodings, answers and status codes.
- [Command batches](02-command-batches.md): `assignment.revokeWhere`, `set.addMember`, `set.removeMember`.
- [AuthzAdmin](../authz/10-authz-admin.md): the guard and its refusals.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): the assignment handler, reader and stores.
