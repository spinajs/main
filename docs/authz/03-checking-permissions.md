# Checking permissions

`AuthzService` is the one API every check goes through. Resolve it at boot, then reach it anywhere with the synchronous `authz()` helper. Adapters (HTTP routes, ORM lists, queue jobs, file systems) call the same service for you.

## How it works

1. At boot, `await DI.resolve(AuthzService)` boots the root domain; `await (await DI.resolve(AuthzDomains)).service(name)` boots another ([Domains](05-domains.md)).
2. `authz(domain = 'root')` returns the booted service of that domain. It never resolves anything: before the boot it throws `AuthzConfigError`.
3. `authz().current()` returns the principal of the current request or job (the `Principal` key of the async request store), else `UNATTENDED`.
4. A method such as `assert(principal, permission, resource, subject?)` runs the check flow ([How a check works](01-check-flow.md)) and returns a `Decision`, a boolean or an access plan.

## The service API

| Method | Returns | Use it to |
| --- | --- | --- |
| `current()` | `Principal` | Get the caller: the request store's principal, else `UNATTENDED`. |
| `can(principal, permission, resource?, subject?)` | `Promise<boolean>` | Branch on access. Returns `decision.allowed`, which is also true for a conditional allow. |
| `assert(principal, permission, resource?, subject?)` | `Promise<Decision>` | Guard an operation. Throws `AccessDenied` (a 403 `Forbidden` carrying `decision`) on a denial. |
| `check(input)` | `Promise<Decision>` | Get the whole decision: fields, roles, reason, `validUntil`. |
| `explain(input)` | `Promise<Decision>` | Debug a decision: every model is evaluated, caches are bypassed, `decision.trace` is set and the call is audited as `explain`. |
| `inspect?(input)` | `Promise<Decision>` | Optional. A decision for admin tools, not an access attempt: never audited, reads and stores no decision cache, models read fresh. Never guard an action with it ([Holders](13-holders.md#inspect)). |
| `ancestors?(ref)` | `Promise<ResourceRef[] \| null>` | Optional. The path a check of `ref` walks, `[ref, ...ancestors, GLOBAL]`; `null` for an unknown resource. |
| `checkMany(principal, permissions, resource?)` | `Promise<Map<Permission, Decision>>` | Several permissions on one resource (which buttons to show). The resource is resolved once; the checks share one request cache. |
| `checkAll(principal, requests)` | `Promise<Decision[]>` | Many `{ permission, resource }` pairs, in input order. See [Batch checks](#batch-checks). |
| `accessPlan(principal, permission, type, env?)` | `Promise<AccessPlan>` | Filter a list before the query. An adapter renders the plan ([Access plans](#access-plans)). |
| `filter(principal, permission, type)` | `Promise<ResourceFilter>` | The type-level residual: the check on `{ type }`. |
| `filterNow(principal, permission, type)` | `ResourceFilter \| undefined` | The same, synchronously; `undefined` when a step needs IO. Models with `sync: 'after-preload'` need `preload()` first. |
| `summary(principal, at = GLOBAL)` | `Promise<AccessSummary>` | What the principal may do at a node: for an access screen or a client cache. |
| `covers(holder, target, at = GLOBAL)` | `Promise<boolean>` | The impersonation rule: the holder's permissions strictly contain the target's (B26). |
| `preload(principal)` | `Promise<void>` | Let models load the principal's data before many checks or `filterNow`. |
| `runAs(principal, reason, fn)` | `Promise<T>` | Run `fn` as another principal, usually `SYSTEM`. Audited as `runAs`. |
| `invalidate(tags)` | `void` | Drop cached decisions by tag in this domain ([Caching](06-caching-and-change-propagation.md)). |
| `models()` | `AuthorizationModel[]` | The models of this domain, after `disable` and overrides. |
| `admin()` | `AuthzAdmin` | This domain's write API ([AuthzAdmin](10-authz-admin.md)). Throws when none is registered. |
| `domain` | `string` | The domain name. |

### `check()` input

`CheckInput` is a `DecisionRequest` whose `resource` may also be an object an adapter accepts.

| Field | Type | Meaning |
| --- | --- | --- |
| `principal` | `Principal` | Who asks. `DefaultAuthzService` uses `current()` when the key is absent. |
| `permission` | `Permission` | A registered permission name, never a glob. |
| `resource` | `ResourceRef \| object` | A ref, or a row (an adapter's `refOf()` gives its ref and the row becomes the subject). Absent: `{ type: <resource part> }`. |
| `subject` | `unknown` | The row to evaluate a residual against. |
| `actor` | `Principal` | The acting principal, when it differs from `principal`. |
| `env` | `Record<string, unknown>` | Request facts conditions read as `env.*` (IP, time zone). `env.now` always comes from `AuthzClock`. |
| `explain` | `boolean` | Same as calling `explain()`. |
| `fresh` | `boolean` | Skip the decision caches and the models' assignment caches for this call. The answer is still stored. |

## Conditional allows

A model may permit "if the row matches", such as an `owner` grant. Checked on a bare ref, that is `allowed: true` with a residual such as `{ op: 'relation', relation: 'owner' }`. `can()` and `assert()` then say yes.

- Pass the row: `assert(me, 'task:update', task)` when an adapter accepts `task`, or `assert(me, 'task:update', { type: 'task', id }, task)`. The engine evaluates the residual against it and the decision is definite.
- Check `decision.residual.op === 'true'` when only an unconditional yes will do. `AuthzAdmin` requires that for every command.
- `checkAll` loads the rows of conditional answers itself ([Batch checks](#batch-checks)).

## Batch checks

`checkAll(principal, requests)` answers many single-object checks of one principal:

1. Each entry with an unregistered permission, or a type outside the permission's types, becomes a denial with `invalid_request`; one bad entry never fails the batch.
2. One `ancestorsMany()` call per type fills the request cache, where the adapter has it.
3. Each entry is checked. An allowed entry with a residual is checked again against its row, loaded with one `loadMany()` call per type, else `load()` per ref.
4. No row denies `unknown_resource`; a failed load denies `model_error`; an adapter that cannot load leaves the answer conditional.

## Access plans

`accessPlan(principal, permission, type, env?)` answers a list before the query runs, without reading any row:

- `{ kind: 'none', reason }`: nothing could grant it. A list with no permit at all is a 403, not an empty list (H16).
- `{ kind: 'filter', permit: 'all' | PlanTerm[], deny: PlanTerm[], within?, validUntil? }`: rows that match a permit term and no deny term, inside the ceiling's `within` resources.

The permission must be declared `list: true` and `type` must be in its `types`, or the call throws `AuthzConfigError`. `SYSTEM` gets `permit: 'all'`. An `intersect` delegate gets `none` with `delegate`. The routed models' `listPlan()` answers combine under `deny-overrides` only. A plan without `env` is kept in the request cache. A plan of a `fresh` permission neither reads nor stores that cache, passes `ListPlanRequest.fresh` to the models (RBAC reads assignments fresh), and runs a model's nested checks fresh. `@spinajs/authz-orm` renders plans as query conditions; see [its docs](../authz-orm/README.md).

## `summary` and `covers`

Both count what each routed model lists in its `summarize()` answer, so a scoped, bare-type or pattern-limited grant counts too (RFC L1-3).

- `summary` runs a quiet check per candidate permission at `at`. A name a model's summary lists but the check denies shows as `conditional: true`; its fields are the union over the entries, less `neverRead`. A check that rests on an engine fault leaves its permission out.
- For `covers`, the target's set is its own checks plus every summary entry of the models routed for the permission. At `$global`, holder and target are also compared on each type of the permission. The holder's set is its checks only, never a summary.
- A summary entry counts as covered only when the holder is unconditional on every compared resource and has the entry's fields. The holder's fields come from its unconditional permits only.
- A deny on the target never drops its summary entries: a deny may rest on session facts that change under impersonation.
- `covers` is false, never a guess, when a routed model gives no summary for the target (no `summarize`, a failure, a timeout or a malformed answer), when a compared route uses a custom combinator, and past its deadline. **A model you write must implement `summarize`**, or `covers` stays false in every domain that routes it.
- `covers` judges one instant, with the target object you give it. Build the target the way the session will carry it: no strategy attributes, no ceiling, the companions and the actor the session will have.
- Both run under a deadline of a multiple of `authz.engine.modelTimeoutMs`; `covers` holder checks skip the cache.

## Checks outside the core

Other packages call the service for you. One line each; their docs hold the details.

| Where | API | Package |
| --- | --- | --- |
| HTTP routes | `@Access(permission, { resource: fromParam(...) \| fromModel(...), subject, fields })`, `@AllowAnonymous()`, `@Unscoped(reason)` | [`@spinajs/authz-http`](../authz-http/01-protecting-routes.md) |
| ORM lists | `Model.where(...).accessible(permission)`, `.withAccess([...])`, `.within(refs)` | [`@spinajs/authz-orm`](../authz-orm/README.md) |
| Queue jobs | `@Job({ runAs: 'initiator' \| 'system' })` | [`@spinajs/authz-queue`](../authz-queue/README.md) |
| File systems | `authz.fs.<name>.mode: 'enforce'` checks `fs:*` on every path | [`@spinajs/authz-fs`](../authz-fs/README.md) |
| Edit time | the ESLint rule `@spinajs/authz/require-accessible` | [`@spinajs/eslint-plugin-authz`](../eslint-plugin-authz/README.md) |

## Helpers

| Export | Use |
| --- | --- |
| `authz(domain?)` | The booted `AuthzService` of a domain, synchronously. |
| `definite(decision)` | True only for an allow whose residual is `TRUE`. |
| `currentPrincipal()` | The request store's principal, else `UNATTENDED`, without a service. |
| `filterObject(fields, data)` | Keeps the fields of an object (or array) that `decision.fields.read` allows; values come back as `JSON.stringify` sees them. |
| `compileFieldGlobs(globs)` | A matcher for field globs such as `['*', '!Password']`. |
| `matchesPermission(glob, name)`, `isPermission(name)`, `parsePermission(name)` | Permission name and glob rules in app code. |
| `GLOBAL`, `resourceKey(ref)` | The root resource; `type:id` keys. |
| `SYSTEM`, `UNATTENDED`, `principalKey(ref)` | The built-in principals; `type:id` keys of principals. |

## Errors

The errors extend `@spinajs/exceptions` classes, so `@spinajs/http` maps them by class:

| Error | Extends | HTTP | When |
| --- | --- | --- | --- |
| `AccessDenied` | `Forbidden` | 403 | `assert()` denied; `error.decision` holds the decision, which stays out of the error body. |
| `Unauthenticated` | `AuthenticationFailed` | 401 | An anonymous request on a route `@Access` guards (authz-http). |
| `AuthzConfigError` | `InvalidOption` | 500 | Wrong setup: the service is not booted, a misconfigured domain, model or decorator, a glob instead of a name, a type outside `types`, a malformed request, `runAs` without a reason. |
| `UnknownPermission` | `AuthzConfigError` | 500 | A check names an unregistered permission; an `implies` names one at boot. |
| `AuthzAdminFailure` | `Exception` | 500 unless the adapter answers it (authz-http-admin does, by `code`) | A refused admin command; carries `code` and `field` ([AuthzAdmin](10-authz-admin.md)). |

`AuthzConfigError` and `AuthzAdminFailure` take the standard `{ cause }` option. The cause stays non-enumerable and `inner` stays unset, so it never reaches an HTTP error body.

## Important behaviour

- **`authz()` throws before boot.** Resolve the service in a bootstrapper or at app start, not lazily in a hot path.
- **Every check inside one request shares the L1 cache.** `runAs` starts a new one, so a decision of the outer principal never leaks into the inner run.
- **`runAs` drops the route's decision and `@Unscoped` mark** from the request store for `fn`, preloads the principal unless it is `SYSTEM` or `UNATTENDED`, and refuses an empty `reason`. It is audited unless `authz.audit.runAs` is false.
- **`can()` on a ref says yes to a conditional allow.** Pass the row when the answer guards that row.
- **`fresh` costs a store read per check** in models that keep assignment caches.

## Best practices

- Check before the operation, on the object it touches: load the row by id, then `assert(me, permission, row)`.
- Check a create against the parent: `assert(me, 'task:create', { type: 'folder', id: folderId })`.
- Use `checkMany` for the actions a screen offers on one object, and `checkAll` for a table of objects.
- Use `explain()` (or `authz.engine.explain` in development) to see which model decided and why.

## Patterns and antipatterns

```ts
// Don't: a code path with no user turns into SYSTEM by accident; UNATTENDED is denied on purpose
const me = authz().current();
await authz().assert(me, 'invoice:delete', ref);

// Do: act as SYSTEM explicitly, with a reason that lands in the audit
await authz().runAs(SYSTEM, 'nightly-invoice-cleanup', async () => {
  await authz().assert(SYSTEM, 'invoice:delete', ref);
});
```

```ts
// Don't: a bare ref answers "yes, if the row matches" for owner grants
if (await authz().can(me, 'task:update', { type: 'task', id })) await save(task);

// Do: pass the row so the residual is evaluated
if (await authz().can(me, 'task:update', { type: 'task', id }, task)) await save(task);
```

## Examples

### Return only the invoice fields the caller may read

```ts sample
import { authz, filterObject } from '@spinajs/authz';

interface Invoice {
  id: string;
  number: string;
  amount: number;
  internalNote: string;
}

export async function readInvoice(invoice: Invoice): Promise<Partial<Invoice>> {
  const decision = await authz().check({
    principal: authz().current(),
    permission: 'invoice:read',
    resource: { type: 'invoice', id: invoice.id },
    subject: invoice,
  });
  if (!decision.allowed) return {};
  return filterObject(decision.fields.read, invoice);
}
```

### Decide which actions an invoice screen shows

```ts sample
import { authz } from '@spinajs/authz';

export async function invoiceActions(invoiceId: string): Promise<string[]> {
  const me = authz().current();
  const decisions = await authz().checkMany(me, ['invoice:approve', 'invoice:delete', 'invoice:read'], { type: 'invoice', id: invoiceId });
  return [...decisions].filter(([, d]) => d.allowed && d.residual.op === 'true').map(([permission]) => permission);
}
```

### Purge old drafts from a scheduled job

```ts sample
import { SYSTEM, authz } from '@spinajs/authz';

export async function purgeDrafts(draftIds: string[]): Promise<void> {
  await authz().runAs(SYSTEM, 'cron:purge-drafts', async () => {
    for (const id of draftIds) {
      await authz().assert(authz().current(), 'invoice:delete', { type: 'invoice', id });
      // ... delete the draft
    }
  });
}
```

## Related

- [How a check works](01-check-flow.md): what every method above runs.
- [Declaring permissions](02-permissions.md): what a check may name.
- [`@spinajs/authz-http`](../authz-http/README.md): `@Access`, field filtering and `/user/access`.
- [`@spinajs/authz-orm`](../authz-orm/README.md): lists through access plans.
- [`@spinajs/authz-testing`](../authz-testing/README.md): fakes and harnesses to test checks.
