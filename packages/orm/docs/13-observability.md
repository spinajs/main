# Observability

Metrics, connection health, retries and logging.

## Connection state

Every driver tracks a `ConnectionState`.

| State | Meaning |
| --- | --- |
| `Disconnected` | No usable connection. |
| `Connecting` | A connect attempt is in flight. |
| `Connected` | Healthy. |
| `Degraded` | Reachable but failing health probes, or mid-reconnect. **Queries are still attempted.** |

Transitions are logged: `Connected` at `info`, `Degraded` and `Disconnected` at `warn`, the rest
at `trace`. A repeat transition to the same state is ignored.

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver, ConnectionState } from '@spinajs/orm';

export function health() {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['default'])!;

  return {
    state: driver.State,
    healthy: driver.State === ConnectionState.Connected,
    pool: driver.poolMetrics(),
  };
}
```

## Health checks

`Orm.createConnections()` calls `driver.startHealthCheck()` on every connection as it opens.
A connection that was healthy at boot says nothing about a pool holding sockets to a database
that has since restarted, so the probe keeps running for the connection's lifetime.

- Interval: `Resilience.HealthCheckInterval`, default 30000 ms. `0` disables it.
- The timer is `unref`'d — it never holds the process open.
- `startHealthCheck()` / `stopHealthCheck()` are idempotent.
- `orm.dispose()` stops every probe and disconnects.

One probe publishes pool metrics, calls `ping()`, and on failure marks the driver `Degraded` and
attempts a single reconnect. **It never throws** — it runs on a timer with no caller to receive
the error.

A successful reconnect does *not* by itself restore `Connected`: a fresh handle is not evidence
that queries work, so only the next successful probe promotes it. Drivers whose `connect()`
genuinely verifies the link (MySQL takes and releases a real connection) set the state
themselves.

## Retries

`withReconnect` wraps an operation and, on a **transport** failure, reconnects and retries with
bounded exponential backoff. Query errors — a syntax error, a constraint violation — propagate
on the first attempt untouched.

Backoff is `min(RetryDelay * 2^attempt, MaxRetryDelay)`.

### What counts as retryable

`RETRYABLE_ERROR_CODES` is deliberately narrow — retrying a statement the server rejected only
multiplies the failure:

`ECONNRESET` `ECONNREFUSED` `EPIPE` `ETIMEDOUT` `EHOSTUNREACH` `ENETUNREACH` `ENOTFOUND`
`PROTOCOL_CONNECTION_LOST` `PROTOCOL_SEQUENCE_TIMEOUT` `PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR`
`PROTOCOL_ENQUEUE_AFTER_QUIT` `ER_CON_COUNT_ERROR` `ER_LOCK_WAIT_TIMEOUT` `SQLITE_BUSY`

`isRetryableErrorCode` walks the error's `inner` / `cause` chain up to five levels, because
driver errors are routinely wrapped (`OrmException` carries the original in `inner`) and a
shallow check would miss exactly the cases that matter.

```ts sample
import { isRetryableErrorCode, backoffDelay, RETRYABLE_ERROR_CODES } from '@spinajs/orm';

export function classify(err: unknown) {
  return {
    retryable: isRetryableErrorCode(err),
    firstDelay: backoffDelay(0, 200, 5000),   // 200
    thirdDelay: backoffDelay(2, 200, 5000),   // 800
    cappedDelay: backoffDelay(10, 200, 5000), // 5000
    codes: [...RETRYABLE_ERROR_CODES],
  };
}
```

### Retries never happen inside a transaction

MySQL's driver overrides `isRetryableError` to return `false` whenever a transaction is in
scope. The connection carried uncommitted state; reconnecting and replaying one statement would
silently apply it **outside** the transaction. The error surfaces instead.

### Adding dialect codes

```ts sample
import { SqlDriver } from '@spinajs/orm-sql';
import { isRetryableErrorCode, QueryContext } from '@spinajs/orm';

const EXTRA_CODES = new Set(['ER_LOCK_DEADLOCK']);

export abstract class MyDriver extends SqlDriver {
  public abstract executeOnDb(stmt: string | object, params: unknown[], context: QueryContext): Promise<unknown>;

  protected isRetryableError(err: unknown): boolean {
    if (super.isRetryableError(err)) {
      return true;
    }

    const code = (err as { code?: string })?.code;
    return typeof code === 'string' && EXTRA_CODES.has(code) && isRetryableErrorCode(err);
  }
}
```

## Metrics

The ORM publishes into the shared `Metrics` registry from `@spinajs/telemetry-common`. Nothing
has to be wired: `@spinajs/telemetry`'s `/metrics` endpoint renders that same singleton.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `orm_pool_size` | gauge | `connection` | Open connections (idle + in use). |
| `orm_pool_in_use` | gauge | `connection` | Connections checked out by a query. |
| `orm_pool_waiting` | gauge | `connection` | Callers waiting for a free connection. |
| `orm_connection_state` | gauge | `connection` | `1` when connected, `0` otherwise. |
| `orm_pool_acquire_seconds` | histogram | `connection` | Seconds spent acquiring a pooled connection. |

Acquire buckets are `[0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` —
dense at the bottom, because a healthy acquire is sub-millisecond and prom-client's linear
default (1..10 s) would put every one of them in the first bucket.

Gauges are refreshed on each health tick. `publishPoolMetrics()` and `observeAcquireSeconds()`
both swallow their own errors: telemetry must never break a connection, and `publishPoolMetrics`
runs *first* on every health tick, so a throwing registry would otherwise stop the probe behind
it from ever running.

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver, ormMetrics, ORM_METRIC_POOL_SIZE, ORM_METRIC_CONNECTION_STATE } from '@spinajs/orm';

export function metrics() {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['default'])!;

  // Force a publish outside the health tick.
  driver.publishPoolMetrics();

  return {
    // null when the Metrics service cannot be resolved — never throws.
    defined: ormMetrics() !== null,
    names: [ORM_METRIC_POOL_SIZE, ORM_METRIC_CONNECTION_STATE],
  };
}
```

The ORM depends on `@spinajs/telemetry-common`, **not** `@spinajs/telemetry`. The latter pulls in
`@spinajs/http`, `log`, `validation` and `configuration`, and putting the HTTP stack underneath
every database connection inverts the dependency graph.

`defineMetrics` rebuilds its metric objects on every call, so a second call would silently reset
every value. The ORM therefore builds its set once per `Metrics` **service instance**, tracked in
a `WeakMap` — keyed on the instance rather than a module flag, so `DI.clearCache()` (tests, or
two SpinaJS apps in one process) starts from a fresh registry without leaking across it.

### Reporting pool state from a custom driver

`poolMetrics()` returns an empty pool by default; a driver owning a real pool overrides it. It
**must never throw** — it runs on the health-check timer.

```ts sample
import { SqlDriver } from '@spinajs/orm-sql';
import { IPoolMetrics, QueryContext } from '@spinajs/orm';

export abstract class PooledDriver extends SqlDriver {
  public abstract executeOnDb(stmt: string | object, params: unknown[], context: QueryContext): Promise<unknown>;

  public poolMetrics(): IPoolMetrics {
    return { Size: 10, InUse: 3, Waiting: 0 };
  }

  protected async acquire(): Promise<void> {
    const started = process.hrtime.bigint();
    // ... take a connection from the pool ...
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;

    // Keeping the prom-client objects behind this method is what stops every driver
    // from needing to know about @spinajs/telemetry-common.
    this.observeAcquireSeconds(seconds);
  }
}
```

## Query timing

`SqlDriver.execute` wraps every statement in `Perf.measure('orm.query', ...)` from
`@spinajs/log-common`, labelled with `driver` and `context` (the `QueryContext`), and carrying
the SQL and bindings as fields. Enable perf logging in your logger configuration to see them.

`QueryContext` values: `Select`, `Insert`, `Update`, `Delete`, `Schema`, `Transaction`, `Upsert`,
`InsertReturning`.

## Logging

Each driver resolves a logger named `orm-driver-<Name>` with `orm-name`, `orm-host` and
`orm-database` bound as variables, so every line carries its connection.

`Orm` itself logs under `ORM`: migration progress at `info`, each created connection at
`success`, and missing connections or disabled migrations at `warn`.

Connection parameters are logged as JSON restricted to `Database`, `User`, `Host`, `Port`,
`Filename`, `Driver` and `Name`. **`Password` is never logged.**

A failed statement is logged at `error` with the message, stack, model name and query context
before the error is re-thrown.

## Debugging a query

```ts sample
import { Connection, Model, ModelBase, Primary, ICompilerOutput } from '@spinajs/orm';

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public Status: string;
}

export function showSql() {
  const query = Order.where('Status', 'open').take(10);

  // Compile without executing. Idempotent — safe to call before awaiting the builder.
  const compiled = query.toDB() as ICompilerOutput;

  return { sql: compiled.expression, bindings: compiled.bindings };
}
```

`toDB()` does not consume the builder, so you can log the SQL and then still `await` it.
