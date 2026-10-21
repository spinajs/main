# `@spinajs/http`

The HTTP server and controller framework of SpinaJS, built on Express 5. You write controller classes with decorators; the package discovers them, builds their routes, extracts and validates arguments, runs policies and middlewares, and turns the returned response object (or a thrown exception) into an HTTP answer in JSON, HTML or XML.

Every moving part is a DI service or an abstract class: controller discovery, route arguments, hydrators, input filters, upload middlewares and uploaders, responses, the error map, data transformers, policies, route and server middlewares, the throttle store and the controller cache. Each page below has a "Services and extension points" section that shows how to replace or extend it.

It does **not** authenticate users or check permissions by itself: it gives you `BasePolicy` and `ServerMiddleware` to plug them in. Session, login and role policies live in `@spinajs/authn-http` and `@spinajs/authz-http`. It does **not** generate OpenAPI documents; [`@spinajs/http-swagger`](../http-swagger/README.md) reads this package's controller cache for that.

## Install

```sh
npm install @spinajs/http
```

The decorators read TypeScript metadata. Set `experimentalDecorators`, `emitDecoratorMetadata` and `useDefineForClassFields: false` in `tsconfig.json`, as for [`@spinajs/di`](../di/README.md#install).

## Features

| Feature | What it does |
| --- | --- |
| [HTTP server](01-http-server.md) | `HttpServer`: Express app, HTTP or HTTPS listener, start and graceful stop, lifecycle events, static files, the full `http.*` configuration |
| [Controllers and routing](02-controllers-and-routing.md) | `BaseController`, `@BasePath`, `@Get` and the other route decorators, path rules, the `Controllers` loader, overriding a package controller, startup exceptions |
| [Controller discovery](03-controller-discovery.md) | `ControllerSource`: filesystem scan, DI registry, your own source; `Controllers.add()` at runtime |
| [Route arguments](04-route-arguments.md) | `@Query`, `@Param`, `@Body`, `@Header`, `@Cookie`, `@Ip` and the rest; how values are converted, validated and hydrated |
| [Custom route arguments](05-custom-route-arguments.md) | Write a `RouteArgs` class and its decorator, or replace a built-in one |
| [Argument hydrators](06-argument-hydrators.md) | `ArgHydrator`, `@Hydrator`, `DateTimeHydrator`: build a domain object from a raw argument |
| [Argument input filters](07-argument-input-filters.md) | `ArgInputFilter`: inspect, rewrite or reject every argument before validation |
| [File uploads](08-file-uploads.md) | `@File`, `@Files`, `@CsvFile`, `@JsonFile`, `@Form`, `@FormField`; the upload flow and its options |
| [Upload middlewares and uploaders](09-upload-middlewares-and-uploaders.md) | `FileUploadMiddleware` (info, validation, zip, unzip) and `FormFileUploader`: transform, validate and store uploaded files |
| [Responses](10-responses.md) | `Ok`, `NotFound`, `Json`, `Xml`, `FileResponse`, `TemplateResponse`, `Redirect` and the rest; content negotiation; writing your own response |
| [Error handling](11-error-handling.md) | How a thrown exception becomes a response; `@HandleException` and the error map; 404 for unmatched routes |
| [Data transformers](12-data-transformers.md) | `DataTransformer`: reshape a JSON answer on request with `x-data-transform` and `x-error-transform` |
| [Policies](13-policies.md) | `BasePolicy`, `@Policy`: AND groups, OR alternatives, controller and route scopes, policies named in configuration |
| [Route middlewares](14-route-middlewares.md) | `RouteMiddleware`, `@Middleware`, `@Accepts`: code around one route or controller |
| [Server middlewares](15-server-middlewares.md) | `ServerMiddleware` and `Order`: the global Express stack, the shipped middlewares, adding or replacing one |
| [CORS](16-cors.md) | `CorsMiddleware`: allowed origins, credentials, preflight, header lists |
| [Client IP and trusted proxies](17-client-ip-and-trust-proxy.md) | `RealIp`, `http.trustProxy`, `parseTrustProxy`, `parseTrustProxyOverride`, `requestProxyTrust`, `trustedClientAddress`, `requestOrigin` |
| [Throttling](18-throttling.md) | `ThrottleMiddleware` and the `ThrottleStore` seam: per-IP, per-path rate limits |
| [Request storage and tracing](19-request-storage-and-tracing.md) | `req.storage`, `AsyncLocalStorage`, request id and `traceparent`, access log, timing headers, slow-request warnings, perf rollups |
| [Cookies](20-cookies.md) | Signed cookies, `http.cookie.*`, `@Cookie`, setting cookies on a response |
| [Controller cache and CLI](21-controller-cache-and-cli.md) | `DefaultControllerCache`, JSDoc tag extractors, `spinajs http:controllers:cache` |
| [CSRF guard](23-csrf-guard.md) | `CsrfGuard`, `@CsrfExempt()`, `http.csrf.*`: default-deny CSRF protection by `Origin` and `Sec-Fetch-Site` |
| [Same-origin guard](22-same-origin-guard.md) | `checkSameOrigin`, `SameOriginGuard`: refuse cross-origin state-changing requests by `Origin` and `Sec-Fetch-Site` |
| [Header and cookie helpers](22-header-and-cookie-helpers.md) | `parseBearer`, `normalizeHeaders`, `parseCookieHeader`, `basicAuthHeader`, `retryAfterHeader`, `hostPrefixedCookie`, `clearCookie`, `isPublicCookieSecret`, `parseCidr`, `cidrMatcher` |

## Quick start

A controller with three routes, then the application entry that boots the container and starts the server.

```ts sample
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { BaseController, BasePath, Body, Controllers, Created, Get, HttpServer, NotFound, Ok, Param, Post, Query } from '@spinajs/http';

class CreateUserDto {
  public name: string;

  constructor(data: Partial<CreateUserDto>) {
    Object.assign(this, data);
  }
}

@BasePath('users')
export class UsersController extends BaseController {
  /** GET /users?page=1 */
  @Get('/')
  public list(@Query() page?: number) {
    return new Ok({ page: page ?? 1, items: [{ id: 1, name: 'John' }] });
  }

  /** GET /users/42 */
  @Get(':id')
  public get(@Param() id: number) {
    if (id !== 42) {
      return new NotFound({ message: 'no such user' });
    }
    return new Ok({ id, name: 'John' });
  }

  /** POST /users  { "name": "Alice" } */
  @Post('/')
  public create(@Body() user: CreateUserDto) {
    return new Created(user);
  }
}

// Application entry.
async function main() {
  for (const bootstrapper of DI.resolve(Array.ofType(Bootstrapper))) {
    await bootstrapper.bootstrap();
  }
  await DI.resolve(Configuration);
  await DI.resolve(fsService);
  await DI.resolve(Controllers);

  const server = await DI.resolve(HttpServer);
  await server.start();
}

void main();
```

Controllers in the directories listed in `system.dirs.controllers` are found and mounted on their own; `UsersController` above is a controller declared next to the entry for brevity.

## Related packages

- [`@spinajs/di`](../di/README.md): every service on these pages is registered, resolved and replaced here.
- [`@spinajs/configuration`](../configuration/README.md): the `http.*` keys and the `http.configuration` schema.
- [`@spinajs/validation`](../validation/README.md): `DataValidator` and `@Schema`, used to validate route arguments.
- [`@spinajs/exceptions`](../exceptions/README.md): the exceptions mapped to HTTP statuses; see [HTTP error mapping](../exceptions/03-http-error-mapping.md).
- [`@spinajs/fs`](../fs/README.md): file providers for uploads, file responses, response templates and the controller cache.
- [`@spinajs/templates`](../templates/README.md) and [`@spinajs/templates-pug`](../templates-pug/README.md): HTML rendering of responses and error pages.
- [`@spinajs/log`](../log/README.md): the `http` and `http.access` loggers, trace context and perf rollups.
- [`@spinajs/orm-http`](../orm-http/README.md): `@FromModel`, `@AsModel`, filtering and ORM-aware responses on top of these route arguments.
- [`@spinajs/http-swagger`](../http-swagger/README.md): OpenAPI documents built from the controller cache.
- [`@spinajs/http-lazy-file-uploader`](../http-lazy-file-uploader/README.md): an uploader that moves files to their target storage in a background job.
- [`@spinajs/intl-http`](../intl-http/README.md): the `@Lang()` route argument and the language middleware.
- [`@spinajs/http-socket`](../http-socket/README.md): WebSocket handlers that reuse `ArgInputFilter`.
