# Action hooks

`DbTokenService` runs create, revoke, rotate, update and the self-revocation through the [`@spinajs/hooks`](../hooks/README.md) runner. A hook can refuse them, narrow what a create or an update asks for, and observe each before and after it runs.

## How it works

1. The method runs the checks that need no hook first: `create` checks the token format and `ctx.now`; `revoke` answers `false` for an empty `id`; `rotate` checks `ctx.now` and `graceSeconds` (`InvalidArgument`).
2. `create` reads `ctx.now` and parses what the caller asked for (`kind`, `roles`, `scope`, `profile`) before any hook runs.
3. The method calls `runHookedAction` (`@spinajs/authn/hooks`). With no matching hook (`Hooks.has(action)` is false), it runs alone and copies nothing.
4. The `before` hooks run. They may replace `opts` of a create or an update, or refuse with `ctx.refuse(code)`.
5. The action runs on its own values and on the `opts` the hooks left; every check runs again on that `opts` (see [What a hook may change](#what-a-hook-may-change)).
6. The `after` hooks see the input and the output, failure results included.
7. A refusal, or a `before` hook that throws or times out, is audited and rethrown (see [Refusals](#refusals)).

## Actions

| Action | Method | Input | Mutable | Refusable | Refused answer |
| --- | --- | --- | --- | --- | --- |
| `authn.token.create` | `create` | `owner`, `opts`, `ctx` | `opts` | yes | throws; nothing is stored; HTTP 403 on `POST /user/tokens` |
| `authn.token.revoke` | `revoke` | `owner`, `id`, `actor?`, `ctx` | none | yes | throws; the token stays valid; HTTP 403 on `DELETE /user/tokens/:uuid` |
| `authn.token.rotate` | `rotate` | `owner`, `id`, `opts?`, `ctx` | none | yes | throws; the old secret stays; HTTP 403 on `POST /user/tokens/:uuid/rotate` |
| `authn.token.update` | `update` | `owner`, `id`, `opts`, `ctx` | `opts` | yes | throws; the token is unchanged; HTTP 403 on `PATCH /user/tokens/:uuid` |
| `authn.token.selfRevoke` | `revokeByPlaintext` | `ctx` | none | no | none: a refusal or a hook error is logged and the token is revoked |

`update` takes the change as its `change` argument; the hook input names it `opts`.

Two methods run no hook:

- `revokeAllFor`: it follows a security event (a password reset, a ban, an admin action), which must not be stopped.
- `revokeById`: the operator path of `authn:token-delete`.

The input and output types are exported from `@spinajs/authn-token`: `TokenCreateInput`, `TokenRevokeInput`, `TokenRotateInput`, `TokenUpdateInput`, `TokenSelfRevokeInput`, `TokenCreateOutput`, `TokenRotateOutput`. Importing the package brings their `HookActions` declaration.

## What hooks never see

- **No plaintext.** The create output is `{ ok: true, record }` and the rotate output `{ ok: true, token }`; failure results pass as they are. The caller still gets the plaintext.
- **No presented secret.** `authn.token.selfRevoke` runs before the plaintext is looked up, so its input is `ctx` alone and names no token.

## What a hook may change

- **Create.** `opts` goes through every check of a create without hooks: the kind, the scope shape, the profile against `TokenProfilePolicy`, `authn.token.maxTtlDays` and `authn.token.agentMaxTtlMinutes`, the name, the owner's roles. It may then only narrow what the caller asked for: the same `kind` and `profile`, `roles` and `scope.permissions` a subset of the caller's, `scope.resources` among the caller's. A widening answers `{ ok: false, code: 'invalid_scope' }`, an expiry past the cap `invalid_expiry`, a bad name throws `InvalidArgument`.
- **Update.** `opts` goes through the narrowing check of `update` as it is: `roles` a subset of the token's (for a token without roles, roles the owner holds; none on an agent token), `expiresAt` after `ctx.now` and not after the token's expiry, `name` 1 to 128 characters. The check compares with the stored token, not with what the caller asked for.
- **Nothing else.** `owner`, `id`, `actor` and `ctx` are fixed: the action reads them from its own arguments, so a change to them is dropped.

## Refusals

The refusing methods (`create`, `revoke`, `rotate`, `update`) throw the runner's error to their caller:

- `ActionRefused` (`@spinajs/hooks`) for `ctx.refuse(code)`; its `code` is the hook's code.
- `ActionHookFailed` for a `before` hook that threw, timed out or failed to resolve; the routes answer it with the code `hook_error`.

Before it rethrows, the method publishes the method's event (`token.create`, `token.revoke`, `token.rotate`, `token.update`) with outcome `failure`, the owner as `identity` and the reason `hook:<code>`, or `hook_error`. A revoke adds its `actor`; revoke, rotate and update add `data: { token: id }`.

The `/user/tokens` routes of [`@spinajs/authn-http`](../authn-http/23-action-hooks.md) answer a refusal of their own action with 403 `{ error: 'action_refused', code, message }`. Any other error, a nested action's refusal included, is rethrown.

## Important behaviour

- **Hooks get copies.** Each input key is a frozen copy (`hookView`), a mutable key a plain copy (`hookCopy`), and the after hooks get a frozen copy of the output. A write in place in a hook reaches nothing the action acts on.
- **A create's clock and limits are read before its hooks run.** A hook cannot move `ctx.now`, and with it the TTL caps, nor change the request it is held to.
- **A self-revocation always completes.** `authn.token.selfRevoke` runs with `refusable: false`; past `hooks.maxDepth` it runs without its hooks.
- **Hooks that ran before a refusing one keep their effects.** Write `before` hooks that are safe to run twice.

## Example: cap personal tokens at 30 days

```ts sample
import { Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import '@spinajs/authn-token';

const DAY_MS = 86_400_000;

/** Shortens a personal token asked for longer than 30 days; service and agent tokens keep their expiry. */
@Injectable(ActionHook)
export class ShortPersonalTokens extends ActionHook<'authn.token.create'> {
  readonly actions: readonly ActionPattern[] = ['authn.token.create'];

  public before(ctx: BeforeContext<'authn.token.create'>): void {
    if (ctx.input.opts.kind !== 'pat') return;
    const latest = new Date(ctx.input.ctx.now.getTime() + 30 * DAY_MS);
    if (ctx.input.opts.expiresAt > latest) ctx.input.opts = { ...ctx.input.opts, expiresAt: latest };
  }
}
```

## Example: no token rotation during a deploy freeze

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import '@spinajs/authn-token';

export abstract class DeployFreeze {
  abstract active(at: Date): Promise<boolean>;
}

/** Refuses rotating or revoking API tokens while a deploy freeze is on, so running pipelines keep their credentials. */
@Injectable(ActionHook)
export class TokenFreeze extends ActionHook<'authn.token.rotate' | 'authn.token.revoke'> {
  readonly actions: readonly ActionPattern[] = ['authn.token.rotate', 'authn.token.revoke'];

  @Autoinject(DeployFreeze)
  protected Freeze: DeployFreeze;

  public async before(ctx: BeforeContext<'authn.token.rotate' | 'authn.token.revoke'>): Promise<void> {
    if (await this.Freeze.active(ctx.input.ctx.now)) ctx.refuse('deploy_freeze');
  }
}
```

## Related

- [Issuing and revoking tokens](01-token-service.md): the methods these actions wrap.
- [`@spinajs/authn-http` action hooks](../authn-http/23-action-hooks.md): the route answers.
- [Writing a hook](../hooks/01-writing-a-hook.md): the hook contract, ordering, timeouts and the depth limit.
- [`@spinajs/authn` action hooks](../authn/14-action-hooks.md): `hookView`, `hookCopy` and `hookRefusalOf`.
