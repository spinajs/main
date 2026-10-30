# Route arguments

Parameter decorators tell a route where each action argument comes from: query string, URL parameter, body, header, cookie, the request itself, or the DI container. Before the action runs, each value is filtered, converted to the declared TypeScript type, validated against a JSON schema and, for classes, built into an instance.

File and form arguments (`@File`, `@Files`, `@CsvFile`, `@JsonFile`, `@Form`, `@FormField`) are on [File uploads](08-file-uploads.md). Raw bodies (`@RequestStream`, `@ContentDigest`) are on [Raw request bodies and digests](24-raw-body-and-digests.md). Writing your own decorator is on [Custom route arguments](05-custom-route-arguments.md).

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

   Without 1, 2 and 4, in manifest mode, the schema derived from the TypeScript type is checked too; see [Validation from the manifest](#validation-from-the-manifest).
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

Validation runs after the policies and the route middlewares' `onBefore`, right before the action. A failure throws `ValidationFailed`, which answers 400 unless an [`@OnError`](11-error-handling.md#route-error-handlers) handler with the `'arguments'` stage answers it differently, for example with the uniform 401 of a login route.

A schema whose `$id` starts with a `validation.strict.idPrefixes` entry (by default `authn.` and `authz.`) is validated without type coercion: `{ "login": 123 }` fails a `type: 'string'` field instead of becoming `"123"`. See [Validator options](../validation/02-validator-options.md#strict-schema-ids).

### Validation from the manifest

When the app runs with a manifest (`system.manifest.mode` `prefer` or `require`, decided by the configuration source), an argument without an explicit schema is validated against the JSON Schema the compiler derived from its TypeScript type. A DTO needs no `@Schema` that repeats its class:

```ts
export class CreateItem {
  public name: string;
  public count: number;
  public tags?: string[];
}

@Post()
public create(@Body() item: CreateItem) {} // { "name": "a", "count": "x" } answers 400
```

- **Precedence.** An explicit schema always wins and the derived one is then not used: `route.Schema[paramName]`, the decorator's schema, the class `@Schema` (a JSON Schema or a Standard Schema). Without one, the derived schema is checked; for `number`, `string` and `boolean` the default schema of the type is checked as well.
- **Which arguments.** `@Body()`, `@Query()`, `@Param()`, `@Header()`, `@Cookie()`, `@BodyField()`, `@QueryField()`, `@ParamField()` and `@HeadersField()`. Files, forms, models (`@FromModel`, `@AsModel`) and custom arguments are not. A type with a [hydrator](06-argument-hydrators.md) is not, since the hydrator reads its own wire format. Absent optional arguments are not validated, and a non-optional TypeScript parameter does not make an argument required: use `{ required: true }` for that.
- **What is checked.** The value as the client sent it, JSON-parsed, before `new Dto(value)` builds the instance; for primitives the converted value.
- **Coercion.** Query, path, header and cookie values arrive as strings, so they are coerced to the derived types (Ajv `coerceTypes: 'array'`): `?page=2` becomes `2`, `?ids=7` becomes `[7]`, and the handler receives the coerced values. A JSON body is never coerced: `{ "count": "2" }` fails a `number` field. A number converted to `NaN` (`?n=abc`) fails.
- **Closed objects.** Derived object schemas reject undeclared properties, except at the root of a whole request part: a whole body (`@Body()` as the only body argument, `@BodyField()`) and a whole query, path or header object (`@QueryField()`, `@ParamField()`, `@HeadersField()`) accept keys they do not declare, because other readers take them from the same place (other arguments, a reauth strategy reading `reauthPassword` from the body). Nested objects and a single body field (`@Body() first: A, @Body() second: B` reads `body.first` and `body.second`) stay closed. An undeclared root key still reaches `new Dto(value)`: copy only the declared fields in the constructor when that matters.
- **Never stricter than the runtime where the compiler could not see it.** A nested class whose explicit `@Schema` the compiler could not evaluate (`x-explicit: 'partial'`) accepts anything, and so does a model from a dependency package (an open object). The intersection `A & B` of two closed objects is checked as one closed object with the properties of both.
- **Errors.** A failure throws `ValidationFailed`, answered as the usual 400 `application/problem+json`; the errors name the path and the rule, never the value.
- **Startup.** Every derived schema is compiled once, when the controller registers its routes. One that cannot compile (an unresolved `$ref`) fails the boot in `require` and leaves that argument unchecked, with a warning, in `prefer`. An argument whose index, kind or name disagrees with the manifest (a stale build) is not checked. In `off` mode, or without a manifest, nothing changes.

### Body size limits

The default body parsers of `http.middlewares` accept JSON and XML bodies up to 5mb and urlencoded bodies up to 100kb (the Express default; that parser sets no limit). `http.bodyLimits` sets a smaller limit under a path prefix:

```ts
// config/http.ts in your app
export default {
  http: {
    bodyLimits: [
      { path: '/auth/passkeys', limit: '96kb' },
      { path: '/auth', limit: '16kb' },
    ],
  },
};
```

- A rule matches the path the client requests, on a segment boundary and case-insensitively: `/auth` covers `/auth` and `/auth/login`, not `/authority`. Include `http.controllers.route.prefix` in the path when the app sets one. A controller with `@BasePath({ config, default })` is matched at its configured path, the one it is served at.
- Rules are checked in order and the first match wins, so list the more specific paths first. Other paths keep the limits of the `http.middlewares` parsers.
- The limit gate runs before `http.middlewares`. On a matching path it parses JSON, urlencoded and XML text bodies itself with the rule's limit, sets `req.rawBody` for JSON like the default parser, and the `http.middlewares` parsers then skip the body. A `verify` hook of your own JSON parser does not run on these paths.
- A declared `Content-Length` over the limit answers 413 for any content type, before the body is read. A body that turns out larger while it is read answers 413 too (`EntityTooLargeException`).
- The gate runs before routing, so a 413 never reaches `@OnError`.
- A `limit` that is not a size throws `InvalidOption` when `HttpServer` resolves.

`HttpServer` builds the gate with the exported `createBodyLimitMiddleware(rules)`, which returns an Express handler, or `null` for an empty list. `IBodyLimitRule` is the rule type (`{ path: string; limit: string }`). `parseBodyLimit(limit)` turns `512b`, `16kb`, `1.5mb` or `1gb` (any case, `b` when there is no unit, 1kb = 1024 bytes) into bytes and throws `InvalidOption` for anything else.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Query(schema?, options?)` | parameter | JSON schema; `{ required?: boolean }` | `req.query[name]`; a name starting with `_` falls back to the name without it. Converted and validated. |
| `@Param(schema?, options?)` | parameter | JSON schema; `{ required?: boolean }` | `req.params[name]`, same `_` fallback. Converted and validated. |
| `@Body(options?)` | parameter | `{ required?: boolean; sensitive?: string[] }` | `req.body[name]` when the body has that field; the whole body when the route has exactly one `@Body`; else `null`. Converted and validated. |
| `@BodyField()` | parameter | none | The whole `req.body`, through the input filters, without validation or hydration. |
| `@Header(key?, schema?, options?)` | parameter | header name in any case (default: the parameter name); JSON schema; `IHeaderArgOptions`: `{ required?, once?, maxLength?, pattern? }` | `req.headers[key]`, looked up in lower case. Converted and validated. With `once`, `maxLength` or `pattern`, a header the client sent that fails them answers 400; see [Strict headers](#strict-headers). |
| `@Cookie(secure = false)` | parameter | `secure`: verify the signature | `req.cookies[name]`; see [Cookies](20-cookies.md). |
| `@FromXml(options?)` | parameter | `fast-xml-parser` `X2jOptions` | Parses an XML body (`application/xml`, `text/xml`, `*+xml`). `ignoreAttributes` is `false` unless you set it. Invalid XML throws `BadRequest` (400). |
| `@RawBody()` | parameter | none | `req.rawBody`: the exact JSON body bytes as a `Buffer`, for webhook signatures; `undefined` for other content types. |
| `@RequestStream(options?)` | parameter | `{ maxBytes?: number }` | The unparsed body as a stream, capped at `maxBytes` (413 past it); 415 when a body parser took the body. See [Raw request bodies and digests](24-raw-body-and-digests.md). |
| `@ContentDigest(options?)` | parameter | `{ required?: boolean; algorithms?: string[] }` | The RFC 9530 `Content-Digest` header as `Map<algorithm, Buffer>`; 400 when malformed, or absent while `required`. See [Raw request bodies and digests](24-raw-body-and-digests.md). |
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

### Strict headers

`@Header(key, schema, { once, maxLength, pattern })` reads the header with [`strictHeaderReader`](22-header-and-cookie-helpers.md#reading-an-untrusted-header):

| Option | Refuses |
| --- | --- |
| `once: true` | A header sent on more than one line, whichever way Node folded it. |
| `maxLength` | A longer value. Implies `once`. |
| `pattern` | A value the pattern does not match in full. Implies `once`. It must start with `^`, end with `$` and have no `g`, `y` or `m` flag. |

- A refused header throws `ValidationFailed` (400) naming the header and the rules, never the value. An absent header is `undefined`, and `required: true` refuses it.
- A bad `maxLength` or `pattern`, or `once: false` together with either, throws `TypeError` when the decorator runs, so the controller fails to load instead of the first request.
- The value then goes through the schema, the conversion and the hydrator as before.
- Keep `pattern` free of nested or overlapping quantifiers: `maxLength` bounds the input, not the time a backtracking pattern takes.

```ts sample
import { BaseController, BasePath, Get, Header, Ok } from '@spinajs/http';

@BasePath('tenants')
export class TenantController extends BaseController {
  /** GET /tenants/current with `X-Tenant: acme-eu`, set once by the gateway */
  @Get('current')
  public current(@Header('x-tenant', null, { required: true, maxLength: 32, pattern: /^[a-z0-9-]{1,32}$/ }) tenant: string) {
    return new Ok({ tenant });
  }
}
```

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
| none (string types) | `RequestStreamArg`, `ContentDigestArg` | same names |
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
| `http.bodyLimits` | `{ path: string; limit: string }[]` | `[]` | `limit` as `512b`, `16kb`, `1.5mb`, `1gb` | Per-path body limits applied before `http.middlewares`; the first prefix match wins. See [Body size limits](#body-size-limits). |
| `validation.strict.idPrefixes` | `string[]` | `['authn.', 'authz.']` | | Schema `$id` prefixes validated without type coercion. |

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
- `@Body({ sensitive: ['reauthPassword'] })`: once the argument holds its value (or failed validation), the named fields are deleted from `req.body` and `req.rawBody` is dropped, so no later reader of the request, a log or another argument, gets them. An untyped body argument, which is `req.body` itself, receives a copy that keeps them.
- `@FromDI()` resolves from the **root** container on every request; the service's own lifetime decides whether it is shared.
- `@Header()` without a key reads the header named like the parameter in lower case: `@Header() authorization: string`.
- `@Header()` without `once`, `maxLength` or `pattern` gives the value as Node folded it: a repeated header joined with `, `, or only the first copy of `Authorization`, `Host` and a few others. The next major makes `once` the default.
- Validation errors throw `ValidationFailed`, answered as 400 by `ValidationError`; see [Error handling](11-error-handling.md). An action cannot catch it, because it is thrown before the action runs; use `@OnError` with `stages: ['arguments']`.
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
