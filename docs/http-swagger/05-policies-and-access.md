# Policies and access

Routes guarded by `@Policy()` (`@spinajs/http`) or `@Access()` (`@spinajs/authz-http`) carry that information into the document: vendor extensions for tools, and readable lines in the operation description for people.

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

Both operations get `x-policies: ['OpeningHoursPolicy']`, the line ``- [`OpeningHoursPolicy`](#policy-openinghourspolicy) (controller) — Rejects calls outside the store's opening hours, 8:00 to 20:00 server time.``, and `info.description` gets the full JSDoc under `## Policies`.

## Related

- [Documenting routes](02-documenting-routes.md#responses): the standard `401` and `403` components.
- [Documentation cache](08-documentation-cache.md): where policy JSDoc is read.
- [Authorization](../authz/README.md): the `@spinajs/authz` model behind `@Access`.
