# Data transformers

A `DataTransformer` reshapes the data of a JSON answer when the client asks for it with a request header. `x-data-transform: <name>` applies to successful answers, `x-error-transform: <name>` to answers with status 400 or above. Use it to serve one endpoint to several client formats (a datatables grid, a legacy mobile app) without a second route.

## How it works

1. Each time a negotiated response is built, `httpResponse()` resolves `Array.ofType(DataTransformer)`.
2. When negotiation picks JSON:
   - status 400 or above: it looks up the transformer whose `Type` equals `x-error-transform`, or `default-http-error-transform` when the header is absent;
   - otherwise, with an `x-data-transform` header: the transformer whose `Type` equals the header;
   - otherwise no transformer runs.
3. It calls `transformer.transform(data, req)` and sends the result with `res.json()`, keeping the status, headers and cookies.
4. No transformer with that name: 400 with `{ error: { message: 'invalid data transformer <name>', code: 400 } }`.

Transformers do not run for HTML, XML or text answers, nor for `Json`, `Xml`, file and redirect responses.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `DataTransformer` (abstract) | `DataTransformer` list, `Array.ofType(DataTransformer)`, resolved per response; each a singleton; selected by its `Type` | `DefaultErrorTransform` (`default-http-error-transform`, returns the data as is), `PureDataTransformer` (`pure`, returns the data as is) | `AuthzFieldTransformer` (`authz-fields`, `@spinajs/authz-http`) | Add one with `@Injectable(DataTransformer)` and a unique `Type`. Replace the default error shape with `DI.register(Mine).as(DefaultErrorTransform)`, keeping `Type` `default-http-error-transform`. |

Members:

| Member | Meaning |
| --- | --- |
| `get Type(): string` | Abstract. The name clients put in the header. |
| `transform(data, request): U` | Abstract, synchronous. Returns the new body. |

### `DataTransformer`: custom implementation

Serve a list endpoint in the shape the datatables.net grid expects, when the grid sends `x-data-transform: datatables`:

```ts sample
import { Injectable } from '@spinajs/di';
import { BaseController, BasePath, DataTransformer, Get, Ok } from '@spinajs/http';
import * as express from 'express';

interface IPage<T> {
  items: T[];
  total: number;
}

@Injectable(DataTransformer)
export class DataTablesTransformer extends DataTransformer<IPage<unknown>, object> {
  public get Type(): string {
    return 'datatables';
  }

  public transform(data: IPage<unknown>, request: express.Request): object {
    return {
      draw: Number(request.query.draw ?? 0),
      recordsTotal: data.total,
      recordsFiltered: data.total,
      data: data.items,
    };
  }
}

@BasePath('customers')
export class CustomersController extends BaseController {
  /** GET /customers                                   → { items, total }
   *  GET /customers?draw=3  x-data-transform: datatables → { draw, recordsTotal, recordsFiltered, data } */
  @Get('/')
  public list() {
    return new Ok({ items: [{ id: 1, name: 'ACME' }], total: 1 });
  }
}
```

### Default error transform: custom implementation

Replace the error body for every JSON error, for example with RFC 9457 problem details:

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { DefaultErrorTransform } from '@spinajs/http';
import * as express from 'express';

@Injectable()
export class ProblemDetailsTransform extends DefaultErrorTransform {
  public transform(data: any, request?: express.Request): any {
    const error = data ?? {};
    return {
      type: 'about:blank',
      title: error.message ?? 'Error',
      instance: request?.originalUrl?.split('?')[0],
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
}

// The list holds DefaultErrorTransform; resolving it now yields ProblemDetailsTransform.
DI.register(ProblemDetailsTransform).as(DefaultErrorTransform);
```

## Important behaviour

- The client picks the transformer. Never put access control in a transformer: a client can omit the header. `@spinajs/authz-http` uses `authz-fields` as an opt-in view, and filters on the input side with an [input filter](07-argument-input-filters.md).
- `x-error-transform` applies to every JSON answer with status 400 or above, including 404 and 500 from the error handler.
- `transform()` is synchronous; the result is sent at once.
- Two transformers with the same `Type`: the first in the list wins.
- `Array.ofType` drops `@NewInstance()` registrations: a transformer decorated `@NewInstance()` is never found.

## Best practices

- Name transformers after the client format (`datatables`, `mobile-v1`), not after the endpoint.
- Keep the default error transform returning `message`; the HTML error pages and clients rely on it.
- Declare the expected input type with `DataTransformer<TIn, TOut>`; a transformer receives the data of every endpoint the client calls with the header.

## Patterns and antipatterns

```ts
// Don't: a second route only to change the shape.
@Get('grid')
public grid() { /* same query, datatables shape */ }

// Do: one route, a transformer selected with x-data-transform.
@Get('/')
public list() { return new Ok({ items, total }); }
```

## Examples

### Hide internal ids from a partner integration

```ts sample
import { Injectable } from '@spinajs/di';
import { DataTransformer } from '@spinajs/http';

function withoutInternal(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutInternal);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_')).map(([key, v]) => [key, withoutInternal(v)]));
  }
  return value;
}

/** x-data-transform: partner — drops every field starting with "_". */
@Injectable(DataTransformer)
export class PartnerTransformer extends DataTransformer {
  public get Type(): string {
    return 'partner';
  }

  public transform(data: unknown): unknown {
    return withoutInternal(data);
  }
}
```

## Related

- [Responses](10-responses.md#content-negotiation): when the JSON branch runs.
- [Error handling](11-error-handling.md): the error body the error transform receives.
- [Argument input filters](07-argument-input-filters.md): the input-side counterpart.
- `@spinajs/authz-http`: `AuthzFieldTransformer`.
