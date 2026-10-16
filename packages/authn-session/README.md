# `@spinajs/authn-session`

Session issuing, stores and codecs for SpinaJS authentication.

## Your own session class

`restore` builds the class registered as `Session` (from `@spinajs/authn/contracts`) in the container, `Session`
itself by default. Register a subclass to add typed reads of your own data keys:

```ts
import { NewInstance, DI } from '@spinajs/di';
import { Session, sessionKey } from '@spinajs/authn/contracts';

const Cart = sessionKey('Cart', (raw) => (Array.isArray(raw) ? raw.filter((i): i is string => typeof i === 'string') : []));

@NewInstance()
export class AppSession extends Session {
  public get cart(): string[] {
    return this.get(Cart) ?? [];
  }
}

DI.register(AppSession).as(Session);
// in a route: (req.storage.AuthnSession as AppSession | null)?.cart
```

The class registered in the container that resolves the issuer decides: `DefaultSessionIssuer`, `AuthnMiddleware` and the socket source are root singletons, so register with `DI.register(AppSession).as(Session)`. A child-container registration applies only to an issuer resolved in that child, such as `new MemorySessionIssuer({ container: child })`.

- The constructor takes the `SessionInit` and passes it to `super`. Use no constructor `@Inject`, because it would come before the init.
- Keep `@NewInstance()`, and re-declare it whenever the class carries another DI decorator. A shared instance is refused.
- Do not depend on an `AsyncService`, because sessions are built synchronously.
- `@Autoinject` fields are assigned after the constructor runs, so the constructor sees them as `undefined`.
- Do not override `activeRole`, `impersonation`, `impersonator`, `pendingSteps`, `get` or `has`, and do not filter `init.data`. authn reads role narrowing and the impersonation block through them.
- A registered class or factory must resolve to a `Session` instance, or the build throws.
- Write data with `SessionIssuer.set(handle, Cart.name, value)`.
