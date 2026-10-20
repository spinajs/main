# Access metadata and OpenAPI

`@Access`, `@AllowAnonymous`, `@Unscoped` and `@UnfilteredInput` write what they declare into one access descriptor per controller class. `AccessPolicy`, the boot check and the OpenAPI document all read that descriptor, so they always agree. Read it yourself to list the guarded routes of an app, or to decide an `@Access`-shaped rule that comes from configuration.

## How it works

1. Each decorator calls `ownAccessDescriptor(target)`, which gives the class its own copy of the inherited descriptor, stored as metadata under `ACCESS_DESCRIPTOR` (`Symbol.for('authz:access')`) on the prototype. A parent controller's descriptor is never changed by a subclass.
2. Keys are route method names, or `ACCESS_CLASS` (`Symbol.for('authz:access:class')`) for class-level declarations.
3. `accessDescriptorOf(controllerClassOrInstance)` returns the nearest descriptor, or `undefined` when no decorator ran on the class or its parents.
4. `swaggerAccess(controller, method)` turns the descriptor of one route into the `x-authz-*` OpenAPI vendor extensions, or `undefined` for a route no `@Access` guards.

`IAccessDescriptor`:

| Member | Type | Holds |
| --- | --- | --- |
| `Access` | `Map<AccessKey, IAccessRule>` | `{ permissions, options }` of each `@Access` |
| `Anonymous` | `Map<AccessKey, true>` | `@AllowAnonymous` |
| `Unscoped` | `Map<AccessKey, string>` | `@Unscoped` reasons |
| `UnfilteredInput` | `Map<AccessKey, string>` | `@UnfilteredInput` reasons |

`SwaggerAccess` (what `swaggerAccess()` returns):

| Field | Present when | Value |
| --- | --- | --- |
| `x-authz-permission` | always | the deciding rule's permissions (the route's own, else the class's); any of them grants |
| `x-authz-controller-permission` | both the route and the class have `@Access` | the class permissions, which must pass too |
| `x-authz-resource` | always | `{ type?, in?, name?, by?, model? }`: `in` is `path`, `body` or `query`; `fromModel` gives `{ in: 'path', name, model }`; no extractor gives `{ type }` from the permission; a custom untyped extractor gives `{}` |
| `x-authz-domain` | the rule names a domain other than `root` | the domain |
| `x-authz-anonymous` | `@AllowAnonymous` on the route or class | `true` |
| `x-authz-unscoped` | `@Unscoped` on the route | the reason |
| `x-authz-unfiltered-input` | `@UnfilteredInput` on the route or class | the reason |

`@spinajs/http-swagger` reads the same metadata under `Symbol.for('authz:access')` without importing this package, and writes these fields and a readable "Access" line into each operation ([Policies and access in http-swagger](../http-swagger/05-policies-and-access.md)).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Access descriptor | metadata `ACCESS_DESCRIPTOR` on the controller prototype; no DI | written by the decorators | `TelemetryAccessPolicy` (`@spinajs/telemetry`) builds one by hand for a rule read from configuration | Write a descriptor on a holder object with `Reflect.defineMetadata(ACCESS_DESCRIPTOR, descriptor, holder)` and pass the holder to `AccessPolicy.execute()` as the controller. |
| `swaggerAccess(controller, method)` | exported function | | http-swagger's own reader | Call it to build your own API listings. |

## Important behaviour

- **A subclass owns a copy.** Redeclaring a route or the class rule in a subclass replaces that entry in the copy; the parent keeps its own.
- **A subclass without decorators reads the parent's descriptor** through `accessDescriptorOf`.
- **No decorator, no rule.** There is no default permission: a controller without `@Access` has no descriptor entry and no `AccessPolicy`.

## Examples

### List the guarded routes of a controller

```ts sample
import { ACCESS_CLASS, Access, accessDescriptorOf, fromParam, swaggerAccess } from '@spinajs/authz-http';
import { BaseController, BasePath, Get, Ok, Param } from '@spinajs/http';

@BasePath('reports')
@Access('report:read')
export class ReportsController extends BaseController {
  @Get(':id')
  @Access('report:read', { resource: fromParam('id', 'report') })
  public get(@Param() id: string) {
    return new Ok({ id });
  }
}

/** Prints one line per route rule, for a security review. */
export function printAccessRules(): void {
  const descriptor = accessDescriptorOf(ReportsController);
  for (const [key, rule] of descriptor?.Access ?? []) {
    const where = key === ACCESS_CLASS ? 'class' : String(key);
    console.log(`${where}: ${rule.permissions.join(' | ')}`);
  }
  console.log(JSON.stringify(swaggerAccess(ReportsController, 'get')));
}
```

## Related

- [Protecting routes](01-protecting-routes.md): the decorators that write the descriptor.
- [Policies and access in http-swagger](../http-swagger/05-policies-and-access.md): how the OpenAPI document shows it.
- [Resource extractors](02-resource-extractors.md): what `x-authz-resource` describes.
