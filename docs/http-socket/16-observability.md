# Observability

The socket server writes one debug line per command and per stream, publishes Prometheus metrics through `@spinajs/telemetry-common`, and carries an inbound `traceparent` into the handler's call store.

## How it works

1. `SocketDispatcher.observe()` runs once per answered command:
   - logs `socket command <name> <code> <ms>ms connection <id>` at debug level on the `http-socket` logger (`code` is `ok` or the error code);
   - increments `socket_commands_total{command, code}` and observes `socket_command_duration_seconds{command}`.
2. Refusals answered before the pipeline (malformed frame, shutdown, duplicate id) are counted with a duration of 0.
3. `SocketDispatcher.streamEnded()` runs once per stream: logs `socket stream <name> <outcome> <n> chunks <ms>ms connection <id>` and increments `socket_streams_total{command, code}` (`ok` or the `fail` code).
4. `trackConnection()` raises the `socket_connections` gauge on connect and lowers it on disconnect.
5. `socketMetrics()` defines the metrics once per `Metrics` service; when `Metrics` cannot be resolved it returns `null` and nothing is published. A failing log line or metric never costs a reply.
6. A command's `traceparent` (W3C) seeds `newTraceContext()`; `traceId` and `spanId` land in the call's AsyncLocalStorage store with `requestId`, `connectionId`, `clientId` and `socketCall`.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `socket_commands_total` | counter | `command`, `code` | Commands answered, by reply code |
| `socket_command_duration_seconds` | histogram (buckets 1 ms to 10 s) | `command` | Receipt to reply |
| `socket_connections` | gauge | none | Open connections on this instance |
| `socket_streams_total` | counter | `command`, `code` | Streams ended, by outcome |

Only registered command names become labels; any other name is `<unknown>` (`SOCKET_UNKNOWN_COMMAND`), because names come from the client.

Other log lines worth alerting on:

| Level | Line | Meaning |
| --- | --- | --- |
| error | `Socket ${context} failed, errorId: ${errorId}` | An unmapped error answered `internal` |
| error | `Socket connect hooks of connection ... still running after ${ms} ms` | A connect hook passed `hooks.connectTimeoutMs` |
| error | `Ordered command ... still running ${graceMs} ms after abort` | A handler ignored its abort past `ordering.abortGraceMs` |
| warn | `Socket ${connectionId}: source ${source} could not revalidate its principal` | A source answered `'unavailable'` |
| warn | `Socket controllers registered after their authz domain booted skip its boot checks` | `SocketServer` resolved after `http.start()` |
| warn | `http.socket.drainMs ... reaches http.shutdownTimeout` | The drain may be cut short |
| info | `Socket ${connectionId} closed: ${reason}` | The principal guard closed a connection |
| debug | `Socket handshake refused: ${code} ${reason}` | A refused handshake |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `Metrics` (`@spinajs/telemetry-common`) | `Metrics` (self), singleton; read with `DI.get(Metrics) ?? DI.resolve(Metrics)` | private prom-client registry | Your subclass | `DI.register(Mine).as(Metrics)` before the first command; expose `getRegistry()` through your metrics endpoint |
| `SocketDispatcher.observe()` | `SocketDispatcher`, singleton | debug line and two metrics | Your subclass | Override `observe(ctx, reply, ms)` and call `super` |
| Exported helpers | functions | `socketMetrics()`, `observeCommand()`, `observeStream()`, `trackConnection()` | none | Call them from custom transports or stages |

### `SocketDispatcher.observe()`: warn about slow commands

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { CommandReply, SocketCommandContext, SocketDispatcher } from '@spinajs/http-socket';

const SLOW_MS = 1_000;

@Injectable()
export class SlowCommandDispatcher extends SocketDispatcher {
  protected observe(ctx: SocketCommandContext, reply: CommandReply, ms: number): void {
    super.observe(ctx, reply, ms);

    if (ms > SLOW_MS) {
      this.Log.warn({ command: ctx.request.name, ms: Math.round(ms), connectionId: ctx.connection.id }, 'slow socket command ${command}: ${ms} ms on connection ${connectionId}');
    }
  }
}

DI.register(SlowCommandDispatcher).as(SocketDispatcher);
```

## Important behaviour

- The command metrics measure until the reply, not until a stream ends; a stream's outcome is counted in `socket_streams_total`.
- The debug lines are per command: at high traffic, keep the `http-socket` logger above debug.
- `socket_connections` counts this instance only.
- Without `@spinajs/telemetry-common`'s `Metrics` resolvable, metrics are silently skipped.
- Events and hooks have no metrics; failures are logged (events at most one warning per connection per 10 s).

## Best practices

- Alert on `socket_commands_total{code="internal"}` and look the `errorId` up in the logs.
- Watch `socket_commands_total{code="resource_exhausted"}` to tune [limits](13-limits.md).
- Send `traceparent` from the client to tie socket calls to the rest of a trace.

## Patterns and antipatterns

```ts
// Don't: label metrics with the raw name a client sent; any string becomes a time series
counter.inc({ command: ctx.request.name });

// Do: label with the registered name, as the built-in metrics do
counter.inc({ command: ctx.handler?.fullName ?? SOCKET_UNKNOWN_COMMAND });
```

## Examples

### Count commands by principal type

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry-common';
import type { Counter } from '@spinajs/telemetry-common';
import { ISocketCommandContext, SOCKET_UNKNOWN_COMMAND, STAGE_ORDER, SocketCommandStage } from '@spinajs/http-socket';

@Injectable(SocketCommandStage)
export class PrincipalTypeMetricStage extends SocketCommandStage {
  protected counter: Counter<string> | null = null;

  public get Order(): number {
    return STAGE_ORDER.Lookup + 1;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    if (!this.counter) {
      const metrics = (DI.get(Metrics) ?? DI.resolve(Metrics)) as Metrics;
      this.counter = metrics.defineMetrics('app_socket', [{ name: 'commands_by_principal_total', help: 'Socket commands by principal type', type: 'counter', labelNames: ['command', 'principal'] }])
        .commands_by_principal_total as Counter<string>;
    }

    this.counter.inc({ command: ctx.handler?.fullName ?? SOCKET_UNKNOWN_COMMAND, principal: ctx.connection.principal.type });
    return next();
  }
}
```

## Related

- [Command pipeline](04-command-pipeline.md): what a reply code means.
- [Error mapping](05-error-mapping.md): `errorId` and `internal`.
- `@spinajs/telemetry-common`: the `Metrics` service and its registry.
