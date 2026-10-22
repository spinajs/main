# Action hooks

`DefaultKeyRegistry` runs `register` and `revoke` through the [`@spinajs/hooks`](../hooks/README.md) runner. A hook can refuse them and observe each before and after it runs. Use one for a key rule of your app, such as an expiry on every machine key, without a subclass of the registry.

## How it works

1. The method runs its own checks first. `register` checks the owner, the key, its fields, and the proof of a user key or the actor of a service or agent key. `revoke` answers `false` for a malformed `kid`. A failed check answers as it does without hooks and reaches no hook.
2. `register` builds the key record before the hooks run, so the stored scope, name and expiry are the caller's.
3. The method calls `runHookedAction` (`@spinajs/authn/hooks`). With no matching hook (`Hooks.has(action)` is false), it runs alone and copies nothing.
4. The `before` hooks run; one may refuse with `ctx.refuse(code)`.
5. The action runs: `register` inserts the record (`duplicate` for a taken `kid` or thumbprint), `revoke` revokes the key.
6. The `after` hooks see the input and the output, failure results included.

## Actions

No input key is mutable.

| Action | Method | Input | Refusable | Refused answer |
| --- | --- | --- | --- | --- |
| `authn.key.register` | `register` | `reg`, `ctx` | yes | `{ ok: false, code: 'refused', refusal }`; nothing is stored; HTTP 403 on `POST /user/keys`; `authn:key-add` fails with `key not registered: refused` |
| `authn.key.revoke` | `revoke` | `owner`, `kid`, `actor?`, `ctx` | yes | `false`; the key stays usable; HTTP 404 `key_not_found` on `DELETE /user/keys/:kid`, as for an unknown key; `authn:key-revoke` fails with `no key <kid> of <type> <id>` |

`refusal` is the hook's code, or `hook_error` for a `before` hook that threw, timed out or failed to resolve. `KeyRegisterResult` carries this member, `{ ok: false; code: 'refused'; refusal: string }`, so an exhaustive match on `code` needs a branch for it.

A refusal publishes `key.register` or `key.revoke` with outcome `failure`, the owner as `identity` and the reason `hook:<code>` or `hook_error`. A refused revoke adds its `actor` and `data: { kid }`.

`POST /user/keys` of [`@spinajs/authn-http`](../authn-http/23-action-hooks.md) answers a refused registration with 403 `{ error: 'action_refused', code, message }`.

The input types are exported from `@spinajs/authn-keys`: `KeyRegisterInput`, `KeyRevokeInput`. Importing the package brings their `HookActions` declaration.

## What hooks see

- `reg` is the registration as the caller passed it: the public JWK, the optional `kid`, `name`, `scope` and `expiresAt`, and the user's `proof` (`challengeId`, `signature`) or the registering `actor`. No private key material exists on the server.
- `kid` of a registration is the caller's; when it is left out, the stored kid is the thumbprint, which the `after` hooks read from `ctx.output.key`.

## Important behaviour

- **Hooks get copies.** Each input key is a frozen copy (`hookView`), and the after hooks get a frozen copy of the output. A write in place in a hook reaches nothing the action acts on.
- **The proof's challenge is redeemed before the hooks run.** A user whose key a hook refused needs a new register challenge.
- **A refused revoke looks like an unknown key** to the route caller; only the audit event tells them apart.
- **Without hooks.** A registry built with `new DefaultKeyRegistry(deps)` runs `deps.hooks` when given and no hook otherwise.

## Example: require an expiry on every machine key

```ts sample
import { Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import '@spinajs/authn-keys';

/** Refuses a service or agent key without an expiry, so a forgotten machine key stops working on its own. */
@Injectable(ActionHook)
export class MachineKeysExpire extends ActionHook<'authn.key.register'> {
  readonly actions: readonly ActionPattern[] = ['authn.key.register'];

  public before(ctx: BeforeContext<'authn.key.register'>): void {
    if (ctx.input.reg.owner.type !== 'user' && ctx.input.reg.expiresAt === undefined) ctx.refuse('expiry_required');
  }
}
```

`authn:key-add service runner-1 --file runner.pub.pem` without `--expires` then fails with `key not registered: refused`, and the audit records `hook:expiry_required`.

## Related

- [Key registry](02-key-registry.md): the methods these actions wrap.
- [`@spinajs/authn-http` action hooks](../authn-http/23-action-hooks.md): the route answers.
- [Writing a hook](../hooks/01-writing-a-hook.md): the hook contract, ordering, timeouts and the depth limit.
