# Route arguments

Five parameter decorators hand a route what [`AuthnMiddleware`](01-request-authentication.md) found: the caller's identity and authentication facts, the session handle, the raw session id, or a value stored in the session. They read `req.storage`, never the cookie.

## How it works

1. Each decorator registers a route parameter of a named type: `AuthnIdentityArg`, `AuthnSessionArg`, `AuthnSessionIdArg` or `AuthnSessionDataArg`.
2. `@spinajs/http` resolves the route argument class by that name from the root container. The package registers the four classes there when it loads (`registerAuthnHttpV3()`).
3. Per request, the class's `extract()` returns the value from `req.storage.AuthnPrincipal` or `req.storage.AuthnSession`.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Identity()` | parameter | | `AuthnIdentity` `{ identity: { type, id }, facts }` of `req.storage.AuthnPrincipal`, or `null` without an authenticated principal (a pending session gives `null`). `facts` is the principal's `authn` (`method`, `strategy`, `assurance`, `mfa`, `authenticatedAt`, `impersonator?`, `sessionHandle?`). For an agent, `identity` is the agent, not `onBehalfOf`. |
| `@AuthnSession()` | parameter | | The `SessionHandle` of `req.storage.AuthnSession`, pending included, or `null`. Not authentication: check `handle.state`. |
| `@SessionId()` | parameter | | The raw id of the restored session, pending included, or `null`. An unknown or expired cookie gives `null`. Never log or return it. |
| `@FromSession(key)` | parameter | `key`: non-empty string, checked when the decorator runs | The value stored under `key` in the session data (`SessionIssuer.set()`), or `undefined` without a session or key. Pending sessions included. |
| `@ClientContext()` | parameter | | `AuthnClientContext` `{ ip?, userAgent?, session?, principal? }`: `req.storage.ClientIp` (never Express's ip), the `User-Agent` header, `req.storage.AuthnSession` (pending included) and `req.storage.AuthnPrincipal`. What the package's own handlers take instead of `@Req()`. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthnIdentityArg`, `AuthnSessionArg`, `AuthnSessionIdArg`, `AuthnSessionDataArg`, `AuthnClientContextArg` | registered `.asSelf()` on the root container at package load, looked up by class name | the classes in `src/args/authn.ts` (not exported) | | Not meant to be replaced. Write your own argument as in [Custom route arguments](../http/05-custom-route-arguments.md). |

## Important behaviour

- `@AuthnSession()`, `@SessionId()` and `@FromSession()` see pending sessions. Guard the route with [`Authenticated`](05-policies.md) when it needs a signed-in caller.
- `@Identity()` counts a principal only when `authenticated` is `true`, as `Authenticated` does.
- An active session that gave no principal is dropped from `req.storage.AuthnSession` by `AuthnMiddleware`, so these arguments give `null` for it.

## Best practices

- Prefer `@Identity()` over `@Req()` plus `req.storage.AuthnPrincipal`: it narrows to the fields a route needs.
- Store small per-session values with `SessionIssuer.set(handle, key, value)` and read them with `@FromSession(key)`.

## Patterns and antipatterns

```ts
// Don't: the raw session id is a bearer secret
@Get('debug')
public async debug(@SessionId() id: string | null) {
  return new Ok({ session: id });
}

// Do: the handle identifies the session without being usable as a cookie
@Get('debug')
public async debug(@AuthnSession() handle: SessionHandle | null) {
  return new Ok({ state: handle?.state ?? null });
}
```

## Examples

### Show the caller's assurance level and remembered cart

```ts sample
import '@spinajs/authn-http';
import { Authenticated, FromSession, Identity } from '@spinajs/authn-http';
import type { AuthnIdentity } from '@spinajs/authn-http';
import { BaseController, BasePath, Get, Ok, Policy } from '@spinajs/http';

@BasePath('checkout')
@Policy(Authenticated)
export class CheckoutController extends BaseController {
  @Get('/')
  public async summary(@Identity() who: AuthnIdentity, @FromSession('cart') cart: unknown) {
    return new Ok({
      user: who.identity.id,
      // Payment needs a passed second factor.
      canPay: who.facts.assurance === 'aal2',
      cart: cart ?? [],
    });
  }
}
```

## Related

- [Route arguments in `@spinajs/http`](../http/04-route-arguments.md): how route arguments resolve.
- [Policies](05-policies.md): guard the route before reading these values.
- [`@spinajs/authn-session`](../authn-session/README.md): `SessionHandle`, session data and `SessionIssuer.set()`.
