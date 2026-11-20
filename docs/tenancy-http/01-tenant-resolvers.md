# Tenant resolvers and the request source

A tenant resolver reads one place of a request (the host, a route parameter, a header, the principal, the session) and proposes a tenant. The chain in `tenancy.http.resolvers` asks them in order; the first proposal is admitted or refused, and no later resolver is asked. HTTP routes and socket handshakes use the same chain.

## How it works

1. The entry point builds a `TenantRequestSource`: `httpSource(ctx)` in [`TenantMiddleware`](02-tenant-middleware.md), `socketSource(handshake, …)` in [`TenantSocketContext`](03-sockets.md).
2. `tenantResolvers(names, container)` turns the names of `tenancy.http.resolvers` into resolver instances. The entry `x` is the `TenantResolver` registered as `XTenantResolver` (first letter upper-cased). An unknown name, or a registration that does not give a `TenantResolver`, throws `InvalidOption` naming `tenancy.http.resolvers` and the entry.
3. `resolveTenant(resolvers, source, container)` walks the chain:
   - a resolver whose `trusted` is `false` is skipped unless the source's principal is authenticated;
   - `resolver.resolve(source)` returns a `TenantProposal` (a tenant id, `{ slug }` or `{ domain }`) or `undefined`;
   - the first proposal goes to `admitTenant(proposal, principal, container)` of `@spinajs/tenancy`, which looks it up in the registry, checks the state is `active` and, for an authenticated principal, asks `TenantAccess.canEnter()`.
4. The result is the `TenantRecord`, or `undefined` when no resolver proposed anything. A refused proposal throws `TenantUnavailable` with the reason `'unknown'`, `'inactive'` or `'forbidden'`. A registry failure throws as itself.

### The request source

| `TenantRequestSource` field | HTTP request (`httpSource`) | Socket handshake (`socketSource`) |
| --- | --- | --- |
| `host` | `X-Forwarded-Host` from a trusted peer, else `Host`; see [Host](#host) | the same, from the handshake headers |
| `headers` | `req.headers` | the handshake headers; `auth.tenant` stands in for the `tenancy.http.header` header |
| `params` | the route parameters | always `{}` |
| `principal` | `principalOf(req.storage)` | the principal the socket server identified |
| `session` | the data of the session authn restored (`AuthnSession.data`, a `Map`) | always `undefined` |

`principalOf(store)` returns the store's `Principal` (written by authz), else `AuthnPrincipal` (written by authn), and only a value shaped like a principal (`type`, `id`, `authenticated`, `attributes`). `isTenantRequestSource(value)` tells a source from anything else.

### Host

- `hostOf(header)` drops the port and a trailing dot and lower-cases the name: `Shop.Acme.Example.:443` gives `shop.acme.example`. Of a list or a comma-separated value it takes the first entry. An IPv6 host keeps its brackets (`[::1]`); an empty or broken value gives `undefined`.
- `X-Forwarded-Host` counts only when the TCP peer is a trusted proxy, by the trust `RealIp` resolved: `http.trustProxy`, or `authn.http.trustProxy` with `@spinajs/authn-http` (see [Client IP and trusted proxies](../http/17-client-ip-and-trust-proxy.md)). A hop count of 1 or more trusts any peer; a list trusts the listed peers. Otherwise the host is the `Host` header.
- `hostPlace(host, baseDomains)` places a host against the application's own domains: `'base'` for one of them, `{ label }` for exactly one label below one of them, `'other'` for anything else. Every base is matched exactly first, so `www.app.example.com` listed next to `app.example.com` is a base, not the label `www`.

## The shipped resolvers

Every shipped resolver extends `RequestTenantResolver` and is registered with `@Injectable(TenantResolver)`.

| Chain name | Class | Reads | Proposes | Trusted |
| --- | --- | --- | --- | --- |
| `domain` | `DomainTenantResolver` | `host` | `{ domain: host }` when the host is `'other'` to `tenancy.http.baseDomains`; nothing while `baseDomains` is empty | yes |
| `subdomain` | `SubdomainTenantResolver` | `host` | `{ slug: label }` for `<label>.<base domain>` | yes |
| `path` | `PathTenantResolver` | `params[tenancy.http.pathParam]` | `{ slug }` | yes |
| `header` | `HeaderTenantResolver` | the `tenancy.http.header` header (first value of a repeated one) | the tenant id | **no** |
| `principal` | `PrincipalTenantResolver` | `principal.attributes[tenancy.http.principalAttribute]` of an authenticated principal | the tenant id | yes |
| `session` | `SessionTenantResolver` | `session.get(tenancy.http.sessionKey)` | the tenant id | yes |

A resolver proposes only a non-empty string; any other value proposes nothing. `RequestTenantResolver.resolve()` proposes nothing for a source that is not a `TenantRequestSource`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `tenancy.http.resolvers` | string[] | `['domain', 'subdomain', 'path', 'header', 'principal', 'session']` | names of registered `<Name>TenantResolver` classes | The chain, in order |
| `tenancy.http.baseDomains` | string[] | `[]` | host names | The application's own domains |
| `tenancy.http.pathParam` | string | `'tenant'` | a route parameter name | Read by `path` |
| `tenancy.http.header` | string | `'x-tenant'` | a header name, any case | Read by `header` |
| `tenancy.http.principalAttribute` | string | `'tenant'` | an attribute name | Read by `principal` |
| `tenancy.http.sessionKey` | string | `'tenant'` | a session data key | Read by `session` |

```ts
tenancy: {
  http: {
    resolvers: ['domain', 'subdomain', 'path', 'principal'],
    baseDomains: ['app.example.com', 'www.app.example.com'],
    pathParam: 'org',
  },
},
```

All keys are on the [Configuration](04-configuration.md) page.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `TenantResolver` (abstract, `@spinajs/tenancy`) | `TenantResolver`; picked by name with `resolveNamed(TenantResolver, '<Name>TenantResolver')` from `tenancy.http.resolvers`; the class's own lifetime (singleton by default). `TenantMiddleware` builds the chain once per route at startup, `TenantSocketContext` at the first handshake | the six classes above | your resolvers | Add one: `@Injectable(TenantResolver)` on a class named `<Name>TenantResolver`, then list `<name>` in `tenancy.http.resolvers`. Replace a shipped one: register a subclass under another name and list that name in its place. Remove one: leave its name out of the chain |
| `RequestTenantResolver` (abstract) | none: the base class of the shipped resolvers | none | none | Extend it and implement `propose(source: TenantRequestSource)`; override `trusted` for a source the client sets |

### `TenantResolver`: custom implementation

Write a resolver when the tenant sits somewhere the shipped ones do not read. Extend `RequestTenantResolver` to get a typed `TenantRequestSource`; extend `TenantResolver` itself to read any other source. Set `trusted = false` when the client chooses the value: the chain then asks the resolver only for an authenticated principal, and `TenantAccess` checks that principal may enter the tenant.

The class must be imported before the chain is built: before the controllers resolve for HTTP, before the first handshake for sockets.

```ts sample
import { Injectable } from '@spinajs/di';
import { TenantResolver } from '@spinajs/tenancy';
import type { TenantProposal } from '@spinajs/tenancy';
import { RequestTenantResolver } from '@spinajs/tenancy-http';
import type { TenantRequestSource } from '@spinajs/tenancy-http';

/** API keys look like `acme.k_9f2c41`: the part before the dot is the tenant id. */
@Injectable(TenantResolver)
export class ApiKeyTenantResolver extends RequestTenantResolver {
  // The client writes the key: honoured only once authn authenticated the request with it.
  public override readonly trusted: boolean = false;

  protected propose({ headers }: TenantRequestSource): TenantProposal | undefined {
    const key = headers['x-api-key'];
    if (typeof key !== 'string') return undefined;
    const tenant = key.split('.')[0];
    return tenant === '' ? undefined : tenant;
  }
}

/** The app's config file: `apiKey` is ApiKeyTenantResolver. */
export default {
  tenancy: { http: { resolvers: ['domain', 'subdomain', 'apiKey', 'principal'] } },
};
```

## Important behaviour

- **The first proposal decides.** A refused proposal refuses the request; the chain does not fall through to the next resolver. With `domain` first, an unknown custom host is refused even when the path names a known tenant.
- **Base domains turn on the host resolvers.** While `tenancy.http.baseDomains` is empty, `domain` and `subdomain` propose nothing. Once it is set, `domain` proposes every host that is neither a base domain nor one label below one, so every other host the app answers on (an internal name, an IP a load balancer probes) is looked up as a tenant domain and refused.
- **One label only.** `subdomain` proposes `acme` for `acme.app.example.com`, nothing for `a.b.app.example.com`. A label below a base is always proposed: `www.app.example.com` is the slug `www` unless that host is listed as a base domain too.
- **Untrusted sources need a principal.** The `header` resolver is skipped for an anonymous request, so the header never names a tenant for it; the next resolver is asked.
- **Anonymous requests are admitted on trusted sources.** `admitTenant` checks `TenantAccess` only for an authenticated principal: an anonymous request on `acme.app.example.com` runs in tenant `acme`. What it may do there is up to the policies.
- **A tenant id is checked before the lookup.** A proposed id that does not match `TENANT_ID_PATTERN` (`^[a-z0-9_-]{1,64}$`) is `'unknown'` without a registry call.
- **Resolver names are checked early.** `tenantResolvers()` throws `InvalidOption` for an unknown name or a registration that is no `TenantResolver`: at startup for HTTP routes that require a tenant, at the first handshake for sockets.

## Best practices

- List every host the application answers on itself in `tenancy.http.baseDomains`, including `www.` variants and internal names.
- Put the trusted host resolvers first: a host cannot be forged past a trusted proxy, a header can.
- Leave `header` out of the chain when no client picks its tenant per request; `principal` or `session` then decide for signed-in users.
- Name a custom resolver `<Name>TenantResolver`; the chain finds nothing else.

## Patterns and antipatterns

```ts
// Don't: the client sets this header on any request; trusted = true lets anonymous callers pick a tenant
@Injectable(TenantResolver)
export class OrgHeaderTenantResolver extends RequestTenantResolver {
  public override readonly trusted: boolean = true;
  protected propose({ headers }: TenantRequestSource) {
    return typeof headers['x-org'] === 'string' ? headers['x-org'] : undefined;
  }
}

// Do: configure the shipped, untrusted header resolver
tenancy: { http: { header: 'X-Org' } }
```

```ts
// Don't: the app is also reached as api.internal and by IP; with base domains set, both are refused as unknown tenant domains
tenancy: { http: { baseDomains: ['app.example.com'] } }

// Do
tenancy: { http: { baseDomains: ['app.example.com', 'api.internal', '10.0.4.12'] } }
```

## Examples

### Tenants in the path, `/orgs/:org/...`

```ts sample
import { BaseController, BasePath, Get, Ok, Param } from '@spinajs/http';
import { requireTenant } from '@spinajs/tenancy';
import { TenantRoute } from '@spinajs/tenancy-http';

/** The app's config file: the path names the tenant by slug; signed-in users fall back to their attribute. */
export default {
  tenancy: { http: { resolvers: ['path', 'principal'], pathParam: 'org' } },
};

@BasePath('orgs')
@TenantRoute()
export class InvoicesController extends BaseController {
  // GET /orgs/acme-inc/invoices runs in the tenant whose slug is acme-inc
  @Get(':org/invoices')
  public list(@Param() org: string) {
    return new Ok({ org, tenant: requireTenant().id, invoices: [] });
  }
}
```

### Check which tenant a request names, in a test

`tenantResolvers()` and `resolveTenant()` take any `TenantRequestSource`, so a test can ask the default chain about a host without a server. It needs the configuration and the tenant registry of a booted container.

```ts sample
import { DI } from '@spinajs/di';
import { TENANCY_DEFAULTS } from '@spinajs/tenancy';
import { resolveTenant, tenantResolvers } from '@spinajs/tenancy-http';
import type { TenantRequestSource } from '@spinajs/tenancy-http';

export async function tenantOfHost(host: string): Promise<string | undefined> {
  const source: TenantRequestSource = { host, headers: {}, params: {}, principal: undefined, session: undefined };
  const chain = await tenantResolvers(TENANCY_DEFAULTS.http.resolvers, DI.RootContainer);
  return (await resolveTenant(chain, source))?.id;
}
```

## Related

- [`TenantMiddleware` and route declarations](02-tenant-middleware.md): where the HTTP chain runs.
- [Tenant of a socket connection](03-sockets.md): where the socket chain runs.
- [`@spinajs/tenancy`](../tenancy/README.md): `TenantResolver`, `TenantProposal`, `admitTenant`, `TenantAccess` and the registry.
- [Client IP and trusted proxies](../http/17-client-ip-and-trust-proxy.md): the trust that decides whether `X-Forwarded-Host` counts.
