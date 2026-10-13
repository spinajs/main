# Fresh authentication

Sensitive actions (change a password, enrol MFA, create a token, start an
impersonation) need proof that the user is at the keyboard now, not only that
a session exists. `FreshAuthCheck` answers that question for code that has a
session handle. The HTTP layer wraps it in a route policy.

## What it provides

- `FreshAuthCheck.check(session, ctx, reauth?)`: resolves to `true` when the
  session is fresh, or when `reauth` re-authenticates its identity; `false`
  otherwise. It never throws for a bad session or bad credentials.
- `FreshAuthCheck.maxAgeSeconds`: the configured window.
- `isFresh(facts, now, maxAgeSeconds)` (`contracts/fresh.ts`): the pure age
  test, also usable on a `Principal`'s `authn` facts. It is true when
  `authenticatedAt` lies within `maxAgeSeconds` before `now`, the boundary
  included. A time after `now`, an invalid time and any impersonation are
  not fresh. A `maxAgeSeconds` that is not a positive number throws
  `RangeError`.
- The `FreshAuth` policy in `@spinajs/authn-http`
  (`policies/v3/fresh-auth.ts`), for routes:
  `@Policy(FreshAuth)` or `@Policy(FreshAuth, 600)` for a stricter window.

## DI registration

`FreshAuthCheck` is a `@PerChildInstance()` `AsyncService`: one per
container, so a child container reads its own configuration. It registers
itself when `@spinajs/authn` loads; there is nothing to list in config.

It resolves two neighbours when it starts:

- `SessionIssuer`, required (`resolve(SessionIssuer, true)`): boot fails when
  none is registered. `@spinajs/authn-session` provides one.
- `AuthnService`, for the re-authentication.

It is not named `FreshAuth` because DI keys classes by name and the HTTP
policy has that name.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `authn.freshAuth.maxAgeSeconds` | `300` | A session authenticated this many seconds ago or less counts as fresh. Minimum 1. |

## Flow

`check` restores the session by its raw id and then:

1. A handle without an id, a session that is gone, one that is not `active`
   (a pending pre-MFA session is not) or one with an `impersonator` returns
   `false`. An impersonator must not act on the target's credentials, and
   `reauth` is not tried.
2. A session whose `authenticatedAt` is within `maxAgeSeconds` of `ctx.now`
   returns `true`, and `reauth` is not looked at.
3. Otherwise, with `reauth` given, `AuthnService.reauthenticate(session,
   reauth, ctx)` decides. It verifies an interactive strategy (a password,
   not a token), counts into the `reauth` throttle and refuses an
   impersonated session. Without `reauth` the answer is `false`.

A successful re-authentication counts for the current request only. It does
not change `authenticatedAt` and does not rotate the session id, so the next
sensitive request asks again once the window has passed.

```ts
import { FreshAuthCheck } from '@spinajs/authn';
import type { AuthnContext, SessionHandle } from '@spinajs/authn';

async function guarded(check: FreshAuthCheck, session: SessionHandle, ctx: AuthnContext, password?: string): Promise<'done' | 'fresh_auth_required'> {
  const fresh = await check.check(
    session,
    { ...ctx, purpose: 'reauth' },
    password === undefined ? undefined : { kind: 'password', login: 'alice@example.test', password },
  );
  return fresh ? 'done' : 'fresh_auth_required';
}
```

## The HTTP policy

`FreshAuth` passes a session principal that is fresh. A route can also take
the password in the request body as `reauthPassword`; the policy removes the
field (and the raw body) before the route runs, so the account password
never reaches a model copy or a request log. Answers:

- 401 when there is no principal, or the re-authentication fails or is
  throttled (the usual authentication-failure body, no retry information);
- 403 `session_required` for a per-request principal such as a token or key;
- 403 `impersonating` during an impersonation;
- 403 `fresh_auth_required` for a stale session with no password.

When a route sets a `maxAgeSeconds` stricter than the configured one, the
policy verifies the password through `reauthenticate` itself: `check` would
pass a session that is fresh under the longer window. Routes that take the
password in their own body (role switch, impersonation) call
`assertFreshAuth(container, req, maxAgeSeconds, password)` directly.
