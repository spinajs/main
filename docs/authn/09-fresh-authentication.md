# Fresh authentication

Sensitive actions (change a password, enrol MFA, create a token, start an impersonation, link an account) need proof that the user is at the keyboard now, not only that a session exists. `FreshAuthCheck` answers that for code that holds a session handle. `@spinajs/authn-http` wraps it in the `FreshAuth` route policy.

## How it works

`FreshAuthCheck.check(session, ctx, reauth?)`:

1. Restores the session by its raw id. A handle without an id, a session that is gone, one that is not `active` (a pending session is not) and an impersonation all answer `false`. `reauth` is not tried.
2. A session whose `facts.authenticatedAt` lies within `authn.freshAuth.maxAgeSeconds` before `ctx.now` answers `true`. `reauth` is not looked at.
3. Otherwise, with `reauth` given, `AuthnService.reauthenticate(session, reauth, ctx)` decides: an interactive strategy verifies, the `reauth` throttle counts, and the identity must be the session's own. Without `reauth` the answer is `false`.

`check` never throws for a bad session or bad credentials. A successful re-authentication counts for the current request only: it changes no fact and does not rotate the session id.

`isFresh(facts, now, maxAgeSeconds)` is the pure age test, also usable on `principal.authn`. It is `true` when `authenticatedAt` lies within `maxAgeSeconds` before `now`, the boundary included. A time after `now`, an invalid time and any impersonation are not fresh. A `maxAgeSeconds` that is not a positive finite number throws `InvalidArgument`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.freshAuth.maxAgeSeconds` | `integer` | `300` | ≥ 1 | A session authenticated this many seconds ago or less counts as fresh |

```ts
authn: { freshAuth: { maxAgeSeconds: 300 } }
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `FreshAuthCheck` | Class token, per child container | `FreshAuthCheck` | None | Not meant to be replaced; it needs a registered `SessionIssuer` |

It is not named `FreshAuth`: DI keys classes by name, and the route policy in `@spinajs/authn-http` has that name.

## Important behaviour

- An impersonation is never fresh. The impersonator must not act on the target's credentials.
- `reauth` takes only interactive credentials, such as a password. A token or key the client holds does not prove presence.
- Re-authentication attempts count into the `reauth` throttle flow, keyed by the identity.

## Best practices

- Pass the password inline as `reauth` instead of sending the user to log in again: the session id stays the same.
- Set `ctx.purpose` to `reauth` when you call `check` from your own code.

## Examples

### Guard an action with fresh authentication

```ts sample
import { FreshAuthCheck } from '@spinajs/authn';
import type { AuthnContext, SessionHandle } from '@spinajs/authn';

export async function guarded(check: FreshAuthCheck, session: SessionHandle, ctx: AuthnContext, login: string, password?: string): Promise<'done' | 'fresh_auth_required'> {
  const fresh = await check.check(session, { ...ctx, purpose: 'reauth' }, password === undefined ? undefined : { kind: 'password', login, password });
  return fresh ? 'done' : 'fresh_auth_required';
}
```

## Related

- [Authentication flow](01-authentication-flow.md#re-authentication-reauthenticate): what `reauthenticate` checks.
- [`@spinajs/authn-http`](../authn-http/README.md): the `FreshAuth` policy and the `reauthPassword` body field.
- [Account linking](10-account-linking.md) and [Impersonation](11-impersonation-and-active-role.md): both call `FreshAuthCheck`.
