# Extending the session issuer

`DefaultSessionIssuer` is registered as `SessionIssuer` and can be subclassed. Extend it to change what the issuer reports or records, such as the device list or the public session data, and keep its hashing and revocation guarantees. Replace `SessionIssuer` entirely only when sessions do not live in a `SessionProvider` at all.

## How it works

1. Importing `@spinajs/authn-session` registers `DefaultSessionIssuer` with `@Injectable(SessionIssuer)`.
2. Your subclass, decorated `@Injectable(SessionIssuer)`, registers a second implementation under the same token. A single resolve takes the last registration, so your class wins when its module loads after `@spinajs/authn-session`; importing `DefaultSessionIssuer` from it guarantees that.
3. `DefaultSessionIssuer` is `@PerChildInstance()`, and a subclass inherits that lifetime: each container that resolves `SessionIssuer` builds one instance, which reads that container's `authn.session` (store, `pendingTtlSeconds`). `AuthnService`, `AuthnMiddleware`, the routes of `@spinajs/authn-http` and `@spinajs/users` resolve `SessionIssuer`. Register before the first of them resolves it.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Session issuer | `SessionIssuer` (from `@spinajs/authn/contracts`), `@PerChildInstance()`: one per container | `DefaultSessionIssuer` | `MemorySessionIssuer` of `@spinajs/authn-testing` (tests) | Subclass `DefaultSessionIssuer` with `@Injectable(SessionIssuer)`; or implement `SessionIssuer` and `DI.register(MyIssuer).as(SessionIssuer)` |

Protected members of `DefaultSessionIssuer`:

| Member | What it does | Override to |
| --- | --- | --- |
| `Store: SessionProvider` | The store, injected from `authn.session` | Read rows directly in your own methods |
| `Container: IContainer` | The container `resolveSession` builds sessions in | |
| `PendingTtlSeconds: number` | `authn.session.pendingTtlSeconds` | |
| `refresh(session)` | Records last-seen (at most once a minute) and calls `Store.touch`; runs on every non-peeking `restore` of an active session | Record more per-request data in the same write |
| `publicData(session)` | The entries `Session.data` gets: all except `authn:` ones, plus the pending steps | Hide or add entries |
| `factsOf(session, stored)` | Builds `AuthnFacts` from the stored facts, the row's impersonator and the handle | Rarely; its `stored` parameter type is not exported |
| `need(h)` | Reads the row of a handle or throws `InvalidArgument` / `InvalidOperation` | |
| `moveTo(session, data, over)` | The re-keying of `rotate` and `elevate` | |

### `DefaultSessionIssuer`: custom implementation

Call `super` and adjust the result; do not re-implement the ordering of `moveTo` or `set`, which carries the revocation guarantees.

```ts sample
import { Injectable } from '@spinajs/di';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { IdentityRef, SessionHandle } from '@spinajs/authn/contracts';
import { DefaultSessionIssuer } from '@spinajs/authn-session';

/** Privacy policy: the device list shows the browser and times, never the client IP. */
@Injectable(SessionIssuer)
export class PrivacySessionIssuer extends DefaultSessionIssuer {
  public async list(subject: IdentityRef, opts?: { current?: SessionHandle }) {
    const rows = await super.list(subject, opts);
    return rows.map(({ ip, ...row }) => row);
  }
}
```

Import the module in the app entry, before the HTTP server starts. `GET /user/sessions` of `@spinajs/authn-http` then answers without `ip`.

## Important behaviour

- **`peek` and `peekingSessions` belong to `DefaultSessionIssuer`.** An issuer that does not extend it ignores `peekingSessions`; socket revalidation then restores its sessions like a request does.
- **The contract's guarantees are yours to keep** when you implement `SessionIssuer` from scratch: hashed storage, rotation on privilege change, `revoke` true once, owner-bound `revokeHandle`, pending sessions with no principal. `runSessionIssuerConformance()` of `@spinajs/authn-testing` checks them.
- **One issuer per container.** The instance a container builds on its first resolve stays in that container's cache and in every object it was injected into; a registration after that has no effect on them. A child container that resolves `SessionIssuer` gets its own instance, with the store and `pendingTtlSeconds` of its own `authn.session`.

## Best practices

- Prefer a [custom store](05-writing-a-session-store.md) when the change is about where sessions live, a [custom strategy](03-expiration-strategies.md#sessionexpirationprovider-custom-implementation) when it is about when they expire, and a [custom session class](08-custom-session-class.md) when it is about reading data. Subclass the issuer only for what none of them covers.
- Keep reserved keys reserved: an override of `set` that lets `Subject`, `State` or an `authn:` key through lets data change who the session belongs to.

## Patterns and antipatterns

```ts
// Don't: re-implement rotate; a copy saved after a parallel logout brings the session back
public async rotate(h: SessionHandle): Promise<SessionHandle> {
  const row = await this.Store.restore(storageKeyOf(h.id));
  await this.Store.delete(row!.SessionId);
  return this.issue(row!.Subject, facts);
}

// Do: wrap the default
public async rotate(h: SessionHandle): Promise<SessionHandle> {
  const next = await super.rotate(h);
  this.Metrics.increment('session.rotated');
  return next;
}
```

## Examples

The `PrivacySessionIssuer` above is a complete example.

## Related

- [Issuing and restoring sessions](01-issuing-and-restoring-sessions.md): what each public method does.
- [Revocation and the session list](02-revocation-and-session-list.md): `list`, which the example changes.
- [Multiple implementations](../di/06-multiple-implementations.md): why the last registration wins.
- [`@spinajs/authn`](../authn/README.md): the `SessionIssuer` contract.
