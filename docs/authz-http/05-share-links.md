# Share links

A share link lets a request act through a link: whoever holds the link token gets the link's principal, limited by the link's ceiling. `LinkPrincipalSource` finds the token in the request and asks the registered `LinkResolver` for the principal. The principal the other sources found stays on as the link principal's companion.

authz-http does not store links. The RBAC model keeps them and hands out a resolver ([`@spinajs/authz-rbac`](../authz-rbac/README.md)); without a registered `LinkResolver` every link opens nothing.

## How it works

1. `PrincipalMiddleware` runs the other sources first and leaves their answer (or nothing) in `req.storage.Principal` ([Principal resolution](03-principal-resolution.md)).
2. `LinkPrincipalSource.authenticate(req)` (order 110) reads the token from the first configured place that holds a non-empty string: the query parameter `authz.http.links.query`, then the header `authz.http.links.header`, then the cookie `authz.http.links.cookie` (signed cookies first).
3. No token: it returns `null` and the earlier answer stands.
4. No `LinkResolver` registered: it logs one warning (`a request carries a share link token, but no LinkResolver is registered`) and returns `deadLinkPrincipal(companion)`.
5. Otherwise it resolves `LinkResolver` from DI and returns `resolver.principal(token, companion)`, where `companion` is the earlier answer.
6. The link principal replaces the earlier answer as `req.storage.Principal`.

`deadLinkPrincipal(companion?)` is `{ type: 'link', id: 'unresolved', authenticated: true, source: 'link', companions?: [companion ref], ceiling: { resources: [], reason: 'link_invalid' } }`: its ceiling covers nothing, so every check denies with `link_invalid`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.http.links.query` | `string \| null` | `'link'` | non-empty name, or `null` | Query parameter that carries the token; `null` turns it off. |
| `authz.http.links.header` | `string \| null` | `'X-Authz-Link'` | non-empty name, or `null` | Header that carries the token; `null` turns it off. |
| `authz.http.links.cookie` | `string \| null` | `null` | non-empty name, or `null` | Cookie that carries the token; off by default. |

```ts
export default {
  authz: {
    http: {
      // links arrive in a header or a cookie only, never in a URL a proxy logs
      links: { query: null, header: 'X-Authz-Link', cookie: 'share_link' },
    },
  },
};
```

An empty string is refused at boot; use `null` to turn a place off.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `LinkResolver` (abstract: `principal(token, companion?)`) | `LinkResolver`, looked up on every request that carries a token | none | `RbacLinkResolver` (`@spinajs/authz-rbac`), registered in root by `authz.use: ['rbac']` or `registerRbac(DI.RootContainer, …)` | `DI.register(MyResolver).as(LinkResolver)` for your own. It may be registered after `LinkPrincipalSource` is built, e.g. at the root domain's boot. Only the root container's registration counts: RBAC listed in a child domain's `use` alone leaves links dead. |
| `LinkPrincipalSource` | `PrincipalSource` list, `@Injectable(PrincipalSource)`, order 110 | `LinkPrincipalSource` | | Subclass and override the protected `token(req)` to read the token elsewhere. Register the subclass with `@Injectable(PrincipalSource)` and remove the shipped one with `DI.unregister(LinkPrincipalSource)`, before `HttpServer` resolves. |

`PrincipalMiddleware` treats every `LinkPrincipalSource` instance (subclasses included) as a link source: it runs after the plain sources and replaces their answer.

### `LinkResolver`: custom implementation

A resolver must always return a principal. An unknown, expired or revoked token returns one that denies everything: `ceiling.resources: []` with reason `link_invalid`, as `deadLinkPrincipal()` builds. It must never return `null` or throw for a bad token.

```ts sample
import { DI } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { LinkResolver, deadLinkPrincipal } from '@spinajs/authz-http';

interface DocumentLink {
  readonly id: string;
  readonly documentId: string;
  readonly expiresAt: Date;
  readonly revoked: boolean;
}

/** Read-only links to one document; the app keeps them in its own table. */
export class DocumentLinkResolver extends LinkResolver {
  constructor(private readonly find: (token: string) => Promise<DocumentLink | undefined>) {
    super();
  }

  public async principal(token: string, companion?: Principal): Promise<Principal> {
    const link = await this.find(token);
    if (!link || link.revoked || link.expiresAt <= new Date()) {
      return deadLinkPrincipal(companion);
    }

    return Object.freeze({
      type: 'link',
      id: link.id,
      authenticated: true,
      source: 'link',
      ...(companion ? { companions: Object.freeze([{ type: companion.type, id: companion.id }]) } : {}),
      ceiling: Object.freeze({
        resources: Object.freeze([{ type: 'document', id: link.documentId }]),
        permissions: Object.freeze(['document:read']),
        expiresAt: link.expiresAt,
        reason: 'link_invalid',
      }),
      attributes: Object.freeze({}),
    });
  }
}

const links = new Map<string, DocumentLink>();
DI.register(() => new DocumentLinkResolver(async (token) => links.get(token))).as(LinkResolver);
```

## Important behaviour

- **A link replaces the session principal.** A signed-in user who opens a link acts as the link principal, with the user as companion. Checks see the link's ceiling, not the user's roles.
- **A token always yields a principal.** A bad token, or a missing resolver, gives a principal that is denied everything, never a fallback to the user's own rights.
- **The missing-resolver warning is logged once** per source instance, so requests with tokens cannot flood the log.
- **No link section, no links.** When `authz.http.links` never went through the schema (not an object), no token is read.
- **Query tokens end up in logs and `Referer` headers.** The default reads `?link=`; turn it off with `query: null` when links travel in headers.

## Best practices

- Wire `rbac.linkResolver` as `LinkResolver` whenever you use RBAC links; [`@spinajs/authz-rbac`](../authz-rbac/README.md) shows the setup.
- Return `deadLinkPrincipal(companion)` from your resolver for every token it cannot honour, so the denial reason stays `link_invalid`.
- Use a signed cookie name in `links.cookie`: the source reads `req.signedCookies` first.

## Related

- [Principal sources](04-principal-sources.md): the other sources a link replaces.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): the link store and `rbac.linkResolver`.
- [`@spinajs/authz`](../authz/01-check-flow.md#concepts): ceilings and companions.
- [Cookies](../http/20-cookies.md): signed cookies.
