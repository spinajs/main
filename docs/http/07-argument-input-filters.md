# Argument input filters

An `ArgInputFilter` sees every route argument value before it is validated and hydrated. It can return the value unchanged, return a rewritten value, or throw to refuse the request. Use it for rules that hold across all routes: strip fields a client must never write, normalise Unicode, refuse oversized nested objects. `@spinajs/authz-http` uses it to drop body fields a caller is not allowed to write.

## How it works

1. A route argument handler calls `RouteArgs.filterInput(value, parameter, route)`, directly or through `tryHydrateParam()`. Values that are `null` or `undefined` are not filtered.
2. `filterInput()` resolves `Array.ofType(ArgInputFilter)` on every call. With no filters registered it returns the value as is.
3. For a non-primitive parameter, a string holding a JSON object or array (a query object, a form field) is parsed first, so the filters see an object.
4. It calls each filter's `filter(input, parameter, route)` in registration order; each one receives the previous one's output. `filter()` may return a value or a `Promise`.
5. A value that was parsed from a JSON string is turned back into a string, so hydrators that parse their own input keep receiving text.
6. The result goes on to the required check, validation and hydration. A filter that removes a required value makes the required check fail.

Arguments that pass through the filters:

| Decorator | Filtered |
| --- | --- |
| `@Query`, `@Param`, `@Body`, `@Header`, `@Cookie` | yes, through `tryHydrateParam()` |
| `@BodyField`, `@FromXml`, `@JsonFile` | yes, through `filterInput()` |
| `@Form`, `@FormField`, `@CsvFile` (each row) | yes, through `tryHydrateParam()` |
| `@Req`, `@Res`, `@Ip`, `@RequestId`, `@UserAgent`, `@Referer`, `@RawBody`, `@FromDI`, `@File` | no |

`@spinajs/http-socket` runs the same filters on WebSocket payloads, with `route` undefined.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ArgInputFilter` (abstract) | `ArgInputFilter` list, `Array.ofType(ArgInputFilter)`, resolved on every filtered argument; each filter a singleton | none | `AuthzInputFieldFilter` (`@spinajs/authz-http`) | Add one with `@Injectable(ArgInputFilter)`. Remove one with `DI.unregister(TheirFilter)`. Replace one with `DI.register(Mine).as(TheirFilter)`. |

Members:

| Member | Meaning |
| --- | --- |
| `filter(input, parameter, route?)` | Abstract. Returns the value to validate and hydrate, sync or async. Throw to refuse. |

`parameter` tells you what is being filtered: `parameter.Type` is the `ParameterType` string (`FromBody`, `FromQuery`, ...), `parameter.Name` the argument name, `parameter.RuntimeType` the declared type. `route` is the `IRoute` (method, path, policies), or `undefined` from sockets.

### `ArgInputFilter`: custom implementation

Strip server-managed fields from every JSON body, at any depth, so a client cannot set them through any endpoint:

```ts sample
import { Injectable } from '@spinajs/di';
import { ArgInputFilter, IRoute, IRouteParameter, ParameterType } from '@spinajs/http';

const SERVER_MANAGED = new Set(['Id', 'CreatedAt', 'UpdatedAt', 'OwnerId']);
const BODY_TYPES = new Set<string>([ParameterType.FromBody, ParameterType.BodyField, ParameterType.FromForm]);

function strip(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(strip);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SERVER_MANAGED.has(key))
        .map(([key, v]) => [key, strip(v)]),
    );
  }
  return value;
}

@Injectable(ArgInputFilter)
export class ServerManagedFieldsFilter extends ArgInputFilter {
  public filter(input: unknown, parameter: IRouteParameter, _route?: IRoute): unknown {
    // Only bodies; an `Id` route parameter is legitimate.
    if (!BODY_TYPES.has(String(parameter.Type))) {
      return input;
    }
    return strip(input);
  }
}
```

The module must be imported before the first request. Filters run in import order; import order-sensitive filters explicitly.

## Important behaviour

- Filters run before validation. A `@Schema` with `additionalProperties: false` no longer fails on a field a filter removed.
- `Array.ofType` drops `@NewInstance()` registrations from its result: a filter decorated `@NewInstance()` never runs. Keep filters singletons.
- The list is resolved per argument, from the root container. Registering a filter at runtime affects the next request.
- A filter that throws `BadRequest` or `Forbidden` answers 400 or 403; any other error answers 500.
- A filter receives primitives (`string`, `number`) as they came: query and header values are strings even for `number` parameters.
- A filter's output of `null` or `undefined` makes the argument absent; with `{ required: true }` that fails validation.

## Best practices

- Check `parameter.Type` first and return early; most filters apply to bodies only.
- Return a new object instead of mutating `input`; `@BodyField()` hands `req.body` itself to the filters.
- Keep filters synchronous and cheap; they run once per argument per request.

## Patterns and antipatterns

```ts
// Don't: rejecting in a hydrator or in each action duplicates the rule and misses @BodyField and sockets.
@Post('/')
public create(@Body() order: OrderDto) {
  if ((order as any).OwnerId !== undefined) throw new Forbidden('OwnerId is server-managed');
  // ...
}

// Do: one filter for every route and socket handler.
@Injectable(ArgInputFilter)
export class ServerManagedFieldsFilter extends ArgInputFilter {
  public filter(input: unknown, parameter: IRouteParameter) {
    return parameter.Type === ParameterType.FromBody ? strip(input) : input;
  }
}
```

## Examples

### Refuse deeply nested JSON

```ts sample
import { Injectable } from '@spinajs/di';
import { BadRequest } from '@spinajs/exceptions';
import { ArgInputFilter, IRouteParameter } from '@spinajs/http';

const MAX_DEPTH = 8;

function depth(value: unknown): number {
  if (value === null || typeof value !== 'object') {
    return 0;
  }
  const children = Object.values(value as Record<string, unknown>);
  return 1 + (children.length ? Math.max(...children.map(depth)) : 0);
}

@Injectable(ArgInputFilter)
export class MaxDepthFilter extends ArgInputFilter {
  public filter(input: unknown, parameter: IRouteParameter): unknown {
    if (depth(input) > MAX_DEPTH) {
      throw new BadRequest(`${parameter.Name} is nested deeper than ${MAX_DEPTH} levels`);
    }
    return input;
  }
}
```

## Related

- [Route arguments](04-route-arguments.md#validation-and-conversion): where the filters run.
- [Argument hydrators](06-argument-hydrators.md): run after the filters.
- [Data transformers](12-data-transformers.md): the output-side counterpart.
- `@spinajs/authz-http`: `AuthzInputFieldFilter`.
- [`@spinajs/http-socket`](../http-socket/README.md): runs the filters on socket payloads.
