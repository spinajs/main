# `@spinajs/cache-http`

A server-side cache of whole JSON replies. A GET route marked `@ResponseCache` runs once per key; until the stored
reply expires or one of its tags is invalidated, the same request gets the stored reply and the action does not run.
The policies run on every request, a stored reply included, so a revoked route permission is refused at once; what a
stored reply holds does not change until it ends (see "Invalidation and failures").

Nothing is cached unless a route carries the decorator. The replies live in a named cache of
[`@spinajs/cache`](../cache/README.md).

```ts
import { ResponseCache } from '@spinajs/cache-http';

@Get('invoices')
@ResponseCache({ ttl: '5m', tags: ['any:invoice'] })
@Middleware(CacheControl, 60)
public invoices(@Query() page: number) { ... }
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `ttl` | required | How long a stored reply is served: milliseconds or a duration (`'5m'`); capped by `cache.maxTtl` |
| `swr` | none | How long after `ttl` the stored reply is still served while one request runs the route again |
| `scope` | `'principal'` | Who shares a stored reply: the principal that asked, every principal of the tenant (`'tenant'`), everyone (`'shared'`) |
| `sharedBecause` | none | Required with `'tenant'` and `'shared'`, refused with `'principal'`: why the reply is the same for every caller who gets it, as `@AllTenants(reason)` asks for its reason |
| `vary` | `[]` | Request headers whose values are part of the key |
| `tags` | `[]` | Tags the reply depends on: `cache().invalidate(tags)` drops it (later also a write on a cacheable model, once `@spinajs/cache-orm` ships) |
| `cache` | `'default'` | The cache (`cache.caches.<name>`) that keeps the replies |

```ts
@ResponseCache({ ttl: '1m', swr: '10m', scope: 'shared', sharedBecause: 'the price list is public' })
```

A wrong option throws at import, with the name of the route (`Prices.list: @ResponseCache …`), a wider scope without
its reason too. `@ResponseCache` on a route that is not GET or HEAD, a `CacheControl` mounted after it, a `'tenant'` or
`'shared'` scope on a route whose reply a middleware shapes per principal (below) or that reads a request input the key
does not hold (see "Arguments of a shared route"), a `'tenant'` scope with nothing that puts the tenant into the key, a
route that reads the request body, a cache the configuration does not have, and `ResponseCacheMiddleware` mounted with
`@Middleware()` instead of `@ResponseCache` fail the start of the application.

## The key

A stored reply is found again by a SHA-256 hash of a JSON list of: the route, the scope, the principal (scope
`'principal'`), the URL with its query as sent, the `Accept` and `x-data-transform` headers, each `vary` header with its
name (a header sent twice counts as its list; header names in any case), the tenant of the request (from
`@spinajs/tenancy-http`), the language `@spinajs/intl-http` detected (`req.storage.language`), and the parts of every
registered `ResponseCacheKeyPart`. `@spinajs/cache` adds the segments of its `CacheScope` providers. The request
method is not in it: a HEAD request is answered from a stored GET reply, and a HEAD request on a GET route stores
nothing.

The tenant reaches the key through `@spinajs/tenancy-http` (later also through `@spinajs/tenancy-cache`, once it
ships), or through any `IdempotencyScopePart` or `CacheScope`. A `'tenant'` route fails its registration when there is
none; the check cannot tell a tenant part from another one (a region part passes it too), and a request without a
tenant gets no tenant part: such requests share their replies.

**A reply that depends on anything else must say so**, or another request gets it: a request header the action reads
belongs in `vary`; a value a middleware puts into `req.storage` needs a key part:

```ts
@Injectable(ResponseCacheKeyPart)
export class RegionKeyPart extends ResponseCacheKeyPart {
  public partOf(storage: IActionLocalStoregeContext) {
    return 'region' in storage && typeof storage.region === 'string' ? `region:${storage.region}` : undefined;
  }
}
```

The principal is `req.storage.Principal`, which `@spinajs/authz-http` resolves. On a per-principal route a request
runs uncached, and the route logs one warning for each of these reasons:

- it has no such principal. That is also the case with `@spinajs/authn-http` alone: its `req.storage.AuthnPrincipal`
  is not read. With `@spinajs/authz-http` installed the principal is read, but see "What is stored": authn-http's
  `no-store` keeps a signed-in caller's reply out of the store unless the route sets its own `Cache-Control`;
- its principal is unauthenticated (the anonymous principal every caller without credentials gets): a page for
  visitors is cached with `scope: 'shared'`;
- its principal is not one the key can read whole: an `id` that is not a string (a number from an application's own
  principal source, for example), an `authenticated` that is not `true` or `false`, a malformed ceiling, delegation or
  sign-in.

The principal's part of the key holds its type and id, its ceiling, delegation, impersonator and companions, and the
strength of its sign-in: method, strategy, assurance and MFA steps. So a principal with a ceiling, a delegation, an
impersonation, a share link or companions has entries of its own, apart from the same user's unrestricted ones, and a
reply computed for a step-up (`aal2`) sign-in never reaches an `aal1` session of the same user.

### What the key leaves out

Not in the key: the time of the sign-in, the session handle, the principal's attributes, its source, the external
login (provider and session id) and the identity object. So a stored reply can differ only between sessions of **one**
identity, never between two identities. When that difference matters, the route must not be cached per principal:

```ts
// principal.authn.authenticatedAt >= env.now - 300s shows the payout details: a reply stored in minute 1 of a fresh
// sign-in reaches the same session at minute 10, and another session of the user that signed in an hour ago, until ttl
// principal.authn.sessionHandle != null (session callers only): a token caller of the same user usually differs in
// method or strategy, which are keyed, but nothing guarantees that
// resource.department == principal.attributes.department, the department asserted by an OIDC or SAML claim: after the
// identity provider changes it, the user's next session gets the old department's rows until ttl
```

Leave such a route uncached, or, for an attribute, put the value into the key with a `ResponseCacheKeyPart`; the time
of a sign-in cannot be keyed. A `FreshAuth` policy is not affected: the policies run on every request, a stored reply
included.

The `Host` header is not in the key either. On a `'tenant'` or `'shared'` route a reply that builds URLs from the
request host (`req.hostname`, `req.protocol`) needs `vary: ['host']`, and `x-forwarded-host` (and `x-forwarded-proto`)
behind a proxy: otherwise one caller's `Host` header plants its links in the reply every caller gets. An action that
reads `Accept-Language` itself needs `vary: ['accept-language']`, with or without `@spinajs/intl-http`, which never
reads that header. The key holds no build or version of the application: a reply cached before a deployment is served
after it until it ends, and two versions behind one shared store exchange their replies; invalidate the route's tags
on deploy, or register a `ResponseCacheKeyPart` that returns the build id. Two applications that share one store
(Redis) need a cache name of their own each: with the same cache name and route path they compute the same keys.

## Arguments of a shared route

On a `'tenant'` or `'shared'` route only arguments from the URL (`@Query`, `@Param`), the container and `Accept` are in
the key. A `@Header`, `@Cookie` or `@UserAgent` argument needs its header in `vary`, `@Referer()` both `referer` and
`referrer`, and `@Header()` must name its header (`@Header('x-region')`): http names an argument only after the routes
are registered. Any other argument (session, IP, the current principal or user, `@Lang()`, the orm-http model and
filter arguments, an application's own resolver) fails the registration: cache such a route with scope `'principal'`.
An action that takes `@Req()` or `@Res()` fails the registration too.

http also passes `req`, `res` and `next` after the declared arguments: an action with more parameters than declared
arguments fails the registration, but one that reads them through a default or rest parameter, `arguments`, or under
a method decorator that wraps the action (`@Measure()` of `@spinajs/log`, whose wrapper takes `...args`) cannot be
seen. A `'tenant'` or `'shared'` action must not read the request at all, whatever decorates it; it takes what it needs
as `@Query`, `@Param` or `@Header` arguments.

A route that reads the request body (`@Body`, a form, a file, the raw body, `@ContentDigest`, `@RequestStream`) fails
the registration on every scope, per principal too: a GET body is in no key.

## What is stored

Only a reply that answers no error with status 200, a JSON content type and a body that parses as JSON (or none); whose
response sets no cookie (whoever set it, a session middleware included), has neither `no-store` nor `no-cache` in its
`Cache-Control` (a hit never asks the action again), says `private` only with scope `'principal'`, and does not say
`Vary: *`. On a `'tenant'` or `'shared'` route a reply whose route sets its own `Vary` naming `Cookie` or
`Authorization` is not stored either: it was made for one caller. Only a `Vary` the route sets itself is checked:
`@spinajs/intl-http` adds `Vary: Cookie, X-Lang` and CORS `Vary: Origin` to every reply, and the language intl-http
detects is in the key; intl-http joins its names into a `Vary` the route sets, so such a route is not stored on a wider
scope. Streams, files, text, XML and HTML replies are never stored, nor the reply of a HEAD request on a GET route.

The reply is stored after it was sent. It keeps its `Content-Type`, `Location`, `ETag` and, of the headers the route
set, only those that describe the body (`Content-Language`, `Content-Disposition`, `Last-Modified`, `Link`,
`Cache-Control`, `Expires`, `Vary`), on every scope: a route's `X-Request-Id`, CSRF token or rate-limit value belongs to
one request or session, and one principal has many. A header like that is set by a middleware, which sets it again on
a hit. Any other header the route sets itself is missing on a hit, also per principal: a total count such as
`X-Total-Count` (the admin user list of `@spinajs/users-http` sends one) belongs in the body, or the route is not
cached; a client that pages by that header breaks on its second request. A value read back from the store is checked
before it is sent: a corrupt entry, or one an older version or another application wrote, is a miss and the route
runs.

`@spinajs/authn-http` sets `Cache-Control: no-store` on every request it finds a session or a principal for, before
the route runs. With it installed a signed-in caller's reply is therefore stored only when the route sets its own
`Cache-Control` (for example `private, max-age=60` in the reply's headers), which replaces that value. A per-principal
route without that header runs its action on every signed-in request, and logs one warning on the logger `cache` that
says so; a `'tenant'` or `'shared'` route is filled by callers without a session and served to everyone.

`CacheControl` answers `private` to every request that carries `Authorization`, whatever its own options say. A
`'tenant'` or `'shared'` route that also has a `CacheControl` therefore stores nothing for callers who sign in with a
bearer token; leave `CacheControl` off such a route, or set its `Cache-Control` in the action.

A `'tenant'` or `'shared'` reply is the reply of the first principal that asked, after every hook: never share a route
whose reply depends on who asks. A route middleware that shapes the reply for the caller says so with
`public static readonly PerPrincipalReply = true` (the field filter of `@Access(…, { fields: 'filter' })`,
`AuthzFieldsMiddleware`, does), and a `'tenant'` or `'shared'` route that mounts one, on the route or on its
controller, fails its registration; mounted for every route (`http.routes.middlewares`), it keeps the route from being
answered from the store (next section). A request whose `x-data-transform` names a transformer marked the same way runs
uncached on every scope. A marked server middleware is not seen by this version: on a `'tenant'` or `'shared'` route
its view of the first caller is stored. `sharedBecause` is where the author vouches for the rest.

## A stored reply on its way out

It goes through the reply pipeline as `CachedResponse`, a `ReplayedResponse`: the `onAfter` hooks of the server
middlewares and of the route middlewares mounted before `@ResponseCache` run on it, and a hook that changes data
skips it as it skips an idempotent replay. Route middlewares mounted after `@ResponseCache` do not run. That is why a
`CacheControl` on the same route goes below `@ResponseCache` (decorators are mounted bottom-up). A request whose
`If-None-Match` names the stored `ETag` gets 304.

**Write every decorator that mounts a route middleware below `@ResponseCache`.** The policies run on every request, but
a middleware written above it would not run on a stored reply, so the cache does not answer such a route from the
store at all: on the first request it reads the middlewares mounted on the route, and when an inner one (no `Stage`, or
`'inner'`) with `onBefore`, `onAfter`, `onFinish` or `onAround` comes after it, the route runs uncached and one error on
the logger `cache` names the middleware. `'outer'` and `'beforePolicy'` middlewares run before the cache wherever they
are written and do not count. `@Access(…, { fields: 'filter' })` mounts such a middleware: write it below
`@ResponseCache` or on the controller, and the filter runs on every stored reply again.

```ts
@Get('invoices')
@ResponseCache({ ttl: '5m' })
@Access('invoice:read', { fields: 'filter' })   // below: cached, and filtered on every stored reply
public invoices() { ... }
```

## Stale while revalidate

With `swr`, an expired reply stays in the store for `swr` longer (`ttl` and `swr` together end at most `cache.maxTtl`
after the reply's tags were read). The first request of a process that finds it runs the route, gets the new reply and
stores it; while it runs, every other request of the key in that process gets the expired reply, each from its own
lookup. So the expired reply is served only while the cache still holds it valid for that request: never after one of
its tags was invalidated, never to a request of another key (another principal, tenant, language or `vary` value), and
never to a request of another cache scope. Other replicas keep serving the expired reply until their own first request
refreshes it.

The refresh is that first request: it runs the route with its own principal, tenant and request store, waits for it,
and gets the new reply. No refresh runs in the background, and none outlives its request. Its reply is stored by the
rules of "What is stored", under the tag versions its own lookup read before the route ran: a refresh that an
invalidation reaches while it runs stores a reply that is already invalid. A refresh that fails, or whose reply is not
stored, leaves the expired reply in place, and the next request of the process refreshes it again.

## Concurrent requests

Concurrent requests of one key that find nothing in one process wait for the one that runs the route, then look the
key up again in their own scope: each gets the stored reply through its own lookup and its own reply pipeline, so a
waiter never gets the headers or the cookies of the request it waited for. When that run stores nothing (it failed,
its client went away, its reply is not stored, or an invalidation reached it), each waiter runs the route itself.
A request waits at most `cache.http.timeout`; then it runs the route itself, and the route logs a warning at most once
a minute. A request of another key never waits; one of another cache scope (a tenant that only a `CacheScope` puts
into the key) may wait for the run of the same key in another scope, and then runs its own.

## Invalidation and failures

An entry is dropped when its `ttl` (and `swr`) ends or one of its `tags` is invalidated. Without `tags` it lives its
whole `ttl`. An error of the cache is logged on the logger `cache` and read as a miss: the route runs.

A stored reply is not checked again until it ends, `ttl` plus `swr`, at most `cache.maxTtl` (default `1h`):

- The rows an `.accessible()` or `@spinajs/authz-orm`-filtered query returned for the caller stay in a stored reply,
  so a caller whose access to a row was revoked keeps seeing it from the cache until then. Cache a row-filtered list
  with scope `'principal'` and a short `ttl` (and no `swr`), or do not cache it.
- A hit runs no query, so `@AuditReads` of `@spinajs/audit-orm` records only the miss. Do not cache a route that reads
  an audited model, or accept that its hits leave no read record. `@spinajs/audit-http`'s `Audit` and the policy
  decision log do run on a hit.

## Configuration

| Key | Default | What it does |
| --- | --- | --- |
| `cache.http.timeout` | `250` | Milliseconds the response cache waits for its cache to answer a lookup or a store, and for a concurrent run of the same key. Past it a lookup or a store is read as a miss and the request runs uncached, and a request that waited runs the route itself; the route logs a warning, at most once per call and minute. A store call that answers later may still store the reply, under the tag versions read before the action ran, so an invalidation in between still wins. A key part or a cache call that throws is read the same way. |
