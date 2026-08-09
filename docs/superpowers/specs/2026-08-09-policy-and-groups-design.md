# `@Policy` AND groups

Date: 2026-08-09
Packages: `@spinajs/http`, `@spinajs/http-swagger`, `@spinajs/rbac-http`, `@spinajs/rbac-http-user`

## Problem

`createPolicyGate` flattened every policy attached to a route — controller-wise
and route-wise alike — into one list and let the request through as soon as
**any** of them resolved. Multiple `@Policy` decorators therefore meant OR, and
there was no way to express "both must hold".

Two controllers were mis-guarded by this:

- `TwoFactorAuthUserController` carried `@Policy(AuthorizedPolicy)` and
  `@Policy(TwoFactorAuthEnabled)`. `AuthorizedPolicy` resolves for any logged-in
  caller, so `TwoFactorAuthEnabled` could never reject one. The system-wide
  `rbac.twoFactorAuth.enabled` switch had to be re-checked by hand inside the
  mutating handlers to compensate.
- `TwoFactorAuthController` carried `@Policy(TwoFacRouteEnabled)` and
  `@Policy(NotAuthorizedPolicy)`, and its own docstring claimed "Both class
  policies must hold". Under OR that was false: an already-authorized session
  still reached the login-time 2FA routes through `TwoFacRouteEnabled` alone.

The same flattening had a wider consequence. A controller-level
`@Policy(AuthorizedPolicy)` was merged into the same OR as the `RbacPolicy` that
`@Permission` attaches per route, so an authorized session passed the gate
whether or not it held the route's permission. That affected every controller
built on that pairing — `rbac-http-admin`, `rbac-http-user`, `orm-api`,
`GrantsController`.

## Semantics

Three levels combine, from the inside out:

- a **group** is one `@Policy()` call. All of its members must resolve — AND.
- a **scope** is every group declared at one place, on the controller class or
  on the route method. Any one of its groups passing is enough — OR.
- the two **scopes** are combined with AND. A controller-wide policy states what
  every route needs, so it can only narrow a route; it must not be satisfiable
  instead of the route's own policies.

```
class:  @Policy(A)
        @Policy([B, C])
route:  @Policy(D)

pass = ( A OR (B AND C) ) AND D
```

The OR within a scope is what keeps several independent access paths to one
resource working, e.g. api token OR session. The AND within a group is what lets
a single path demand several conditions at once, e.g. an authorized session AND
a feature switch.

## Data shape

`IPolicyDescriptor` is unchanged. `Policies` is nested, one inner array per
`@Policy()` call, on both `IRoute` and `IControllerDescriptor`:

```ts
export type IPolicyGroup = IPolicyDescriptor[];

Policies: IPolicyGroup[];
```

This is a breaking change for readers of `.Policies`.

```ts
export function Policy(policy: Constructor<BasePolicy> | string | (Constructor<BasePolicy> | string)[], ...options: any[]) {
  return Route((controller, route) => {
    const group = toArray(policy).map((p) => ({ Options: options, Type: p }));
    if (group.length === 0) return;
    (route ?? controller).Policies.push(group);
  });
}
```

`toArray` from `@spinajs/util` guards with `Array.isArray`, so a configuration
key passed as a string stays one policy rather than being split. `options` apply
to every policy in the group.

`detachInheritedRoutes` copies one level deeper —
`route.Policies.map((g) => [...g])`. With a shallow copy a subclass `@Policy`
push would mutate the parent's group array, the exact cross-class corruption
that function exists to prevent.

## Gate

`resolveRoutePolicies` returns the two scopes separately:

```ts
export interface IResolvedRoutePolicies {
  Controller: BasePolicy[][];
  Route: BasePolicy[][];
}
```

`createPolicyGate` then evaluates:

```
enable(groups) = groups.map(drop disabled members).filter(non-empty)
scopes         = [enable(Controller), enable(Route)].filter(non-empty)
if no scopes   -> next()
pass           = every scope has some group whose every member resolves
otherwise      -> next(first rejection of the first scope that did not hold)
```

A group whose members are all disabled is **dropped, not treated as vacuously
true**. Vacuous-true would open its whole scope for every caller even when a
sibling group in that scope is a live authorization check. A scope left with no
group states no requirement and passes, so a route nothing guards still runs.

Each group is settled with `Promise.allSettled` so a rejecting member never
escapes as an unhandled rejection; the outer `Promise.all` therefore cannot
reject. The existing `.catch(err => next(err))` guard stays, so the request can
never stall without a response.

The reported error is the first rejection of the first scope that did not hold —
reporting a later scope's error would name a requirement the caller never got as
far as.

## `@Permission`

Groups at one scope are alternatives, so a route that needs one more condition
alongside its permission check cannot express it with a second `@Policy` —
`RbacPolicy` passing alone would open the route. `@Permission` therefore accepts
extra policies that join `RbacPolicy` in the same group:

```ts
export function Permission(permission: PermissionType[] = ['readOwn'], ...also: Constructor<BasePolicy>[]) {
  ...
  Policy([RbacPolicy, ...also])(target, propertyKey, undefined);
}
```

## Consumers

- `http-swagger`'s `swagger-cache.ts` flattens groups before extracting policy
  names. The generated document lists policies without AND/OR wording, so its
  output is unchanged.
- `http`'s `cache.ts` receives policy names from `swagger-cache`; only its doc
  comment mentions `.Policies`.
- `Policies: []` initialisers in tests and fixtures remain valid.

## Call sites

```ts
// TwoFactorAuthUserController — class scope
@Policy(AuthorizedPolicy)
// ... and per mutating route
@Permission(['updateOwn'], TwoFactorAuthEnabled)

// TwoFactorAuthController
@Policy([TwoFacRouteEnabled, NotAuthorizedPolicy])
```

`TwoFactorAuthEnabled` is deliberately not a class policy on
`TwoFactorAuthUserController`: `GET /user/2fa` stays readable while the switch is
off, which is how the frontend learns to hide its 2FA controls via
`ITwoFactorStatus.SystemEnabled`. The `assertSystemEnabled` helpers in both
controllers are removed — the gate now enforces what they compensated for.

## Tests

`packages/http/test/policy-groups.test.ts`:

- AND group: both members resolve; one member rejects; first rejection forwarded
- OR within a scope, including a passing single-policy group next to a failing
  AND group
- a group with one disabled member — the remaining member decides
- a fully disabled group does not open its scope; a scope of only disabled
  groups passes; no policies at all passes
- scopes: both must hold; a controller policy cannot stand in for the route's
  own; the first failing scope is the one reported
- `@Policy` shape: array into one group, stacked decorators into separate
  groups, a configuration key inside an array stays one policy, options applied
  to every member

Updated for the nested shape: `controller-inheritance.test.ts` (three
`.Policies` assertions) and `route-builder.test.ts` (descriptor fixture).

`rbac-http-user`: the system-switch tests that called handlers directly now
assert the declaration instead — a direct call is exactly the path that skips
the gate. `two-factor-wire-format.test.ts` is the end-to-end proof and keeps its
original expectations: `GET /user/2fa` answers 200 with `SystemEnabled: false`,
`POST /user/2fa/enable` answers 403 `E_2FA_SYSTEM_DISABLED` — now from the
policy gate rather than from handler code.

## Follow-up

The scope AND closes the `AuthorizedPolicy` / `@Permission` bypass by
construction, but the controllers built on that pairing were written when the
permission check was effectively optional. Each should be re-read to confirm the
permission it declares is the one it wants now that the permission is actually
enforced: `rbac-http-admin` (`Users`, `Roles`, `Security`, `Profile`),
`rbac-http-user` (`UserController`, `SessionsController`,
`UserMetadataController`), `rbac-http` (`GrantsController`), `orm-api`
(`Create`, `Read`, `Update`, `Delete`).
