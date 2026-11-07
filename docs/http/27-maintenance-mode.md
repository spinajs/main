# Maintenance mode and shutdown answers

`MaintenanceMode` is a server middleware that answers 503 in place of the application. It does two jobs:

- **Maintenance.** While `http.maintenance.enabled` is set, or after `enable()` at runtime, every request gets a 503 with `Retry-After`, except the path prefixes you allow (health checks, an admin API).
- **Graceful shutdown.** While `HttpServer` is closing, every request gets a 503 with `Connection: close`. `stop()` stops accepting connections, but a client on a kept-alive connection can still send a request while the in-flight ones finish; it gets this answer, and its connection is closed, so it reconnects to another instance.

It is always mounted, at Order 2.5: after CORS (-1), so browsers can read the 503, and after `RequestId`, `RealIp` (1) and `AccessLog` (2), so the 503 carries `x-request-id` and is logged; before throttling (3), CSRF (4), authentication (5) and routing.

## How it works

Per request (`onBefore`, synchronous):

1. `HttpServer.State` is `Closing`: returns a 503 with `Connection: close` and `{ error: { code: 'shutting_down', message: 'The server is shutting down, try again' } }`. Allowed paths get it too.
2. Maintenance off (`enable()`/`disable()` decide, else `http.maintenance.enabled`): the request goes on.
3. `req.path` under one of `http.maintenance.allow` (a prefix on a segment boundary, case-insensitive: `/health` covers `/health/live`, not `/healthy`): the request goes on.
4. Else: returns a 503 with `Retry-After: <http.maintenance.retryAfter>` and `{ error: { code: 'maintenance', message } }`.

The 503 goes through the reply pipeline like every early answer: the `onAfter` of the server middlewares entered before it (CORS, `ResponseTime`, `ServerTiming`) see it, and the entered ones get `onFinish` (`AccessLog`, metrics).

The middleware learns the server's state from the `http.server.listening` and `http.server.closing` events `HttpServer` emits on the DI container; it does not inject `HttpServer`, which resolves it.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.maintenance.enabled` | `boolean` | `false` | | Answers 503 to every request but the allowed paths. |
| `http.maintenance.retryAfter` | `integer` | `60` | ≥ 0 | Seconds sent in `Retry-After`. |
| `http.maintenance.allow` | `string[]` | `[]` | paths starting with `/` | Path prefixes answered as usual. Include `http.controllers.route.prefix`. |
| `http.maintenance.message` | `string` | `'The service is down for maintenance, try again later'` | non-empty | The error message of the maintenance 503. |

```ts
export default {
  http: {
    maintenance: {
      enabled: false,
      retryAfter: 600,
      allow: ['/health', '/api/v1/admin'],
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | How to replace or extend |
| --- | --- | --- | --- |
| `MaintenanceMode` | `ServerMiddleware` list; singleton | itself | `DI.register(Mine).as(MaintenanceMode)`; override `onBefore` and call `super.onBefore(ctx)`. |

Members:

| Member | Meaning |
| --- | --- |
| `enable(): void` | Turns maintenance on, whatever the configuration says. |
| `disable(): void` | Turns it off, whatever the configuration says. |
| `Active: boolean` | Whether maintenance answers are sent now. |

## Important behaviour

- The runtime switch lives in this process. Behind a load balancer, switch every instance, or use the configuration.
- The shutdown answer does not depend on `http.maintenance`: it is sent while `HttpServer.State` is `Closing`, from `stop()` until the last connection closed.
- Static files are served after the server middlewares, so they get the 503 too unless their route is allowed.
- `http.maintenance` is read once, at the first request; a configuration changed later does not switch maintenance. Use `enable()` and `disable()`.
- It follows the server that last emitted `http.server.listening` or `http.server.closing` on its container: run one `HttpServer` per container.
- Raw `http.middlewares` handlers (the body and cookie parsers, unless your version mounts them as server middlewares) run before every server middleware, so a request body is read before the 503.

## Examples

### Switch maintenance from an admin route

```ts sample
import { DI } from '@spinajs/di';
import { BaseController, BasePath, MaintenanceMode, NoContent, Post } from '@spinajs/http';

// Allow /admin in http.maintenance.allow, or the switch cannot be turned back off over HTTP.
@BasePath('admin/maintenance')
export class MaintenanceController extends BaseController {
  @Post()
  public on() {
    DI.get(MaintenanceMode)!.enable();
    return new NoContent(null);
  }

  @Post()
  public off() {
    DI.get(MaintenanceMode)!.disable();
    return new NoContent(null);
  }
}
```

Protect the route with a policy; anyone who can call it can take the service down.

## Related

- [HTTP server](01-http-server.md): `stop()`, `http.shutdownTimeout` and the lifecycle events.
- [Server middlewares](15-server-middlewares.md): Order, early answers and the reply pipeline.
