# `@spinajs/http`

The HTTP server and controller framework of SpinaJS, built on Express 5. You write controller classes with decorators; the package discovers them, builds their routes, extracts and validates arguments, runs policies and middlewares, and turns the returned response object (or a thrown exception) into an HTTP answer in JSON, HTML or XML.

Every moving part is a DI service or an abstract class: controller discovery, route arguments, hydrators, input filters, upload middlewares and uploaders, responses, the error map, data transformers, policies, route and server middlewares, the throttle store and the controller cache. Each page below has a "Services and extension points" section that shows how to replace or extend it.

It does **not** authenticate users or check permissions by itself: it gives you `BasePolicy` and `ServerMiddleware` to plug them in. Session, login and role policies live in `@spinajs/authn-http` and `@spinajs/authz-http`. It does **not** generate OpenAPI documents; [`@spinajs/http-swagger`](../http-swagger/README.md) reads this package's controller cache for that.

## Install

```sh
npm install @spinajs/http
```

The decorators read TypeScript metadata. Set `experimentalDecorators`, `emitDecoratorMetadata` and `useDefineForClassFields: false` in `tsconfig.json`, as for [`@spinajs/di`](../di/README.md#install). An app that boots from a manifest can drop `emitDecoratorMetadata`: argument types then come from the manifest ([Building without decorator metadata](../manifest/README.md#building-without-decorator-metadata)). With no manifest to answer, the app logs a named error for each untyped argument at boot.

## Features

| Feature | What it does |
| --- | --- |
| [HTTP server](01-http-server.md) | `HttpServer`: Express app, HTTP or HTTPS listener, start and graceful stop, lifecycle events, static files, the full `http.*` configuration |
| [Controllers and routing](02-controllers-and-routing.md) | `BaseController`, `@BasePath`, `@Get` and the other route decorators, path rules, the `Controllers` loader, overriding a package controller, startup exceptions |
| [Controller discovery](03-controller-discovery.md) | `ControllerSource`: filesystem scan, DI registry, your own source; `Controllers.add()` at runtime |
| [Route arguments](04-route-arguments.md) | `@Query`, `@Param`, `@Body`, `@Header`, `@Cookie`, `@Ip` and the rest; how values are converted, validated and hydrated; per-path body limits (`http.bodyLimits`); `@Body({ sensitive })` |
| [Custom route arguments](05-custom-route-arguments.md) | Write a `RouteArgs` class and its decorator, or replace a built-in one |
| [Argument hydrators](06-argument-hydrators.md) | `ArgHydrator`, `@Hydrator`, `DateTimeHydrator`: build a domain object from a raw argument |
| [Argument input filters](07-argument-input-filters.md) | `ArgInputFilter`: inspect, rewrite or reject every argument before validation |
| [File uploads](08-file-uploads.md) | `@File`, `@Files`, `@CsvFile`, `@JsonFile`, `@Form`, `@FormField`; the upload flow and its options |
| [Upload middlewares and uploaders](09-upload-middlewares-and-uploaders.md) | `FileUploadMiddleware` (info, validation, zip, unzip) and `FormFileUploader`: transform, validate and store uploaded files |
| [Responses](10-responses.md) | `Ok`, `NotFound`, `Json`, `Xml`, `FileResponse` (download or inline, byte ranges, conditional requests), `TemplateResponse`, `Redirect` and the rest; content negotiation; writing your own response |
| [Error handling](11-error-handling.md) | How a thrown exception becomes a response; `@HandleException` and the error map; `CodedHttpException` and its `{ code, message, details? }` answer; `@OnError` route error handlers and `http.errors.handlers`; 404 for unmatched routes |
| [Data transformers](12-data-transformers.md) | `DataTransformer`: reshape a JSON answer on request with `x-data-transform` and `x-error-transform` |
| [Policies](13-policies.md) | `BasePolicy`, `@Policy`: AND groups, OR alternatives, controller and route scopes, policies named in configuration |
| [Route middlewares](14-route-middlewares.md) | `RouteMiddleware`, `@Middleware`, `@Accepts`: code around one route or controller |
| [Server middlewares](15-server-middlewares.md) | `ServerMiddleware`, `Order` and the hooks: the request timeline, the route before routing (`RouteIndex`), the shipped middlewares, the 404 and error tail, adding or replacing one |
| [CORS](16-cors.md) | `CorsMiddleware`: allowed origins, credentials, preflight, header lists, per-route `@Cors` |
| [Client IP and trusted proxies](17-client-ip-and-trust-proxy.md) | `RealIp`, `http.trustProxy`, `parseTrustProxy`, `parseTrustProxyOverride`, `requestProxyTrust`, `trustedClientAddress`, `requestOrigin` |
| [Throttling](18-throttling.md) | `ThrottleMiddleware` and the `ThrottleStore` seam: per-IP, per-path rate limits |
| [Request storage and tracing](19-request-storage-and-tracing.md) | `req.storage`, `AsyncLocalStorage`, request id and `traceparent`, access log, timing headers, slow-request warnings, perf rollups |
| [Cookies](20-cookies.md) | Signed cookies, `http.cookie.*`, `@Cookie`, setting cookies on a response |
| [Controller cache and CLI](21-controller-cache-and-cli.md) | `DefaultControllerCache`, JSDoc tag extractors, `spinajs http:controllers:cache` |
| [Header and cookie helpers](22-header-and-cookie-helpers.md) | `strictHeader`, `parseBearer`, `normalizeHeaders`, `parseCookieHeader`, `basicAuthHeader`, `retryAfterHeader`, `hostPrefixedCookie`, `clearCookie`, `isPublicCookieSecret`, `parseCidr`, `cidrMatcher` |
| [Same-origin guard](22-same-origin-guard.md) | `checkSameOrigin`, `SameOriginGuard`: refuse cross-origin state-changing requests by `Origin` and `Sec-Fetch-Site` |
| [CSRF guard](23-csrf-guard.md) | `CsrfGuard`, `@CsrfExempt()`, `http.csrf.*`: default-deny CSRF protection by `Origin` and `Sec-Fetch-Site` |
| [Bot checks](23-bot-check.md) | `@BotCheck`, `BotVerifier`, `BotCheckService`, `http.bot`: captcha or score checks on chosen routes; adapters in [`@spinajs/http-bot`](../http-bot/README.md) |
| [Raw request bodies and digests](24-raw-body-and-digests.md) | `@RequestStream()`, `@ContentDigest()`, `parseContentDigest()`: the raw body as a capped stream, RFC 9530 digests, the 413 and 415 answers |
| [Untrusted request headers](25-untrusted-headers.md) | Every request header the framework reads, its risk and how it is parsed; what Node's parser refuses first; open questions |
| [Idempotency-Key](26-idempotency.md) | `@Idempotent()`: a retried request replays the stored JSON reply; 409 while in flight, 422 for a reused key, the ORM store's app-entry import |

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

### Compile cache

Node can keep the compiled code of every module it loads on disk and reuse it on the next start, which saves part of the module loading of a boot. It caches only what it compiles after the cache is turned on, so start the app through a launcher that turns it on and then imports the entry, and await the boot in the entry (`await main();`) instead of `void main();`:

```ts
// start.ts: run with `node lib/start.js`
import { enableCompileCache, flushCompileCache } from '@spinajs/util/compile-cache';

enableCompileCache();
await import('./main.js');
flushCompileCache();
```

- The cache lives in a per-user dir: `$XDG_CACHE_HOME/spinajs/compile-cache`, else `~/.cache/spinajs/compile-cache`, and `%LOCALAPPDATA%\spinajs\compile-cache` on Windows. On POSIX the dirs are created with mode `0700`, and the cache stays off when one of them, from the cache root down, belongs to another user or can be written by the group or others, and when a dir above the cache root, up to `/`, belongs to neither root nor the app's user or can be written by the group or others (so never below `/tmp`). On Windows nothing is checked: the profile's ACL keeps `%LOCALAPPDATA%` private, so it must point at a per-user dir. Node trusts what it finds in the cache, so a dir anyone else can write to would let them supply the code of the app's modules. Do not call Node's `module.enableCompileCache()` without a dir: its default is `<os temp dir>/node-compile-cache`, which every user shares on Linux.
- `NODE_COMPILE_CACHE=<dir>` puts the cache in a dir the app owns instead (Node turns it on at start-up and the helper leaves it alone); make sure only the app's user can write to it. `NODE_DISABLE_COMPILE_CACHE=1` turns it off. A cache dir that cannot be created, as in a container with a read-only home, leaves it off without a message; the app starts as usual.
- Node keys entries by file content and Node version, so a changed file is compiled again.
- Node writes the cache when the process exits, which a server stopped by a signal never does. `flushCompileCache()` after the import writes it once the app listens. The first start with an empty cache writes every entry there, so its first requests wait for that write; later starts only read.
- A container starts with an empty cache unless its image has one: set `NODE_COMPILE_CACHE` to a dir in the image and start the app once while building the image. Without that, every container start compiles everything again and gets none of the saving.
- `enableCompileCache` and `flushCompileCache` do nothing on a Node version without the API (`module.enableCompileCache` came in 22.1, `module.flushCompileCache` in 22.10).

The `spinajs` bin and the bundle of `@spinajs/http-socket-example` start this way.

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
