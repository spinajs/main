# Impersonation and the active role

An authorized actor (typically an admin) can act as another user. Who may
impersonate whom is an authorization question, answered by an
`ImpersonationGuard`. How an impersonation lives on a session, how it ends and
what it audits is this module. The active-role switch shares the session data
and the role ceiling, so it is described here too.

## What it provides

- `AuthnImpersonationService`:
  - `start(session, target, ctx, reauth?)` resolves to `{ ok: true, session }`
    with a new session for the target, or `{ ok: false }`. It says no reason;
    the reason goes to the audit event.
  - `stop(session, ctx)` resolves to a new session for the impersonator, or
    `null` when this is no live impersonation or the impersonator may no
    longer log in.
  - `principalOf(session, ctx)` resolves to the `Principal` a request with
    this session acts as, or `null`. It also enforces the expiry rules below,
    so call it on every request.
  - `endFor(impersonator, { except? })` revokes every session of an identity,
    the impersonations it runs included. Call it when you ban or deactivate an
    identity or change or reset its password (SR-06). It audits nothing.
- `IMPERSONATION_BLOCK`: the session data key of the block described below.
- `ImpersonationGuard` (`contracts/impersonation.ts`):
  `allowed(actor, target)` answers `{ ok: true }` or `{ ok: false, code }` with
  `forbidden`, `protected_role` or `escalation`. `AuthzImpersonationGuard` in
  `@spinajs/users` implements it over authz (`authn.*` never imports authz).
- `ACTIVE_ROLE_KEY` and `activeRoleCeiling(data)`: the role chosen by a role
  switch, as a ceiling `{ roles: [role] }` that narrows the principal.

## DI registration

`AuthnImpersonationService` is a `@PerChildInstance()` `AsyncService`, one per
container. It resolves these neighbours when it starts:

| Neighbour | How | If missing |
| --- | --- | --- |
| `SessionIssuer` | `resolve(T, true)` | boot fails |
| `IdentityStore` | `resolve(T, true)` | boot fails |
| `PrincipalFactory` | `resolve(T, true)` | boot fails |
| `ImpersonationGuard` | `resolveOptional(T)` | every `start` is refused (`no_guard`); the HTTP routes answer 404 |
| `FreshAuthCheck`, `AuthnAudit` | `resolve(T)` | in `@spinajs/authn` itself |

Register a guard in the app (or import `@spinajs/users`) to turn impersonation
on.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `authn.impersonation.requirePassword` | `true` | `start` needs a fresh session or a re-authentication (`reauth`). Off only when set to `false`. |
| `authn.impersonation.requireMfa` | `true` | The actor's session must be `aal2`. |
| `authn.impersonation.maxMinutes` | `60` | Longest impersonation. Minimum 1. |
| `authn.impersonation.clockSkewSeconds` | `30` | Tolerance for a block whose start time disagrees with the session by clock drift between instances. 0 to 300. |

The lifetime of the session itself, `authn.session.expiration.maxLifetime`,
also bounds an impersonation (see below).

## Flow

### Start

`start` checks, in order, and refuses at the first failure: a guard is
registered; the session is the actor's own active session and is not already
an impersonation (`nested`); it is within the session lifetime; the target is a
user (`invalid_target`, `self`, `non_user_target`); the session is `aal2` when
`requireMfa`; the actor is still allowed to log in; the session is fresh, or
`reauth` re-authenticates it, when `requirePassword`; the target is allowed to
log in; and the guard consents. The audit event `impersonation.start` carries
`reason` with the failed check. Two starts or stops on one session in
parallel are serialized, so both cannot pass the checks.

On success it issues a new session for the target and revokes the actor's
session, so the id rotates. The new session keeps the actor's method,
strategy, assurance, MFA steps and authentication time, and sets
`facts.impersonator` to the actor. Authentication time stays the actor's, so
the new session is not fresh just because it is new, and `FreshAuthCheck`
never treats an impersonation as fresh.

### The session block

The new session holds one data entry, `IMPERSONATION_BLOCK`:
`{ startedAt, actorRoles? }`. `startedAt` is an ISO time. `actorRoles` holds
the role of the actor's active-role switch at the start (at most one), because
a role switch and an impersonation are separate narrowings: the block does not
reuse `ActiveRole`, which would narrow the target. `stop` puts it back as the
impersonator's `ActiveRole`. A session migrated from 2.x has no block; its
authentication time stands in for the start and there is no actor ceiling.

A block is unreadable (the impersonation ends with `invalid_block`) when it is
not an object, its time or roles cannot be parsed, or its start lies ahead of
now or before the authentication by more than `clockSkewSeconds`. Nothing
honest writes such a block.

### Session states

An impersonation session is an `active` session whose facts carry an
`impersonator`. A `pending` session (before MFA) cannot start one. The
principal of an impersonation session is the target, with
`principal.authn.impersonator` set. After a stop or an end, `principalOf` on the
old session answers `null`, never the impersonator, because a request cannot
rotate its own cookie.

### Checked on every request

`principalOf` ends the impersonation, revokes the session and audits it when:

- `maxMinutes` has passed since `startedAt`: `impersonation.expire`, reason
  `max_minutes`;
- the session is past `authn.session.expiration.maxLifetime` counted from the
  actor's login: reason `session_lifetime`. A start or stop issues a new row
  whose store lifetime would begin again, so the bound is checked here;
- the actor or the target is no longer allowed to log in (`impersonator_*`,
  `target_*` with `banned`, `deleted`, `inactive`, `unknown_identity`);
- the guard no longer consents, asked with the actor's role switch applied
  (`forbidden`, `protected_role`, `escalation`, `guard_error`).

An explicit `stop` audits `impersonation.end`. An impersonator that may no
longer log in gets no new session: the impersonation ends and `stop` returns
`null`.

### Audit events

`impersonation.start`, `impersonation.end` and `impersonation.expire`, each
with `outcome`, `reason` for failures and endings, `identity` (the target),
`actor` (the impersonator) and the hashed `session` handle. They never carry
a raw session id.

## HTTP

`@spinajs/authn-http` serves it under `auth`. The whole controller answers
404 while no `ImpersonationGuard` is registered.

| Route | Purpose |
| --- | --- |
| `GET auth/impersonate` | `{ Active: false }`, or the impersonator, the target and `StartedAt`. |
| `POST auth/impersonate` | Body `{ target, password? }`; `target` is a user id or `{ type, id }`. Needs an MFA-satisfied session and fresh authentication (a recent login, or `password` through the throttled re-authentication). 400 for a malformed target, 401 when the password fails, 403 `impersonation_refused` for every other refusal. Sets the cookie of the new session. |
| `DELETE auth/impersonate` | Ends it and sets the impersonator's cookie. 400 `not_impersonating` when none is active. |

`AuthnImpersonationController` serves these. `AuthnActiveRoleController`
serves the role switch: `GET auth/active-role` gives `ActiveRole` and the
roles `RoleSource` returns; `POST auth/active-role` with `{ role, password? }`
rotates the session and stores `ActiveRole`. It asks for a password unless the
role says `requirePassword: false`, and it is refused while impersonating.
Both need a registered `RoleSource`.

## Programmatic use

Code that holds the session handle can drive the service directly, for
example a support tool or a job that acts as a user:

```ts
import type { AuthnContext, AuthnImpersonationService, IdentityRef, Principal, SessionHandle } from '@spinajs/authn';

async function actAs(svc: AuthnImpersonationService, session: SessionHandle, target: IdentityRef, ctx: AuthnContext): Promise<{ as: Principal; back: SessionHandle } | null> {
  const started = await svc.start(session, target, ctx);
  if (!started.ok) return null;
  const as = await svc.principalOf(started.session, ctx);
  const back = await svc.stop(started.session, ctx);
  return as && back ? { as, back } : null;
}
```

Hand the session you get back (`started.session`, then `back`) to your cookie
issuer: the old ids are revoked. `start` in this form needs the actor's
session to be `aal2` and fresh unless you turn those keys off; pass a
`reauth` credential as the fourth argument when it is not fresh.

## Why audit sinks, not a separate event bus

Impersonation publishes to `AuthnAudit` and not to a second, in-process event
bus. `AuthnEventSink` already is the in-process observer: DI resolves every
registered sink through `Array.chainOf`, each sink gets every event, and
`AuthnAudit` delivers them together under a per-sink timeout, so a slow sink
cannot hold up a login. `QueueAuthnEventSink` in `@spinajs/users` is only one
sink, the one that forwards to the queue (`UserImpersonationStarted` and
`UserImpersonationEnded`). A subscriber registers a sink instead of a handler.
A second mechanism would give two ways to observe the same fact and a second
place to decide delivery, ordering and failure.
