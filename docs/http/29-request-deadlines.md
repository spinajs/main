# Request deadlines

`RequestDeadline` gives every request a deadline. When it passes, the request's `AbortSignal` aborts, and a request nothing was sent for yet is answered 504, so a client is not left waiting on a stuck database or upstream call. `@Deadline(ms)` gives a route a shorter one.

It is off by default. When on, it runs at Order -0.3: after `MaintenanceMode` (-0.5) and `ConcurrencyLimit` (-0.4), before everything else, so the deadline covers the whole request.

The action is never stopped by force: JavaScript cannot interrupt it. It stops early only when it passes `req.storage.signal` to its I/O (`fetch`, a database query, a timer), which then rejects once the signal aborts.

## How it works

Per request:

1. `onBefore` creates an `AbortController`, puts its signal in `req.storage.signal` and the deadline (epoch ms) in `req.storage.deadline`, and starts a timer of `http.deadline.ms`.
2. A route's `@Deadline(ms)` middleware moves the deadline to `ms` from when it runs, when that is earlier; a later one is ignored. Without `RequestDeadline` it creates the signal and the timer itself.
3. When the timer fires:
   - the signal aborts with a `DOMException` named `TimeoutError`;
   - when no reply has started yet, a warning is logged and the request is answered 504 with `{ error: { code: 'deadline_exceeded', message: 'The request took too long' } }`, through the reply pipeline: the `onAfter` hooks of the entered middlewares see it, with the `TimeoutError` as `ctx.error`;
   - once that 504 went out, a later reply of the request is dropped: the action's `Response`, an error reply, a 404. An error the action throws afterwards is logged at debug level, not as an error. An action not started yet is skipped.
4. `onFinish` clears the timer. When the client went away first (`aborted`), the signal aborts with an `AbortError`.

A reply that started before the deadline (the action's reply in its `onAfter` hooks, a streamed file) is left alone; only the signal aborts.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.deadline.enabled` | `boolean` | `false` | | Turns the middleware on; read once at mount. |
| `http.deadline.ms` | `integer` | `30000` | ≥ 1 | Milliseconds a request may take, from when the middleware runs. |

```ts
export default {
  http: {
    deadline: { enabled: true, ms: 10000 },
  },
};
```

Set it below the timeout of the proxy in front of the app, so the client gets this 504 and not the proxy's.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Deadline(ms)` | class or method | positive milliseconds | Adds `DeadlineMiddleware`: the deadline is `ms` from when the route's middlewares run, when that is earlier than the current one. A non-positive or non-finite `ms` throws `InvalidArgument` at import. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | How to replace or extend |
| --- | --- | --- | --- |
| `RequestDeadline` | `ServerMiddleware` list; singleton | itself | `DI.register(Mine).as(RequestDeadline)`. |
| `DeadlineMiddleware` | `RouteMiddleware`, a new instance per route (`@NewInstance()`) | itself, mounted by `@Deadline` | `ms` is its constructor option. |

`req.storage` fields:

| Field | Meaning |
| --- | --- |
| `signal?: AbortSignal` | Aborts at the deadline (`TimeoutError`) or when the client goes away (`AbortError`). Set only while a deadline applies. |
| `deadline?: number` | When the deadline passes, in epoch milliseconds. |

## Important behaviour

- Server middlewares at a lower Order than -0.3 (CORS, `MaintenanceMode`, `ConcurrencyLimit`) run before the deadline starts; their own work is not covered.
- `RequestId` and the other server middlewares above -0.3 have run by the time the deadline fires, so the 504 carries `x-request-id` and is access-logged.
- A slot of `ConcurrencyLimit` is freed when the 504 finished, even while the action still runs. Pass the signal to the action's I/O, or the work goes on unseen.
- Work the action starts in the background and should outlive the request must not take `req.storage.signal`.

## Examples

### Pass the signal to I/O

```ts sample
import { BaseController, BasePath, Deadline, Get, Ok, Req, Request } from '@spinajs/http';

@BasePath('reports')
export class ReportsController extends BaseController {
  @Get()
  @Deadline(5000)
  public async summary(@Req() req: Request) {
    // rejects with the signal's reason once the deadline passed or the client went away
    const upstream = await fetch('https://reports.internal.example/summary', { signal: req.storage.signal });
    return new Ok(await upstream.json());
  }
}
```

## Related

- [Server middlewares](15-server-middlewares.md): Order and the reply pipeline.
- [Route middlewares](14-route-middlewares.md): `@Middleware` and constructor options.
- [Request storage and tracing](19-request-storage-and-tracing.md): the other `req.storage` fields.
- [Concurrency limit](28-concurrency-limit.md): load shedding.
