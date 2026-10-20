# Principal sources

A `PrincipalSource` turns a request into a principal, or answers `null` when the request carries nothing it recognises. `PrincipalMiddleware` asks the registered sources in ascending `order` and keeps the first non-null answer. Add a source to accept a credential authn-http does not handle, such as a client certificate.

## How it works

1. Each source registers itself with `@Injectable(PrincipalSource)`. `PrincipalMiddleware` gets them all with `@Autoinject(PrincipalSource)` and sorts them by `order` when it resolves.
2. Per request it calls `authenticate(req)` on each source except `LinkPrincipalSource`, lowest `order` first, and stops at the first non-null principal.
3. A link source runs after them and may replace the principal ([Share links](05-share-links.md)).
4. A source that returns a `system` or `unattended` principal makes the request fail with `AuthzConfigError` (500). A source that throws fails the request with the thrown error's status.

Shipped sources:

| Source | `name` | `order` | Answers |
| --- | --- | --- | --- |
| `ServicePrincipalSource` | `service` | 40 | `{ type: 'service', id: <name>, authenticated: true, source: 'service', attributes }` when a configured header holds one of the service's tokens |
| `AuthnPrincipalSource` | `authn` | 50 | `req.storage.AuthnPrincipal`, the principal authn-http resolved from a session, token or key; `null` for none or a session still waiting for MFA |
| `LinkPrincipalSource` | `link` | 110 | a share link principal when the request carries a link token |

`ServicePrincipalSource.authenticate(req)`, per configured service:

1. Reads the request header the entry names (header names are compared lower-case).
2. Skips an absent or empty header.
3. Compares the whole header value with every token of the entry: SHA-256 digests, compared with `timingSafeEqual`. Every token is compared, matched or not.
4. A match returns the service principal. A wrong token yields nothing, so the request falls through to the authn principal: the header may be one other credentials share.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.http.services` | `ServiceEntry[]` | `[]` | list of entries below | Header-token service principals. |
| `authz.http.services[].name` | `string` | required | non-empty | The principal id: the service is `service:<name>`. An entry without a name never authenticates. |
| `authz.http.services[].header` | `string` | required | non-empty header name | The header that carries the token. |
| `authz.http.services[].token` | `string \| string[]` | required | non-empty string, or a non-empty list of them | Accepted tokens; list several to rotate without downtime. |
| `authz.http.services[].attributes` | `object` | `{}` | any object | Copied, frozen, to `principal.attributes`; conditions read them as `principal.*`. |

```ts
export default {
  authz: {
    http: {
      services: [
        // the billing worker calls internal routes with its own key; two tokens during a rotation
        { name: 'billing-worker', header: 'x-service-key', token: ['k-2026-10', 'k-2026-07'], attributes: { region: 'eu' } },
      ],
    },
  },
};
```

AJV checks `authz.http.*` at boot and fails with the full path of a malformed value. Keep tokens out of config files with a [config var protocol](../configuration/05-config-var-protocols.md).

`@spinajs/telemetry` appends its own entries here: a non-empty `telemetry.auth.token` becomes the `telemetry` service on `x-metrics-token` and on `Authorization: Bearer <token>`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `PrincipalSource` (abstract: `name`, `order`, `authenticate(req)`) | `PrincipalSource` list, `@Injectable(PrincipalSource)`, injected into `PrincipalMiddleware` when it resolves; each source is a singleton | `ServicePrincipalSource`, `AuthnPrincipalSource`, `LinkPrincipalSource` | your sources | Add one with `@Injectable(PrincipalSource)` and an `order` that places it. Remove one with `DI.unregister(ServicePrincipalSource)`. Register both before `HttpServer` resolves. |
| `ServicePrincipalSource` | as above | | | Subclass to change matching; `servicePrincipals(entries)` normalises the configured entries (lower-case header, token list, frozen attributes). |
| `AuthnPrincipalSource` | as above | | | Not meant to be replaced: it only copies what authn-http left. |

`PrincipalSource` resolves `AuthzService` per call when it needs it: sources are built with `PrincipalMiddleware`, before the root domain boots, so they must not inject it.

### `PrincipalSource`: custom implementation

Pick an `order` by precedence: below 50 wins over a session or token, above 50 only answers when authn found nothing. Return `null` for anything you do not recognise.

```ts sample
import type { TLSSocket } from 'node:tls';
import { Injectable } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { PrincipalSource } from '@spinajs/authz-http';
import type { Request } from '@spinajs/http';

/** Partner systems call with a client certificate the TLS server verified; its CN names the partner. */
@Injectable(PrincipalSource)
export class ClientCertificateSource extends PrincipalSource {
  public readonly name = 'mtls';
  public readonly order = 45;

  public async authenticate(req: Request): Promise<Principal | null> {
    const socket = req.socket as TLSSocket;
    if (typeof socket.getPeerCertificate !== 'function' || !socket.authorized) {
      return null;
    }

    const certificate = socket.getPeerCertificate();
    const partner = certificate?.subject?.CN;
    if (typeof partner !== 'string' || partner === '') {
      return null;
    }

    return Object.freeze({
      type: 'service',
      id: `partner-${partner}`,
      authenticated: true,
      source: 'mtls',
      attributes: Object.freeze({ fingerprint: certificate.fingerprint256 }),
    });
  }
}
```

Import the module before `HttpServer` resolves; `@Injectable` registers the source on import.

## Important behaviour

- **A service header wins over a session.** `ServicePrincipalSource` (40) runs before `AuthnPrincipalSource` (50), so a request with both a valid service token and a session cookie is the service.
- **The header value is compared whole.** `Authorization: Bearer <token>` matches only a configured token `Bearer <token>`.
- **Rotation is a list.** Add the new token next to the old one, move the callers, then drop the old one.
- **A missing `authz.http.services`** (a configuration that skipped the schema) authenticates no service and throws nothing.
- **Sources run on every request**, guarded route or not. Keep `authenticate()` cheap and free of writes.

## Best practices

- Grant service principals narrow permissions in your model (`service:billing-worker` gets `invoice:read`), never an admin role.
- Give each calling system its own `name`, so audit entries and grants tell them apart.
- Throw from a source only for a credential that is present and wrong in a way the client must see; return `null` otherwise, so other sources still run.

## Patterns and antipatterns

```ts
// Don't: SYSTEM bypasses every check, and PrincipalMiddleware refuses it with a 500.
public async authenticate(req: Request): Promise<Principal | null> {
  return req.headers['x-internal'] === '1' ? SYSTEM : null;
}

// Do: a service principal the model grants exactly what it needs.
public async authenticate(req: Request): Promise<Principal | null> {
  return isTrustedCaller(req) ? Object.freeze({ type: 'service', id: 'scheduler', authenticated: true, source: 'internal', attributes: {} }) : null;
}
```

## Related

- [Principal resolution](03-principal-resolution.md): the middleware that asks the sources.
- [Share links](05-share-links.md): `LinkPrincipalSource` and `LinkResolver`.
- [`@spinajs/authn-http`](../authn-http/README.md): sessions, tokens and keys behind `AuthnPrincipalSource`.
- [Principal sources of http-socket](../http-socket/08-principal-sources.md): the socket counterpart, `SocketPrincipalSource`.
