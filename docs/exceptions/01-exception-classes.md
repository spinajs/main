# Exception classes

`@spinajs/exceptions` exports `Exception` and seventeen subclasses, each naming one kind of failure. Throw the class that says what went wrong; callers branch on it with `instanceof`, and `@spinajs/http` picks the HTTP status from it.

## How it works

1. Code throws one of the classes, for example `new ResourceNotFound('invoice 42 does not exist')`.
2. `Exception`'s constructor calls `super(message)` on `Error` and sets `name` to the class name and stores the second argument in the public `inner` field and in `cause`.
3. A caller catches the error and tests it with `instanceof`. Every class extends `Exception`, so `err instanceof Exception` holds for all of them.
4. In an HTTP request, the error reaches the `@spinajs/http` error handler. It walks the class chain, finds the response registered for the nearest mapped class, and answers with that status. See [HTTP error mapping](03-http-error-mapping.md).

## Class reference

All classes extend `Exception`, which extends `Error`. `Exception` sets `name` to the name of the constructed class, so `err.name` is `'Forbidden'`, `'ResourceNotFound'` and so on.

### `Exception`

```ts
class Exception extends Error {
  inner?: Error | unknown;
  constructor(message?: string, inner?: Error | unknown);
}
```

| Member | Type | Meaning |
| --- | --- | --- |
| `message` | `string` | The message passed to the constructor. |
| `inner` | `Error \| unknown` | The original cause, for example a driver error. Public, not enumerable. |

The same value is also set as the standard `Error.cause` (not enumerable) when `inner` is given.

### `InvalidArgument`

```ts
class InvalidArgument extends Exception {
  constructor(message?: string, public fieldName?: string, public errorCode?: string, inner?: Error | unknown);
}
```

| Member | Type | Meaning |
| --- | --- | --- |
| `fieldName` | `string` | The argument or field that failed, for example `'email'`. |
| `errorCode` | `string` | A machine-readable reason, for example `'TYPE_MISMATCH'` or `'MISSING_KEY'` (used by `@spinajs/util`'s argument checks). |

`InvalidArgument` and `CodedHttpException` are the only classes with other constructor parameters. Every other subclass takes `(message?, inner?)`.

### `CodedHttpException`

```ts
class CodedHttpException<TCode extends string = string, TDetails = unknown> extends Exception {
  readonly status: number;
  readonly code: TCode;
  readonly details?: TDetails;
  constructor(status: number, code: TCode, message?: string, details?: TDetails, inner?: unknown);
}
```

| Member | Type | Meaning |
| --- | --- | --- |
| `status` | `number` | The HTTP status, an integer from 400 to 599. Any other value throws `UnexpectedServerError`, so a wrong status answers 500, not a client error. |
| `code` | `TCode` | A stable code the client branches on, for example `'invoice.locked'`. |
| `message` | `string` | Defaults to `code`. |
| `details` | `TDetails` | Data the client acts on. Set only when given. It must survive `JSON.stringify`. |

`status`, `code` and `details` are own enumerable fields. `@spinajs/http` re-exports the class and answers it with `CodedHttpExceptionResponse`: `{ code, message, details? }` and `status`, never a stack. A package with no HTTP layer, such as `@spinajs/upload`, throws it without depending on `@spinajs/http`. See [Coded errors](../http/11-error-handling.md#coded-errors).

The body type is `CodedErrorBody<TCode, TDetails>`: `{ code: TCode; message: string; details?: TDetails }`.

### Semantic subclasses and their HTTP status

The status column applies when `@spinajs/http` handles the error. "Unmapped" classes fall back to HTTP 500, and the error handler also logs a warning that the type has no assigned response.

| Class | Throw when | HTTP status | `@spinajs/http` response |
| --- | --- | --- | --- |
| `Exception` | No subclass fits. | 500 | unmapped, `ServerError` |
| `ConnectionNotFound` | A named connection (database, queue, transport) is not configured. | 500 | unmapped, `ServerError` |
| `NotSupported` | A feature or option is not supported by this implementation. | 500 | unmapped, `ServerError` |
| `InvalidArgument` | An argument is invalid, for example out of range or of the wrong type. | 400 | `BadRequestResponse` |
| `InvalidOption` | A configuration option is missing or malformed. | 500 | unmapped, `ServerError` |
| `InvalidOperation` | A call is invalid for the object's current state. | 500 | unmapped, `ServerError` |
| `AuthenticationFailed` | Credentials are missing or invalid. | 401 | `Unauthorized` |
| `BadRequest` | The request data is invalid. | 400 | `BadRequestResponse` |
| `Forbidden` | The caller is known but not allowed. | 403 | `ForbiddenResponse` |
| `IOFail` | An IO operation failed, for example a file is not accessible. | 500 | `ServerError` |
| `ResourceNotFound` | A model, file or route does not exist. | 404 | `NotFound` |
| `MethodNotImplemented` | A method is declared but not implemented. | 500 | `ServerError` |
| `UnexpectedServerError` | A generic server failure. | 500 | `ServerError` |
| `ResourceDuplicated` | A unique resource already exists, for example a unique constraint failed. | 409 | `Conflict` |
| `JsonValidationFailed` | A JSON entity does not match its schema. | 400 | `BadRequestResponse` |
| `ExpectedResponseUnacceptable` | The client's `Accept` header asks for a format the server cannot produce. | 400 | `BadRequestResponse` |
| `LimitExceeded` | A stream or input went over a configured size limit, for example `ByteLimitStream` of `@spinajs/fs`. | 413 | `EntityTooLarge` |
| `CodedHttpException` | A refusal the client tells apart by a stable code, with a status of its own. | its `status` | `CodedHttpExceptionResponse` |

`@spinajs/http` also maps `ValidationFailed` from `@spinajs/validation` to 400, and its own `EntityTooLargeException` to 413 and `UnsupportedMediaTypeException` to 415. Those classes extend `Exception` but live in their packages.

## Services and extension points

The package registers nothing in DI and has no abstract classes or factories. It is extended in two ways, each on its own page:

| Extension point | Mechanism | Page |
| --- | --- | --- |
| Domain exception | Subclass `Exception` or a semantic subclass. | [Domain exceptions](02-domain-exceptions.md) |
| HTTP status of an exception | Register a response class for its name in `@spinajs/http`'s `__http_error_map__`. | [HTTP error mapping](03-http-error-mapping.md) |

## Important behaviour

- `name` and `inner` are non-enumerable own properties, so the HTTP error handler's spread does not copy them into the response body. Stack traces and logs print `<ClassName>: <message>`.
- `CodedHttpExceptionResponse` sends `code`, `message` and `details` only, whatever other own fields a subclass adds.
- `fieldName` and `errorCode` are own enumerable properties. The `@spinajs/http` error handler spreads them into the JSON response body, in production too.
- `stack` is added to the response body only when `configuration.isProduction` is not `true`.
- `instanceof` checks need a single installed copy of `@spinajs/exceptions`. Two copies give two `Forbidden` classes; the HTTP mapping still works, because it matches by class name.
- `InvalidOperation`, `InvalidOption`, `NotSupported` and `ConnectionNotFound` answer HTTP 500 unless you map them. Thrown from a controller for a client mistake, they read as a server fault.

## Best practices

- Throw the most specific class: `ResourceNotFound` for a missing row, `ResourceDuplicated` for a unique-key clash. The status code follows for free.
- Pass `fieldName` and `errorCode` to `InvalidArgument`; clients read them from the 400 body to highlight the field.
- Wrap a low-level error in `inner` only when the caller needs it, and and still log it on the server rather than rely on the response (see the pattern below).
- Throw `InvalidOption` from bootstrap and config checks, not from request handlers: it answers 500.

## Patterns and antipatterns

```ts
// Don't: custom enumerable fields that copy the mysql error (SQL text, message) are spread into the 500 body
try {
  await db.query('SELECT * FROM invoices WHERE id = ?', [id]);
} catch (err) {
  throw new UnexpectedServerError('cannot load invoice', err);
}

// Do: log the cause on the server, throw a clean exception to the client
try {
  await db.query('SELECT * FROM invoices WHERE id = ?', [id]);
} catch (err) {
  log.error(err, 'cannot load invoice ${id}');
  throw new UnexpectedServerError('cannot load invoice');
}
```

```ts
// Don't: a client mistake answers 500, because InvalidOperation is unmapped
if (order.status === 'shipped') {
  throw new InvalidOperation('order already shipped');
}

// Do: a semantic class the HTTP layer maps, or a domain subclass of one
if (order.status === 'shipped') {
  throw new ResourceDuplicated('order already shipped');
}
```

## Examples

### Validate a transfer request

```ts sample
import { BadRequest, Forbidden, InvalidArgument, ResourceNotFound } from '@spinajs/exceptions';

interface Account {
  id: string;
  ownerId: number;
  balance: number;
}

const accounts = new Map<string, Account>([
  ['PL01', { id: 'PL01', ownerId: 7, balance: 500 }],
  ['PL02', { id: 'PL02', ownerId: 9, balance: 20 }],
]);

export function transfer(userId: number, from: string, to: string, amount: number): void {
  if (!(amount > 0)) {
    throw new InvalidArgument('amount must be greater than zero', 'amount', 'OUT_OF_RANGE');
  }
  if (from === to) {
    throw new BadRequest('source and target accounts are the same');
  }

  const source = accounts.get(from);
  const target = accounts.get(to);
  if (!source || !target) {
    throw new ResourceNotFound(`account ${source ? to : from} does not exist`);
  }
  if (source.ownerId !== userId) {
    throw new Forbidden(`account ${from} does not belong to user ${userId}`);
  }

  source.balance -= amount;
  target.balance += amount;
}
```

### Branch on the exception class

```ts sample
import { Exception, InvalidArgument, IOFail, ResourceNotFound } from '@spinajs/exceptions';
import { readFile } from 'node:fs/promises';

export async function loadTemplate(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ResourceNotFound(`template ${path} does not exist`, err);
    }
    throw new IOFail(`cannot read template ${path}`, err);
  }
}

export async function renderOrFallback(path: string): Promise<string> {
  try {
    return (await loadTemplate(path)) ?? '';
  } catch (err) {
    if (err instanceof ResourceNotFound) {
      return '<p>Template missing</p>';
    }
    if (err instanceof InvalidArgument) {
      return `<p>Bad field ${err.fieldName}</p>`;
    }
    if (err instanceof Exception) {
      console.error(err.message, err.inner);
    }
    throw err;
  }
}
```

## Related

- [Domain exceptions](02-domain-exceptions.md): subclass these classes for your own rules.
- [HTTP error mapping](03-http-error-mapping.md): how the status column above is produced, and how to change it.
- [`@spinajs/http`](../http/README.md): the error handler that answers with these statuses.
