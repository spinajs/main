# @spinajs/http

HTTP server & controller framework for SpinaJS, built on top of Express.

- Class-based controllers with decorator routing (`@Get`, `@Post`, …)
- Declarative route arguments (`@Query`, `@Body`, `@Param`, `@File`, …) with validation & hydration
- Policies (authorization) and route middlewares
- Pluggable controller discovery (`ControllerSource`) — filesystem scan, DI registry, or your own
- Typed response classes (`Ok`, `Created`, `NotFound`, …) with content negotiation (JSON / HTML / XML)
- Controller metadata cache with ahead-of-time CLI build (fast cold starts in docker)
- Fail-fast startup: broken controllers throw typed exceptions instead of half-starting

## Installation

```bash
npm install @spinajs/http
```

## Quick start

```ts
// src/controllers/UsersController.ts
import { BaseController, BasePath, Get, Post, Ok, Created, NotFound, Query, Param, Body } from '@spinajs/http';

@BasePath('users')
export class UsersController extends BaseController {
  /**
   * GET /users?page=1
   */
  @Get('/')
  public async list(@Query() page?: number) {
    return new Ok([{ id: 1, name: 'John' }]);
  }

  /**
   * GET /users/42
   */
  @Get(':id')
  public async get(@Param() id: number) {
    if (id !== 42) {
      return new NotFound({ message: 'no such user' });
    }
    return new Ok({ id, name: 'John' });
  }

  /**
   * POST /users  { "name": "Alice" }
   */
  @Post('/')
  public async create(@Body() user: UserDto) {
    return new Created(user);
  }
}
```

```ts
// src/index.ts — application bootstrap
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { Controllers, HttpServer } from '@spinajs/http';

await DI.resolve(Configuration);
await DI.resolve(fsService);
await DI.resolve(Controllers);   // discovers & mounts all controllers

const server = await DI.resolve(HttpServer);
server.start();                  // listens on http.port ( default 1337 )
```

Controllers are auto-discovered from directories configured at `system.dirs.controllers`.

## Configuration

All settings live under the `http` config key ( see `src/config/http.ts` for full defaults ):

```ts
// config/http.ts ( app override )
import config from './config.js';

export default {
  system: {
    dirs: {
      // where controller classes are scanned from
      controllers: ['/app/dist/controllers'],
    },
  },
  http: {
    port: 3000,

    // global prefix added to EVERY controller route, eg. api/v1 -> /api/v1/users
    controllers: {
      route: { prefix: 'api/v1' },
    },

    // raw express middlewares, executed before routing
    middlewares: [ /* helmet(), express.json(), ... */ ],

    // signed cookie secret — ALWAYS override in production
    cookie: {
      secret: 'change-me',
      options: { maxAge: 900000, httpOnly: true },
    },

    // static content: GET /_static/* served from Path
    Static: [{ Route: '/_static', Path: '/app/public' }],

    ssl: { key: '', cert: '' },
  },
};
```

## Routing

Route decorators: `@Get`, `@Post`, `@Put`, `@Patch`, `@Del`, `@Head` — all take optional path and schema.

Path resolution rules:

| Declaration | Resulting path |
| --- | --- |
| `@BasePath('user')` + `@Get()` on `refresh()` | `/user/refresh` ( method name fallback ) |
| `@BasePath('user')` + `@Get('/')` | `/user` |
| `@BasePath('user')` + `@Get('grants/:id')` | `/user/grants/:id` |
| no `@BasePath` | controller class name lowercased |
| config `http.controllers.route.prefix = 'api/v1'` | `/api/v1/...` prepended to all of the above |

## Route arguments

Declared per-parameter with decorators; extracted, validated and hydrated before the action runs:

```ts
import {
  Get, Post, Query, Body, Param, Header, Cookie, Form, File, CsvFile, JsonFile,
  FromXml, RawBody, Req, Res, Ip, RequestId, UserAgent, Referer, FromDI, PKey, Uuid,
} from '@spinajs/http';

class ExamplesController extends BaseController {
  @Get(':id')
  public async byId(@PKey() id: number) { /* primary key helper */ }

  @Get('search')
  public async search(@Query() q: string, @Header('x-api-key') key: string) { }

  @Post('upload')
  public async upload(@File({ maxFileSize: 1024 * 1024 }) file: IUploadedFile) { }

  @Post('import')
  public async import(@CsvFile() rows: unknown[]) { }

  @Post('webhook')
  public async webhook(@RawBody() raw: Buffer, @Header('x-signature') sig: string) {
    // raw = exact received bytes, for signature verification
  }

  @Get('whoami')
  public async whoami(@Ip() ip: string, @UserAgent() ua: string, @RequestId() rid: string) { }

  @Get('svc')
  public async svc(@FromDI() service: SomeService) { /* resolved from DI per request */ }
}
```

Selected argument decorators:

| Decorator | Source |
| --- | --- |
| `@Query(schema?)` | query string parameter |
| `@Body(options?)` | JSON body ( whole body or single field ) |
| `@Param(schema?)` | URL parameter ( `:id` ) |
| `@Header(name?)` | request header |
| `@Cookie(secure?)` | cookie ( optionally signed ) |
| `@Form` / `@FormField` | multipart form data |
| `@File` / `@Files` | uploaded file(s), with size limits & upload middlewares |
| `@CsvFile` / `@JsonFile` | uploaded file parsed to data |
| `@FromXml` | XML request body, parsed |
| `@RawBody` | raw request bytes ( webhook signatures ) |
| `@Req` / `@Res` | express request / response |
| `@Ip`, `@RequestId`, `@UserAgent`, `@Referer` | request metadata |
| `@FromDI` | DI-resolved service |
| `@PKey`, `@Uuid` | validated identifier helpers |
| `@Model(Type)` | ORM model lookup ( with `@spinajs/orm-http` ) |

Custom types passed to `@Body` / `@Query` are hydrated: class instances are constructed and (optionally) validated against JSON schema attached via `@Schema` from `@spinajs/validation`. Custom hydration via `@Hydrator(MyHydrator)` on the DTO class.

## Responses

Actions return response objects ( content negotiation JSON / HTML / XML happens automatically based on `Accept` header ):

```ts
import { Ok, Created, NoContent, BadRequestResponse, Unauthorized, ForbiddenResponse,
         NotFound, Conflict, ValidationError, ServerError, Json, Xml,
         FileResponse, ZipResponse, JsonFileResponse, TemplateResponse, Redirect } from '@spinajs/http';

@Get('download')
public async download() {
  return new FileResponse({ path: '/data/report.pdf', filename: 'report.pdf' });
}

@Get('page')
public async page() {
  // renders pug template ( with @spinajs/templates-pug )
  return new TemplateResponse('page.pug', { title: 'Hello' });
}

@Get('legacy')
public async legacy() {
  return new Redirect('/new-location');
}
```

## Policies ( authorization )

Policies gate route execution. When several policies are attached, **one success is enough** — this allows alternative access paths ( e.g. session cookie OR api token ):

```ts
import { BasePolicy, Policy, IRoute, IController } from '@spinajs/http';

export class ApiKeyPolicy extends BasePolicy {
  public isEnabled(_route: IRoute, _controller: IController): boolean {
    return true;
  }

  public async execute(req: express.Request): Promise<void> {
    if (req.headers['x-api-key'] !== process.env.API_KEY) {
      throw new Forbidden('invalid api key');
    }
    // resolving = access granted
  }
}

@BasePath('admin')
@Policy(ApiKeyPolicy)               // controller-wide
export class AdminController extends BaseController {
  @Get()
  @Policy(SessionPolicy)            // route-level, OR-ed with ApiKeyPolicy
  public async dashboard() { ... }
}
```

Policies can also be referenced **by configuration key** — the key must resolve to a registered policy type name:

```ts
@Policy('rbac.session.policy')      // read from configuration at startup
```

A config key that does not resolve to a registered `BasePolicy` throws `RouteRegistrationException` at startup — a silently dropped policy would leave the route unprotected.

## Route middlewares

Run before / after actions and can inspect the produced response:

```ts
import { RouteMiddleware, Middleware } from '@spinajs/http';

export class AuditMiddleware extends RouteMiddleware {
  public isEnabled(route: IRoute, controller: IController): boolean { return true; }
  public async onBefore(req, res, route, controller): Promise<void> { /* before action */ }
  public async onResponse(response, route, controller): Promise<void> { /* inspect response object */ }
  public async onAfter(req, res, route, controller): Promise<void> { /* after action */ }
}

@Middleware(AuditMiddleware)        // controller-wide or per-route
export class OrdersController extends BaseController { ... }
```

Server-level middlewares ( whole express stack, not per-route ) ship in `src/middlewares/`: `AccessLog`, `Cors`, `Compression`, `RequestId` ( w3c traceparent + `x-request-id` ), `ResponseTime`, `RealIp`, `ServerTiming`, `PerfRollup`, `SlowRequestWarning`, `NotFound`, `ErrorHandler`.

## Controller discovery ( ControllerSource )

Discovery is pluggable. Built-in sources:

- `FilesystemControllerSource` — scans `system.dirs.controllers` directories
- `DiRegistryControllerSource` — picks up types registered in DI **before** `Controllers` resolves:

```ts
// package bootstrapper — conditional controller registration
@Injectable(Bootstrapper)
export class MyPackageBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    if (someFeatureFlag) {
      DI.register(MyFeatureController).as(BaseController);
    }
  }
}
```

Custom source — implement and register, the loader picks it up automatically:

```ts
import { ControllerSource, BaseController } from '@spinajs/http';
import { ClassInfo, Injectable } from '@spinajs/di';

@Injectable(ControllerSource)
export class PluginManifestSource extends ControllerSource {
  public async getControllers(): Promise<Array<ClassInfo<BaseController>>> {
    // read your plugin manifest, return ClassInfo entries ( name, type, file )
    return [];
  }
}
```

### Overriding a package controller

Register the subclass as an override — only the subclass mounts:

```ts
DI.register(MyUserController).as(PackageUserController);
```

Subclassing a scanned controller **without** registering the override mounts BOTH and logs a warning ( express route order decides which answers ).

### Dynamic registration at runtime

```ts
const controllers = await DI.resolve(Controllers);
await controllers.add(LateBoundController);   // idempotent, mounts immediately
```

## Startup error handling

Registration is fail-fast — the app refuses to start instead of silently skipping broken pieces:

| Condition | Exception |
| --- | --- |
| controller instance could not be resolved | `ControllerRegistrationException` |
| controller has descriptor but no router ( `super.resolve()` not called ) | `ControllerRegistrationException` |
| route declared for a member that does not exist | `RouteRegistrationException` |
| unknown route type ( broken decorator ) | `RouteRegistrationException` |
| string policy config key not resolvable | `RouteRegistrationException` |

Routes inherited from a base class declared in another file are fine — parameter names fall back to runtime extraction.

## Controller cache & CLI

Route parameter names and JSDoc documentation ( used by `@spinajs/http-swagger` ) are extracted from `.d.ts` files with the TypeScript compiler and cached under `__cache__/__controllers__` ( configurable via the `__fs_controller_cache__` fs provider ).

Entries are keyed by `<@spinajs/http version>_<content hash of the .d.ts>`. The hash covers "did the controller change?", the version covers "did the extractor that reads it change?" — installing a new package build lands on keys nothing was ever written under, so a release that learns to read a new JSDoc tag never serves documents written before it could.

First app start pays the parsing cost. To avoid that ( e.g. docker images ), pre-build the cache at image build time:

```bash
# generate missing cache entries
spinajs http:controllers:cache

# clear the directory and regenerate every entry — also the manual revalidation hook
spinajs http:controllers:cache --rebuild
```

While developing controllers locally, hang it off a watcher rather than the framework:

```json
"watch:controllers": "nodemon --watch src/controllers --ext ts --exec \"spinajs http:controllers:cache --rebuild\""
```

```dockerfile
FROM node:22 AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build
# pre-build controllers cache AFTER tsc — cache keys are content hashes of compiled .d.ts
RUN node node_modules/.bin/spinajs http:controllers:cache --rebuild

FROM node:22-slim
WORKDIR /app
COPY --from=build /app .
CMD ["node", "dist/index.js"]
```

The command exits non-zero when any controller fails to parse, failing the image build loudly.

## Exceptions

| Exception | Purpose |
| --- | --- |
| `ControllerRegistrationException` | controller-level startup failure |
| `RouteRegistrationException` | route-level startup failure |
| `EntityTooLargeException` | uploaded file exceeds limits ( maps to HTTP 413 ) |

## Related packages

- `@spinajs/http-swagger` — OpenAPI document generation from controller JSDoc
- `@spinajs/orm-http` — `@Model()` route arg, ORM-aware responses
- `@spinajs/rbac-http` — session / role policies
- `@spinajs/templates-pug` — HTML rendering for `TemplateResponse` and error pages
