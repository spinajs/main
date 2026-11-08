# Concurrency limit

`ConcurrencyLimit` is a server middleware for load shedding: it caps how many requests this process serves at once. A request over the cap is answered 503 with `Retry-After` before throttling, authentication, routing and the action, so an overloaded instance answers fast instead of queueing work it cannot finish in time, and a load balancer or client can retry elsewhere.

It is off by default. When on, it runs at Order 2.6: after CORS (-1), `RequestId` and `RealIp` (1), `AccessLog` and the timing middlewares (2) and `MaintenanceMode` (2.5), so a refusal carries `x-request-id` and is logged and counted like any reply; before throttling (3), CSRF (4), authentication (5) and routing.

## How it works

Per request (`onBefore`, synchronous):

1. Fewer than `http.concurrency.max` requests in flight: the request is counted and goes on.
2. Else: it returns a 503 with `Retry-After: <http.concurrency.retryAfter>` and `{ error: { code: 'overloaded', message: 'The server is busy, try again later' } }`. A refused request is not counted.

A counted request frees its slot in `onFinish`: when its response finished, or when its client went away (`aborted`). The 503 goes through the reply pipeline like every early answer.

The count covers every request the server middlewares see: routes, 404s and static files.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.concurrency.enabled` | `boolean` | `false` | | Turns the middleware on; read once at mount. |
| `http.concurrency.max` | `integer` | `500` | ≥ 1 | Requests served at once by this process. |
| `http.concurrency.retryAfter` | `integer` | `1` | ≥ 0 | Seconds sent in `Retry-After`. |

```ts
export default {
  http: {
    concurrency: { enabled: true, max: 200, retryAfter: 2 },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | How to replace or extend |
| --- | --- | --- | --- |
| `ConcurrencyLimit` | `ServerMiddleware` list; singleton | itself | `DI.register(Mine).as(ConcurrencyLimit)`; override `onBefore` and call `super.onBefore(ctx)` for the requests you count. |

`InFlight: number` is the count now; read it for a metric or a readiness check.

## Important behaviour

- The limit is per process. With several instances behind a load balancer, the cluster serves up to `max` times the instance count.
- A client that goes away frees its slot at once, even while its action still runs: the action is not stopped. With actions that ignore that, the cap bounds the requests being answered, not the work in progress.
- Raw `http.middlewares` handlers (the body and cookie parsers, unless your version mounts them as server middlewares) run before every server middleware: a refused request's body has been read already.
- A long-lived response (a server-sent event stream, a large download) holds a slot until it ends; size `max` for them or keep them on another instance.

## Related

- [Server middlewares](15-server-middlewares.md): Order, early answers and the reply pipeline.
- [Throttling](18-throttling.md): per-client limits, where this one is per process.
- [Maintenance mode](27-maintenance-mode.md): the other 503 answers.
