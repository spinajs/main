# OpenAPI builder

`OpenApiBuilder` turns controllers and their documentation entries into one `IOpenApiDocument`. `SwaggerService` drives it; you can replace it to filter or reshape the document, or use it on its own to build a document from a chosen set of controllers.

## How it works

1. **Constructor** `new OpenApiBuilder(config: ISwaggerConfig)` starts the document:
   - `openapi: '3.0.3'`;
   - `info`: `title` (default `'API Documentation'`), `version` (default `'1.0.0'`), `description`;
   - `servers` from `config.servers`;
   - `components.securitySchemes` from `config.securitySchemes`, and `security` from `config.security`, when set;
   - empty `paths` and `tags`.
2. **`addController(controller, entry)`** documents one controller: its tag, then one operation per route, as described in [Documenting routes](02-documenting-routes.md), [Parameters and request bodies](03-parameters-and-request-bodies.md) and [Policies and access](05-policies-and-access.md). It registers components and standard responses as it meets them. It throws `InvalidArgument` for a path argument it cannot bind; routes added before the throw stay in the document.
3. **`build()`** copies the collected tags into `tags` and returns the document. It returns the same object on every call.

`config.basePath` is used as given; `SwaggerService` fills it from `http.controllers.route.prefix` before it creates the builder.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `OpenApiBuilder` | class `OpenApiBuilder`; no lifetime decorator, so a singleton; `SwaggerService.buildSpec()` resolves it with `DI.resolve(OpenApiBuilder, [config])` | `OpenApiBuilder` | none | Subclass, override `addController()` and `build()`, and `DI.register(Sub).as(OpenApiBuilder)` before the first build |
| `SchemaProvider` list | `@Autoinject(SchemaProvider)` on `protected SchemaProviders: SchemaProvider[]`, read on use | every `@Injectable(SchemaProvider)` class | see [Named schemas and schema providers](04-named-schemas-and-schema-providers.md#shipped-providers) | Register another provider |

The constructor takes the config as its only argument. `addController()` and `build()` are the only public methods; everything else is private, so a subclass shapes the document through these two.

### `OpenApiBuilder`: custom implementation

Replace the builder to leave out whole controllers, rename or sort tags, or add vendor extensions to every operation. Decorate the subclass `@NewInstance()`: each `buildSpec()` then gets a fresh builder with the current config, instead of the instance from the first build.

```ts sample
import { ClassInfo, DI, NewInstance } from '@spinajs/di';
import { BaseController } from '@spinajs/http';
import { IOpenApiDocument, ISwaggerCacheEntry, OpenApiBuilder } from '@spinajs/http-swagger';

/** Leaves out controllers tagged Internal and sorts what is left. */
@NewInstance()
export class PublicApiBuilder extends OpenApiBuilder {
  public addController(controller: ClassInfo<BaseController>, entry: ISwaggerCacheEntry): void {
    if (entry.classTags?.includes('Internal')) {
      return;
    }

    super.addController(controller, entry);
  }

  public build(): IOpenApiDocument {
    const document = super.build();

    document.tags = [...(document.tags ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    document.paths = Object.fromEntries(Object.entries(document.paths).sort(([a], [b]) => a.localeCompare(b)));

    for (const item of Object.values(document.paths)) {
      for (const operation of Object.values(item)) {
        operation.summary ??= operation.operationId;
      }
    }

    return document;
  }
}

// Before the first GET /docs/swagger.json.
DI.register(PublicApiBuilder).as(OpenApiBuilder);
```

## Important behaviour

- Without `@NewInstance()` on a replacement, the builder is cached on the first build. A later build after `SwaggerService.invalidate()` adds to the old document and ignores the new config.
- A second route with the same documented path and method overwrites the first in `paths`.
- `addController()` returns without doing anything for a controller with no runtime `Descriptor`.
- The builder writes into schema objects it receives from schema providers while it expands them.
- Named types resolve only through `SchemaProvider`s registered in DI, also when you create the builder with `new`.

## Best practices

- Filter in `addController()` rather than in `build()`: a skipped controller registers no components, so the document carries no unused schemas.
- Keep `operationId` stable. Client generators use it for method names, and it is derived from class and method names.

## Examples

### Build a partner document from selected controllers

```ts sample
import { writeFile } from 'fs/promises';
import { DI } from '@spinajs/di';
import { Controllers } from '@spinajs/http';
import { OpenApiBuilder, SwaggerDocCache } from '@spinajs/http-swagger';

const PARTNER_CONTROLLERS = new Set(['InvoiceController', 'PaymentController']);

// Run after the app booted (configuration, file systems, controllers).
export async function exportPartnerSpec(file: string) {
  const controllers = await DI.resolve(Controllers);
  const docCache = await DI.resolve(SwaggerDocCache);

  const builder = new OpenApiBuilder({
    enabled: true,
    title: 'Billing API for partners',
    version: '2.3.0',
    basePath: 'api',
    servers: [{ url: 'https://partners.example.com' }],
  });

  for (const controller of await controllers.Controllers) {
    if (PARTNER_CONTROLLERS.has(controller.name)) {
      builder.addController(controller, await docCache.getCache(controller));
    }
  }

  await writeFile(file, JSON.stringify(builder.build(), null, 2), 'utf8');
}
```

## Related

- [Swagger service](06-swagger-service.md): when and how the builder is resolved.
- [Named schemas and schema providers](04-named-schemas-and-schema-providers.md): the providers the builder asks.
- [Documentation cache](08-documentation-cache.md): the `ISwaggerCacheEntry` that `addController()` reads.
- [Lifetimes](../di/04-lifetimes.md): `@NewInstance()` and the default singleton.
