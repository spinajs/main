# Principal builders

Functions that build the `Principal` objects checks run as: users, anonymous callers, services, groups, share links and agents, with ceilings, companions and authentication facts. Use them instead of object literals in every authz test.

## How it works

1. A builder fills the defaults of its type (`type`, `source`, `authenticated`, `attributes: {}`) and merges your `init` over them.
2. `sealPrincipal(p)` copies and freezes what the principal owns: `attributes` (deep), `ceiling`, `authn` and `companions`. `onBehalfOf` and `identity` stay your objects; `Date`s stay `Date`s.
3. The `with*` helpers return a new sealed principal; the input is never changed.

## Builders

| Function | `type` | `source` | `authenticated` | Notes |
| --- | --- | --- | --- | --- |
| `userPrincipal(id, init?)` | `user` | `session` | `true` | |
| `anonymousPrincipal(id = 'anonymous', init?)` | `anonymous` | `anonymous` | `false` | |
| `servicePrincipal(id, init?)` | `service` | `token` | `true` | |
| `groupPrincipal(id, init?)` | `group` | `session` | `true` | A group speaks for its member set in RBAC subject sets (B33). |
| `linkPrincipal(id, { scope, expiresAt?, permissions?, ...init })` | `link` | `link` | `true` | `scope` (one ref or a list) becomes `ceiling.resources`; the ceiling reason is `link_invalid` (B38). |
| `agentPrincipal(id, onBehalfOf, opts?)` | `agent` | `token` | `true` | `delegation` defaults to `'inherit'` (B37). With `permissions` or `resources` the ceiling is built here with reason `out_of_scope` (B24); otherwise `opts.ceiling` is used. |

`init` is `PrincipalInit`: any `Principal` key except `type` and `id` (`attributes`, `ceiling`, `companions`, `onBehalfOf`, `authn`, …).

| Helper | Effect |
| --- | --- |
| `withCeiling(p, ceiling)` | Replaces the ceiling. |
| `withAttributes(p, attributes)` | Merges `attributes` over the existing ones (shallow). |
| `withCompanions(p, refs)` | Sets `companions` (the signed-in user behind a link or a service call). |
| `withAuthn(p, facts?)` | Sets `authn`. Defaults: `method: 'password'`, `strategy: 'local'`, `mfa: []`, `authenticatedAt: new Date(0)`; `assurance` is `aal2` when `mfa` is not empty, else `aal1`. |
| `sealPrincipal(p)` | Copies and freezes a principal you built by hand. |

`SYSTEM` and `UNATTENDED` are re-exported from `@spinajs/authz`, never rebuilt: the engine recognises them by identity.

## Important behaviour

- `withAuthn` uses fixed defaults, not the current time, so fixtures stay deterministic.
- A principal is frozen: `p.attributes.team = 'red'` throws in strict mode. Use `withAttributes`.
- `companions` are reduced to `{ type, id }` refs when sealed.

## Best practices

- Pass `onBehalfOf` a principal built by a builder; the agent keeps that object as is.
- Use `withCeiling(userPrincipal('bob'), { roles: ['viewer'] })` to model a session role switch (B24 sets `ceiling.roles` only).

## Examples

### An agent that may only read one project

```ts sample
import { agentPrincipal, linkPrincipal, userPrincipal, withAuthn } from '@spinajs/authz-testing';

const alice = withAuthn(userPrincipal('alice', { attributes: { team: 'red' } }), { mfa: ['totp'] });

// Acts as alice (inherit), limited to project p1 and read permissions.
export const readBot = agentPrincipal('read-bot', alice, {
  permissions: ['project:read', 'file:read'],
  resources: [{ type: 'project', id: 'p1' }],
});

// A share link to one file, valid for one day, opened by alice.
export const shareLink = linkPrincipal('l1', {
  scope: { type: 'file', id: 'f1' },
  expiresAt: new Date('2026-01-02T00:00:00Z'),
  companions: [alice],
});
```

## Related

- [Arbitraries](13-arbitraries.md): `arb.principal()` and `arb.ceiling()` generate principals with the same builders.
- [`@spinajs/authz` concepts](../authz/01-check-flow.md#concepts): principal types, ceilings, delegation and companions.
