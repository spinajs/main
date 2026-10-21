# Share links

A share link grants a role at a scope to whoever holds its token. These routes create, change, revoke and list links through `AuthzAdmin`. Opening a link with its token is not part of this package: `@spinajs/authz-http` reads the token from the request, see [`@spinajs/authz-http`](../authz-http/README.md).

## How it works

| Route | Command | Body | Query |
| --- | --- | --- | --- |
| `GET /authz/links` | `list({ kind: 'links' })` | none | `scope`, `limit`, `offset` or `after` |
| `POST /authz/links` | `link.create` | `{ scope, role, tags?, expiresAt?, attributes? }` | `reason`, `idempotencyKey`, `dryRun` |
| `PATCH /authz/links/:id` | `link.update` | `{ expiresAt?, attributes?, role?, tags? }`, at least one key; `id` optional | `reason`, `idempotencyKey`, `dryRun` |
| `DELETE /authz/links/:id` | `link.revoke` | none | `reason`, `idempotencyKey`, `dryRun` |

Create:

1. `AuthzAdminController.createLink()` sets `Cache-Control: no-store` and `Pragma: no-cache` before anything else, so every answer of the route carries them.
2. It takes the body object (else `400 invalid_request`), sets `kind: 'link.create'` and decodes `expiresAt`.
3. `AuthzAdmin` validates the command, checks `authz:links.manage` at `scope` and runs the guard.
4. The answer is `{ results: [{ ok: true, kind: 'link.create', id, token, affected: 1 }] }`.

Change:

1. `patchLink()` refuses a key other than `id`, `expiresAt`, `attributes`, `role` and `tags` with `400 invalid_request` naming the key; `scope` and `token` cannot change.
2. An `id` in the body must equal the path id (`400 invalid_request`, `field: 'id'`). A body with none of the four keys answers `400 invalid_request`.
3. It runs one `link.update`: `role` changes the role the link grants, `tags` replaces the tags of that grant, `expiresAt: null` clears the expiry.

Revoke:

1. `revokeLink()` runs `{ kind: 'link.revoke', id }`. It revokes the link and the role it grants; its token opens nothing from then on.
2. `AuthzAdmin` checks `authz:links.manage` at the link's scope. An unknown id answers `404 not_found`.

List:

1. `readPageQuery('links', query)` parses `scope`, `limit`, and `offset` or `after`.
2. `AuthzAdmin.list` checks `authz:links.read` at `scope`, or at `$global` without one.
3. Each item is `{ id, scope, expiresAt, attributes, createdBy? }`.

## Important behaviour

- **The token is shown once.** Only the answer of `POST /authz/links`, or of the [`POST /authz/commands`](02-command-batches.md) batch that created the link, carries it. A list, a `PATCH` answer, events, audit entries and logs never do.
- **No cache may keep a token.** Both creating routes send `Cache-Control: no-store` and `Pragma: no-cache` on every answer, refusals and errors included.
- **A dry run creates nothing** and answers without a `token`.
- **A retried create** with the same `idempotencyKey` answers the first link's `id` without the token. A client that lost the first answer cannot get the token back; revoke the link and create a new one.
- **The link's grant is an assignment** with the subject `link:<id>`. `GET /authz/assignments?subject=link:<id>` shows its role and tags.
- **The `LinkCreated` event** goes to the `AuthzEventSink`s without the token.

## Best practices

- Always set `expiresAt` on a link that leaves your organisation.
- Store the token on the client side only as long as you need to hand it over; the server keeps no way to show it again.

## Examples

### Share a project read-only for 30 days

```ts sample
export async function shareProject(baseUrl: string, bearer: string, projectId: string): Promise<{ id: string; url: string }> {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(`${baseUrl}/authz/links?reason=${encodeURIComponent('client review')}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: { type: 'project', id: projectId }, role: 'viewer', expiresAt }),
  });

  const body = (await res.json()) as { results?: { ok: boolean; id?: string; token?: string; error?: { code: string } }[]; error?: { code: string } };
  const created = body.results?.[0];
  if (res.status !== 200 || !created?.id || !created.token) throw new Error(`link refused: ${created?.error?.code ?? body.error?.code}`);

  return { id: created.id, url: `${baseUrl}/projects/${projectId}?link=${encodeURIComponent(created.token)}` };
}
```

The `link` query parameter is the default name authz-http reads a token from (`authz.http.links.query`).

## Related

- [Admin routes](01-admin-routes.md): encodings, answers and status codes.
- [`@spinajs/authz-http`](../authz-http/README.md): how a request presents a link token.
- [AuthzAdmin](../authz/10-authz-admin.md): `link.create`, `link.update` and `link.revoke`.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): the link handler and store.
