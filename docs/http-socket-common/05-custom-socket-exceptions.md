# Custom socket exceptions

Subclass `SocketException` to give a domain error its own class, fixed code and structured `details`. The server sends any subclass through its `toWire()`, so overriding `toWire()` shapes exactly what the client receives.

## How it works

1. A handler throws `new DocumentLocked(...)`, a subclass of `SocketException`.
2. `SocketErrorMapper` of `@spinajs/http-socket` looks up a mapping by walking the error's constructor chain by class name: `DocumentLocked`, then `SocketException`.
3. With no mapping registered for `DocumentLocked`, it finds the built-in `SocketExceptionMapping`, which calls `error.toWire()`. An overridden `toWire()` runs here.
4. The client receives the `SocketError` and rejects with `SocketException.fromWire(error)`: a plain `SocketException`, not a `DocumentLocked`.
5. The client recognises the error by `code` and the shape of `details`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SocketException` | none, a plain class | `SocketException` | Your subclasses | `class X extends SocketException`; call `super(code, message, options)`; override `toWire()` to add or redact fields. |
| Server mapping of a subclass | `@HandleSocketException(X)` in `@spinajs/http-socket` | `SocketExceptionMapping` (calls `toWire()`) | A mapping class of your own for `X` | Register a mapping only when `toWire()` is not enough, e.g. to log or translate. |

### Overridable members

| Member | Override when |
| --- | --- |
| `constructor` | Fix the code and build `message` and `details` from domain arguments. |
| `toWire()` | Compute `details` at send time, or remove fields that must not leave the server. Call `super.toWire()` and change its result. |

### `SocketException`: custom implementation

A collaborative editor refuses edits on a locked document and tells the client who holds the lock and until when:

```ts sample
import { SocketException, isSocketError, type SocketError, type SocketExceptionOptions } from '@spinajs/http-socket-common';

export interface DocumentLockedDetails {
  docId: string;
  lockedBy: string;
  lockedUntil: string;
}

/** Server side: thrown by the edit handler. */
export class DocumentLocked extends SocketException {
  constructor(
    public readonly docId: string,
    public readonly lockedBy: string,
    public readonly lockedUntil: Date,
    options: Pick<SocketExceptionOptions, 'cause'> = {},
  ) {
    super('failed_precondition', `document ${docId} is locked by ${lockedBy}`, {
      ...options,
      retryable: true,
      retryAfterMs: Math.max(0, lockedUntil.getTime() - Date.now()),
    });
    this.name = 'DocumentLocked';
  }

  public override toWire(): SocketError {
    const details: DocumentLockedDetails = { docId: this.docId, lockedBy: this.lockedBy, lockedUntil: this.lockedUntil.toISOString() };
    return { ...super.toWire(), details };
  }
}

/** Shared: recognise the error on the client, where it arrives as a plain SocketException. */
export function asDocumentLocked(err: unknown): DocumentLockedDetails | null {
  if (!(err instanceof SocketException) || err.code !== 'failed_precondition') {
    return null;
  }
  const details = err.details as Partial<DocumentLockedDetails> | undefined;
  return typeof details?.docId === 'string' && typeof details.lockedBy === 'string' && typeof details.lockedUntil === 'string'
    ? { docId: details.docId, lockedBy: details.lockedBy, lockedUntil: details.lockedUntil }
    : null;
}

// the server sends exactly this
const wire = new DocumentLocked('doc-7', 'anna', new Date(Date.now() + 30_000)).toWire();
console.log(isSocketError(wire), wire.code, wire.retryable, wire.details);

// the client rebuilds it and recognises it
const lock = asDocumentLocked(SocketException.fromWire(wire));
if (lock) {
  console.log(`locked by ${lock.lockedBy} until ${lock.lockedUntil}`);
}
```

Use it in a socket controller of `@spinajs/http-socket`:

```ts
@Command('edit', { schema: EditSchema })
public async edit(@Payload() req: CommandPayload<NotesContract, 'notes.edit'>, @Connection() conn: NotesConnection) {
  const lock = this.Locks.holder(req.docId);
  if (lock && lock.user !== conn.user?.name) {
    throw new DocumentLocked(req.docId, lock.user, lock.until);
  }
  return this.Store.edit(req.docId, req.entity);
}
```

No registration is needed: the subclass is mapped through `SocketException`.

## Important behaviour

- The subclass identity does not cross the wire. Client code checks `code` and `details`, never `instanceof DocumentLocked`.
- The server matches mappings by **class name**, walking the prototype chain. A subclass named like a mapped spinajs exception (`Forbidden`, `InvalidArgument`, `ResourceNotFound`, `AccessDenied`, ...) is sent through that mapping instead of `toWire()`, losing its `details` and `retryable`.
- A mapping registered for the subclass itself wins over `SocketExceptionMapping`.
- If `toWire()` throws, the server sends `internal` and logs the mapping failure.
- `cause` is kept on the server for logs and is never sent.

## Best practices

- Fix the code in the subclass constructor; do not let callers pass it, so one class always means one code.
- Put everything the client needs in `details` with a documented type, and export a recogniser like `asDocumentLocked` from the shared contract module.
- Override `toWire()` to redact: anything on the instance that `toWire()` does not copy stays on the server.

## Patterns and antipatterns

```ts
// Don't: the name collides with @spinajs/exceptions' Forbidden, so the server's ForbiddenMapping
// handles it and drops details and retryable
export class Forbidden extends SocketException {}

// Do: a distinct name, routed through toWire()
export class TenantForbidden extends SocketException {}
```

```ts
// Don't: instanceof fails on the client, which only ever sees SocketException
if (err instanceof DocumentLocked) showLock(err);

// Do
const lock = asDocumentLocked(err);
if (lock) showLock(lock);
```

## Related

- [Error codes and `SocketException`](04-error-codes.md): codes, defaults and the wire shape.
- [Typed contracts](06-typed-contracts.md): the shared module where error recognisers belong.
- [`@spinajs/http-socket`](../../packages/http-socket/README.md): `SocketErrorMapper` and `@HandleSocketException`.
