# Custom session class

`DefaultSessionIssuer.restore()` returns the class registered as `Session` (from `@spinajs/authn/contracts`), and `Session` itself by default. Register a subclass to give routes typed reads of your own session data, such as `session.cart` instead of decoding `session.data.get('Cart')` everywhere. The `Session` class, `SessionKeys` and `sessionKey` are described in [Session contract](../authn/08-session-contract.md#the-session-class); this page covers how `DefaultSessionIssuer` builds the subclass.

## How it works

1. `restore()` finishes with `resolveSession(container, { handle, identity, facts, data })` from `@spinajs/authn/contracts`.
2. `resolveSession` resolves `Session` from the issuer's container with that init object as the constructor argument. Your registration `DI.register(AppSession).as(Session)` makes it build `AppSession`.
3. It checks the result: it must be a `Session` instance, and it must not be an instance handed out before (a shared instance would give one session to every request). Either failure throws `Error`.
4. `AuthnMiddleware` of `@spinajs/authn-http` puts the result in `req.storage.AuthnSession`. A session it gets as a plain object goes through `resolveSession` too.

Which container counts: the one that resolves the issuer. `DefaultSessionIssuer` is `@PerChildInstance()`: each container that resolves it builds its own, and that issuer builds sessions in its own container. `AuthnMiddleware` and the socket session source of `@spinajs/authn-http` are root singletons and use the root container's issuer, so register in the root container: `DI.register(AppSession).as(Session)`. A child-container registration applies only to an issuer resolved in that child, such as `new MemorySessionIssuer({ container: child })` of `@spinajs/authn-testing`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Restored session | `Session` (from `@spinajs/authn/contracts`), `@NewInstance()`, built per `restore` | `Session` | Your subclass | `@NewInstance()` subclass of `Session`, `DI.register(AppSession).as(Session)` in the root container before the first request |
| Typed data key | `sessionKey(name, decode)` from `@spinajs/authn/contracts` | `SessionKeys.ActiveRole`, `Impersonation`, `Ip`, `UserAgent`, `PendingSteps` | Your keys | Define a key, read it with `Session.get(key)`, write it with `SessionIssuer.set(handle, key.name, value)` |

### `Session`: custom implementation

Rules for the subclass:

- The constructor takes the `SessionInit` and passes it to `super`. Use no constructor `@Inject`: it would come before the init argument.
- Keep `@NewInstance()`, and repeat it whenever the class carries another DI decorator. A shared instance is refused.
- Do not depend on an `AsyncService`: sessions are built synchronously, and the resolve would return a `Promise`, which is refused.
- `@Autoinject` fields are assigned after the constructor runs; the constructor sees them as `undefined`.
- Do not override `activeRole`, `impersonation`, `impersonator`, `pendingSteps`, `get` or `has`, and do not filter `init.data`. authn reads the role narrowing and the impersonation block through them.

```ts sample
import { DI, NewInstance } from '@spinajs/di';
import { Session, sessionKey } from '@spinajs/authn/contracts';

export const Cart = sessionKey('Cart', (raw) => (Array.isArray(raw) ? raw.filter((sku): sku is string => typeof sku === 'string') : []));

@NewInstance()
export class AppSession extends Session {
  public get cart(): string[] {
    return this.get(Cart) ?? [];
  }
}

DI.register(AppSession).as(Session);
```

## Important behaviour

- **`Session.data`** holds the public entries only; the issuer's own `authn:` entries never reach it.
- **The init is a snapshot.** A session object does not change when `set` writes later; the next `restore` builds a new one.

## Best practices

- Decode defensively in `sessionKey`: stored data may come from an older release of your app.
- Expose read-only getters; write through `SessionIssuer.set(handle, Cart.name, value)` so the write reaches the store.

## Patterns and antipatterns

```ts
// Don't: a singleton session class hands one request's session to the next; resolveSession throws
@Singleton()
export class AppSession extends Session {}

// Do
@NewInstance()
export class AppSession extends Session {}
```

## Examples

### Add a product to the cart of the current session

```ts sample
import { DI, NewInstance } from '@spinajs/di';
import { Session, SessionIssuer, sessionKey } from '@spinajs/authn/contracts';

const Cart = sessionKey('Cart', (raw) => (Array.isArray(raw) ? raw.filter((sku): sku is string => typeof sku === 'string') : []));

@NewInstance()
export class ShopSession extends Session {
  public get cart(): string[] {
    return this.get(Cart) ?? [];
  }
}

DI.register(ShopSession).as(Session);

/** `session` is req.storage.AuthnSession of the request. */
export async function addToCart(session: ShopSession, sku: string): Promise<string[]> {
  const next = [...session.cart.filter((s) => s !== sku), sku];
  const sessions = await DI.resolve(SessionIssuer);
  await sessions.set(session.handle, Cart.name, next);
  return next;
}
```

## Related

- [Session contract](../authn/08-session-contract.md): the `Session` class, `SessionKeys`, `resolveSession` and the `SessionIssuer` contract.
- [Issuing and restoring sessions](01-issuing-and-restoring-sessions.md): where `restore` builds the session.
- [Lifetimes](../di/04-lifetimes.md): `@NewInstance()` and why a subclass repeats it.
