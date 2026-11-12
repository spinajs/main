# Policies and access

Routes guarded by `@Policy()` (`@spinajs/http`) or `@Access()` (`@spinajs/authz-http`) carry that information into the document: vendor extensions for tools, and readable lines in the operation description for people. The answers a route middleware gives instead of the route, such as the `429` of `@RateLimit`, are documented too.

## How it works

### Policies

1. `SwaggerDocCache.getCache()` reads the live controller's `Descriptor.Policies` (controller level) and each route's `Policies`. `.d.ts` files carry no decorators, so this comes from the runtime class.
2. Policy groups, one per `@Policy()` call, are flattened into one list of names: the class name, or the string given to `@Policy()`.
3. `DefaultControllerCache.getPolicyDocumentation()` reads the class-level JSDoc of each policy.
4. `OpenApiBuilder` sets `x-policies` to the controller policies followed by the route policies.
5. It appends a `**Policies applied:**` block to the operation description: one line per policy, linked to its anchor, marked `(controller)` when it comes only from the controller, followed by the first sentence of its JSDoc (at most 200 characters).
6. On first use of a policy it adds an entry to a `## Policies` section at the end of `info.description`: an anchor `policy-<name>`, the name, and the full JSDoc, or `_No description available — add JSDoc to the policy class._`.

### Access

1. `swaggerAccess()` reads the metadata `@Access`, `@AllowAnonymous`, `@Unscoped` and `@UnfilteredInput` store under `Symbol.for('authz:access')`. It does not import `@spinajs/authz-http`, so an app without authz still builds.
2. A route without its own `@Access` and without a class-level one gets nothing.
3. Otherwise the builder copies the `x-authz-*` fields onto the operation and appends one line, eg. ``**Access:** requires `invoice:read` on `invoice` (path `id`)``.
4. It adds `401` and `403` as `$ref`s to the standard responses, unless the JSDoc documents those codes.

### Route middlewares

1. The builder calls `documentation(route)` on every middleware mounted on the route (`BaseController.MountedMiddlewares(method)`, see [In API documents](../http/14-route-middlewares.md#in-api-documents)), in mount order: global, controller, route.
2. Each answer is added under its status, unless the JSDoc or `@Access` already set that status. Between middlewares the later one wins, so a route's own `@RateLimit` answers over its controller's.
3. An answer with a `component` is registered once under `components.responses` and referred to with a `$ref`. Any other answer is inline: its description, its `headers`, and a body from `schema` or from the named `type` (resolved like `@response 429 {AuthnError}`), under `contentType` (default `application/json`).
4. The `headers` a middleware sets on the route's own success answers go to the route's inline `2xx` responses. A `$ref` response is left alone.
5. Its `x-` extensions are copied onto the operation; any other key in `extensions` is dropped, so a middleware cannot set `parameters`, `requestBody` or `deprecated` this way. An array extension that two middlewares set is concatenated. A key the operation already has, such as `x-authz-domain` from `@Access`, keeps its value unless both values are arrays.
6. A middleware whose `documentation()` throws adds nothing to that route. The builder logs a warning on the `http-swagger` logger naming the middleware class and the route (e.g. `POST /reports/daily`), and documents the other middlewares and routes.

For `@RateLimit` this gives ([what it documents](../http/18-throttling.md#in-api-documents)):

- headers off (the default): `429` as a `$ref` to the shared `TooManyRequests` response, whose body is the `E_TOO_MANY_REQUESTS` error and whose only header is `Retry-After`;
- headers on: an inline `429` with `Retry-After` and `X-RateLimit-*`, `X-RateLimit-*` on the success answers, and `x-rate-limit`;
- a closed route (`limit: 0`): an inline `429` without `Retry-After`, with only `X-RateLimit-Limit` and `X-RateLimit-Remaining` when the headers are on, and no headers on the success answers ([closed routes](../http/18-throttling.md#in-api-documents));
- a custom `answer` marked with `documentedAnswer`: its own status and description; an unmarked one adds nothing;
- `@RateLimit({ config: false })`, or a configured `false`: nothing, since the middleware is not mounted.

The `429` of a limit with the headers on:

```json
{
  "429": {
    "description": "Too many requests",
    "headers": {
      "Retry-After": { "description": "Seconds until the limit lets a request through again", "schema": { "type": "integer" } },
      "X-RateLimit-Limit": { "description": "Requests allowed in the window", "schema": { "type": "integer" } },
      "X-RateLimit-Remaining": { "description": "Requests left in the current window", "schema": { "type": "integer" } },
      "X-RateLimit-Reset": { "description": "When the current window resets, in Unix seconds", "schema": { "type": "integer" } }
    },
    "content": { "application/json": { "schema": { "type": "object", "required": ["error"], "properties": { "error": { "type": "object" } } } } }
  }
}
```

The body schema above is cut short; the document carries the full `{ code, message }` object.

## Extensions

| Field | Type | Present when | Meaning |
| --- | --- | --- | --- |
| `x-policies` | `string[]` | any policy applies | Policy names, controller-level first |
| `x-authz-permission` | `string[]` | `@Access` on the route or class | Any of these permissions grants access: the route's own, else the class's |
| `x-authz-controller-permission` | `string[]` | both the route and the class have `@Access` | The class requirement, which must also pass |
| `x-authz-resource` | `{ type?, in?, name?, by?, model? }` | with `x-authz-permission` | Where the checked resource comes from: `in` is `path`, `body` or `query`. Without a resource extractor only `type` is set, from the permission's prefix (`invoice` for `invoice:read`). Empty for a custom extractor |
| `x-authz-domain` | `string` | the rule names a domain other than `root` | Domain the check runs in |
| `x-authz-anonymous` | `true` | `@AllowAnonymous` on the route or class | Anonymous callers pass authentication |
| `x-authz-unscoped` | `string` | `@Unscoped` on the route | The reason given |
| `x-authz-unfiltered-input` | `string` | `@UnfilteredInput` on the route or class | The reason given |
| `x-rate-limit` | `{ limit, windowSeconds, by? }[]` | a `@RateLimit` that sends `X-RateLimit-*` | The effective numbers of each such limit, controller first. `by` is left out when a `key` counts instead |

```json
{
  "x-authz-permission": ["test:update"],
  "x-authz-controller-permission": ["test:read"],
  "x-authz-resource": { "type": "test" },
  "description": "**Access:** requires `test:update` on `test`, and the controller requires `test:read`"
}
```

`@spinajs/authz-http` is work in progress. Its own `swaggerAccess()` returns the same fields; a snapshot test in this package keeps the two equal.

## Important behaviour

- The document lists which policies apply, not how they combine. Two `@Policy()` calls (OR between groups) and one call with two classes (AND) look the same.
- A policy on both the controller and the route appears twice in `x-policies`.
- Policy names are class names. Two policy classes with one name share one anchor and one description.
- Access lines and policy blocks are appended after the JSDoc description, access first.
- Middleware answers come from the running app: only a controller whose routes are mounted has them. A document built from the manifest (`system.manifest.mode`) has none, see [the OpenAPI builder](07-openapi-builder.md#important-behaviour).
- A `@response 429` in the JSDoc replaces the `429` of `@RateLimit` on that route, headers and all.

## Best practices

- Put a one-sentence summary first in every policy's JSDoc; that sentence is what each operation shows.
- Document `401` and `403` with `@response` when the default texts do not explain the refusal.

## Examples

### Show opening-hours rules in the docs

```ts sample
import { Forbidden } from '@spinajs/exceptions';
import { BaseController, BasePath, BasePolicy, Get, Ok, Policy, Post } from '@spinajs/http';

/**
 * Rejects calls outside the store's opening hours, 8:00 to 20:00 server time.
 * Use it on routes that change stock while staff are on site.
 */
export class OpeningHoursPolicy extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    const hour = new Date().getHours();
    if (hour < 8 || hour >= 20) {
      throw new Forbidden('The store is closed');
    }
  }
}

/**
 * Stock levels of the store.
 * @tags Stock
 */
@BasePath('stock')
@Policy(OpeningHoursPolicy)
export class StockController extends BaseController {
  /**
   * Current stock level of a product
   */
  @Get(':sku')
  public async level() {
    return new Ok({ level: 12 });
  }

  /**
   * Book a delivery into stock
   */
  @Post(':sku/deliveries')
  public async deliver() {
    return new Ok({ booked: true });
  }
}
```

Both operations get `x-policies: ['OpeningHoursPolicy']`, a **Policies applied:** list whose `OpeningHoursPolicy (controller)` entry links to the policy's section and gives the first sentence of its JSDoc ("Rejects calls outside the store's opening hours, 8:00 to 20:00 server time."), and `info.description` gets the full JSDoc under `## Policies`.

## Related

- [Documenting routes](02-documenting-routes.md#responses): the standard `401` and `403` components.
- [Documentation cache](08-documentation-cache.md): where policy JSDoc is read.
- [Authorization](../authz/README.md): the `@spinajs/authz` model behind `@Access`.
