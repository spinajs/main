# `@spinajs/authz-http`

The HTTP integration of SpinaJS authorization: it picks the principal of each request, guards controllers and routes with `@Access`, filters body and response fields by the decision, and serves the client access API (`/user/access`, its checks, its event stream).

It does **not** authenticate anyone: logins, sessions, tokens and keys are [`@spinajs/authn-http`](../authn-http/README.md), which leaves its principal on the request for this package. It ships no model either: permissions are decided by the models you wire into [`@spinajs/authz`](../authz/README.md) (RBAC, ABAC).

## Install

```sh
npm install @spinajs/authz-http
```

Importing the package registers its server middlewares, principal sources, field filters, contributor and controller source. Its config module adds the `AccessController` folder to `system.dirs.controllers` and the `authz.http.*` defaults.

## Features

| Feature | What it does |
| --- | --- |
| [Protecting routes](01-protecting-routes.md) | `@Access`, `@AllowAnonymous`, `@Unscoped`, `HasPrincipal`, `IsAuthenticated`: the request check end to end, status codes and error bodies, the boot check of permissions |
| [Resource extractors](02-resource-extractors.md) | `fromParam`, `fromBody`, `fromQuery`, `fromModel`, `typedExtractor`: which object a route checks; `subject: 'load'` |
| [Principal resolution](03-principal-resolution.md) | `PrincipalMiddleware`, the anonymous principal, `@CurrentPrincipal()`, the `req.storage` keys, the root domain boot |
| [Principal sources](04-principal-sources.md) | `PrincipalSource` and the shipped service and authn sources; `authz.http.services`; writing your own source |
| [Share links](05-share-links.md) | `LinkPrincipalSource`, `LinkResolver`, `authz.http.links`: requests that act through a share link |
| [Field filters](06-field-filters.md) | Body fields stripped or refused by `decision.fields.write`, responses limited with `fields: 'filter'`, `@UnfilteredInput` |
| [Client access API](07-client-access-api.md) | `GET /user/access`, `POST /user/access/checks` and the `X-Access-Epoch` header |
| [Access events](08-access-events.md) | `GET /user/access/events`: `authz.changed` over server-sent events, ended with the session |
| [Explain](09-explain.md) | `GET /authz/explain` and the trace in a 403, outside production only |
| [Access metadata and OpenAPI](10-access-metadata-and-openapi.md) | `ACCESS_DESCRIPTOR`, `accessDescriptorOf`, `swaggerAccess` and the `x-authz-*` extensions |

## Quick start

A controller whose routes need `invoice:list` and `invoice:read`:

```ts sample
import type { Principal } from '@spinajs/authz';
import { Access, CurrentPrincipal, fromParam } from '@spinajs/authz-http';
import { BaseController, BasePath, Get, Ok, Param } from '@spinajs/http';

@BasePath('invoices')
export class InvoicesController extends BaseController {
  @Get('/')
  @Access('invoice:list')
  public list(@CurrentPrincipal() caller: Principal) {
    return new Ok({ requestedBy: `${caller.type}:${caller.id}` });
  }

  // 401 without a signed-in caller, 403 { error: 'forbidden', ... } when the model denies invoice <id>.
  @Get(':id')
  @Access('invoice:read', { resource: fromParam('id', 'invoice'), subject: 'load' })
  public get(@Param() id: string) {
    return new Ok({ id });
  }
}
```

Declare the permissions, or the boot fails:

```ts
export default {
  authz: {
    permissions: { 'invoice:list': {}, 'invoice:read': {} },
  },
};
```

## Configuration

Every `authz.http.*` key, with its page. AJV validates the section at boot.

| Key | Default | Page |
| --- | --- | --- |
| `authz.http.services` | `[]` | [Principal sources](04-principal-sources.md#configuration) |
| `authz.http.links.query`, `.header`, `.cookie` | `'link'`, `'X-Authz-Link'`, `null` | [Share links](05-share-links.md#configuration) |
| `authz.http.access.domain` | `'root'` | [Client access API](07-client-access-api.md#configuration) |
| `authz.http.events.maxStreamsPerPrincipal` | `5` | [Access events](08-access-events.md#configuration) |
| `authz.http.explainRoute.enabled`, `.permission` | `false`, `'authz:explain'` | [Explain](09-explain.md#configuration) |
| `authz.http.webhooks` | `[]` | [Webhooks](../authn-http/20-webhooks.md#authorization-changes) |
| `authz.http.admin.domain` | `'root'` | The domain whose `AuthzAdmin` the `@spinajs/authz-http-admin` routes use. |

The package also reads the core keys `authz.principals.anonymous.enabled`, `authz.fields.*`, `authz.engine.explain` and `authz.audit.unscoped`; each page lists the ones it uses.

## Related packages

- [`@spinajs/authz`](../authz/README.md): the engine, permissions, decisions and domains every check here runs on.
- [`@spinajs/authn-http`](../authn-http/README.md): authenticates the request and leaves `req.storage.AuthnPrincipal` for `AuthnPrincipalSource`.
- [`@spinajs/http`](../http/README.md): policies, route middlewares, input filters and the error handler this package plugs into.
- [`@spinajs/authz-orm`](../authz-orm/README.md): `@AccessResource` models for `fromModel` and `subject: 'load'`, and `.accessible()` for list routes.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): the RBAC model and the `LinkResolver` for share links.
- [`@spinajs/http-swagger`](../http-swagger/README.md): reads the access metadata into the OpenAPI document.
- [`@spinajs/http-socket`](../http-socket/README.md): `@SocketAccess`, the socket counterpart of `@Access`, and the socket push of access changes.
