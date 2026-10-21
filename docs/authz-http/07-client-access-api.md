# Client access API

`AccessController` tells a client what its caller may do, so a UI can hide buttons it would only get a 403 for: `GET /user/access` returns an access summary and `POST /user/access/checks` answers a batch of checks. Every response with a principal carries `X-Access-Epoch`, which changes when the caller's access may have changed without any authz data changing.

The API is generic and tied to no UI kit; ckit's `createHttpChecker` talks to it with its defaults. It answers for the caller only: there is no route to ask about another principal (the [explain route](09-explain.md) is the debugging tool for that).

## How it works

The package config adds the package's `controllers` folder to `system.dirs.controllers`, so http discovers `AccessController` (`@BasePath('user/access')`) like an app controller ([Controller discovery](../http/03-controller-discovery.md)). Both routes answer in the domain `authz.http.access.domain` (default `root`), or the one the [`AuthzDomainResolver`](../authz/05-domains.md#per-request-domains) names for the request; an unknown name is a 403 with reason `unknown_domain`.

### `GET /user/access`

1. `HasPrincipal` lets any principal in, anonymous included; no principal is 401.
2. The route reads the caller with `@CurrentPrincipal()` and the domain with `@AccessDomain()`, not `@Req()`.
3. Calls `AuthzService.summary(principal)` and answers 200 with the `AccessSummary`:

```json
{
  "principal": { "type": "user", "id": "alice" },
  "models": [{ "model": "rbac", "roles": [{ "role": "editor", "scope": { "type": "$global" } }] }],
  "permissions": [
    { "name": "file:read", "conditional": false },
    { "name": "file:write", "conditional": true }
  ]
}
```

`permissions` are the permissions at `$global`; `conditional: true` means "only on some rows". `ceiling` is present for a principal that has one. The shape of each `models` entry comes from the model ([`@spinajs/authz`](../authz/03-checking-permissions.md)).

### `POST /user/access/checks`

Request and answer:

```json
{ "checks": [
    { "object": { "type": "invoice", "id": "42" }, "permission": "edit" },
    { "object": { "type": "invoice", "id": "*" }, "permission": "invoice:create" },
    { "object": { "type": "invoice", "id": "42" }, "permission": "edit", "context": { "field": "amount" } }
] }
```

```json
{ "results": [true, false, true], "reasons": [null, "no_access", null] }
```

1. `HasPrincipal`: any principal, anonymous included; 401 without one.
2. `checks` is validated as a route argument against `ACCESS_CHECKS_SCHEMA` (`authz.http.accessChecks`): a required list of at most 100 entries (`MAX_ACCESS_CHECKS`); anything else is the standard validation 400 for the whole request (`ValidationError`, body `{ message, parameter, details }`, see [Validation errors](../validation/07-validation-errors.md)). The entries are not validated at this point, so a non-object entry is answered `false` like any malformed one. The route reads the caller with `@CurrentPrincipal()` and the domain with `@AccessDomain()`, not `@Req()`.
3. `readClientCheck()` reads each entry. A malformed entry gets its own `false` and never fails the batch:
   - the entry must match `CLIENT_CHECK_SCHEMA` (`authz.http.clientCheck`): `object.type` (up to 64 characters), `object.id` (up to 160) and `permission` (up to 256) are non-empty strings, `context.field` is up to 128 characters. Unknown keys are ignored;
   - a `permission` with `:` is used as is; otherwise it becomes `<object.type>:<permission>`;
   - `id: '*'` checks the type (`{ type }`, "may I create one"); `type: '$global'` checks `GLOBAL`;
   - `subject`, when present, must be the caller (`{ type, id }` of the principal, no `relation`); the subject checked is always the request's principal;
   - `context.field` (non-empty) narrows the answer to that field; `context.fieldMode` is `'read'` or `'write'` (default `'write'`), and any other value breaks `CLIENT_CHECK_SCHEMA`, so the entry is answered `false` with `invalid_request`. No other `context` key is read.
4. `answerClientChecks()` sends the valid entries to `AuthzService.checkAll(principal, ...)` in one call.
5. Each answer is `true` only for a definite allow: allowed, with a `TRUE` residual, and, with `context.field`, the field in `decision.fields[fieldMode]` minus `neverRead`.

`reasons[i]` for a `false`:

| Reason | Meaning |
| --- | --- |
| `invalid_request` | The entry is malformed, the permission name is invalid, or the decision denied with this code (an unknown permission or type). |
| `subject_mismatch` | `subject` names someone other than the caller. |
| `conditional` | Allowed only if the row matches; a client cannot know, so the answer is `false`. |
| `field_denied` | Allowed, but not for `context.field`. |
| any other code | The decision's deny reason, e.g. `no_access`, `ceiling`, `anonymous`. |

### `X-Access-Epoch`

`AccessEpochMiddleware` (a server middleware, `Order` 11, right after `PrincipalMiddleware`) sets `X-Access-Epoch` on every response whose request has a principal, anonymous included. A request with no principal gets no header.

The value, `accessEpoch(principal)`, is the first 16 hex characters of a SHA-256 over the principal's key, its session handle (`principal.authn.sessionHandle`) and its ceiling. It changes on login, role switch, MFA elevation and impersonation start and end (each rotates the session), and when a token's or link's ceiling changes. It does not change when an admin grants or revokes a role; those changes arrive as [access events](08-access-events.md).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.http.access.domain` | `string` | `'root'` | a domain name | The domain `GET /user/access`, `POST /user/access/checks` and the explain route answer for; the fallback of the `AuthzDomainResolver`. |
| `system.dirs.controllers` | `string[]` | the package's `lib/<mjs\|cjs>/controllers` folder (added by the package config) | | Where http finds `AccessController`. |
| `http.cors.exposedHeaders` | `string[] \| string \| null` | not set | header names | Add `X-Access-Epoch` so cross-origin browser clients can read it ([CORS](../http/16-cors.md)). |

```ts
export default {
  authz: { http: { access: { domain: 'root' } } },
  http: { cors: { exposedHeaders: ['X-Access-Epoch'] } },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AccessController` | `BaseController`, discovered from `system.dirs.controllers` | `AccessController` | | Subclass it with your own `@BasePath` to add routes; see [overriding a package controller](../http/02-controllers-and-routing.md). |
| `AccessEpochMiddleware` | `ServerMiddleware` list, `@Injectable(ServerMiddleware)`, `Order` 11 (`ACCESS_EPOCH_MIDDLEWARE_ORDER`) | `AccessEpochMiddleware` | | `DI.register(Mine).as(AccessEpochMiddleware)` before `HttpServer` resolves. |
| `answerClientChecks(service, principal, entries, { authz, log })` | exported function | | | Reuse the wire format on another transport. |
| `readClientCheck(raw, principal)` | exported function | | | One entry as a `ClientCheck`, or the reason it is answered `false`. |
| `AccessChecks()` | parameter decorator: the body's `checks` validated against `ACCESS_CHECKS_SCHEMA` (required) | | | Reuse it on your own route that takes the same body; the argument type is `AccessChecksBody` (`readonly unknown[]`). |
| `ACCESS_CHECKS_SCHEMA`, `CLIENT_CHECK_SCHEMA`, `MAX_ACCESS_CHECKS` | exported schemas (`authz.http.accessChecks`, `authz.http.clientCheck`) and the list cap `100` | | | Read-only. |
| `CLIENT_CHECK_REASONS` | frozen object: `invalid`, `subjectMismatch`, `conditional`, `fieldDenied` mapped to the reason codes above | | | Compare `reasons[i]` against it instead of string literals. |

## Important behaviour

- **Only a definite allow is `true`.** A conditional permission answers `false` with `conditional`; show the action and let the route decide when the row matters.
- **A bad entry costs only its own answer.** Answers keep the request order.
- **The subject is always the caller.** A client cannot ask about other users here.
- **`X-Access-Epoch` is set before routing**, so it is on error answers too.
- **Answers are per node and per moment.** Cache them in the client until the epoch changes or an `authz.changed` event arrives.

## Best practices

- Drop the client's cached answers when `X-Access-Epoch` changes, and refetch on `authz.changed`.
- Batch the checks of one screen in one `POST /user/access/checks` call.
- Use the bare action form (`"permission": "edit"` on `{ "type": "invoice" }`) in UI code; the server builds `invoice:edit`.

## Related

- [Access events](08-access-events.md): `GET /user/access/events`, the push side.
- [Protecting routes](01-protecting-routes.md): the server-side check the UI answer mirrors.
- [`@spinajs/authz`](../authz/03-checking-permissions.md): `summary` and `checkAll`.
- [`@spinajs/http-socket`](../http-socket/README.md): the socket transport for the same push events.
