# Handler arguments

Parameter decorators tell the server what to pass to each handler argument: the validated payload, the connection, the abort signal, the disconnect reason or a DI service. Each decorator names a `SocketArg` extractor class, so you add an argument kind by writing one more extractor.

## How it works

1. A parameter decorator calls `SocketParameter(type, schema, options)`. It stores the index, the extractor class `type`, the TypeScript runtime type (`design:paramtypes`), the schema and the options on the handler.
2. For a command, `ArgumentsStage` (order 700) calls `SocketArgumentResolver.resolve(ctx)`. For an event or a hook, the dispatcher calls it right before the handler.
3. `SocketArgumentResolver.resolve()` resolves each extractor with `DI.resolve(param.Type)` and awaits `extract(ctx, param)`. Positions without a decorator stay `undefined`.
4. `PayloadArg.extract()` handles the payload:
   1. `filter()`: an object payload goes through every `ArgInputFilter` registered with `@spinajs/http`, as one body parameter named `payload`. A primitive payload skips them.
   2. Picks the schema: the command's `schema` option, else `@Payload(schema)`, else the DTO's `@Schema` (not for `Object`, `Array`, `String`, `Number`, `Boolean`).
   3. With a schema, a `null` or missing payload throws `InvalidArgument('payload is required')`; otherwise `DataValidator.validate()` throws `ValidationFailed`. Both answer `invalid_argument`.
      Without one, in manifest mode (`prefer` or `require`), a payload of a handler that no [contract](02-controllers.md) validates is checked against the schema the compiler derived from its `@Payload` type, without coercion and closed (nothing else reads the payload, so undeclared properties are refused); a failure throws `ValidationFailed`, and an absent payload is not checked. The schema is compiled once when the controller registers; one that cannot compile fails the build in `require` and is skipped with a warning in `prefer`.
   4. `hydrate()`: a class with `@Hydrator(H, ...options)` is built by `H.hydrate(payload, param)`; any other class by `new Dto(payload)`; plain types and `null` pass unchanged.
5. A thrown extractor error fails the command like any stage error; see [Error mapping](05-error-mapping.md).

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Payload(schema?)` | handler parameter | `schema`: ajv schema | The client payload, filtered, validated and hydrated (`PayloadArg`) |
| `@Connection()` | handler parameter | none | The `SocketConnection` (`ConnectionArg`) |
| `@Signal()` | handler parameter | none | An `AbortSignal` (`SignalArg`): the command's signal; the connection's signal in events and connect hooks; a signal that never aborts in disconnect hooks |
| `@Reason()` | handler parameter | none | The socket.io disconnect reason in `@OnDisconnect` hooks, else `null` (`ReasonArg`) |
| `@FromDI(...options)` | handler parameter | constructor options | `DI.resolve(<parameter type>, options)` (`FromDiArg`). In a build without decorator metadata the type comes from the manifest ([Building without decorator metadata](../manifest/README.md#building-without-decorator-metadata)), as for `@Payload` |
| `SocketParameter(type, schema?, options?)` | handler parameter | extractor class, schema, any options | Base of every decorator above; use it to build your own |

A command's `@Signal()` aborts on its deadline, a client cancel, a disconnect and shutdown. Its `reason` is the `SocketException` the client is answered with.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SocketArg` extractors | Each extractor class is its own token, resolved by class on every call (`DI.resolve(param.Type)`); `@Injectable()`, singleton | `PayloadArg`, `ConnectionArg`, `SignalArg`, `ReasonArg`, `FromDiArg` | Your extractor | Extend `SocketArg`, implement `extract(ctx, param)`, wrap it in a decorator with `SocketParameter(MyArg, null, options)` |
| `PayloadArg` | `PayloadArg` (self), singleton | `PayloadArg` | Your subclass | Override `filter()`, `schemaOfType()` or `hydrate()`; `DI.register(MyPayloadArg).as(PayloadArg)` |
| `SocketArgumentResolver` | `SocketArgumentResolver` (self), singleton | `SocketArgumentResolver` | Your subclass | Override `resolve(ctx)`; `DI.register(Mine).as(SocketArgumentResolver)` before `SocketServer` resolves |
| `ArgInputFilter` (`@spinajs/http`) | `ArgInputFilter`, every registered class (`Array.ofType`), resolved on every object payload | `AuthzInputFieldFilter` when `@spinajs/authz-http` is loaded | Your filter | `@Injectable(ArgInputFilter)`; it runs on http bodies too, with `route` undefined on sockets |
| `ArgHydrator` (`@spinajs/http`) | The class named by `@Hydrator(H, ...options)` on the DTO, resolved with those options | none (`new Dto(payload)`) | Your hydrator | Extend `ArgHydrator`, put `@Hydrator(MyHydrator)` on the DTO class |

### `SocketArg`: a custom argument decorator

An extractor receives the `ISocketCallContext` (`kind`, `connection`, `handler`, `payload`, `signal`, `reason`, `storage`) and the `ISocketParameter` (`Index`, `Type`, `RuntimeType`, `Schema`, `Options`). It is resolved through DI, so it can `@Autoinject` services. Throw to refuse the call.

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { BaseSocketController, Command, ISocketCallContext, ISocketParameter, SocketArg, SocketController, SocketParameter } from '@spinajs/http-socket';

export interface Tenant {
  id: string;
  plan: 'free' | 'pro';
}

@Injectable()
export class TenantDirectory {
  protected tenants = new Map<string, Tenant>([['acme', { id: 'acme', plan: 'pro' }]]);

  public async find(id: string): Promise<Tenant | undefined> {
    return this.tenants.get(id);
  }
}

/** The tenant the client named in `io(url, { auth: { tenant } })`; options[0] is the plan it requires. */
@Injectable()
export class TenantArg extends SocketArg {
  @Autoinject()
  protected Tenants: TenantDirectory;

  public async extract(ctx: ISocketCallContext, param: ISocketParameter): Promise<Tenant> {
    const id = ctx.connection.handshake.auth.tenant;
    const tenant = typeof id === 'string' ? await this.Tenants.find(id) : undefined;
    const plan = param.Options as Tenant['plan'] | undefined;

    if (!tenant || (plan === 'pro' && tenant.plan !== 'pro')) {
      throw new Forbidden('this tenant cannot use this command');
    }

    return tenant;
  }
}

export function CurrentTenant(plan?: Tenant['plan']) {
  return SocketParameter(TenantArg, null, plan);
}

@SocketController('reports')
export class ReportsSocket extends BaseSocketController {
  @Command('export')
  public async export(@CurrentTenant('pro') tenant: Tenant) {
    return { tenant: tenant.id, queued: true };
  }
}
```

### `PayloadArg`: change how every payload is prepared

Subclass `PayloadArg` to change one step for every `@Payload` in the app. `hydrate(payload, param)` runs after validation; `filter(ctx, param)` before it.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { ISocketParameter, PayloadArg } from '@spinajs/http-socket';

function trimStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(trimStrings);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trimStrings(item)]));
  }
  return value;
}

/** Trims every string of a validated payload before it is hydrated. */
@Injectable()
export class TrimmingPayloadArg extends PayloadArg {
  protected async hydrate(payload: unknown, param: ISocketParameter): Promise<unknown> {
    return super.hydrate(trimStrings(payload), param);
  }
}

DI.register(TrimmingPayloadArg).as(PayloadArg);
```

### `ArgHydrator`: build a DTO from the payload

`@Hydrator` on the DTO class picks the hydrator, as on http bodies. The validated payload is its input.

```ts sample
import { ArgHydrator, Hydrator, IRouteParameter } from '@spinajs/http';
import { BaseSocketController, Command, Payload, SocketController } from '@spinajs/http-socket';

export class RangeHydrator extends ArgHydrator {
  public async hydrate(input: { from: string; to: string }, _parameter: IRouteParameter): Promise<DateRange> {
    return new DateRange(new Date(input.from), new Date(input.to));
  }
}

@Hydrator(RangeHydrator)
export class DateRange {
  constructor(public readonly from: Date, public readonly to: Date) {}

  public get days(): number {
    return Math.round((this.to.getTime() - this.from.getTime()) / 86_400_000);
  }
}

@SocketController('stats')
export class StatsSocket extends BaseSocketController {
  @Command('visits', { schema: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' } } } })
  public async visits(@Payload() range: DateRange) {
    return { days: range.days };
  }
}
```

## Important behaviour

- The command `schema` option wins over `@Payload(schema)`, which wins over the DTO's `@Schema`. Only one schema is applied.
- Without any schema, the payload is not validated: a `null` or missing payload reaches the handler.
- A primitive payload (string, number, boolean) skips the `ArgInputFilter`s, where http checks a primitive body by its parameter name. Use a record payload for anything an authz decision restricts.
- A list payload, or a record payload declared with a primitive type (`@Payload() p: string`), is checked by the input filters as one field named `payload`.
- `@FromDI()` resolves the TypeScript parameter type: an interface or a type literal has runtime type `Object`, so it never resolves your service. Use a class.
- Extractors run in parameter order, one after another; a slow extractor delays the next one.
- For a command, arguments are built inside the queue place of an `ordered` command and after the policies, so hydrators see what earlier commands changed.

## Best practices

- Prefer the command `schema` option for request shapes; keep `@Schema` DTOs for payloads shared with http routes.
- Make custom extractors cheap and side-effect free: they run before the handler on every call, also for calls that fail later in the handler.
- Read the principal from `@Connection()` (`conn.principal`, `conn.user`) or `AuthzService.current()`; there is no `@User()` decorator.

## Patterns and antipatterns

```ts
// Don't: an interface type has no runtime class, so @FromDI() cannot resolve it
@Command('send')
public async send(@FromDI() mailer: IMailer) {}

// Do: inject the abstract class the service is registered under
@Command('send')
public async send(@FromDI() mailer: Mailer) {}
```

## Examples

### Validate with a DTO schema and hydrate into a class

```ts sample
import { Schema } from '@spinajs/validation';
import { BaseSocketController, Command, Connection, Payload, SocketConnection, SocketController } from '@spinajs/http-socket';

@Schema({ type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, tags: { type: 'array', items: { type: 'string' } } }, additionalProperties: false })
export class NewTask {
  public title: string;
  public tags: string[] = [];

  constructor(data: Partial<NewTask>) {
    Object.assign(this, data);
  }
}

@SocketController('tasks')
export class TasksSocket extends BaseSocketController {
  @Command('create')
  public async create(@Payload() task: NewTask, @Connection() conn: SocketConnection) {
    return { title: task.title, tags: task.tags, by: conn.clientId };
  }
}
```

## Related

- [Socket controllers](02-controllers.md): the handlers these arguments feed.
- [Command pipeline](04-command-pipeline.md): `ArgumentsStage` at order 700.
- [Policies and `@SocketAccess`](10-policies-and-access.md): the authz input field filter applied to payloads.
- [`@spinajs/http` argument hydrators](../http/06-argument-hydrators.md) and [argument input filters](../http/07-argument-input-filters.md): the same `ArgHydrator`, `@Hydrator` and `ArgInputFilter` on http routes.
