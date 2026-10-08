# `@spinajs/authz-http-admin`

Admin routes over the SpinaJS authorization management API (`AuthzAdmin`,
design §6.6.5).

## Routes

| Route | Runs |
|---|---|
| `POST /authz/commands` `{ commands, reason?, idempotencyKey?, dryRun? }` | `execute` |
| `GET /authz/assignments?scope=&subject=&role=&includeExpired=&limit=&offset=` | `list({ kind: 'assignments' })` |
| `POST /authz/assignments`, `PATCH`/`DELETE /authz/assignments/:id` | `assignment.*` |
| `GET`/`POST /authz/links`, `PATCH`/`DELETE /authz/links/:id` | `link.*` |
| `GET /authz/rules`, `PUT`/`DELETE /authz/rules/:id` | `rule.*` |
| `GET /authz/policies`, `PUT`/`DELETE /authz/policies/:id` | `policy.*` |
| `GET`/`PATCH`/`PUT /authz/scopes/:type/:id/attributes` | `scope.*` |

- The routes check only that the caller is authenticated (401 otherwise).
  The caller's principal is the actor; every permission, validation and
  guard check runs inside `AuthzAdmin`, so an HTTP call and an in-process
  call get the same answer.
- Query encodings: `scope` is `<type>` or `<type>:<id>`; `subject` is
  `<type>:<id>` or `set:<role>@<type>:<id>`. On the single-command routes
  `reason`, `idempotencyKey` and `dryRun` go in the query string.
- Writes answer `{ results }`; a failed command sets the status (403 for
  `forbidden`, `escalation`, `last_holder`, `self_lockout`,
  `protected_role`; 404 `not_found`; 409 `conflict`; 400 otherwise).
  Lists answer `{ items, total }`.
- A link token is shown once: only in the answer of `POST /authz/links` or
  of the `POST /authz/commands` batch that created it. Both routes send
  `Cache-Control: no-store`.

## Configuration

- `authz.http.admin.domain` (default `root`): the authz domain whose
  `AuthzAdmin` the routes use.
- The package ships no `AdminGuard`; `AuthzAdmin` runs the one named in
  `authz.admin.guard.service` (`DefaultAdminGuard` from
  `@spinajs/authz-rbac`).

## Swagger

http-swagger documents the routes and their answers. It cannot see the
request bodies and query parameters, because the routes read them from the
request so that no http-layer check can refuse what `AuthzAdmin` would
answer. Pass the built document through `describeAuthzAdminDocument(doc)` to
add them.
