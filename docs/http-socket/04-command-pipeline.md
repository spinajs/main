# Command pipeline and custom stages

Every client command passes an ordered chain of `SocketCommandStage`s before its handler runs: limits, authentication, lookup, idempotency, ordering, policies and arguments. Each stage is a DI class, so you add one, wrap the handler with one, or replace a built-in one.

## How it works

1. `SocketDispatcher.onCommand()` receives a `cmd` frame. Before the pipeline it:
   1. takes a rate token from the connection's bucket; a refusal is kept for the rate stage;
   2. ignores a frame without an ack callback (logged, one warning per connection per 10 s);
   3. answers a malformed frame `invalid_argument`, a frame during shutdown `unavailable`, and a request id that is already running `invalid_argument`;
   4. builds a `SocketCommandContext` and arms the client's `deadline`.
2. `SocketDispatcher.execute()` runs the stages in ascending `Order` inside the call's AsyncLocalStorage store. Each stage calls `next()` to continue.
3. After the last stage, the handler runs with the arguments the arguments stage built.
4. The result becomes the reply: `undefined` answers `null`; an async iterable answers `{ stream: true }` and becomes a [stream reply](06-stream-replies.md). A thrown error becomes an error reply through `SocketErrorMapper`.
5. An abort (deadline, cancel, disconnect, shutdown) answers the client at once. Before the handler started, the chain stops at its next step: `next()` rejects with `SocketClientGone`, and no later stage and no handler runs. After the handler started, the chain keeps running, and keeps its in-flight slot and queue place, until the handler settles.

| Order | `STAGE_ORDER` key | Stage | What it does | Refusal |
| --- | --- | --- | --- | --- |
| 100 | `Size` | `SizeStage` | Measures the payload with `payloadSize()` | `resource_exhausted`, not retryable, `details { size, limit }`; `invalid_argument` for a payload that cannot be serialized |
| 200 | `Rate` | `RateStage` | Throws the refusal of the token taken on arrival | `resource_exhausted` with `retryAfterMs` |
| 300 | `InFlight` | `InFlightStage` | Holds one of `maxInFlightPerConnection` slots until the handler settles | `resource_exhausted`, `retryAfterMs: 100` |
| 320 | `Ready` | `ReadyStage` | Waits for the connection's connect hooks | the abort reason (deadline, cancel, disconnect) |
| 350 | `Authentication` | `AuthenticationStage` | `SocketPrincipalGuard.ensure()`; refreshes `Principal` and `AuthnPrincipal` in the store | `unauthenticated` |
| 400 | `Lookup` | `LookupStage` | Finds the handler, sets `ctx.handler`, arms `timeoutMs` | `unimplemented` |
| 500 | `Idempotency` | `IdempotencyStage` | Replays, joins or claims an `idempotencyKey` | see [Durable commands](12-durable-commands.md) |
| 550 | `Ordering` | `OrderingStage` | Serial queue for `ordered`; the `after` fence | `unavailable` with `details.after` |
| 600 | `Policies` | `PoliciesStage` | `@SocketPolicy` and `@SocketAccess` through `SocketPolicyGate` | `unauthenticated`, `forbidden`, `invalid_argument` |
| 650 | `Policies + 50` | `AccessFieldsStage` | `@SocketAccess(…, { fields: 'filter' })` limits the result or each chunk | none |
| 700 | `Arguments` | `ArgumentsStage` | `SocketArgumentResolver.resolve()` sets `ctx.args` | `invalid_argument` |

```mermaid
sequenceDiagram
  participant Client
  participant Dispatcher as SocketDispatcher
  participant Stages as SocketCommandStage chain
  participant Handler
  Client->>Dispatcher: cmd { id, name, payload }
  Dispatcher->>Dispatcher: rate token, frame checks, context
  Dispatcher->>Stages: execute(ctx, next) in Order
  Stages->>Handler: method(...ctx.args)
  Handler-->>Stages: result
  Stages-->>Dispatcher: result (or throw)
  Dispatcher-->>Client: ack { id, ok, result | error | stream }
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SocketCommandStage` | `SocketCommandStage`; every registered class, resolved once as `Array.ofType(SocketCommandStage)` by `SocketDispatcher.resolve()` and sorted by `Order`; each stage a singleton | The eleven stages in the table above | Your stages | Add: `@Injectable(SocketCommandStage)`. Replace: `DI.unregister(BuiltInStage)` and register yours. Extend: subclass a built-in stage and swap it the same way. All before `SocketServer` resolves |
| `SocketDispatcher` | `SocketDispatcher` (self), singleton, `AsyncService` | `SocketDispatcher` | Your subclass | Override `callStorage()` (the per-call store), `observe()` (per-command log and metric); `DI.register(Mine).as(SocketDispatcher)` |
| `SocketCommandContext` | Not in DI; built per command | `SocketCommandContext` | none | Read and write it from a stage: `ctx.storage`, `ctx.args`, `ctx.handlerStarted`, `ctx.drainGrace`, `ctx.addOutcomeRecorder()`, `ctx.abort()`, `ctx.armDeadline()` |

### `SocketCommandStage`: a stage of your own

`Order` places the stage; use `STAGE_ORDER` keys plus an offset. `execute(ctx, next)` is an onion layer: work before `await next()` runs on the way in, work after it on the way out. Return without calling `next()` to answer early; throw to fail the command.

What a stage sees depends on where it sits:

- before 400, `ctx.handler` is not set yet;
- between 550 and 600, it runs inside the queue place of an `ordered` command;
- before 700, `ctx.args` is not set yet;
- for a stream reply, `await next()` returns the handler's async iterable when the stream starts, not when it ends.

`next()` runs the later stages and the handler, and settles before the reply is built. It can be called once: a second call from the same stage rejects with `internal` `next() called twice by <Stage>`.

| What happens | `next()` |
| --- | --- |
| The handler returned or threw | Resolves with its raw result (an async iterable for a stream, binary, a `toJSON` class) or rejects with its error. |
| An abort came before the handler started | Rejects with `SocketClientGone`, `beforeHandler: true`. No later stage and no handler ran. |
| An abort came after the handler started | Settles with the handler's real result or error. `ctx.handlerStarted` is `true`. The client has its answer already, so what the stage returns is not sent. |

`SocketClientGone` is a `SocketException` with the code, message and retry hint of the abort reason (`cancelled`, `deadline_exceeded`, `unavailable`), which is also its `cause`. Rethrown, it answers as the abort did.

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage, SocketException } from '@spinajs/http-socket';

@Injectable()
export class MaintenanceSwitch {
  public until: Date | null = null;
}

/** Refuses write commands during maintenance, before idempotency and ordering claim anything. */
@Injectable(SocketCommandStage)
export class MaintenanceStage extends SocketCommandStage {
  @Autoinject()
  protected Switch: MaintenanceSwitch;

  public get Order(): number {
    return STAGE_ORDER.Lookup + 10;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    const until = this.Switch.until;
    const isWrite = /\.(create|update|delete)$/.test(ctx.request.name);

    if (until && isWrite && until.getTime() > Date.now()) {
      throw new SocketException('unavailable', 'maintenance in progress', { retryAfterMs: until.getTime() - Date.now() });
    }

    return next();
  }
}
```

### `onRegister`

`onRegister(handler, registration)` is optional. It runs once per command, when `SocketHandlerRegistry.build()` registers the command: in ascending `Order`, after the command's policies resolved and before socket.io attaches. It never runs for events or hooks, because stages never run for them. Check configuration or load an optional dependency there. A throw fails the build with `InvalidOperation`, which names the stage and the command: `Socket command audit.export ( AuditSocket::export ): stage AuditSinkStage refused the registration: no audit sink configured`. The original error is its `cause`.

`registration.refuseStream(what)` declares that the command cannot reply with a stream while this stage applies:

- an async-generator handler fails the build: `Socket command X ( C::m ) is <what> and replies with a stream; <what> commands cannot stream`;
- any other async-iterable result is answered `failed_precondition`: `<what> command X cannot reply with a stream`.

When several stages refuse, the word of the highest `Order` is used. It is kept as `handler.streamRefusal`. The built-in `ordered` and `idempotent` refusals are checked before it.

### Per-command state

- `ctx.handlerStarted` is `false` until the dispatcher calls the handler, and `true` from then on.
- `ctx.drainGrace`: a stage sets it to `true` when its handler may commit at any moment once started. The first abort of the shutdown drain then leaves the command running if `handlerStarted` is `true` (see [Shutdown and recovery](14-shutdown-and-recovery.md)).
- `ctx.addOutcomeRecorder(recorder)` registers an outer stage's record of the outcome, an object with `settle(outcome)` and `detach(running)`. An inner stage that serialises commands calls `ctx.recordOutcome(outcome)` before it lets the next command run. That settles every recorder. A failing recorder is ignored, because the stage that owns it answers the failure. `ctx.detachOutcome(running)` passes a handler the pipeline gave up on to every recorder, which settles once `running` does.

### State between stages

State is shared, never copied. Every stage, the argument extractors, the policies and the handler see the same `ctx` and `ctx.storage` objects for the whole command.

- `ctx` is one `SocketCommandContext`. Cancel, credit, disconnect and shutdown reach the same object. The pipeline owns `handler` (set at 400), `idempotency` (500), `args` (700), `stream`, `rateRefusal`, `handlerStarted`, `drainGrace` and the recorders.
- Typed per-call state goes on `ctx.storage` (`ISocketCallStorage`, extended by declaration merging), as http's goes on `req.storage`.
- Untyped per-call state goes on `ctx.storage` too: it has a string index, so there is no `res.locals`. A stage's private state goes in its own `WeakMap<ISocketCommandContext, T>`.
- What a stage writes before `next()` is visible to the later stages, the extractors, the policies and the handler. After `next()` settles, the stage sees what they wrote.
- Unlike http, stages run inside the call's AsyncLocalStorage context, and so do stream steps. A service called from a stage reads the same store.

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { IRegisteredHandler, ISocketCommandContext, STAGE_ORDER, SocketClientGone, SocketCommandStage } from '@spinajs/http-socket';

@Injectable()
export class AuditSink {
  public configured = false;
  public readonly lines: string[] = [];

  public write(command: string, outcome: string): void {
    this.lines.push(`${command} ${outcome}`);
  }
}

/** Commands under audit.* need an audit sink: fail the boot, not the first call, when none is configured. */
@Injectable(SocketCommandStage)
export class AuditSinkStage extends SocketCommandStage {
  @Autoinject()
  protected Sink: AuditSink;

  public get Order(): number {
    return STAGE_ORDER.Policies + 10;
  }

  public onRegister(handler: IRegisteredHandler): void {
    if (handler.fullName.startsWith('audit.') && !this.Sink.configured) {
      throw new InvalidOperation('no audit sink configured');
    }
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    if (!ctx.request.name.startsWith('audit.')) {
      return next();
    }

    try {
      const result = await next();
      this.Sink.write(ctx.request.name, ctx.signal.aborted ? 'finished after the client left' : 'ok');
      return result;
    } catch (err) {
      this.Sink.write(ctx.request.name, err instanceof SocketClientGone ? 'aborted before the handler' : 'failed');
      throw err;
    }
  }
}
```

### Replace a built-in stage

Unregister the built-in class by name and register your subclass. Do both after `@spinajs/http-socket` is imported and before `SocketServer` resolves: the dispatcher reads the stage list once.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { ISocketCommandContext, SizeStage, SocketCommandStage, SocketException, payloadSize } from '@spinajs/http-socket';

const CHAT_LIMIT_BYTES = 4 * 1024;

/** Chat messages get 4 KiB; every other command keeps http.socket.maxPayloadBytes. */
@Injectable(SocketCommandStage)
export class PerCommandSizeStage extends SizeStage {
  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    if (ctx.request.name.startsWith('chat.')) {
      const size = payloadSize(ctx.payload);
      if (size > CHAT_LIMIT_BYTES) {
        throw new SocketException('resource_exhausted', `chat message of ${size} bytes exceeds ${CHAT_LIMIT_BYTES}`, { retryable: false, details: { size, limit: CHAT_LIMIT_BYTES } });
      }
    }

    return super.execute(ctx, next);
  }
}

DI.unregister(SizeStage);
```

### `SocketDispatcher`: add fields to every call store

`callStorage(connection, call, requestId?, traceparent?)` builds the AsyncLocalStorage store of each command, event and hook. Fields you add there are visible to stages, policies, hydrators, handlers and log lines.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { ISocketCallStorage, SocketConnection, SocketDispatcher } from '@spinajs/http-socket';

@Injectable()
export class TenantDispatcher extends SocketDispatcher {
  protected callStorage(connection: SocketConnection, call: string, requestId?: string, traceparent?: string): ISocketCallStorage {
    const storage = super.callStorage(connection, call, requestId, traceparent);
    const tenant = connection.handshake.auth.tenant;
    return { ...storage, tenantId: typeof tenant === 'string' ? tenant : null };
  }
}

DI.register(TenantDispatcher).as(SocketDispatcher);
```

## Important behaviour

- Stages apply to commands only. Events and hooks run their own fixed steps (see [Socket controllers](02-controllers.md#important-behaviour)).
- The stage list is resolved once, in `SocketDispatcher.resolve()`. A stage registered later is never used.
- `Array.ofType` leaves `@NewInstance()` classes out of its result: a stage marked `@NewInstance()` never runs.
- Stages with the same `Order` run in registration order.
- Every `cmd` frame costs a rate token when it arrives, including frames without an ack, malformed frames and duplicate ids.
- An abort answers the client at once. A command whose handler started holds its in-flight slot until the handler settles, so cancel-and-resend cannot run unbounded handlers.
- `onRegister` runs after the command's policies resolved: a command whose policies fail to resolve reports that error first.
- A client `deadline` of `0` or below aborts the call as `deadline_exceeded` before the handler runs; a `timeoutMs` of `0` or below is ignored.
- The deadline is the earliest of the client's `deadline` and the command's `timeoutMs`, both counted from `receivedAt`. Deadlines above 2^31-1 ms are reached in several timer steps.
- A handler reached without `ctx.handler` or `ctx.args` answers `internal` ("a built-in stage is missing"): keep `LookupStage` and `ArgumentsStage`, or set those fields yourself.
- `socket.io` encodes the ack synchronously. A result it cannot encode is answered `internal` instead of leaving the client to time out.

## Best practices

- Place a stage relative to `STAGE_ORDER` keys, never with a literal number: the built-in orders are a contract, offsets keep your intent readable.
- Refuse early (before 500) when the refusal does not depend on the command's predecessors; a refusal after idempotency claims a key first.
- Put work that must see the result of the previous `ordered` command between 550 and 600.
- Write stage data into `ctx.storage` rather than module state; the handler reads it through AsyncLocalStorage.

## Patterns and antipatterns

```ts
// Don't: a stage that catches everything hides the error mapping and the idempotency outcome
public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>) {
  try {
    return await next();
  } catch {
    return null;
  }
}

// Do: observe, then rethrow
public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>) {
  try {
    return await next();
  } catch (err) {
    this.Failures.record(ctx.request.name);
    throw err;
  }
}
```

## Examples

### Audit every command that passed the policies

```ts sample
import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '@spinajs/http-socket';

@Injectable(SocketCommandStage)
export class AuditStage extends SocketCommandStage {
  @Logger('audit')
  protected Log: Log;

  public get Order(): number {
    return STAGE_ORDER.Policies + 10;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    const started = Date.now();
    try {
      return await next();
    } finally {
      this.Log.info(
        { command: ctx.request.name, principal: ctx.connection.principal.id, client: ctx.connection.clientId, ms: Date.now() - started },
        'socket ${command} by ${principal} ( ${client} ) in ${ms} ms',
      );
    }
  }
}
```

## Idempotency storage

Idempotent commands (`@Command(name, { idempotent: true })`) keep their replies through `@spinajs/idempotency`.
`http.socket.idempotency.service` names the store, built with the whole `http.socket.idempotency` object as in 3.x:

| `service` | Store |
|---|---|
| `MemoryIdempotencyStore` (the shipped default) | `@spinajs/idempotency`'s memory store, one process; `maxEntries` caps completed keys |
| `OrmIdempotencyStore` | `__idempotency` on the `idempotency` connection, shared by every instance |
| `null` | the store of `IdempotencyService`, `idempotency.store` (see `docs/idempotency/README.md`) |
| a class of your own | an `IdempotencyStore` of `@spinajs/idempotency`, or a 3.x store of this package |

A running claim is a lease, renewed while the handler runs: `http.socket.idempotency.lease`, or `idempotency.lease`
(default `30s`) when it is not set. When a shutdown aborts a handler that already started, its key stays claimed, because the handler may have
committed. Another instance takes the key over once the lease ends, and a resend meanwhile is told to retry after the
rest of the lease. 3.x tracked no lease, so such a key used to stay running until something released it.
A handler whose lease is lost (a renewal was refused because another instance took the key over) is aborted with
`unavailable`, so it stops instead of running alongside the other instance's run. An error carrying `crash: true`
stands for a dead process: its key is neither stored nor released, and its lease ends on its own.

Stores keep replies as JSON. Binary parts of a reply (a `Buffer`, a typed array, an `ArrayBuffer`) are stored
base64-encoded beside it and replay as binary; a `Buffer` replays as a `Uint8Array`. Base64 makes them about a third
larger in the store. A stored reply that cannot be read back answers the final `failed_precondition`: the command
already ran once, and the store cannot free a completed key.

A claim that loses a lock or serialization conflict on the database (`IdempotencyClaimConflict`) answers `unavailable`,
which the client retries.

http-socket depends on `@spinajs/idempotency`, and importing that package registers the `__idempotency` model and
migration (connection `idempotency`, an alias of `default`). So a socket app with a database gets the `__idempotency`
table even when it keeps the memory store.

A 3.x store (a class extending this package's deprecated `IdempotencyStore`) still works. It is wrapped by
`fromLegacySocketStore`, keeps the 3.x key format, and its running claims never expire. Move it to `IdempotencyStore`
of `@spinajs/idempotency` and run `describeIdempotencyStoreConformance` from `@spinajs/idempotency/testing` against it.

## Related

- [Limits](13-limits.md): the size, rate and in-flight stages in detail.
- [Durable commands](12-durable-commands.md): the idempotency and ordering stages.
- [Policies and `@SocketAccess`](10-policies-and-access.md): the policy and access-field stages.
- [Error mapping](05-error-mapping.md): how a thrown error becomes the reply.
