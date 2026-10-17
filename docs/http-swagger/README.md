# `@spinajs/http-swagger`

Builds an OpenAPI 3.0.3 document from the loaded `@spinajs/http` controllers and serves it with a Swagger UI page. It reads route decorators at runtime and JSDoc from each controller's `.d.ts` file.

It does **not** generate controllers, clients or validation. It describes what the routes already do; a route the builder cannot describe unambiguously fails the whole build instead of being skipped.

## Install

```sh
npm install @spinajs/http-swagger
```

Installing the package is enough: `@spinajs/configuration` loads its config file from `node_modules/@spinajs/http-swagger`. That file adds `SwaggerController` to `system.dirs.controllers`, the `http:swagger:cache` command to `system.dirs.cli`, two static routes and two file providers.

## Features

| Feature | What it does |
| --- | --- |
| [Spec and UI endpoints](01-spec-and-ui-endpoints.md) | `GET /docs/swagger.json`, the Swagger UI page, `http.swagger` config, custom templates and custom docs controllers |
| [Documenting routes](02-documenting-routes.md) | JSDoc tags read per route, paths, operation ids, responses, examples, security, file downloads |
| [Parameters and request bodies](03-parameters-and-request-bodies.md) | Which decorator lands where, strict path placeholders, JSON and multipart bodies, `orm-http` arguments |
| [Named schemas and schema providers](04-named-schemas-and-schema-providers.md) | How type names become `components.schemas`, request and response flavours, custom `SchemaProvider` |
| [Policies and access](05-policies-and-access.md) | `x-policies`, the Policies section, `x-authz-*` extensions |
| [Swagger service](06-swagger-service.md) | `SwaggerService`: build, cache, invalidate, failure; replacing and extending it |
| [OpenAPI builder](07-openapi-builder.md) | `OpenApiBuilder`: standalone use, replacing and extending it |
| [Documentation cache](08-documentation-cache.md) | `SwaggerDocCache`, custom JSDoc tags, the `http:swagger:cache` command |

## Quick start

```ts sample
import { DI } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok, Param } from '@spinajs/http';
import { SwaggerService } from '@spinajs/http-swagger';

/**
 * Orders placed by customers.
 * @tags Orders
 */
@BasePath('orders')
export class OrderController extends BaseController {
  /**
   * Get one order
   * Returns the order with all its lines.
   * @param id Order number
   * @response 404 Order not found
   */
  @Get(':id')
  public async getOrder(@Param() id: number) {
    return new Ok({ id, lines: [] });
  }
}

// After the HTTP server started: the same document GET /docs/swagger.json returns.
export async function printDocumentedPaths() {
  const swagger = await DI.resolve(SwaggerService);
  const spec = await swagger.getSpec();
  console.log(Object.keys(spec?.paths ?? {}));
}
```

Open `/docs/` for Swagger UI. Compile controllers with `declaration: true` and without `removeComments`: the JSDoc is read from the `.d.ts` files; see [Documentation cache](08-documentation-cache.md).

## Related packages

- [`@spinajs/di`](../di/README.md): every service here is a DI singleton you can replace with `DI.register(...).as(...)`.
- [`@spinajs/configuration`](../configuration/README.md): the `http.swagger` keys and how package config files merge with the app config.
- [`@spinajs/orm`](../orm/11-json-schema.md): `ModelSchemaProvider` turns model names into component schemas.
- [`@spinajs/orm-http`](../orm-http/README.md): `@FromModel`, `@Filter` and DTO `@Relation` are documented with their real wire shape.
- [`@spinajs/fs`](../fs/README.md): the `__fs_swagger_views__` provider serves the UI template.
- [`@spinajs/cli`](../cli/README.md): runs the `http:swagger:cache` command.
- `@spinajs/http`: controllers, route decorators and `DefaultControllerCache`, which parses the JSDoc.
- `@spinajs/validation`: `SchemaProvider` and `@Schema`, the source of named schemas.
