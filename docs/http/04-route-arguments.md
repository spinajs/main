# Route arguments

Parameter decorators tell a route where each action argument comes from: query string, URL parameter, body, header, cookie, the request itself, or the DI container. Before the action runs, each value is filtered, converted to the declared TypeScript type, validated against a JSON schema and, for classes, built into an instance.

File and form arguments (`@File`, `@Files`, `@CsvFile`, `@JsonFile`, `@Form`, `@FormField`) are on [File uploads](08-file-uploads.md). Writing your own decorator is on [Custom route arguments](05-custom-route-arguments.md).

## How it works

1. **At import**, each decorator calls `Route(Parameter(type, schema, options))`. `Parameter()` records an `IRouteParameter` on the route: index, `Type` (a `ParameterType` string), the runtime type from `design:paramtypes`, the schema, the options, and a default schema for `number`, `string` and `boolean` parameters.
2. **At startup**, `Controllers.register()` fills each parameter's `Name` from the [controller cache](21-controller-cache-and-cli.md).
3. **Per request**, `extractRouteArgs()` resolves one handler per parameter type with `DI.resolve(param.Type)` (once per type per request) and sorts the parameters by the handler's `Priority`, highest first. File arguments (`Priority` 9999) run first so the multipart body is parsed once.
4. Each handler's `extract()` reads the raw value and, for most decorators, calls `RouteArgs.tryHydrateParam()`, which converts and validates it (below).
5. A handler can pass data to the handlers after it through `IRouteCall.Payload`; the multipart parser shares the parsed form this way.
6. A parameter type with no registered handler throws `UnexpectedServerError` (500): `Route parameter not registered for parameter ...`.

### Validation and conversion

`RouteArgs.tryHydrateParam(arg, param, route)`:

1. A value that is not `null` or `undefined` goes through every [argument input filter](07-argument-input-filters.md).
2. With `{ required: true }` in the options, a missing value (`undefined`, `null`, `''`) throws `ValidationFailed` (400).
3. It picks one schema, first match wins:
   1. `route.Schema[paramName]`, from `@Get(path, { id: {...} })`;
   2. the schema given to the decorator (`@Query(schema)`);
   3. the default for the type: `number` accepts a number or a digit string, `string` has `maxLength: 512`, `boolean` accepts `true`, `false`, `0`, `1`;
   4. the schema `DataValidator.extractSchema()` finds on the runtime type (eg. `@Schema` from `@spinajs/validation`); for `@Type(Array.ofType(X))` an array of `X`'s schema.
4. **Primitive types** (`string`, `number`, `bigint`, `boolean`) are converted first, then validated:
   - `number`: `Number(value)`; `''` becomes `undefined`, `0` stays `0`;
   - `bigint`: `BigInt(value)`; a bad value throws `InvalidArgument` (400);
   - `boolean`: `true` for `true`, `1` or the string `'true'` in any case; otherwise `false`.
5. **Other types**:
   - with a [hydrator](06-argument-hydrators.md) on the type, the raw value is validated, then the hydrator builds the result;
   - `@Type(Array.ofType(X))`: a JSON string is parsed, the value must be an array (else `InvalidArgument`), each item becomes `new X(item)`, then the array is validated;
   - a class: `new Type(value)`, the value parsed from JSON first when it is a string, then the instance is validated;
   - `object` or `Array`: a JSON string is parsed; the result is validated.
   - Invalid JSON throws `InvalidArgument` (400): `Argument '<name>' is invalid JSON`.
6. `null` and `undefined` results are never validated: an absent optional argument stays `undefined`.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Query(schema?, options?)` | parameter | JSON schema; `{ required?: boolean }` | `req.query[name]`; a name starting with `_` falls back to the name without it. Converted and validated. |
| `@Param(schema?, options?)` | parameter | JSON schema; `{ required?: boolean }` | `req.params[name]`, same `_` fallback. Converted and validated. |
| `@Body(options?)` | parameter | `{ required?: boolean }` | `req.body[name]` when the body has that field; the whole body when the route has exactly one `@Body`; else `null`. Converted and validated. |
| `@BodyField()` | parameter | none | The whole `req.body`, through the input filters, without validation or hydration. |
| `@Header(key?, schema?, options?)` | parameter | header name (default: parameter name in lower case); JSON schema; `{ required?: boolean }` | `req.headers[key]`. Converted and validated. |
| `@Cookie(secure = false)` | parameter | `secure`: verify the signature | `req.cookies[name]`; see [Cookies](20-cookies.md). |
| `@FromXml(options?)` | parameter | `fast-xml-parser` `X2jOptions` | Parses an XML body (`application/xml`, `text/xml`, `*+xml`). `ignoreAttributes` is `false` unless you set it. Invalid XML throws `BadRequest` (400). |
| `@RawBody()` | parameter | none | `req.rawBody`: the exact JSON body bytes as a `Buffer`, for webhook signatures; `undefined` for other content types. |
| `@Ip()` | parameter | none | `req.storage.realIp`; see [Client IP](17-client-ip-and-trust-proxy.md). |
| `@RequestId()` | parameter | none | `req.storage.requestId`, the value of the `x-request-id` response header. |
| `@UserAgent()` | parameter | none | `User-Agent` header. |
| `@Referer()` | parameter | none | `Referer` header, or `Referrer`. |
| `@AcceptType()` | parameter | none | An `HttpAcceptHeaders` value from the `Accept` header; see [Route middlewares](14-route-middlewares.md#accepts). |
| `@FromDI()` | parameter | none | `container.resolve(<parameter type>)`: a service from the root container, per request. |
| `@Req()` | parameter | none | The Express request. |
| `@Res()` | parameter | none | The Express response. |
| `@PKey(type = ParameterType.FromParams)` | parameter | the parameter source | Number with schema `{ type: 'number', minimum: 0 }`. |
| `@Uuid(type = ParameterType.FromParams, version = UuidVersion.v4)` | parameter | the parameter source; version (recorded, not checked) | 36-character UUID string, hex pattern. |
| `@Type(type)` | parameter | a class or `Array.ofType(X)` | Overrides the runtime type, which TypeScript erases for arrays. Combine with another parameter decorator. |
| `@HeadersField()` | parameter | none | All headers, `req.headers`. |
| `@QueryField()` | parameter | none | The whole `req.query`. |
| `@ParamField()` | parameter | none | The whole `req.params`. |
| `@Model(type)` | parameter | model class | Records `ParameterType.FromModel`. **No package registers a `FromModel` handler**; use `@FromModel()` or `@AsModel()` from [`@spinajs/orm-http`](../orm-http/README.md). |

`@PKey` and `@Uuid` take the source as a `ParameterType`: `@PKey(ParameterType.FromQuery)` reads the query string.

### Parameter types

`ParameterType` values are the DI names of the handlers. Built-in handlers and their names:

| `ParameterType` | Value (DI name) | Handler class |
| --- | --- | --- |
| `FromQuery` | `FromQuery` | `FromQuery` |
| `FromParams` | `FromParams` | `FromParams` |
| `FromBody` | `FromBody` | `FromBody` |
| `BodyField` | `BodyFieldRouteArgs` | `BodyFieldRouteArgs` |
| `FromHeader` | `FromHeader` | `FromHeader` |
| `FromCookie` | `FromCookie` | `FromCookie` |
| `FromXml` | `FromXmlRouteArgs` | `FromXmlRouteArgs` |
| `RawBody`, `Ip`, `RequestId`, `UserAgent`, `Referer` | `RawBodyRouteArgs`, `IpRouteArgs`, `RequestIdRouteArgs`, `UserAgentRouteArgs`, `RefererRouteArgs` | same names |
| `RequestType` | `RequestTypeRouteArgs` | `RequestTypeRouteArgs` |
| `FromDi` | `FromDi` | `FromDi` |
| `Req`, `Res` | `ArgAsRequest`, `ArgAsResponse` | same names |
| `FromFile`, `FromCSV`, `FormField`, `FromForm` | `FromFile`, `FromCSV`, `FromFormField`, `FromForm` | same names |
| `QueryField`, `Headers`, `ParamField` | `QueryFieldRouteArgs`, `HeadersFieldRouteArgs`, `ParamFieldRouteArgs` | same names (the old `QueryFieldRouteArg`, `HeadersFieldRouteArg`, `ParamFieldRouteArg` exports are deprecated aliases) |
| `FromJSONFile` | `FromJSONFile` | `FromJSONFile` (the old `FromJsonFile` export is a deprecated alias) |
| `FromModel`, `FromSession`, `Other` | `FromModel`, `FromSession`, `Other` | none in this package |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.middlewares` | `express.RequestHandler[]` | includes `express.json`, `express.urlencoded`, `express.text` for XML | | The body parsers that fill `req.body` and `req.rawBody`; see [HTTP server](01-http-server.md#configuration). |
| `http.trustProxy` | see [Client IP](17-client-ip-and-trust-proxy.md) | `null` | | Decides what `@Ip()` returns. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Route argument handler | Its class name, which equals the `ParameterType` string; `@Injectable()`, singleton (file and form handlers `@NewInstance()`); resolved per request with `DI.resolve(name)` | the classes in the table above | `@spinajs/orm-http`, `@spinajs/intl-http`, `@spinajs/users-http`, `@spinajs/authz-http` add their own | See [Custom route arguments](05-custom-route-arguments.md). Replace one with `DI.register(Mine).as(FromQuery)`. |
| `DataValidator` | `@spinajs/validation`, autoinjected into every `RouteArgs` | `DataValidator` | | See [`@spinajs/validation`](../validation/README.md). |
| `ArgHydrator` | metadata on the type | `DateTimeHydrator` | | See [Argument hydrators](06-argument-hydrators.md). |
| `ArgInputFilter` | `ArgInputFilter` list | none | `AuthzInputFieldFilter` (`@spinajs/authz-http`) | See [Argument input filters](07-argument-input-filters.md). |

## Important behaviour

- Parameter names come from the compiled `.d.ts` (or the function source). Minifying controller code breaks name-based binding.
- A `string` parameter without your own schema is limited to 512 characters by the default schema.
- `@Body()` with one body parameter receives the whole body unless the body has a field with the parameter's name: `create(@Body() user: UserDto)` gets `req.body.user` when the client sends `{ "user": {...} }`, and `req.body` otherwise.
- A DTO class is built with `new Dto(value)`: its constructor receives the plain object and must copy what it needs.
- `@FromDI()` resolves from the **root** container on every request; the service's own lifetime decides whether it is shared.
- `@Header()` without a key reads the header named like the parameter in lower case: `@Header() authorization: string`.
- Validation errors throw `ValidationFailed`, answered as 400 by `ValidationError`; see [Error handling](11-error-handling.md).
- The action also receives `req`, `res` and `next` after the decorated arguments.

## Best practices

- Put a `@Schema` on DTO classes; every `@Body()`, `@Query()` and `@Form()` of that type is then validated with no extra code.
- Use `@Type(Array.ofType(Item))` for array arguments; without it TypeScript emits `Array` and items stay plain objects.
- Mark mandatory query and header values `{ required: true }`; without it a missing value is `undefined`, not an error.
- Prefer `@Ip()` over `req.ip`: `req.ip` follows Express's `trust proxy`, which this package leaves off.

## Patterns and antipatterns

```ts
// Don't: the element type is erased; items arrive as plain objects, unvalidated.
@Post('bulk')
public bulk(@Body() items: OrderLine[]) { /* ... */ }

// Do
@Post('bulk')
public bulk(@Body() @Type(Array.ofType(OrderLine)) items: OrderLine[]) { /* ... */ }
```

```ts
// Don't: the schema argument of @Query is the first one; this passes the options as a schema.
@Get('search')
public search(@Query({ required: true }) q: string) { /* ... */ }

// Do
@Get('search')
public search(@Query(null, { required: true }) q: string) { /* ... */ }
```

## Examples

### A search endpoint with validated input

```ts sample
import { Schema } from '@spinajs/validation';
import { BaseController, BasePath, Body, Get, Header, Ip, Ok, Param, PKey, Post, Query, RawBody, RequestId, Type, Uuid } from '@spinajs/http';

@Schema({
  type: 'object',
  properties: {
    sku: { type: 'string', minLength: 3 },
    quantity: { type: 'integer', minimum: 1 },
  },
  required: ['sku', 'quantity'],
})
export class OrderLine {
  public sku: string;
  public quantity: number;

  constructor(data: Partial<OrderLine>) {
    Object.assign(this, data);
  }
}

@BasePath('shop')
export class ShopController extends BaseController {
  /** GET /shop/products?q=lamp&page=2 */
  @Get('products', { page: { type: 'integer', minimum: 1, maximum: 100 } })
  public products(@Query(null, { required: true }) q: string, @Query() page?: number) {
    return new Ok({ q, page: page ?? 1 });
  }

  /** GET /shop/products/15 */
  @Get('products/:id')
  public product(@PKey() id: number) {
    return new Ok({ id });
  }

  /** GET /shop/carts/3b241101-e2bb-4255-8caf-4136c566a962 */
  @Get('carts/:cart')
  public cart(@Uuid() cart: string) {
    return new Ok({ cart });
  }

  /** POST /shop/orders  [{ "sku": "LMP-1", "quantity": 2 }] */
  @Post('orders')
  public order(@Body() @Type(Array.ofType(OrderLine)) lines: OrderLine[], @Ip() ip: string, @RequestId() requestId: string) {
    return new Ok({ lines: lines.length, ip, requestId });
  }

  /** POST /shop/webhooks/payment — signature over the exact received bytes. */
  @Post('webhooks/payment')
  public payment(@RawBody() raw: Buffer, @Header('x-signature', null, { required: true }) signature: string) {
    return new Ok({ bytes: raw?.length ?? 0, signature: signature.length > 0 });
  }

  /** GET /shop/orders/12/lines/3 */
  @Get('orders/:order/lines/:line')
  public line(@Param() order: number, @Param() line: number) {
    return new Ok({ order, line });
  }
}
```

## Related

- [Custom route arguments](05-custom-route-arguments.md): write a decorator of your own.
- [Argument hydrators](06-argument-hydrators.md) and [input filters](07-argument-input-filters.md): the two hooks inside `tryHydrateParam()`.
- [File uploads](08-file-uploads.md): multipart arguments.
- [`@spinajs/validation`](../validation/README.md): `@Schema` and `DataValidator`.
- [`@spinajs/orm-http`](../orm-http/README.md): route arguments that load models.
