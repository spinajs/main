# `@spinajs/exceptions`

The shared exception classes of the framework: one base class, `Exception`, and seventeen semantic subclasses such as `ResourceNotFound`, `Forbidden`, `InvalidArgument` and `CodedHttpException`. Every `@spinajs/*` package throws these, and `@spinajs/http` turns each one into an HTTP status.

The package has **no** DI services, configuration or runtime code beyond the classes and a few helpers for caught values. It does **not** map exceptions to HTTP responses; `@spinajs/http` does that, keyed by class name.

## Install

```sh
npm install @spinajs/exceptions
```

## Features

| Feature | What it does |
| --- | --- |
| [Exception classes](01-exception-classes.md) | The `Exception` base, the seventeen semantic subclasses, their constructors and the HTTP status each one gets. |
| [Domain exceptions](02-domain-exceptions.md) | Subclass a semantic exception to name the rule that failed, carry a stable code and keep the inherited HTTP status. |
| [HTTP error mapping](03-http-error-mapping.md) | Map an exception class to an HTTP response through `@HandleException` and the `__http_error_map__` DI map; add or override a mapping. |
| [Error helpers](04-error-helpers.md) | Describe a caught value of unknown type (`errorClassOf`, `errorMessage`, `describeError`, `toError`) and test its class across cjs and mjs copies (`isErrorOf`). |

## Quick start

```ts sample
import { InvalidArgument, ResourceNotFound } from '@spinajs/exceptions';

interface Invoice {
  id: number;
  total: number;
}

const invoices = new Map<number, Invoice>([[1, { id: 1, total: 120 }]]);

export function findInvoice(id: number): Invoice {
  if (!Number.isInteger(id) || id <= 0) {
    throw new InvalidArgument(`invoice id must be a positive integer, got ${id}`, 'id', 'INVALID_ID');
  }

  const invoice = invoices.get(id);
  if (!invoice) {
    throw new ResourceNotFound(`invoice ${id} does not exist`);
  }

  return invoice;
}

try {
  findInvoice(42);
} catch (err) {
  if (err instanceof ResourceNotFound) {
    console.log(err.message); // invoice 42 does not exist
  }
}
```

Thrown from a controller, the `ResourceNotFound` answers HTTP 404 and the `InvalidArgument` answers HTTP 400.

## Related packages

- [`@spinajs/http`](../http/README.md): its error handler maps these classes to HTTP responses.
- [`@spinajs/di`](../di/README.md): holds the `__http_error_map__` map that `@HandleException` fills.
- [`@spinajs/orm`](../orm/README.md): `OrmException` and its subclasses extend `Exception`.
