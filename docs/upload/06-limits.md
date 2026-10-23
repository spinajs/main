# Limits

The upload refuses a file, a part or a session that is too large, too fragmented or too many, before it reads or stores the bytes. This page lists each limit, how a controller tightens it per request, which HTTP limits sit in front of the routes, and what a client sees when a part is refused before its body was read.

## How it works

1. `effectiveLimits(configured, limitsFor(req))` merges the configured `upload.limits` with the controller's per-request override. The override can only tighten.
2. `create` checks the file size, plans the parts (`planParts`) and checks the owner's open sessions, then stores `part_size`, `part_count` and `expires_at` on the session.
3. `putPart` compares `Content-Length` with the part's size before reading, counts the bytes with `ByteLimitStream` while reading, and compares the count after.
4. Parts and completes after `expiresAt` are refused; the sweeper expires the session.

| Limit | Enforced where | Refusal |
| --- | --- | --- |
| `size <= maxFileSize` | create | `400` `upload.too_large` |
| `minPartSize <= partSize <= maxPartSize` and `partCount <= maxParts` | create | `400` `upload.part_size` |
| Open sessions per owner `< maxOpenSessionsPerOwner` | create | `429` `upload.too_many_sessions` |
| Part bytes = the part's size | part: `Content-Length` before the read, the byte limit during it, the count after it | `411` `upload.length_required`, `400` `upload.part_size`, `413` `upload.part_too_large` |
| Session lifetime `sessionTtl` | part, complete; the sweeper | `410` `upload.expired` |
| A part body at most `UPLOAD_MAX_PART_BYTES` (5 GiB, the ceiling of `maxPartSize`) | `@RequestStream({ maxBytes })` of the part route | `413` |
| Request rate, body size per path | `http.throttle`, `http.bodyLimits` (below) | `429`, `413` |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `upload.limits.maxFileSize` | `integer` | `1073741824` (1 GiB) | `>= 1` | Largest declared file size. |
| `upload.limits.partSize` | `integer` | `8388608` (8 MiB) | `>= 1` | Part size when the client asks for none. |
| `upload.limits.minPartSize` | `integer` | `1048576` (1 MiB) | `>= 1` | Smallest part size a client may ask for. |
| `upload.limits.maxPartSize` | `integer` | `67108864` (64 MiB) | `1`..`5368709120` | Largest part size; the drain bound when the part's size is unknown. |
| `upload.limits.maxParts` | `integer` | `10000` | `>= 1` | Most parts per session. |
| `upload.limits.maxOpenSessionsPerOwner` | `integer` | `20` | `>= 1` | Open sessions per owner; sessions without an owner are not counted. |
| `upload.limits.sessionTtl` | `string` | `'24h'` | a duration above zero, e.g. `30m`, `24h`, `7d` | Lifetime of a session from create. |

`limitsFor(req)` returns `Partial<UploadLimits>`. The merge, per key:

| Key | Merge |
| --- | --- |
| `maxFileSize`, `maxPartSize`, `maxParts`, `maxOpenSessionsPerOwner` | the smaller of the two |
| `minPartSize` | the larger of the two |
| `sessionTtl` | the override when it is shorter; a zero duration throws `InvalidOption` |
| `partSize` | the override as given; it is still clamped into `minPartSize`..`maxPartSize` |

A `NaN` or infinite number in the override is ignored. A `sessionTtl` of zero (`'0s'`) is server misconfiguration, not a client error: it throws `InvalidOption`, answered `500` `upload.internal`.

The metadata of a session has no limit of its own; the body limits of `http` cap it (below).

## Refused parts

An answer sent while the client is still sending its body resets the connection on the client's side, so the client sees `ECONNRESET` instead of the JSON error. The part route therefore settles the unread body before every refusal, from the policy stage on (`@OnError(Error, settleRefusedPart)` on `putPart`):

1. A request whose body has already arrived whole is answered at once, and keeps its keep-alive connection.
2. A body whose `Content-Length` is at most the bound is read off and discarded, then answered. The bound is the part's size once the session and part number are known, else `upload.limits.maxPartSize`.
3. Any other body (larger than the bound, or chunked without `Content-Length`) is answered with `Connection: close`. A client that sends more than the socket buffers hold may then see a reset instead of the JSON.

So a refused request costs at most one part of reading, like an accepted one. Send the exact `Content-Length` with every part: the answer then always arrives.

## HTTP limits in front of the routes

`http.bodyLimits` and `http.throttle` run before routing. Their `413` and `429` answers do **not** pass through the part route's settle step: they are early answers, with the reset risk above for a body in flight.

### `http.bodyLimits`

The part route needs no body limit: it refuses a `Content-Length` that is not the part's size before reading, and stops reading at the part's size. Add one only as a coarse cap for a static prefix you own, well above `upload.limits.maxPartSize`:

```ts
// config/http.ts in your app; the controller is @BasePath('uploads')
export default {
  http: {
    bodyLimits: [{ path: '/uploads', limit: '80mb' }],
  },
};
```

- A rule matches a path prefix, so it cannot name `:placeholders`. Under `projects/:project/uploads` the only prefix is `/projects`.
- A rule also sets the JSON, urlencoded and XML body limit of every route under its prefix. A large limit on `/projects` lets every JSON route there accept 80 MB bodies.

See [Body size limits](../http/04-route-arguments.md#body-size-limits).

### `http.throttle`

Throttling is off by default. A recipe per client IP:

```ts
// config/http.ts in your app; the controller is @BasePath('projects/:project/uploads')
export default {
  http: {
    throttle: {
      enabled: true,
      rules: [
        // create and complete: a few sessions a minute
        { path: '/projects', methods: ['POST'], limit: 30, windowSeconds: 60 },
        // parts: a 1 GiB file is 128 parts of 8 MiB; leave room for retries and parallel sends
        { path: '/projects', methods: ['PUT'], limit: 600, windowSeconds: 60 },
      ],
    },
  },
};
```

- The first rule whose prefix and methods match wins, so list specific paths first.
- A `PUT` rule refuses with `429` before routing: keep its limit well above the part rate of a legitimate client, or it costs connections.
- The in-memory counters are per process. See [Throttling](../http/18-throttling.md) for a shared store.

### Node request timeout

Node ends a request that takes longer than `server.requestTimeout`, 300 seconds by default; SpinaJS does not change it.

- A legitimate part must arrive within it: 64 MiB over a 1 Mbit/s link takes about 9 minutes. Pick `partSize` (or `limitsFor`) so the slowest client you serve sends a part in well under 5 minutes, or raise the timeout.
- A refused part that is drained (step 2 above) can hold its connection until the timeout too.

```ts
import { DI } from '@spinajs/di';
import { HttpServer } from '@spinajs/http';

const server = await DI.resolve(HttpServer);
server.Server.requestTimeout = 15 * 60 * 1000;
await server.start();
```

## Important behaviour

- **The owner cap is soft on Postgres and MySQL.** The insert counts the owner's open sessions after locking their rows. An owner with **no** open session has no row to lock, so concurrent first creates of that owner are not serialised: N such requests can leave the owner with up to `maxOpenSessionsPerOwner + N - 1` open sessions. SQLite runs one transaction at a time and is exact.
- **Sessions without an owner are never capped.** `ownerOf()` returning `null` turns the cap off, and the count is skipped.
- **A lock conflict is retried once.** The insert transaction retries once after a deadlock, lock wait timeout (MySQL 1213, 1205) or serialization failure (Postgres `40001`, `40P01`), unless a caller's transaction is open. A second `1205` can double the latency of a `create`.
- **`maxPartSize` is also the drain bound** for refusals whose part size is unknown: an unknown session, a refusing policy or `authorize`, or a part number out of range. Keep it near your real part size.
- **A refusal answers after the drain.** A client sending a refused part at full speed sees the answer once its body is sent; a slow one waits up to the request timeout.

## Best practices

- Have clients send `Content-Length` with every part; never send parts chunked.
- Set `maxOpenSessionsPerOwner` to what one user really needs in parallel; abandoned sessions count until the sweeper expires them.
- Give each controller its own limits in `limitsFor` (a profile picture route does not need 1 GiB), instead of lowering the global ones.

## Related

- [Wire protocol](01-protocol.md#errors): the limit error codes.
- [Raw request bodies and digests](../http/24-raw-body-and-digests.md): how `@RequestStream` stops a long body.
- [Throttling](../http/18-throttling.md) and [Route arguments](../http/04-route-arguments.md#body-size-limits).
