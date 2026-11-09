# Idempotency-Key

`@Idempotent()` makes a route safe to retry. A client sends an `Idempotency-Key` header. The first request with that
key runs the route, and every repeat within `ttl` gets the stored reply instead of running it again.

```ts
import { BaseController, BasePath, Body, Created, Idempotent, Post } from '@spinajs/http';

@BasePath('orders')
export class OrdersController extends BaseController {
  @Post()
  @Idempotent({ required: true, ttl: '24h' })
  public async create(@Body() order: NewOrder) {
    return new Created(await this.orders.place(order));
  }
}
```

Install `@spinajs/idempotency` and import it in the app entry, before the boot:

```ts
import '@spinajs/idempotency';
```

The keys live in the store `idempotency.store` names (`OrmIdempotencyStore` by default, see
[`@spinajs/idempotency`](../idempotency/README.md)). The ORM reads its models and runs migrations when it resolves, so
the import must come first. `@spinajs/http` loads the package itself only when the first `@Idempotent` route
registers, which is too late for the `__idempotency` table. With the ORM store, a route registered after the Orm
resolved without the model fails the boot with `RouteRegistrationException`. With
`idempotency.store: 'MemoryIdempotencyStore'` the import is optional.

A wrong `idempotency.*` value, or a `ttl` that is not a duration, fails the route registration as well, not the first
request: the boot fails with `RouteRegistrationException`, and for a bad `ttl` its cause is an `InvalidArgument`.

## Options

| Option | Default | Meaning |
|---|---|---|
| `required` | `false` | `true`: a request without the header is refused with 400 |
| `ttl` | `'24h'` | how long a reply replays |
| `fingerprint` | `'body'` | `'body'`: a repeat with a different body or URL is refused with 422; `'none'`: only the method and URL are compared |
| `maxReplyBytes` | `1048576` | a larger reply is not stored, and its key is released |
| `sharedScope` | `'random'` | `'random'`: a caller in a [shared scope](#shared-scopes) (anonymous, or a share link without a signed-in companion) must send a random UUID, or is refused with 400 `idempotency.key-not-random`; `'any'`: any key |

## The header

`Idempotency-Key` takes the two forms of draft-ietf-httpapi-idempotency-key-header. One is a quoted string (`"k 1"`:
printable ASCII, `\"` and `\\` escapes, no parameters). The other is bare visible ASCII (`0x21`–`0x7E`) without `,` and
`;`. `"k-1"` and `k-1` are the same key. The key itself is 1 to 255 characters. Use a fresh random UUID per
operation, which a caller in a [shared scope](#shared-scopes) must. A malformed or repeated header is refused with 400
`idempotency.key-malformed`.

## What happens

| Situation | Answer |
|---|---|
| first request with a key | the route runs; a 2xx or 4xx JSON reply is stored |
| repeat within `ttl` | the stored status, headers (see below) and body, plus `Idempotent-Replayed: true`; for an authenticated principal without running the policies (see [Replays before the policies](#replays-before-the-policies)) |
| repeat while the first still runs | 409 `idempotency.in-flight` with `Retry-After` (seconds) |
| repeat with a different body or URL, while the first runs or after it | 422 `idempotency.key-reuse` |
| a key that is not a random UUID, from a caller in a [shared scope](#shared-scopes) | 400 `idempotency.key-not-random`, after the policies; the route does not run and nothing is claimed |
| a claim inside a database transaction lost a deadlock or serialization check | 409 `idempotency.claim-conflict` with `Retry-After: 1` |
| client disconnects before the route started (in a policy or during the claim) | the route does not run; the key is not claimed, or is released |
| client disconnects after the route started, before the reply finished | the key stays claimed until the lease ends: the route may still commit; a retry gets 409 meanwhile |
| the route crashed (an error with `crash: true`, a dead process in tests and simulations) | nothing is stored or released; the key stays claimed until the lease ends |
| 5xx, 1xx or 3xx reply | not stored; the key is released, so a retry runs the route again |
| 401, 403, 408, 425 or 429 reply | not stored; the key is released: these say "try again later" or "with other credentials", and a stored one would replay for the whole `ttl` |
| reply that is not JSON (HTML, XML, text, file, stream, redirect) | not stored, a warning is logged, the key is released |

All the errors are problem+json. A replay is answered by the gate itself: the action and the inner route middlewares do
not run for it. A replay of an authenticated principal is answered before the policy gate, and only the `'beforePolicy'`
route middlewares and the server middlewares see it (see
[Middlewares on an early replay](#middlewares-on-an-early-replay)). Otherwise the outer middlewares entered before the gate (global and controller ones, and route ones written below
`@Idempotent`, since decorators apply bottom-up) run for it: their `onAfter` gets a `ReplayedResponse`, whose `data` is
the stored body they already shaped on the first answer. The entered server middlewares' `onAfter` run on it too, after
the route's: `x-response-time`, `Server-Timing` and `X-Access-Epoch` are set on a replay as on any reply. A hook that changes data checks
`ctx.response instanceof ReplayedResponse`; a data change it makes is sent, and the stored bytes otherwise. See
[Route middlewares](14-route-middlewares.md#around-middlewares).

An optional route (`required: false`) without a key runs as usual. If its client left during the policy stage, before
the route started, the route does not run either.

### Headers of a replay

| Header | Replayed |
|---|---|
| `Content-Type`, `Location`, `ETag` | yes, also when an `onAfter` hook set them; the stored `ETag` is dropped when an `onAfter` hook changed the replayed data, and express computes one for the new body |
| headers the route set through `IResponseOptions.Headers` (`new Ok(body, { Headers: [...] })`) | yes |
| `Set-Cookie`, also when the route set it through `IResponseOptions.Headers` | never |
| `Connection`, `Keep-Alive`, `Transfer-Encoding`, `Trailer`, `Upgrade`, `Content-Length`, `Date` | never; the replay's own send sets those it needs |
| headers set by middlewares (an `onAfter` hook included), server middlewares or `res.setHeader` in the action | no; server middlewares that run before the route (CORS, helmet) set theirs on the replay again, and an outer route or server `onAfter` that runs on the replay sets its own again |

## Replays before the policies

Policies judge the current state. Once a request committed (a delete, a state change such as "submit" guarded by
`status == 'draft'`), a policy refuses its resend with 403 or 404. A client whose first response was lost would then
be told that its successful operation failed, which is the failure an idempotency key exists to prevent. So for an
authenticated, unrestricted principal, a repeat of a completed key is replayed before the
[policy gate](13-policies.md):

```text
'beforePolicy' middlewares → replay check → policy gate → outer and inner middlewares → claim → action
```

The check replays only when all of these hold:

- the caller is an authenticated principal (`req.storage.Principal`), which the Authn and Principal server middlewares
  verify again on every request, before routing;
- the principal is unrestricted: it has no `ceiling` (a scoped token, a signing key, a role switch), no `onBehalfOf`,
  no `authn.impersonator`, no `companions`, and is not a share link (`type: 'link'`). The limits of those credentials
  are enforced by the policies, so their repeats always go through them;
- that principal has a completed record of the key on this route;
- the request has the record's fingerprint: method, URL and, with `fingerprint: 'body'`, the body.

The stored reply is then sent as a `ReplayedResponse` through the reply pipeline. Neither the policies nor the action
run. In every other case the request goes on to the policies and the claim, as before:

| Situation | Answer |
|---|---|
| anonymous caller | the policies run first: all anonymous callers share one scope, so their repeats are judged by the policies; then a key that is not a random UUID is refused with 400 `idempotency.key-not-random` ([shared scopes](#shared-scopes)), and a random one goes to the claim |
| restricted principal (ceiling, delegation, impersonation, share link, companions) | the policies run first, then the claim in the principal's own [scope](#scope); a share link bearer without a signed-in companion must send a random UUID, as an anonymous caller must |
| route without policies | no check: the claim replays, there is nothing to skip |
| no record, or the record expired | the policies, then the claim |
| key in flight | the policies, then the claim: 409 `idempotency.in-flight`; a retry after the first run completed is replayed |
| a different request on the key | the policies, then the claim: 422 `idempotency.key-reuse` |
| record stored without a fingerprint | the policies, then the claim |
| the store fails on the check | a warning is logged; the policies, then the claim |
| a `'beforePolicy'` middleware answered | the policies judge that answer, as on any route |

The claim stays after the policies, so a 401 or 403 is still never stored. The check reads the principal as it is
before the gate: an app that signs the caller in inside a policy, not in a server middleware, gets its replays after
the policies. The check reads the store without a timeout of its own, as the claim does: a store that hangs holds the
request before the policies instead of after them.

### Why the policies may be skipped

On any other route the policies always run, even after a `'beforePolicy'` middleware answered
([Stage](14-route-middlewares.md#stage)). This replay is the single exception, and it holds because of three facts:

- the same principal identity and authority: the key's scope holds the principal, verified again before routing, and
  only a principal with the full authority of its identity is replayed early, so a replay never reaches another
  principal or a narrower credential of the same one;
- the same request: the fingerprint binds the key to the method, the URL and the body that were authorized the first
  time;
- nothing executes: the client gets the reply it was already given, or would have been given, for that request.

Two consequences follow:

- Policies that do not depend on the principal, such as an IP allowlist, MFA step-up freshness or a tenant header,
  are not evaluated again on a replay. The replayed reply is the one they admitted the first time. A tenant chosen by
  a header is not part of the fingerprint either, so one user's request to tenant B with a key used for tenant A
  replays A's reply, on the claim path too: put the tenant in the URL, or in the body with `fingerprint: 'body'`.
- A principal whose permission was revoked within `ttl` still gets the reply it was owed. That is the standard
  semantics of idempotency keys (the IETF Idempotency-Key draft, Stripe). Keep `ttl` short on routes where this matters.

### Middlewares on an early replay

A replay before the policies is an early answer: only the middlewares entered before the check see it. Those are the
server middlewares and the route's `'beforePolicy'` middlewares; the shipped [`Audit`](30-audit.md) records it. The
`'outer'` and `'inner'` route middlewares are not entered, so their `onAfter` does not run and they set no header on
it. A replay that goes through the claim (an anonymous or restricted caller, a principal signed in inside a policy, a
route without policies) is seen by the `'outer'` middlewares entered before `@Idempotent`, so one key can be replayed
in two shapes. A middleware that decorates replies (adds headers, wraps the body) and must see every replay belongs
in the `'beforePolicy'` stage or among the server middlewares.

## Scope

A key is one key per route and principal. The route is `http:<METHOD> <path>` with the route template, for example
`/orders/:id/pay`. The principal is the authenticated principal, or `anonymous`. The same key from two users runs
twice. All anonymous callers of a route share one key space (see [Shared scopes](#shared-scopes)).

A restricted principal gets a scope of its own: its key (`principalKey`) together with its authority, which is its
`ceiling`, `onBehalfOf` and `delegation`, `authn.impersonator` and `companions` (`idempotencyPrincipal()` of
`@spinajs/idempotency`). A reply stored for the full session of a user never replays to a scoped token, a role switch
or an admin impersonating that user, nor the other way round. An unrestricted principal keeps the plain
`principalKey`. A share link is scoped by the link, its scope and expiry and the signed-in companion: two bearers of
one link who are not signed in share its key space, as anonymous callers share theirs.

### Shared scopes

Two kinds of caller share one key space with every caller like them: anonymous callers (no principal, or an
unauthenticated one) and the bearers of one share link who are not signed in (a `type: 'link'` principal without
`companions`). There a key one caller picked can be another caller's key. A collision answers the second caller with
the first one's stored reply when the requests match, or with 422 `idempotency.key-reuse` or 409
`idempotency.in-flight` for a request it never sent. A caller who guesses another's key and sends the same request gets
that caller's stored reply.

So with `sharedScope: 'random'` (the default) a caller in a shared scope must send a random UUID, version 4 or 7, bare
or quoted. Any other key is refused with 400 `idempotency.key-not-random`. The check runs after the policies, so a 401
or 403 still wins, and before the claim, so the route does not run and nothing is claimed. A request without the
header is not affected: an optional route runs it as usual, and a `required: true` route refuses it with 400
`idempotency.key-required`. A signed-in user, and a link bearer with a signed-in companion, may send any key.
`isSharedScope()` and `isRandomKey()` of `@spinajs/idempotency` make the two checks.

`sharedScope: 'any'` takes any key in a shared scope too. Use it only when every client of the route draws its keys at
random anyway, and the format is all that differs.

The fingerprint covers the method, the full URL (path and query) and, by default, the body. A key reused on another
resource of the same route template is refused with 422, never replayed. Send one key per operation.

Only a body a server middleware parsed (JSON, form, text) is compared byte for byte. A body no parser read before
the route (multipart uploads, `application/octet-stream`, any type without a parser) is compared only by the method,
the URL, the media type of `Content-Type` (without its parameters, so a new multipart boundary still matches) and
`Content-Length`. Two different uploads of the same size under one key replay the first reply.

## Guarantees

The route runs at least once. If the server dies after claiming a key and before storing the reply, the key stays
claimed until its lease (`idempotency.lease`, default 30 s) ends. Then a retry runs the route again.

The claim is not part of a transaction the action opens: the gate claims before the action runs and stores the reply
after the response finished, both outside it. A claim made while a transaction is already open (a server middleware
or a policy that wraps the whole request in one) joins that transaction instead. It commits or rolls back with it,
other callers of the key wait on the row until then instead of getting 409 at once, and a lost deadlock or
serialization check answers 409 `idempotency.claim-conflict`. Keep such request-wide transactions off `@Idempotent`
routes (see [Transactions](../idempotency/README.md#transactions)).

The lease is renewed while the route runs, but http has no abort signal an action could observe. If a renewal fails
long enough for the lease to end during a slow action (a lost database connection, a paused process), another
replica may claim the key and run the action a second time while the first one is still running.
