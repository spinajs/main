# Command batches

`POST /authz/commands` runs a list of `AuthzCommand`s through `AuthzAdmin.execute()` in one transaction. It is the only route for `assignment.revokeWhere`, `set.addMember`, `set.removeMember` and `scope.forget`, and the way to change several things all or nothing.

## How it works

1. `IsAuthenticated` refuses a request without a signed-in principal with `401`.
2. `AuthzAdminController.commands()` sets `Cache-Control: no-store` and `Pragma: no-cache` first, so every answer of the route carries them.
3. The body must be an object; anything else answers `400 invalid_request`.
4. `reason`, `idempotencyKey` and `dryRun` are copied from the body, as given, into the `AuthzAdminOptions`. `AuthzAdmin` checks their types (`dryRun: 'yes'` answers `400 invalid_batch` with `field: 'dryRun'`).
5. `decodeCommands(body.commands)` turns each ISO 8601 `expiresAt` into a `Date` at the expiry paths of `assignment.grant`, `assignment.setExpiry`, `set.addMember`, `link.create`, `link.update`, `rule.put` (`rule.expiresAt`) and `policy.put` (`policy.expiresAt`). Every other value goes through as it came.
6. `AuthzAdmin.execute(principal, commands, options)` runs the batch. `commands` that is not an array, or holds more than `authz.admin.maxBatch` (default `100`) commands, answers `400 invalid_batch` with `{ error }`.
7. The route answers `{ results }`: `200` when every command succeeded, else the status of the failed command.

## Request

```json
{
  "commands": [
    { "kind": "set.addMember", "set": { "role": "group.member", "scope": { "type": "group", "id": "g1" } }, "member": { "type": "user", "id": "42" } },
    { "kind": "assignment.setExpiry", "id": "a-17", "expiresAt": "2027-01-01T00:00:00Z" }
  ],
  "reason": "onboarding",
  "idempotencyKey": "req-123",
  "dryRun": false
}
```

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `commands` | `AuthzCommand[]` | yes | The commands, run in order. Dates are ISO 8601 strings. |
| `reason` | `string` | no | Goes to the audit entry of each command. |
| `idempotencyKey` | `string` | no | A retried batch with the same key answers the first result. |
| `dryRun` | `boolean` | no | Validate, check permissions and guard, then roll back. |

The command kinds and their fields are those of `AuthzCommand` in `@spinajs/authz`; `COMMAND_KINDS` lists all 19 and `commandSchemas` holds a JSON schema for each. See [AuthzAdmin](../authz/10-authz-admin.md) for what each command does.

## Answer

| Status | Body |
| --- | --- |
| `200` | `{ results }`, one `{ ok: true, kind, id?, token?, affected }` per command. |
| `400`, `403`, `404`, `409` | `{ results }`: the commands before the failure as `{ ok: true, affected: 0 }`, then the failed one as `{ ok: false, kind, error }`. Commands after it are not listed. |
| `400` | `{ error }` for `invalid_request` (body not an object) and `invalid_batch` (bad `commands` or options, batch too large). |
| `401` | `IsAuthenticated` refused the request. |

## Important behaviour

- **All or nothing.** One command failing rolls back the batch; no change, event or audit entry is published.
- **The guard sees earlier commands.** It runs before each command inside the transaction, so a transfer grants the new owner first and revokes the old one after, in one batch.
- **Link tokens.** The result of a `link.create` carries the link `token`, shown only in this answer. A dry run or a replayed batch answers without it.
- **No-store on every answer.** Including refusals and errors after the route started. The `401` of `IsAuthenticated` comes before the route and holds no token.
- **An empty list** answers `200 { results: [] }`.

## Best practices

- Put the steps of one user action in one batch, not in several requests: a failure then leaves nothing half done.
- To ask which roles the caller may grant, send one dry run per role: a batch stops at its first failure, so a batch of several grants reports only the first refused one.

## Examples

### Hand team ownership over in one batch

```ts sample
export async function transferOwnership(baseUrl: string, bearer: string, teamId: string, from: string, to: string): Promise<void> {
  const team = { type: 'team', id: teamId };
  const res = await fetch(`${baseUrl}/authz/commands`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { kind: 'assignment.grant', subject: { type: 'user', id: to }, role: 'team.owner', scope: team },
        { kind: 'assignment.revokeWhere', scope: team, subject: { type: 'user', id: from }, role: 'team.owner' },
      ],
      reason: `ownership of team ${teamId} handed from ${from} to ${to}`,
      idempotencyKey: `team-transfer:${teamId}:${from}:${to}`,
    }),
  });

  if (res.status !== 200) {
    const body = (await res.json()) as { results?: { ok: boolean; error?: { code: string } }[]; error?: { code: string } };
    throw new Error(`transfer refused: ${body.results?.find((r) => !r.ok)?.error?.code ?? body.error?.code}`);
  }
}
```

## Related

- [Admin routes](01-admin-routes.md): protection, encodings and status codes shared by all routes.
- [AuthzAdmin](../authz/10-authz-admin.md): the commands, the guard and idempotency.
- [Share links](04-share-links.md): `link.create` and its token.
