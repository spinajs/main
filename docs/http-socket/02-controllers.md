# Socket controllers

A socket controller is a class whose methods answer client commands, receive client events, and run when a connection opens or closes. Decorators describe the handlers; `SocketHandlerRegistry` indexes them by full name when `SocketServer` resolves.

## How it works

1. `@SocketController(prefix)` stores the prefix in the class's socket descriptor and registers the class with `DI.register(target).as(BaseSocketController)`.
2. `@Command`, `@OnEvent`, `@OnConnect` and `@OnDisconnect` mark methods; argument decorators (`@Payload`, `@Connection` ...) and `@SocketPolicy` add to the same handler entry.
3. `SocketServer.resolve()` calls `SocketHandlerRegistry.build()`. For each type registered under `BaseSocketController`, it:
   1. resolves the controller (one singleton instance shared by every connection);
   2. skips it with a warning when the class carries no socket decorators;
   3. builds the full name, `prefix.name`, or `name` without a prefix;
   4. validates the name and options, and resolves the handler's policy instances;
   5. adds it to the command map, the event map or the hook lists.
4. At run time:
   - a `cmd` frame goes through the [command pipeline](04-command-pipeline.md) to the `@Command` handler; its return value is the reply (`undefined` answers `null`), a thrown error is the error reply;
   - an `evt` frame goes through limits, the principal check and the policies to the `@OnEvent` handler; nothing is answered;
   - a new connection runs every `@OnConnect` hook; a closed one runs every `@OnDisconnect` hook.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@SocketController(prefix?, { contract }?)` | class extending `BaseSocketController` | `prefix`: string; empty or omitted means no prefix; `contract`: a `defineContract()` value, see [Server-enforced contracts](#server-enforced-contracts) | Registers the class as a socket controller; handler names get `prefix.` |
| `@Command(name?, options?)` | method | `name` (default: method name); `ICommandOptions`: `schema`, `timeoutMs`, `idempotent`, `ordered` | Request/response command answered through the socket.io ack |
| `@OnEvent(name?, options?)` | method | `name` (default: method name); `IEventOptions`: `schema` | Fire-and-forget client event |
| `@OnConnect()` | method | none | Hook run for every new or recovered connection |
| `@OnDisconnect()` | method | none | Hook run when a connection closes; `@Reason()` gives the socket.io reason |

`ICommandOptions`:

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `schema` | object | none | ajv schema of the payload; wins over the `@Payload(schema)` and the DTO's `@Schema` |
| `timeoutMs` | number | none | server deadline; the earlier of this and the client's `deadline` applies, both counted from receipt |
| `idempotent` | boolean | `false` | replays by principal, `clientId` and `idempotencyKey`; see [Durable commands](12-durable-commands.md) |
| `ordered` | `'connection'` \| `'client'` | none | serial queue per connection, or per principal and `clientId` across reconnects |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Socket controllers | `BaseSocketController`, every registered class, each a singleton; read with `DI.getRegisteredTypes(BaseSocketController)` | none | Your controllers; `AccessPushSocket` (shipped, prefix `authz`) | `@SocketController(prefix)` on a class extending `BaseSocketController`; a shared abstract base of your own is fine |
| `SocketHandlerRegistry` | `SocketHandlerRegistry` (self), singleton | `SocketHandlerRegistry` | Your subclass | Subclass, override `add()` to add registration rules, `DI.register(MyRegistry).as(SocketHandlerRegistry)` before `SocketServer` resolves |

### `BaseSocketController`: a shared base for your controllers

Put helpers every controller needs into an abstract base that extends `BaseSocketController`. Only classes with `@SocketController` are registered, so the base itself never becomes a controller. Handlers declared on an undecorated base are inherited, under the prefix of each subclass.

```ts sample
import { Autoinject } from '@spinajs/di';
import { Unauthenticated } from '@spinajs/authz';
import { BaseSocketController, Command, Connection, Payload, SocketConnection, SocketController, SocketHub } from '@spinajs/http-socket';

interface Member {
  id: number;
  name: string;
}

export abstract class MemberSocket extends BaseSocketController {
  @Autoinject()
  protected Hub: SocketHub;

  protected member(conn: SocketConnection<Record<string, unknown>, Member>): Member {
    if (!conn.user) {
      throw new Unauthenticated('sign in to use this command');
    }
    return conn.user;
  }

  // every subclass answers '<prefix>.whoami'
  @Command('whoami')
  public async whoami(@Connection() conn: SocketConnection<Record<string, unknown>, Member>) {
    return this.member(conn);
  }
}

@SocketController('boards')
export class BoardsSocket extends MemberSocket {
  @Command('subscribe', { schema: { type: 'object', required: ['board'], properties: { board: { type: 'string' } } } })
  public async subscribe(@Payload() req: { board: string }, @Connection() conn: SocketConnection<Record<string, unknown>, Member>) {
    const member = this.member(conn);
    conn.join(`board:${req.board}`);
    this.Hub.to(`board:${req.board}`).emit('boards.joined', { board: req.board, member: member.name });
    return { board: req.board };
  }
}
```

### `SocketHandlerRegistry`: add a registration rule

`add(controllerName, controller, descriptor, handler)` runs once per handler during `build()`. Override it to enforce a team rule at startup; throwing stops `SocketServer.resolve()` before socket.io attaches.

```ts sample
import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { BaseSocketController, ISocketControllerDescriptor, ISocketHandlerDescriptor, SocketHandlerRegistry } from '@spinajs/http-socket';

/** Every command must validate its payload: a schema on the command or on its @Payload. */
export class SchemaRequiredRegistry extends SocketHandlerRegistry {
  protected async add(controllerName: string, controller: BaseSocketController, descriptor: ISocketControllerDescriptor, handler: ISocketHandlerDescriptor): Promise<void> {
    const hasSchema = handler.Options.schema !== undefined || [...handler.Parameters.values()].some((p) => p.Schema !== null);

    if (handler.Kind === 'command' && handler.Parameters.size > 0 && !hasSchema) {
      throw new InvalidOperation(`${controllerName}::${String(handler.Method)} takes arguments but declares no payload schema`);
    }

    await super.add(controllerName, controller, descriptor, handler);
  }
}

DI.register(SchemaRequiredRegistry).as(SocketHandlerRegistry);
```

## Important behaviour

- Names: a command or event full name must match `NAME_PATTERN` (`/^[\w.:-]+$/`) and be at most `MAX_NAME_LENGTH` (128) characters, or `build()` throws `InvalidOperation`.
- A full name declared twice, in one controller or across controllers, throws `InvalidOperation` naming both methods.
- A method with socket argument or policy decorators but no `@Command`, `@OnEvent`, `@OnConnect` or `@OnDisconnect` throws `InvalidOperation`.
- One method is one handler kind: `@Command` and `@OnEvent` on the same method throw when the module loads.
- An async generator method declared `ordered` or `idempotent` throws `InvalidOperation` at startup; see [Stream replies](06-stream-replies.md).
- A subclass that redeclares an inherited handler changes only its own copy; the parent's descriptor stays as it was.
- Controllers are singletons shared by every connection. Keep per-connection state in `conn.data`, never in controller fields.
- Hooks run in registration order and run **no** policies. A throwing hook is logged as a warning; it never refuses the connection.
- Commands and events of a connection wait for its connect hooks, up to `http.socket.hooks.connectTimeoutMs` (10 s). After that the hook is logged as an error and keeps running, so a disconnect hook may run while a timed-out connect hook still runs.
- A client that leaves while its connect hooks run gets its disconnect hooks after them.
- A connect hook's `@Signal()` is the connection's signal; a disconnect hook gets a signal that never aborts.
- An `@OnEvent` handler is fire-and-forget: a refusal or a throw is logged (one warning per connection per 10 s, the rest at debug) and dropped. The socket stays up unless the principal check fails.
- An event runs the payload size check, the rate limit, `maxInFlightEventsPerConnection`, the principal check and the policies, in that order. An unknown event name is dropped at debug level.
- Every handler and hook runs inside the call's AsyncLocalStorage store (`ISocketCallStorage`): `Principal`, `AuthnPrincipal`, `requestId`, `traceId`, `spanId`, `realIp`, `connectionId`, `clientId` and `socketCall` (the full name). `AuthzService.current()` reads `Principal` from it.

## Best practices

- Prefix every controller (`@SocketController('docs')`): names stay unique and pushes of the same feature share the prefix (`docs.changed`).
- Declare `schema` on every command that takes a payload; the registry rule above enforces it.
- Read `conn.recovered` in an `@OnConnect` hook to skip work connection state recovery already restored, such as room joins.
- Key per-connection state by the connection object, not by `conn.id`: a recovered connection reuses the id, and the old disconnect hooks may still run.

## Patterns and antipatterns

```ts
// Don't: controller fields are shared by every connection
@SocketController('cart')
export class CartSocket extends BaseSocketController {
  protected items: string[] = [];

  @Command('add')
  public async add(@Payload() item: string) {
    this.items.push(item);
  }
}

// Do: per-connection state lives in conn.data
@SocketController('cart')
export class CartSocket extends BaseSocketController {
  @Command('add')
  public async add(@Payload() item: string, @Connection() conn: SocketConnection<{ items?: string[] }>) {
    (conn.data.items ??= []).push(item);
  }
}
```

## Examples

### Presence: announce who joins and leaves a document

```ts sample
import { Autoinject } from '@spinajs/di';
import { BaseSocketController, Command, Connection, OnDisconnect, OnEvent, Payload, Reason, SocketConnection, SocketController, SocketHub } from '@spinajs/http-socket';

type DocConnection = SocketConnection<{ doc?: string }, { name: string }>;

@SocketController('docs')
export class PresenceSocket extends BaseSocketController {
  @Autoinject()
  protected Hub: SocketHub;

  @Command('open', { schema: { type: 'object', required: ['doc'], properties: { doc: { type: 'string', minLength: 1 } } }, timeoutMs: 5_000 })
  public async open(@Payload() req: { doc: string }, @Connection() conn: DocConnection) {
    conn.data.doc = req.doc;
    conn.join(`doc:${req.doc}`);
    this.Hub.to(`doc:${req.doc}`).emit('docs.presence', { doc: req.doc, joined: conn.user?.name ?? 'guest' });
    return { doc: req.doc };
  }

  @OnEvent('cursor', { schema: { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } } })
  public async cursor(@Payload() at: { x: number; y: number }, @Connection() conn: DocConnection) {
    if (conn.data.doc) {
      this.Hub.to(`doc:${conn.data.doc}`).emit('docs.cursor', { by: conn.id, at });
    }
  }

  @OnDisconnect()
  public async left(@Connection() conn: DocConnection, @Reason() reason: string) {
    if (conn.data.doc) {
      this.Hub.to(`doc:${conn.data.doc}`).emit('docs.presence', { doc: conn.data.doc, left: conn.user?.name ?? 'guest', reason });
    }
  }
}
```

## Server-enforced contracts

`@SocketController('docs', { contract: DOCS_CONTRACT })` binds the controller to a contract declared with
`defineContract<C>('<id>')` from `@spinajs/http-socket-common`. The check needs the application manifest
(`spinajs build`) and an effective `system.manifest.mode` other than `off`; with `off` the option does nothing. The mode is
the one the configuration source decided (`SPINAJS_MANIFEST_MODE` or the app's config files, see
[One switch](../manifest/README.md#one-switch)); a `system.manifest` merged later, e.g. by `onLoad`, does not turn it on.

At `SocketServer.resolve()` the controller is matched to its manifest entry by class name and prefix. Its handlers
are then compared with the contract (doctor rules SOCK001-SOCK003), and each incoming payload of a command or client event is
validated with Ajv against the contract schema before the handler runs. Validation does not coerce types, applies
no defaults, and enforces `format`. A failure answers `invalid_argument` with `details: { errors, total }`: the first 10
errors (`path`, `keyword`, `message`) and the total count. A schema marked `x-explicit: 'partial'` is documentation only and is not enforced.

| Situation | `require` | `prefer` |
| --- | --- | --- |
| handler missing or incompatible, controller not in the manifest, runtime and manifest contract ids differ, contract absent or declared twice, schema cannot compile (for example an unresolved `$ref`) | boot fails with an error naming the controller and contract | warning; a contract that cannot compile is skipped, every other contract still enforces |
| the manifest binds a contract but the code declares none | the manifest contract is enforced, with a warning | not enforced, warning (fail-open) |
| no manifest file | boot fails | nothing is checked or enforced (fail-open) |

`prefer` never stops the server and never enforces what it could not verify, so use `require` where the contract is a security or correctness boundary.
The manifest binding is authoritative: a stale manifest is a `require` boot error, not a silent fallback.

A contract with no explicit id takes `<package>:<VARIABLE>` from the compiler. A contract imported from another package
resolves through that package's manifest fragment; otherwise give it an explicit id (see SOCK004 in [spinajs doctor](../compiler/doctor.md)).

## Related

- [Handler arguments](03-handler-arguments.md): what each parameter decorator injects.
- [Command pipeline](04-command-pipeline.md): what runs before a `@Command` handler.
- [Policies and `@SocketAccess`](10-policies-and-access.md): `@SocketPolicy` and `@SocketAccess` on controllers and handlers.
- [Rooms and server push](07-rooms-and-push.md): `SocketHub` and `SocketConnection`.
