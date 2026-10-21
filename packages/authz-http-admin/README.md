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
| `GET /authz/holders?scope=&permission=&expandSets=&limit=&offset=` | `list({ kind: 'holders' })` |
| `GET /authz/policies`, `PUT`/`DELETE /authz/policies/:id` | `policy.*` |
| `GET`/`PATCH`/`PUT /authz/scopes/:type/:id/attributes` | `scope.*` |

- The routes check only that the caller is authenticated (401 otherwise).
  The caller's principal is the actor. The inputs are DTOs checked against
  closed schemas first (400 `invalid_request`, `invalid_query` or
  `invalid_batch` with the `field`); every permission and guard check runs
  inside `AuthzAdmin`, so a well-formed HTTP call and an in-process call get
  the same answer.
- Query encodings: `scope` is `<type>` or `<type>:<id>`; `subject` is
  `<type>:<id>` or `set:<role>@<type>:<id>`. On the single-command routes
  `reason`, `idempotencyKey` and `dryRun` go in the query string.
- Writes answer `{ results }`; a failed command sets the status (403 for
  `forbidden`, `escalation`, `last_holder`, `self_lockout`,
  `protected_role`; 404 `not_found`; 409 `conflict`; 400 otherwise).
  Lists answer `{ items, total }`.
- `GET /authz/holders` lists who holds `permission` on `scope` (both
  required; `expandSets=true` also lists set members). It answers `{ items,
  total }`, or 400 `invalid_query` for a missing or unknown value, 401, and
  403 `forbidden` (the caller needs `authz:holders.read` at the resource).
  See [Holders](../../docs/authz/13-holders.md).
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

http-swagger documents the routes, their answers and the `@Body()` DTOs.
Pass the built document through `describeAuthzAdminDocument(doc)` to add the
batch body, the attribute bodies and the query parameters, which the routes
take through their own route arguments.
