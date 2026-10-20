# Error mapping

Every failure reaches the client in one shape, `SocketError`: `{ code, message, retryable, retryAfterMs?, details?, errorId? }`. `SocketErrorMapper` turns a thrown error into it through mapping classes registered per exception type; anything unmapped becomes `internal`.

## How it works

1. A command handler, a stage, a handshake check, an event, a hook or a stream source throws.
2. `SocketErrorMapper.toWire(error, context)` looks up a mapping: `resolveSocketErrorMapping()` walks the error's constructor and its prototype chain, and matches each class against the classes registered with `@HandleSocketException`.
3. A mapping is found: `new Mapping().map(error)` returns the `SocketError`. A mapping that throws turns into `internal`.
4. No mapping, or a thrown non-`Error` value: `internal()` logs the error with a new `errorId` (a UUID) and returns `internal`.
   - With `configuration.isProduction`, the message is `Internal server error` and there are no details.
   - Otherwise the message is the error's message and `details` holds `{ name, stack }`.
5. Where the result goes:
   - a command: the error reply `{ id, ok: false, error }`;
   - a handshake: `connect_error.data`;
   - a stream: the `fail { id, error }` frame;
   - an event or a hook: a log line only.

| Thrown | Mapping class | Code | Retryable | `details` |
| --- | --- | --- | --- | --- |
| `InvalidArgument`, `BadRequest`, `JsonValidationFailed` | `InvalidArgumentMapping` | `invalid_argument` | no | `field` (`InvalidArgument.fieldName`), `error`, `fields` when present |
| `ValidationFailed` (`@spinajs/validation`) | `ValidationFailedMapping` | `invalid_argument` | no | the ajv errors |
| `AuthenticationFailed`, and `Unauthenticated` (`@spinajs/authz`) through it | `UnauthenticatedMapping` | `unauthenticated` | no | `error`, `fields` when present |
| `Forbidden` | `ForbiddenMapping` | `forbidden` | no | `error`, `fields` when present |
| `AccessDenied` (`@spinajs/authz`) | `AccessDeniedMapping` | `forbidden` | no | `permission`, `resource`, `reason` without `priority` and `sortKey`; never a trace |
| `ResourceNotFound` | `NotFoundMapping` | `not_found` | no | `error`, `fields` when present |
| `ResourceDuplicated` | `ConflictMapping` | `conflict` | no | `error`, `fields` when present |
| `InvalidOperation` | `FailedPreconditionMapping` | `failed_precondition` | no | `error`, `fields` when present |
| `NotSupported`, `MethodNotImplemented` | `UnimplementedMapping` | `unimplemented` | no | `error`, `fields` when present |
| `SocketException(code, message, options)` | `SocketExceptionMapping` | its `code` | its `retryable` | its `details`, `retryAfterMs`, `errorId` |
| anything else | none | `internal` | no | `{ name, stack }` outside production |

`error` and `fields` are the stable code and refused field list that authz-http and authn-http put on their errors; http spreads them into the response body, a socket answers them in `details`.

The pipeline's own refusals are `SocketException`s: `deadline_exceeded` (retryable), `cancelled`, `resource_exhausted` (retryable, except the size limit), `unavailable` (retryable), `unimplemented`, `version_mismatch`. `DEFAULT_RETRYABLE` holds the default of each code.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@HandleSocketException(exception \| exception[])` | class extending `SocketErrorMapping` | one or more exception classes | Maps those exception classes, and subclasses without their own entry, through the decorated class |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SocketErrorMapping` | Not in DI: a module-level map from exception class to mapping class, filled by `@HandleSocketException`; a new instance per mapped error (`new Mapping()`) | The ten mappings in the table | Your mapping; `codeMapping(code)` builds a plain one | `@HandleSocketException(MyError)` on a `SocketErrorMapping` subclass. The last registration for a class wins, so you can also remap a built-in exception |
| `SocketErrorMapper` | `SocketErrorMapper` (self), singleton | `SocketErrorMapper` | Your subclass | Override `toWire()` or `internal()`; `DI.register(Mine).as(SocketErrorMapper)` before `SocketServer` resolves |

### `SocketErrorMapping`: map your own exception

Give a domain exception a precise code, a retry hint or details the client can act on. A subclass of a mapped exception uses its parent's mapping unless it has its own.

```ts sample
import { HandleSocketException, SocketError, SocketErrorMapping, codeMapping } from '@spinajs/http-socket';

export class QuotaExceeded extends Error {
  constructor(public readonly resetAt: Date, public readonly limit: number) {
    super(`quota of ${limit} exports per day reached`);
    this.name = 'QuotaExceeded';
  }
}

export class PaymentRequired extends Error {}

@HandleSocketException(QuotaExceeded)
export class QuotaExceededMapping extends SocketErrorMapping {
  public map(error: Error): SocketError {
    const quota = error as QuotaExceeded;
    return {
      code: 'resource_exhausted',
      message: quota.message,
      retryable: true,
      retryAfterMs: Math.max(0, quota.resetAt.getTime() - Date.now()),
      details: { limit: quota.limit },
    };
  }
}

// a plain code mapping: message as is, the code's default retryability
@HandleSocketException(PaymentRequired)
export class PaymentRequiredMapping extends codeMapping('failed_precondition') {}
```

### `SocketErrorMapper`: report internal errors

Subclass the mapper to send unmapped errors to an error tracker, or to change what an `internal` reply carries. Keep the `errorId`: it ties the client's report to the server log line.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { SocketError, SocketErrorMapper } from '@spinajs/http-socket';

@Injectable()
export class ErrorTracker {
  public capture(error: unknown, tags: Record<string, string>): void {
    console.error('tracked', tags, error);
  }
}

@Injectable()
export class TrackedSocketErrorMapper extends SocketErrorMapper {
  protected internal(error: unknown, context: string): SocketError {
    const wire = super.internal(error, context);
    (DI.get(ErrorTracker) ?? DI.resolve(ErrorTracker)).capture(error, { context, errorId: wire.errorId ?? '' });
    return wire;
  }
}

DI.register(TrackedSocketErrorMapper).as(SocketErrorMapper);
```

## Important behaviour

- Lookup is by class **name**, not by identity. Two exception classes with the same name share one entry, and the last `@HandleSocketException` for that name wins.
- Mapping classes are built with `new`, outside DI: `@Autoinject` in a mapping is never filled. Resolve services with `DI.resolve()` inside `map()` when you need one.
- Lookup walks the prototype chain, so a domain subclass of `Forbidden` answers `forbidden` and a subclass of `AccessDenied` gets the `AccessDenied` details.
- A thrown value that is not an `Error` is always `internal`, even when its constructor is mapped.
- An idempotent command stores the mapped error. Every replay answers the same `SocketError`, `errorId` included; see [Durable commands](12-durable-commands.md).
- `internal` errors are logged at error level; mapped errors are not logged by the mapper.

## Best practices

- Throw `SocketException` from socket-only code when you need a specific code, `retryAfterMs` or `details`; it needs no mapping.
- Throw the `@spinajs/exceptions` classes from code shared with http: they map the same way on both transports.
- Set `retryable` only when resending the same request can succeed; the client's durable queue retries retryable errors.
- Set `configuration.isProduction` in production: otherwise `internal` replies carry stack traces.

## Patterns and antipatterns

```ts
// Don't: a generic Error answers internal, and the client cannot tell a missing document from a crash
@Command('open')
public async open(@Payload() req: { id: string }) {
  const doc = await this.Docs.find(req.id);
  if (!doc) throw new Error('not found');
  return doc;
}

// Do: a mapped exception answers not_found
@Command('open')
public async open(@Payload() req: { id: string }) {
  const doc = await this.Docs.find(req.id);
  if (!doc) throw new ResourceNotFound(`document ${req.id} does not exist`);
  return doc;
}
```

## Examples

### Answer a rate-limited upstream with a retry hint

```ts sample
import { BaseSocketController, Command, Payload, SocketController, SocketException } from '@spinajs/http-socket';

async function callGeocoder(address: string): Promise<{ lat: number; lon: number } | { retryAfterSeconds: number }> {
  return address.length > 0 ? { lat: 52.23, lon: 21.01 } : { retryAfterSeconds: 30 };
}

@SocketController('geo')
export class GeoSocket extends BaseSocketController {
  @Command('locate', { schema: { type: 'object', required: ['address'], properties: { address: { type: 'string' } } } })
  public async locate(@Payload() req: { address: string }) {
    const answer = await callGeocoder(req.address);

    if ('retryAfterSeconds' in answer) {
      throw new SocketException('unavailable', 'geocoder is busy', { retryAfterMs: answer.retryAfterSeconds * 1000 });
    }

    return answer;
  }
}
```

## Related

- [`@spinajs/http-socket-common`](../http-socket-common/README.md): `SocketError`, `SocketException`, `ERROR_CODES`, `DEFAULT_RETRYABLE`.
- [Command pipeline](04-command-pipeline.md): the stages whose refusals are listed above.
- [Stream replies](06-stream-replies.md): errors after the stream started arrive as `fail` frames.
