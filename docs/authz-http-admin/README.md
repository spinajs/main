# `@spinajs/authz-http-admin`

HTTP routes under `/authz` over the `AuthzAdmin` management API of `@spinajs/authz`: grant and revoke roles, manage share links, rules, policies and scope attributes, and run command batches.

The routes check only that the caller is signed in. They do **not** check permissions, validate commands or run the admin guard themselves: `AuthzAdmin` does all of it, with the caller's principal as the actor. The package ships no `AdminGuard` and does not load `@spinajs/authz-rbac`.

It takes over the role routes of the 2.x `@spinajs/rbac-http-admin`; see [the migration guide, C4](../authz/migration-guide.md#c4-authz-http-admin).

## Install

```sh
npm install @spinajs/authz-http-admin
```

The package config adds its controllers directory to `system.dirs.controllers`, so **an app with the package installed serves the routes**. It also needs:

- `@spinajs/authz-http`: its `PrincipalMiddleware` sets the request principal that `IsAuthenticated` checks.
- A model that registers the write handlers: `@spinajs/authz-rbac` for assignments, subject sets, links and rules, `@spinajs/authz-abac` for policies.
- An admin guard named in `authz.admin.guard.service` (`DefaultAdminGuard` from `@spinajs/authz-rbac`). Without one every `AuthzAdmin` call fails closed with `AuthzConfigError`. See [AuthzAdmin](../authz/10-authz-admin.md).

## Features

| Feature | What it does |
| --- | --- |
| [Admin routes](01-admin-routes.md) | The 18 `/authz` routes: protection, the domain they run on, encodings, answers, status codes and the permission each one needs. |
| [Command batches](02-command-batches.md) | `POST /authz/commands`: any `AuthzCommand` list in one transaction, with `reason`, `idempotencyKey` and `dryRun`. |
| [Role assignments](03-role-assignments.md) | Grant, change, revoke and list role assignments over HTTP. |
| [Share links](04-share-links.md) | Create, change, revoke and list share links; the token is shown once. |
| [Rules, policies and scope attributes](05-rules-policies-and-scope-attributes.md) | Put, delete and list RBAC rules and ABAC policies; read, merge and replace the attributes of a scope node. |
| [OpenAPI documentation](06-openapi-documentation.md) | `AuthzAdminSchemaProvider` and `describeAuthzAdminDocument` add the request bodies and query parameters to the http-swagger document. |
| [Custom admin routes](07-custom-admin-routes.md) | Build your own routes over `AuthzAdmin` with the exported decoding, query and status helpers. |

## Quick start

Grant `viewer` on project `p1` to user `42`, as the signed-in caller:

```ts sample
export async function grantViewer(baseUrl: string, sessionCookie: string): Promise<string> {
  const res = await fetch(`${baseUrl}/authz/assignments?reason=${encodeURIComponent('onboarding')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify({ subject: { type: 'user', id: '42' }, role: 'viewer', scope: { type: 'project', id: 'p1' } }),
  });

  const body = (await res.json()) as { results?: { ok: boolean; id?: string; error?: { code: string } }[]; error?: { code: string } };
  if (res.status !== 200) {
    throw new Error(`grant refused (${res.status}): ${body.results?.at(-1)?.error?.code ?? body.error?.code}`);
  }
  return body.results![0].id!;
}
```

## Related packages

- [`@spinajs/authz`](../authz/10-authz-admin.md): `AuthzAdmin`, its commands, permissions, guard, idempotency and audit; every route runs there.
- [`@spinajs/authz-http`](../authz-http/README.md): `IsAuthenticated`, `PrincipalMiddleware` and the `authz.http.*` config schema that validates `authz.http.admin.domain`.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): the write handlers and readers of assignments, links and rules, `DefaultAdminGuard` and `DbAuthzAdminBackend`.
- [`@spinajs/authz-abac`](../authz-abac/README.md): the handler and reader behind the policy routes.
- [`@spinajs/http-swagger`](../http-swagger/README.md): builds the OpenAPI document the [OpenAPI documentation](06-openapi-documentation.md) page completes.
