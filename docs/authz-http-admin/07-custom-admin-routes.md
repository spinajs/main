# Custom admin routes

The package exports the helpers `AuthzAdminController` is built from. Use them to serve your own routes over `AuthzAdmin` with the same encodings and status codes: a route shaped for your UI, a route on another domain, or one that pins the command kind.

Your route stays a thin layer: build the commands, call `AuthzAdmin` as the request principal, map the result. Leave permissions, validation and the guard to `AuthzAdmin`.

## How it works

1. Get the domain's `AuthzAdmin` with `domainAdmin(domain)`.
2. Build commands from the request. `decodeCommand` turns ISO 8601 expiry strings into `Date`s at the paths `AuthzAdmin` expects.
3. Read the options with `readWriteOptions(req.query)`, or a list query with `readAssignmentsQuery` or `readPageQuery`.
4. Call `admin.execute(principal, commands, options)` or `admin.list(principal, query)`.
5. Answer with `resultsStatus(results)` for a write, and catch `AuthzAdminFailure` to answer `adminErrorStatus(e.code)`.

## Helpers

| Export | Signature | What it does |
| --- | --- | --- |
| `domainAdmin` | `(domain: string) => Promise<AuthzAdmin>` | `root`: `AuthzService.admin()`; any other name: `AuthzDomains.service(domain).admin()`. |
| `decodeCommand` | `(command: unknown) => unknown` | A copy with `expiresAt` as a `Date` for `assignment.grant`, `assignment.setExpiry`, `set.addMember`, `link.create`, `link.update`, and inside `rule` or `policy` for `rule.put` and `policy.put`. Everything else, including a string that is not a valid date-time, stays as it came. The input is never changed. |
| `decodeCommands` | `(commands: unknown) => unknown` | `decodeCommand` for each entry of an array; anything else passes through. |
| `ISO_DATE_TIME` | `RegExp` | The only strings read as a date: date, time (seconds and fraction optional), then `Z` or an offset. |
| `parseResourceRef` | `(value: string, field: string) => ResourceRef` | `<type>` or `<type>:<id>`, split at the first `:`; `$global` is `GLOBAL`. |
| `parseAssignmentSubject` | `(value: string, field = 'subject') => AssignmentSubject` | `<type>:<id>` or `set:<role>@<type>:<id>`. |
| `readAssignmentsQuery` | `(q: QueryInput) => AuthzAdminQuery` | `scope`, `subject`, `role`, `includeExpired`, `limit`, `offset` as an `assignments` query. |
| `readPageQuery` | `(kind: 'links' \| 'rules' \| 'policies', q: QueryInput) => AuthzAdminQuery` | `scope`, `limit`, `offset`. |
| `readWriteOptions` | `(q: QueryInput) => AuthzAdminOptions` | `reason`, `idempotencyKey`, `dryRun`. |
| `QueryInput` | `Readonly<Record<string, unknown>>` | A parsed query string. |
| `adminErrorStatus` | `(code: string) => number` | `403` for `forbidden`, `escalation`, `last_holder`, `self_lockout`, `protected_role`; `404` for `not_found`; `409` for `conflict`; `400` for any other code. |
| `resultsStatus` | `(results: readonly AuthzCommandResult[]) => number` | `200` when every result is ok, else the status of the failed one. |

The parsers throw `AuthzAdminFailure('invalid_query', message, field)` for a malformed value or a key given twice. `limit` and `offset` must be non-negative integers; `includeExpired` and `dryRun` must be `true` or `false`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthzAdminController` | `BaseController`, loaded from the package's controllers dir | `AuthzAdminController` | your own controller | Write a controller with the helpers above, at your own base path. |

`AuthzAdminController` has the protected members `AdminDomain` (`authz.http.admin.domain`), `guarded(fn)`, `single(req, build)` and `list(req, build)`.

<!-- TODO(docs-hook): verify whether a subclass of AuthzAdminController can replace the shipped one at /authz without both being registered (http loads the package's controllers dir) -->

## Important behaviour

- **Keep the actor the request principal.** `AuthzAdmin` checks the actor's permission and runs the guard for it; passing `SYSTEM` or another principal skips what the caller may do.
- **Refuse with `AuthzAdminFailure`** in your own input checks, so the same `{ error: { code, message, field? } }` body and status come out.
- **Set `Cache-Control: no-store`** on a route whose answer can hold a link token, before the first step that can fail.

## Patterns and antipatterns

```ts
// Don't: check the permission in the route, then run as SYSTEM; the guard (escalation, last holder) never runs
if (await authz.can(principal, 'authz:assignments.manage', scope)) await admin.execute(SYSTEM, commands);

// Do: run as the caller and let AuthzAdmin answer
const results = await admin.execute(principal, commands, readWriteOptions(query));
```

## Examples

### Add a member to a team at `/teams/:team/members/:user`

```ts sample
import { AuthzAdminFailure } from '@spinajs/authz';
import type { AuthzCommand } from '@spinajs/authz';
import { IsAuthenticated } from '@spinajs/authz-http';
import { adminErrorStatus, domainAdmin, readWriteOptions, resultsStatus } from '@spinajs/authz-http-admin';
import type { QueryInput } from '@spinajs/authz-http-admin';
import { BadRequestResponse, BaseController, BasePath, Conflict, ForbiddenResponse, NotFound, Ok, Policy, Post, Req } from '@spinajs/http';
import type { Request, Response } from '@spinajs/http';

function answer(status: number, body: unknown): Response {
  switch (status) {
    case 200:
      return new Ok(body);
    case 403:
      return new ForbiddenResponse(body);
    case 404:
      return new NotFound(body);
    case 409:
      return new Conflict(body);
    default:
      return new BadRequestResponse(body);
  }
}

@Policy(IsAuthenticated)
@BasePath('teams')
export class TeamMembersController extends BaseController {
  @Post(':team/members/:user')
  public async addMember(@Req() req: Request) {
    const admin = await domainAdmin('root');
    try {
      const command: AuthzCommand = {
        kind: 'set.addMember',
        set: { role: 'team.member', scope: { type: 'team', id: String(req.params.team) } },
        member: { type: 'user', id: String(req.params.user) },
      };
      const results = await admin.execute(req.storage.Principal!, [command], readWriteOptions((req.query ?? {}) as QueryInput));
      return answer(resultsStatus(results), { results });
    } catch (e) {
      if (e instanceof AuthzAdminFailure) return answer(adminErrorStatus(e.code), { error: { code: e.code, message: e.message, ...(e.field === undefined ? {} : { field: e.field }) } });
      throw e;
    }
  }
}
```

Register the controller like any other: put its file in a directory listed in `system.dirs.controllers`.

## Related

- [Admin routes](01-admin-routes.md): the shipped routes built from these helpers.
- [AuthzAdmin](../authz/10-authz-admin.md): `execute`, `list` and the commands.
- [`@spinajs/authz-http`](../authz-http/README.md): `IsAuthenticated` and the request principal.
