# `@spinajs/tenancy-http`

Finds the tenant of an HTTP request or a socket connection and sets the tenant scope of `@spinajs/tenancy` for it. A chain of tenant resolvers reads the host, a route parameter, a header, the principal or the session; `TenantMiddleware` admits the tenant before the policy gate, and route decorators declare which routes need a tenant.

It does **not** store tenants or decide who may enter one: the registry and `TenantAccess` belong to [`@spinajs/tenancy`](../tenancy/README.md). It does **not** authenticate: the principal comes from the request store, written by `@spinajs/authn-http` and `@spinajs/authz-http`. It does **not** require a tenant on any route by itself: mount `TenantMiddleware` globally or with a decorator.

## Install

```sh
npm install @spinajs/tenancy-http
```

For sockets, install `@spinajs/http-socket` too (an optional peer dependency) and import `@spinajs/tenancy-http/socket`.

## Features

| Feature | What it does |
| --- | --- |
| [Tenant resolvers and the request source](01-tenant-resolvers.md) | `TenantRequestSource`, the six shipped resolvers, trusted and untrusted sources, the resolver chain, writing your own `TenantResolver` |
| [`TenantMiddleware` and route declarations](02-tenant-middleware.md) | The route middleware that sets the scope before the policy gate; `@TenantRoute()`, `@NoTenant()`, `@AllTenants(reason)`; the `TenantRefused` answer |
| [Tenant of a socket connection](03-sockets.md) | `TenantSocketContext`: one tenant per connection, resolved in the handshake and copied into every call |
| [Configuration](04-configuration.md) | Every `tenancy.http.*` key: the chain, the header, the base domains, the refusal status |

## Quick start

Require a tenant on every route, serve tenants on subdomains of `app.example.com` and on their own domains, and keep the health check open.

```ts sample
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { requireTenant } from '@spinajs/tenancy';
import { NoTenant } from '@spinajs/tenancy-http';

/** The app's config file. */
export default {
  http: { routes: { middlewares: ['TenantMiddleware'] } },
  tenancy: {
    tenants: [{ id: 'acme', slug: 'acme', domains: ['shop.acme.example'] }],
    http: { baseDomains: ['app.example.com'] },
  },
};

@BasePath('projects')
export class ProjectsController extends BaseController {
  // https://acme.app.example.com/projects and https://shop.acme.example/projects run in tenant acme
  @Get()
  public list() {
    return new Ok({ tenant: requireTenant().id });
  }
}

@BasePath('status')
export class StatusController extends BaseController {
  @NoTenant()
  @Get('health')
  public health() {
    return new Ok({ up: true });
  }
}
```

An unknown host answers 404 with the code `tenant.unavailable`.

## Related packages

- [`@spinajs/tenancy`](../tenancy/README.md): the tenant scope, the registry, `TenantAccess`, `TenantResolver` and `admitTenant`, which this package feeds.
- [`@spinajs/http`](../http/README.md): route middlewares, `http.routes.middlewares`, `RealIp` and `http.trustProxy`.
- [`@spinajs/http-socket`](../http-socket/README.md): `SocketConnectionContext`, which carries the tenant of a connection.
- [`@spinajs/authz-http`](../authz-http/README.md) and [`@spinajs/authn-http`](../authn-http/README.md): the principal and the session the resolvers read.
