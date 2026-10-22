# Custom admin routes

The package exports the helpers `AuthzAdminController` is built from. Use them to serve your own routes over `AuthzAdmin` with the same encodings and status codes: a route shaped for your UI, a route on another domain, or one that pins the command kind.

Your route stays a thin layer: take validated inputs, build the commands, call `AuthzAdmin` as the request principal, map the result. Leave permissions and the guard to `AuthzAdmin`.

## How it works

1. Take every input as a route argument, never from `@Req()`: `@AdminDomain()` for the domain, `@CurrentPrincipal()` (`@spinajs/authz-http`) for the actor, `@Param(schema)` for path segments, `@AdminQuery()` with a query DTO such as `AuthzWriteOptionsQuery`, and `@Body()` or `@AdminBody()` with a body DTO.
2. Put `@OnError([ValidationFailed, InvalidArgument, AuthzAdminFailure, UnknownAuthzDomain], adminInputAnswer, { stages: ['arguments'] })` on the controller, so input that breaks its schema answers `400 { error: { code, message, field } }` (`invalid_query`, `invalid_request`, `invalid_batch`) and an unknown domain `403 unknown_domain`, as on the shipped routes. See [Input validation](01-admin-routes.md#input-validation).
3. Get the domain's `AuthzAdmin`: `(await domains.service(domain)).admin()`, with `AuthzDomains` injected.
4. Build commands from the inputs. `decodeCommand` turns ISO 8601 expiry strings into `Date`s at the paths `AuthzAdmin` expects.
5. Turn the query DTO into options with `readWriteOptions(options)`, or into a list query with `readAssignmentsQuery`, `readHoldersQuery` or `readPageQuery`.
6. Call `admin.execute(principal, commands, options)` or `admin.list(principal, query)`.
7. Answer a write with `respond(resultsStatus(results), { results })`, a list with `respond(200, page)`, and catch `AuthzAdminFailure` to answer `refused(e)`.

## Helpers

| Export | Signature | What it does |
| --- | --- | --- |
| `AdminDomain` | `() => ParameterDecorator` | The request's domain: `resolveAuthzDomain(req, authz.http.admin.domain)`. Runs before the other arguments, so an unknown domain is refused (`UnknownAuthzDomain`) before the input is checked. |
| `AdminQuery` | `() => ParameterDecorator` | The whole query string as the parameter's `@Schema` DTO class. Integer and boolean properties are read from their strings (`/^\d{1,15}$/`, `true`/`false`); then the schema is checked without coercion. A failure throws `AuthzAdminFailure('invalid_query')` naming the key. |
| `AdminBody` | `() => ParameterDecorator` | The whole body as the parameter's DTO class (required). Unlike `@Body()`, a body key named as the parameter is not taken for the body. A failure is `ValidationFailed`, which `adminInputAnswer` answers `invalid_request`. |
| `AdminBatch` | `() => ParameterDecorator` | The body of a command batch as `AuthzAdminCommandBatch`: the envelope against `BATCH_ENVELOPE_SCHEMA`, each command against the schema its kind has in `AuthzCommandSchemaRegistry`, then `decodeCommands`. Not an object: `invalid_request`; anything else: `invalid_batch`. |
| `decodeCommand` | `(command: unknown) => unknown` | A copy with `expiresAt` as a `Date` for `assignment.grant`, `assignment.setExpiry`, `set.addMember`, `link.create`, `link.update`, and inside `rule` or `policy` for `rule.put` and `policy.put`. Everything else, including a string that is not a valid date-time, stays as it came. The input is never changed. |
| `decodeCommands` | `(commands: unknown) => unknown` | `decodeCommand` for each entry of an array; anything else passes through. |
| `ISO_DATE_TIME` | `RegExp` | The strings `decodeCommand` reads as a date: date, time (seconds and fraction optional), then `Z` or an offset. The route schemas are stricter: their `date-time` format needs the seconds. |
| `parseResourceRef` | `(value: string, field: string) => ResourceRef` | `<type>` or `<type>:<id>`, split at the first `:`; `$global` is `GLOBAL`. |
| `parseAssignmentSubject` | `(value: string, field = 'subject') => AssignmentSubject` | `<type>:<id>` or `set:<role>@<type>:<id>`. |
| `readAssignmentsQuery` | `(q: AuthzAssignmentsQuery) => AuthzAdminQuery` | `scope`, `subject`, `role`, `includeExpired`, `limit`, and `offset` or `after` as an `assignments` query. |
| `readHoldersQuery` | `(q: AuthzHoldersQuery) => AuthzAdminQuery` | `scope` (required), `permission`, `expandSets`, `limit`, and `offset` or `after` as a `holders` query. |
| `readPageQuery` | `(kind: 'links' \| 'rules' \| 'policies', q: AuthzAdminPageQuery) => AuthzAdminQuery` | `scope`, `limit`, and `offset` or `after`. `AuthzOffsetListQuery`, the DTO of `policies`, refuses `after`. |
| `readWriteOptions` | `(q: AuthzWriteOptionsQuery) => AuthzAdminOptions` | `reason`, `idempotencyKey`, `dryRun`, only the ones given. |
| `adminInputAnswer` | `(err: Error) => Response \| undefined` | The `@OnError` handler of the arguments stage, as in step 2. |
| `inputFailure` | `(code, errors, prefix?, fallbackField?) => AuthzAdminFailure` | Validation errors as one failure naming the first offending field; the message never quotes the input. |
| `refused` | `(e: AuthzAdminFailure) => Response` | The status of `e.code` with `{ error: { code, message, field? } }`. |
| `respond` | `(status: number, body: unknown) => Response` | `Ok`, `ForbiddenResponse`, `NotFound`, `Conflict`, else `BadRequestResponse`. |
| `adminErrorStatus` | `(code: string) => number` | `403` for `forbidden`, `escalation`, `last_holder`, `self_lockout`, `protected_role`; `404` for `not_found`; `409` for `conflict`; `400` for any other code. |
| `resultsStatus` | `(results: readonly AuthzCommandResult[]) => number` | `200` when every result is ok, else the status of the failed one. |
| `NoStore` | `RouteMiddleware` | Sets `Cache-Control: no-store` and `Pragma: no-cache` before the route runs; use it with `@Middleware(NoStore)` on a route whose answer can hold a link token. |

The DTOs check the types and caps (see [Input validation](01-admin-routes.md#input-validation)). The parsers throw `AuthzAdminFailure('invalid_query', message, field)` only for what a schema cannot say: a malformed `scope` or `subject`, `after` together with `offset`, and a holders query without `scope`.

### Input DTOs and schemas

| Export | What it is |
| --- | --- |
| `AuthzAdminInput` | Abstract base of every DTO: its constructor refuses a value that is not a plain object with `AuthzAdminFailure('invalid_request')`, then copies it. |
| `AuthzAdminPageQuery` | Abstract base of the list query DTOs: `scope`, `limit`, `offset`, `after`. |
| `ASSIGNMENTS_QUERY_SCHEMA`, `HOLDERS_QUERY_SCHEMA`, `PAGE_QUERY_SCHEMA`, `OFFSET_PAGE_QUERY_SCHEMA`, `WRITE_OPTIONS_QUERY_SCHEMA` | The closed schemas of `AuthzAssignmentsQuery`, `AuthzHoldersQuery`, `AuthzListQuery`, `AuthzOffsetListQuery` and `AuthzWriteOptionsQuery`. |
| `ATTRIBUTES_PATCH_SCHEMA`, `ATTRIBUTES_BODY_SCHEMA` | The open object schemas of `AuthzAttributesPatch` and `AuthzAttributesBody`; `AuthzAdmin` checks the attributes themselves. |
| `BATCH_ENVELOPE_SCHEMA` | The batch body without the per-kind schemas: `commands` (objects with a `kind` of 1 to 128 characters), `reason`, `idempotencyKey`, `dryRun`; closed. |
| `AuthzAdminCommandBatch` | `{ commands, options }`, what `@AdminBatch()` hands the route. |
| `commandFields(kind)` | The properties of a built-in command schema without `kind`: the body of a route that runs that one command. |
| `AuthzAdminQueryArg`, `AuthzAdminBodyArg`, `AuthzAdminBatchArg`, `AuthzAdminDomainArg` | The `RouteArgs` behind the four decorators (`SupportedType` is the class name). Not meant to be replaced. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthzAdminController` | `BaseController`, loaded from the package's controllers dir | `AuthzAdminController` | your own controller | Write a controller with the helpers above, at your own base path. |

`AuthzAdminController` has the protected members `AdminDomain` (`authz.http.admin.domain`), `Domains` (`AuthzDomains`), `guarded(fn, domain?)`, `single(domain, actor, options, build)` and `list(domain, actor, build)`. `guarded` runs `fn` on the domain's `AuthzAdmin` and answers an `AuthzAdminFailure` with `refused`; `single` runs the commands `build()` returns as one batch with `readWriteOptions(options)`; `list` answers `admin.list(actor, build())` with `200`.

<!-- TODO(docs-hook): verify whether a subclass of AuthzAdminController can replace the shipped one at /authz without both being registered (http loads the package's controllers dir) -->

## Important behaviour

- **Keep the actor the request principal.** `AuthzAdmin` checks the actor's permission and runs the guard for it; passing `SYSTEM` or another principal skips what the caller may do.
- **Validate before the route runs.** Take inputs through DTOs and `@Param(schema)`, with `adminInputAnswer` on the controller. Without that `@OnError`, an `AuthzAdminFailure` from `@AdminQuery()` is not answered as `{ error }`.
- **Refuse with `AuthzAdminFailure`** in your own input checks, so the same `{ error: { code, message, field? } }` body and status come out.
- **Set `Cache-Control: no-store`** (`@Middleware(NoStore)`) on a route whose answer can hold a link token, so it is set before the first step that can fail.

## Patterns and antipatterns

```ts
// Don't: check the permission in the route, then run as SYSTEM; the guard (escalation, last holder) never runs
if (await authz.can(principal, 'authz:assignments.manage', scope)) await admin.execute(SYSTEM, commands);

// Do: run as the caller and let AuthzAdmin answer
const results = await admin.execute(actor, commands, readWriteOptions(options));
```

```ts
// Don't: read the raw request; nothing checks the query, and a repeated key arrives as an array
public async addMember(@Req() req: Request) { /* ... readWriteOptions(req.query) ... */ }

// Do: take the validated DTO
public async addMember(@CurrentPrincipal() actor: Principal, @AdminQuery() options: AuthzWriteOptionsQuery) { /* ... */ }
```

## Examples

### Add a member to a team at `/teams/:team/members/:user`

```ts sample
import { AuthzAdminFailure, AuthzDomains, fieldSchema, idField } from '@spinajs/authz';
import type { AuthzCommand, Principal } from '@spinajs/authz';
// authz-rbac adds `set.addMember` to AuthzCommand.
import type {} from '@spinajs/authz-rbac';
import { CurrentPrincipal, IsAuthenticated, UnknownAuthzDomain } from '@spinajs/authz-http';
import { AdminDomain, AdminQuery, AuthzWriteOptionsQuery, adminInputAnswer, readWriteOptions, refused, respond, resultsStatus } from '@spinajs/authz-http-admin';
import { Autoinject } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { BaseController, BasePath, OnError, Param, Policy, Post } from '@spinajs/http';
import { ValidationFailed } from '@spinajs/validation';

// The `authz.admin.param.` id makes adminInputAnswer name the segment in `field`.
const TEAM = fieldSchema('authz.admin.param.team', idField);
const USER = fieldSchema('authz.admin.param.user', idField);

@Policy(IsAuthenticated)
@BasePath('teams')
@OnError([ValidationFailed, InvalidArgument, AuthzAdminFailure, UnknownAuthzDomain], adminInputAnswer, { stages: ['arguments'] })
export class TeamMembersController extends BaseController {
  @Autoinject(AuthzDomains)
  protected Domains: AuthzDomains;

  @Post(':team/members/:user')
  public async addMember(@AdminDomain() domain: string, @CurrentPrincipal() actor: Principal, @Param(TEAM) team: string, @Param(USER) user: string, @AdminQuery() options: AuthzWriteOptionsQuery) {
    const admin = (await this.Domains.service(domain)).admin();
    try {
      const command: AuthzCommand = {
        kind: 'set.addMember',
        set: { role: 'team.member', scope: { type: 'team', id: team } },
        member: { type: 'user', id: user },
      };
      const results = await admin.execute(actor, [command], readWriteOptions(options));
      return respond(resultsStatus(results), { results });
    } catch (e) {
      if (e instanceof AuthzAdminFailure) return refused(e);
      throw e;
    }
  }
}
```

Register the controller like any other: put its file in a directory listed in `system.dirs.controllers`. `POST /teams/t1/members/42?reason=onboarding` adds the member; `?dryRun=yes` answers `400 invalid_query` with `field: 'dryRun'`.

## Related

- [Admin routes](01-admin-routes.md): the shipped routes built from these helpers, and their input validation.
- [AuthzAdmin](../authz/10-authz-admin.md): `execute`, `list` and the commands.
- [`@spinajs/authz-http`](../authz-http/README.md): `IsAuthenticated`, `@CurrentPrincipal()` and the request principal.
