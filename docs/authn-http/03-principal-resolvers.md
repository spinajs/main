# Principal resolvers

An `AuthnPrincipalResolver` turns one family of credentials, or the restored session, into a `Principal`. `AuthnMiddleware` asks the resolvers in ascending `order` and writes the first answer that is not `undefined` to `req.storage.AuthnPrincipal`. Add a resolver to accept a new credential family or to refuse credentials before the shipped resolvers see them.

## How it works

1. `AuthnMiddleware.principalOf()` calls `resolve(req, credentials, ctx)` on each resolver, lowest `order` first. `credentials` is the [extractor](02-credential-extractors.md) answer or `null`; `ctx.ip` comes from `ClientIp`.
2. Each resolver answers one of three values:
   - `undefined`: none of its credentials; the next resolver is asked;
   - `null`: its credentials are present but give no principal (rejected, expired, revoked, a pending session); resolution **stops**;
   - a `Principal`: resolution stops and this is the caller.
3. All `undefined` gives `null` (anonymous).

The shipped resolvers:

| Order | Resolver | Answers for | Result |
| --- | --- | --- | --- |
| 45 | `KeyPrincipalResolver` | `jws-assertion` and `http-signature` credentials | `AuthnService.authenticate(credentials, ctx)` with purpose `'request'`, then `AuthnService.principalOf(result)`: the key owner (user, service or agent) with the key's scope as ceiling. A failure is `null`. |
| 50 | `TokenPrincipalResolver` | `bearer` credentials | The same calls. An API token gives its owner with `ceiling.roles` = the token's roles plus its scope; an agent token gives an `agent` principal acting `onBehalfOf` the owner; a JWT gives the linked user. A failure is `null`. |
| 100 | `SessionPrincipalResolver` | `req.storage.AuthnSession` | Pending: `null`. Active: `AuthnImpersonationService.principalOf(handle, ctx)`, narrowed to `ceiling.roles = [ActiveRole]` after a [role switch](10-active-role-routes.md). No session: `undefined`. |

**Refused accounts end their sessions.** When `SessionPrincipalResolver` gets no principal for an active session, it asks `IdentityStore.status()` for the subject and the impersonator. Each that is missing, deleted, banned or inactive has every session ended through `AuthnImpersonationService.endFor()`. `service` and `agent` identities are not asked.

`SessionPrincipalResolver.principalOfSession(session, ctx)` does the same without an HTTP request; [socket sessions](18-socket-sessions.md) use it.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthnPrincipalResolver` (abstract, exported) | Registered `.as(AuthnPrincipalResolver)`, resolved by `AuthnMiddleware` as an `Array.ofType` list; the shipped ones are `@PerChildInstance()` | `KeyPrincipalResolver`, `TokenPrincipalResolver`, `SessionPrincipalResolver`, registered at package load | your own | Extend it, set `order`, implement `resolve()`, `DI.register(Mine).as(AuthnPrincipalResolver)` before `HttpServer` resolves. Subclass a shipped one and register it `.as(TheShippedClass)` to change it. |
| `AuthnService` | resolved per call by the key and token resolvers | `DefaultAuthnService` from `@spinajs/authn` | | See [`@spinajs/authn`](../authn/README.md). |
| `AuthnImpersonationService`, `IdentityStore`, `PrincipalFactory` | resolved per call by `SessionPrincipalResolver` | from `@spinajs/authn` and `@spinajs/users` | | See [`@spinajs/users`](../users/README.md). |

Members:

| Member | Meaning |
| --- | --- |
| `order: number` | Lower is asked first. |
| `resolve(req, credentials, ctx): Promise<Principal \| null \| undefined>` | Never throw for bad credentials; answer `null`. A throw fails the request (500). |

### `AuthnPrincipalResolver`: custom implementation

A resolver with a low `order` can refuse credentials before any strategy runs. Answer `null` to stop resolution; the request continues as anonymous. Verify credentials through `AuthnService.authenticate()`, never through a token or key store directly, so the throttle and the audit apply.

```ts sample
import '@spinajs/authn-http';
import { AuthnPrincipalResolver } from '@spinajs/authn-http';
import { DI } from '@spinajs/di';
import type { AuthnContext, Credentials, Principal } from '@spinajs/authn/contracts';
import type { Request } from '@spinajs/http';

const BLOCKED_PREFIXES = ['203.0.113.'];

/** API tokens and keys from a blocked network get no principal; browser sessions are not affected. */
export class BlockedNetworkResolver extends AuthnPrincipalResolver {
  // Before KeyPrincipalResolver (45) and TokenPrincipalResolver (50).
  public readonly order = 10;

  public async resolve(_req: Request, credentials: Credentials | null, ctx: AuthnContext): Promise<Principal | null | undefined> {
    if (!credentials) return undefined;
    return BLOCKED_PREFIXES.some((prefix) => ctx.ip?.startsWith(prefix)) ? null : undefined;
  }
}

DI.register(BlockedNetworkResolver).as(AuthnPrincipalResolver);
```

## Important behaviour

- `null` stops resolution. A rejected token never falls through to the session or another credential.
- The key and token resolvers resolve `AuthnService` per call, so apps that register no token or key strategy still boot.
- A pending session gives `null` from `SessionPrincipalResolver`, but only when no earlier resolver answered: a pending session plus a valid bearer token gives the token's principal.
- An impersonation session gives the target, with `authn.impersonator` set to the impersonator.
- Resolver errors (a store that fails) go to `next(err)` and answer 500; the request never continues as anonymous.

## Best practices

- Pick an `order` below 45 to act before the shipped resolvers, above 100 to act only when none of them answered.
- Answer `undefined` for credential kinds you do not handle, so the shipped resolvers still see them.

## Patterns and antipatterns

```ts
// Don't: verify a token against the store directly; no throttle, no audit
const record = await tokenStore.find(credentials.token);
return record ? principalFor(record) : null;

// Do: verify through AuthnService
const authn = await this.Container.resolve(AuthnService);
const result = await authn.authenticate(credentials, { ...ctx, purpose: 'request' });
return result.status === 'success' ? authn.principalOf(result) : null;
```

## Related

- [Request authentication](01-request-authentication.md): where the resolvers run.
- [Credential extractors](02-credential-extractors.md): where `credentials` come from.
- [`@spinajs/authn`](../authn/01-authentication-flow.md): `authenticate()` and `principalOf()`.
- [`@spinajs/users`: principal factory](../users/09-principal-factory.md): how the principal is built for a user.
- [`@spinajs/authz-http`](../authz-http/README.md): reads the resolved principal.
