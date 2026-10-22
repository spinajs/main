# Action hooks

`WebAuthnPasskeyService` runs passkey registration and removal through the [`@spinajs/hooks`](../hooks/README.md) runner. A hook can refuse them and observe each before and after it runs. Use one for an app rule on passkeys, such as a cap on how many an account holds.

## How it works

1. The method runs its own checks first. `register` takes the registration challenge, checks the name and verifies the attestation; any failure answers `{ ok: false, code: 'invalid_response' }` and reaches no hook. `remove` answers `false` for an empty `credentialId`.
2. The method calls `runHookedAction` (`@spinajs/authn/hooks`). With no matching hook (`Hooks.has(action)` is false), it runs alone and copies nothing.
3. The `before` hooks run; one may refuse with `ctx.refuse(code)`.
4. The action runs on its own values: `register` adds the verified credential (`duplicate` when it is registered already), `remove` removes the credential of that identity.
5. The `after` hooks see the input and the output, failure results included.

## Actions

No input key is mutable.

| Action | Method | Input | Refusable | Refused answer |
| --- | --- | --- | --- | --- |
| `authn.passkey.register` | `register` | `identity`, `credentialId`, `ctx` | yes | throws; nothing is stored; HTTP 403 on `POST /user/passkeys` |
| `authn.passkey.revoke` | `remove` | `identity`, `credentialId`, `ctx` | yes | throws; the passkey stays; HTTP 403 on `DELETE /user/passkeys/:id` |

- `identity` is the caller's own: the passkey routes act only on the session's identity.
- `credentialId` of a registration is the new credential's, known once the attestation verifies.
- `ctx.session` is the caller's session.

The input type is exported from `@spinajs/authn-webauthn`: `PasskeyActionInput`. Importing the package brings its `HookActions` declaration.

## Refusals

Both methods throw the runner's error, because `PasskeyRegisterResult` and the `boolean` of `remove` have no member for a refusal:

- `ActionRefused` (`@spinajs/hooks`) for `ctx.refuse(code)`;
- `ActionHookFailed` for a `before` hook that threw, timed out or failed to resolve.

Before it rethrows, the method publishes `passkey.register` or `passkey.remove` with outcome `failure`, the identity and the reason `hook:<code>` or `hook_error`. The passkey routes of [`@spinajs/authn-http`](../authn-http/23-action-hooks.md) answer with 403 `{ error: 'action_refused', code, message }`, `code` being `hook_error` for a failed hook. Another caller catches both errors.

## Important behaviour

- **Hooks get copies.** Each input key is a frozen copy (`hookView`), and the after hooks get a frozen copy of the output. A write in place in a hook reaches nothing the action acts on.
- **The registration challenge is spent before the hooks run.** After a refusal the browser starts over with `POST /user/passkeys/options`.
- **No key material.** The input names the credential by its id; the public key, the attestation and the challenge never reach a hook.
- **Without hooks.** A service built with `new WebAuthnPasskeyService(deps)` runs `deps.hooks` when given and no hook otherwise.

## Example: at most five passkeys per account

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import { PasskeyService } from '@spinajs/authn/contracts';
import '@spinajs/authn-webauthn';

const MAX_PASSKEYS = 5;

/** Refuses a sixth passkey, so a stolen session cannot pile up credentials. */
@Injectable(ActionHook)
export class PasskeyLimit extends ActionHook<'authn.passkey.register'> {
  readonly actions: readonly ActionPattern[] = ['authn.passkey.register'];

  @Autoinject(PasskeyService)
  protected Passkeys: PasskeyService;

  public async before(ctx: BeforeContext<'authn.passkey.register'>): Promise<void> {
    if ((await this.Passkeys.list(ctx.input.identity)).length >= MAX_PASSKEYS) ctx.refuse('passkey_limit');
  }
}
```

`POST /user/passkeys` then answers 403 `{ error: 'action_refused', code: 'passkey_limit' }`. The hook injects `PasskeyService` without a dependency cycle: a class hook is resolved on the first run of its action, not at boot.

## Related

- [Passkey management](03-passkey-management.md): the methods these actions wrap.
- [`@spinajs/authn-http` action hooks](../authn-http/23-action-hooks.md): the route answers.
- [Writing a hook](../hooks/01-writing-a-hook.md): the hook contract, ordering, timeouts and the depth limit.
