# Resource extractors

A resource extractor tells `@Access` which object the request works on: `{ type: 'invoice', id: '42' }` from a URL parameter, a body field, a query parameter or a model. Without one, `@Access` checks the type-level ref of the permission (`{ type: 'invoice' }` for `invoice:read`), which answers "may this caller do this to some invoice".

## How it works

1. `@Access(permission, { resource })` stores the extractor in the rule. The shipped builders also attach an `ExtractorInfo` (`type`, `from`, `name`, `by`, `model`) to the function.
2. At boot, `AccessContributor` reads the declared type (`extractorType()`) and has the domain check that the permission applies to that type. A custom extractor without `typedExtractor`, and `fromModel`, declare no type; their permission is checked without one.
3. Per request, `AccessPolicy` calls `resource(req)` after the principal checks and awaits it.
4. A `null` or `undefined` result throws `InvalidArgument` (400, `fieldName: 'resource'`). The shipped builders throw `InvalidArgument` (400) themselves when the value is missing.
5. A `fromModel` result is an unloaded model instance. `AccessPolicy.refOf()` asks the domain's `ResourceAdapter`s for the first one whose `accepts(instance)` is true and checks the ref its `refOf(instance)` gives. No adapter: `AuthzConfigError` (500).
6. Any other result goes to `authz.check()` as the resource.
7. On a conditional allow for a ref with an id, unless the rule says `conditional: 'action'`, `AccessPolicy.load()` asks the first adapter of the domain that has `load()` and serves the ref's type for the row, then checks again with `subject: row`. No such adapter, or no row: the decision becomes a deny with reason `unknown_resource` (403). A type-level ref loads nothing and keeps its residual. The row is loaded once per request, whatever the number of permissions.

## Extractors

| Builder | Reads | Result | Declared type | 400 when |
| --- | --- | --- | --- | --- |
| `fromParam(param, type, { by? })` | `req.params[param]` | `{ type, id }` | `type` | the value is missing, empty or not a string or finite number |
| `fromBody(path, type)` | a dotted path of `req.body`, own properties only (`'project.id'`) | `{ type, id }` | `type` | same |
| `fromQuery(param, type)` | `req.query[param]` | `{ type, id }` | `type` | same |
| `fromModel(model, param)` | `req.params[param]` | an unloaded `model` instance with `PrimaryKeyValue` set | none (the ORM adapter knows it) | same |
| `typedExtractor(type, fn)` | whatever `fn` reads | what `fn` returns | `type` | `fn` returns `null` or `undefined` |

- A number becomes its string: `fromParam('id', 'invoice')` on `/invoices/42` gives `{ type: 'invoice', id: '42' }`.
- `by` in `fromParam` names the field of the resource the value identifies (e.g. `Uuid`). The ref still carries the value as `id`; `by` only shows in the OpenAPI document.
- `fromModel` needs an adapter that accepts the model, e.g. authz-orm's adapter for an `@AccessResource` model ([`@spinajs/authz-orm`](../authz-orm/README.md)).

`ResourceExtractor` is `(req: Request) => ResourceRef | object | Promise<ResourceRef | object>`. Return a `ResourceRef`, `GLOBAL` from `@spinajs/authz`, or an object an adapter of the domain recognises.

Helpers for code that reads extractors (boot checks, OpenAPI):

| Export | Returns |
| --- | --- |
| `extractorInfo(extractor)` | the `ExtractorInfo` a shipped builder or `typedExtractor` attached, or `undefined` |
| `extractorType(extractor)` | the declared `ResourceType`, or `undefined` for a custom extractor and `fromModel` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ResourceExtractor` | a plain function in `AccessOptions.resource`; no DI | the type-level ref of the permission | `fromParam`, `fromBody`, `fromQuery`, `fromModel`; `ownUser` (`@spinajs/users-http`), `TEAM` and `PARENT_TEAM` (`@spinajs/teams-http`) | Write a function; wrap it in `typedExtractor(type, fn)` so the boot and OpenAPI know its type. |
| `ResourceAdapter` (`@spinajs/authz`) | list in the domain's container, `Array.chainOf(ResourceAdapter)` | authz-orm's ORM adapter | your adapter | Read for `fromModel` (`accepts`, `refOf`) and the row of a conditional allow (`types`, `load`). See [`@spinajs/authz`](../authz/09-adapters-and-resolvers.md). |

### Custom extractor: the workspace from a header

Throw an http exception from the function to refuse the request with its status.

```ts sample
import { Access, typedExtractor } from '@spinajs/authz-http';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';

/** The workspace the client works in, named by the X-Workspace header. */
export const currentWorkspace = typedExtractor('workspace', (req: Request) => {
  const id = req.headers['x-workspace'];
  if (typeof id !== 'string' || id === '') {
    throw new InvalidArgument('the X-Workspace header names the workspace', 'X-Workspace');
  }
  return { type: 'workspace', id };
});

@BasePath('workspace')
export class WorkspaceSettingsController extends BaseController {
  @Get('settings')
  @Access('workspace:read', { resource: currentWorkspace })
  public settings() {
    return new Ok({ theme: 'light' });
  }
}
```

## Important behaviour

- Extractors run after the 401 checks and before any model, so an anonymous request on a guarded route never reaches your function.
- The engine never sees a `fromModel` instance: its default field values would read as a row. Only the adapter's ref is checked.
- `fromBody` reads own properties only: `'__proto__.id'` or an inherited key gives no value and a 400.
- An extractor runs once per `AccessPolicy`, so a class `@Access` and a route `@Access` with extractors each call their own.
- A conditional allow loads the row through the first adapter of the domain that serves the type, not through your action's query. Load the row again in the action when you need it.

## Best practices

- Prefer the shipped builders over custom functions: the boot and the OpenAPI document know their type.
- Use `fromModel` for `@AccessResource` models, so the ref type always matches the model's declaration.
- Use `GLOBAL` for "create at the top level" checks, as `PARENT_TEAM` in `@spinajs/teams-http` does for a root team.

## Patterns and antipatterns

```ts
// Don't: the action trusts the URL id while the check ran on the type level.
@Del(':id')
@Access('file:delete')
public remove(@Param() id: string) {}

// Do: check the file the route deletes.
@Del(':id')
@Access('file:delete', { resource: fromParam('id', 'file') })
public remove(@Param() id: string) {}
```

## Examples

### Approve an invoice the ORM declares as a resource

```ts sample
import { Access, fromModel } from '@spinajs/authz-http';
import { AccessResource } from '@spinajs/authz-orm';
import { BaseController, BasePath, Ok, Param, Post } from '@spinajs/http';
import { Model, ModelBase, Primary } from '@spinajs/orm';

@AccessResource('invoice')
@Model('invoices')
export class Invoice extends ModelBase<Invoice> {
  @Primary()
  public id!: number;

  public status!: string;
}

@BasePath('invoices')
export class InvoiceApprovalController extends BaseController {
  // The ORM adapter turns invoice <id> into its ref; an owner-only grant is settled on the row.
  @Post(':id/approve')
  @Access('invoice:approve', { resource: fromModel(Invoice, 'id') })
  public approve(@Param() id: number) {
    return new Ok({ id, status: 'approved' });
  }
}
```

## Related

- [Protecting routes](01-protecting-routes.md): where `resource` and `subject` are set.
- [Access metadata and OpenAPI](10-access-metadata-and-openapi.md): how `x-authz-resource` shows an extractor.
- [`@spinajs/authz-orm`](../authz-orm/README.md): `@AccessResource` and the ORM resource adapter.
- [`@spinajs/authz`](../authz/01-check-flow.md#concepts): resources, `GLOBAL` and conditional decisions.
