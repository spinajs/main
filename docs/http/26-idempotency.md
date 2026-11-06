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
request.

## Options

| Option | Default | Meaning |
|---|---|---|
| `required` | `false` | `true`: a request without the header is refused with 400 |
| `ttl` | `'24h'` | how long a reply replays |
| `fingerprint` | `'body'` | `'body'`: a repeat with a different body or URL is refused with 422; `'none'`: only the method and URL are compared |
| `maxReplyBytes` | `1048576` | a larger reply is not stored, and its key is released |

## The header

`Idempotency-Key` takes the two forms of draft-ietf-httpapi-idempotency-key-header. One is a quoted string (`"k 1"`:
printable ASCII, `\"` and `\\` escapes, no parameters). The other is bare visible ASCII (`0x21`–`0x7E`) without `,` and
`;`. `"k-1"` and `k-1` are the same key. The key itself is 1 to 255 characters. Use a fresh UUID per operation. A
malformed or repeated header is refused with 400 `idempotency.key-malformed`.

## What happens

| Situation | Answer |
|---|---|
| first request with a key | the route runs; a 2xx or 4xx JSON reply is stored |
| repeat within `ttl` | the stored status, headers (see below) and body, plus `Idempotent-Replayed: true` |
| repeat while the first still runs | 409 `idempotency.in-flight` with `Retry-After` (seconds) |
| repeat with a different body or URL, while the first runs or after it | 422 `idempotency.key-reuse` |
| a claim inside a database transaction lost a deadlock or serialization check | 409 `idempotency.claim-conflict` with `Retry-After: 1` |
| client disconnects before the route started (in a policy or during the claim) | the route does not run; the key is not claimed, or is released |
| client disconnects after the route started, before the reply finished | the key stays claimed until the lease ends: the route may still commit; a retry gets 409 meanwhile |
| the route crashed (an error with `crash: true`, a dead process in tests and simulations) | nothing is stored or released; the key stays claimed until the lease ends |
| 5xx, 1xx or 3xx reply | not stored; the key is released, so a retry runs the route again |
| 401, 403, 408, 425 or 429 reply | not stored; the key is released: these say "try again later" or "with other credentials", and a stored one would replay for the whole `ttl` |
| reply that is not JSON (HTML, XML, text, file, stream, redirect) | not stored, a warning is logged, the key is released |

All the errors are problem+json. A replay is answered by the gate itself: route middlewares and the action do not run
for it.

### Headers of a replay

| Header | Replayed |
|---|---|
| `Content-Type`, `Location`, `ETag` | yes |
| headers the route set through `IResponseOptions.Headers` (`new Ok(body, { Headers: [...] })`) | yes |
| `Set-Cookie`, also when the route set it through `IResponseOptions.Headers` | never |
| `Connection`, `Keep-Alive`, `Transfer-Encoding`, `Trailer`, `Upgrade`, `Content-Length`, `Date` | never; the replay's own send sets those it needs |
| headers set by middlewares, server middlewares or `res.setHeader` in the action | no; server middlewares that run before the route (CORS, helmet) set theirs on the replay again |

## Scope

A key is one key per route and principal. The route is `http:<METHOD> <path>` with the route template, for example
`/orders/:id/pay`. The principal is the authenticated principal, or `anonymous`. The same key from two users runs
twice. An anonymous route shares one key space between all its callers, so give anonymous routes `required: true`
and have clients send random UUIDs.

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
