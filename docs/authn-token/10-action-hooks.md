# Action hooks

`DbTokenService` runs create, revoke, rotate, update and the self-revocation through the [`@spinajs/hooks`](../hooks/README.md) runner. A hook can refuse them, narrow what a create or an update asks for, and observe each before and after it runs.

## Actions

| Action | Method | Input | Mutable | Refusable | Refused answer |
| --- | --- | --- | --- | --- | --- |
| `authn.token.create` | `create` | `owner`, `opts`, `ctx` | `opts` | yes | throws `ActionRefused`; the route answers 403 `{ code }` |
| `authn.token.revoke` | `revoke` | `owner`, `id`, `actor?`, `ctx` | none | yes | throws `ActionRefused`; the token stays valid; the route answers 403 `{ code }` |
| `authn.token.rotate` | `rotate` | `owner`, `id`, `opts?`, `ctx` | none | yes | throws `ActionRefused`; the old secret stays |
| `authn.token.update` | `update` | `owner`, `id`, `opts`, `ctx` | `opts` | yes | throws `ActionRefused` |
| `authn.token.selfRevoke` | `revokeByPlaintext` | `ctx` | none | no | none: a refusal is logged and the token is revoked |

`revokeAllFor` runs no hook: it follows a security event (a reset, a ban, an admin action). `revokeById`, the operator path of `authn:token-delete`, runs none either.

A refusal is audited on the method's event (`token.create`, `token.revoke`, `token.rotate`, `token.update`) with outcome `failure` and the reason `hook:<code>`, or `hook_error` for a hook that failed.

## What a hook may change

- **Create.** `opts` is checked again after the hooks, with every check of a create without hooks: the kind, the scope shape, the profile, `authn.token.maxTtlDays` and `authn.token.agentMaxTtlMinutes`, the owner's roles. The result may also only narrow what the caller asked for: the same kind and profile, roles and scope permissions a subset of the caller's, resources among the caller's. A widening answers `invalid_scope`, an expiry past the cap `invalid_expiry`.
- **Update.** `opts` goes through the narrowing check of `update` as it is: roles a subset of the token's, an expiry no later than the token's.

No input or output carries a plaintext. The create and rotate outputs are `{ ok: true, record }` and `{ ok: true, token }`. The self-revocation runs before the plaintext is looked up, so its input is `ctx` alone.

## Important behaviour

- **Hooks get copies.** Each input key is a frozen copy (`hookView`), a mutable key a plain copy (`hookCopy`), and the after hooks get a frozen copy of the output. The action reads what it acts on from its own values, so a write in place in a hook reaches nothing. Without a matching hook nothing is copied.
- **A create's clock is read before its hooks run:** a hook cannot move `ctx.now`, and with it the TTL cap.

## Example: cap personal tokens at 30 days

```ts sample
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import '@spinajs/authn-token';

const DAY = 86_400_000;

export class ShortPersonalTokens extends ActionHook<'authn.token.create'> {
  readonly actions: readonly ActionPattern[] = ['authn.token.create'];

  public before(ctx: BeforeContext<'authn.token.create'>): void {
    const latest = new Date(ctx.input.ctx.now.getTime() + 30 * DAY);
    if (ctx.input.opts.expiresAt > latest) ctx.input.opts = { ...ctx.input.opts, expiresAt: latest };
  }
}
```

## Related

- [Token service](01-token-service.md): the methods these actions wrap.
- [`@spinajs/authn-http` action hooks](../authn-http/23-action-hooks.md): the route answers.
