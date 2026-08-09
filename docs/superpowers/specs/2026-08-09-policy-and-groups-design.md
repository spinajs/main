# `@Policy` AND groups

Date: 2026-08-09
Packages: `@spinajs/http`, `@spinajs/http-swagger`, `@spinajs/rbac-http-user`

## Problem

`createPolicyGate` flattens every policy attached to a route — controller-wise
and route-wise alike — into one list and lets the request through as soon as
**any** of them resolves. Multiple `@Policy` decorators therefore mean OR, and
there is no way to express "both must hold".

Two controllers are mis-guarded by this today:

- `TwoFactorAuthUserController` carries `@Policy(AuthorizedPolicy)` and
  `@Policy(TwoFactorAuthEnabled)`. `AuthorizedPolicy` resolves for any logged-in
  caller, so `TwoFactorAuthEnabled` can never reject one. The system-wide
  `rbac.twoFactorAuth.enabled` switch had to be re-checked by hand inside the
  mutating handlers to compensate.
- `TwoFactorAuthController` carries `@Policy(TwoFacRouteEnabled)` and
  `@Policy(NotAuthorizedPolicy)`, and its own docstring claims "Both class
  policies must hold, so the window closes the moment verification succeeds".
  Under OR that is false: an already-authorized session still reaches the
  login-time 2FA routes through `TwoFacRouteEnabled` alone.

## Semantics

`@Policy` accepts a single policy (unchanged) or an array. Each `@Policy` call
is one **group**:

- inside a group: AND — every policy must resolve
- between groups: OR — unchanged from today

```
@Policy(A)
@Policy([B, C])
@Policy(D)

pass = A OR (B AND C) OR D
```

Existing single-policy call sites keep their exact current behaviour, including
the intentional OR sites (`http`'s `TestPolicyPath.testMultiplePolicies`, and
token-access-or-session patterns downstream).

## Data shape

`IPolicyDescriptor` is unchanged. `Policies` becomes nested, one inner array
per `@Policy` call, on both `IRoute` and `IControllerDescriptor`:

```ts
Policies: IPolicyDescriptor[][];
```

This is a breaking change for readers of `.Policies`.

```ts
export function Policy(policy: Constructor<BasePolicy> | string | (Constructor<BasePolicy> | string)[], ...options: any[]) {
  return Route((controller, route) => {
    const group = toArray(policy).map((p) => ({ Options: options, Type: p }));
    (route ?? controller).Policies.push(group);
  });
}
```

`toArray` from `@spinajs/util` guards with `Array.isArray`, so a configuration
key passed as a string stays one policy rather than being split. `options` apply
to every policy in the group.

`detachInheritedRoutes` must copy one level deeper —
`route.Policies.map((g) => [...g])`. With a shallow copy a subclass `@Policy`
push would mutate the parent's group array, which is the exact cross-class
corruption that function exists to prevent.

## Gate

`resolveRoutePolicies` returns `Promise<BasePolicy[][]>`, preserving grouping.
`createPolicyGate` takes groups:

```
enabledGroups = groups.map(g => g.filter(isEnabled)).filter(g => g.length > 0)
if enabledGroups is empty -> next()
group passes <=> every member resolves      (Promise.allSettled per group)
gate passes  <=> some group passes          (Promise.all across groups)
otherwise    -> next(first rejection in declaration order)
```

A group whose members are all disabled is **dropped, not treated as vacuously
true**. Vacuous-true would let a disabled controller-level policy open a route
that an enabled route-level policy should still guard — a regression the current
flat implementation does not have. Dropping empty groups reproduces today's
behaviour exactly when every group holds a single policy: the OR over remaining
one-member groups is the same as the OR over the flat enabled list, and "no
groups left" is the same as "no enabled policies", which allows the request.

Each group is settled with `Promise.allSettled` so a rejecting member never
escapes as an unhandled rejection; the outer `Promise.all` therefore cannot
reject. The existing `.catch(err => next(err))` guard stays, so the request can
never stall without a response.

## Consumers

- `http-swagger`'s `swagger-cache.ts` flattens groups before extracting policy
  names. The generated document lists policies without AND/OR wording, so its
  output is unchanged.
- `http`'s `cache.ts` receives policy names from `swagger-cache`; only its
  doc comment mentions `.Policies`.
- `Policies: []` initialisers in tests and fixtures remain valid.

## Call sites

```ts
// TwoFactorAuthUserController
@Policy([AuthorizedPolicy, TwoFactorAuthEnabled])

// TwoFactorAuthController
@Policy([TwoFacRouteEnabled, NotAuthorizedPolicy])
```

`TwoFactorAuthUserController`'s `assertSystemEnabled` helper and the docstring
paragraphs explaining the OR workaround are removed: the gate now enforces what
those comments describe as unenforceable.

## Tests

New `packages/http/test/policy-groups.test.ts`:

- AND group where both members resolve — route runs
- AND group where one member rejects — route blocked, that rejection forwarded
- two groups, first fails and second passes — route runs
- array group mixed with a stacked single `@Policy` — OR between them
- group with one disabled member — the remaining member decides
- group with all members disabled, alongside an enabled group — the empty group
  does not open the gate
- string (configuration key) policy inside an array group

Updated for the nested shape: `controller-inheritance.test.ts` (three
`.Policies.map` assertions) and `route-builder.test.ts` (descriptor fixture).

`rbac-http-user`:

- authorized caller receives 403 on `/user/2fa/*` when
  `rbac.twoFactorAuth.enabled` is false
- authorized session is rejected on `/auth/2fa/*`
