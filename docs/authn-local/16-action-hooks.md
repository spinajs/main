# Action hooks

`LocalPasswordService` runs its password and verification flows through the [`@spinajs/hooks`](../hooks/README.md) runner. A hook can refuse a flow, or observe it before and after it runs, without a subclass of the service.

## How it works

1. The flow runs its own checks first: the policy check of a new password, the session of a change, the throttle of a reset or a verification request.
2. It calls `Hooks.run` with the action's input. Hooks registered for the action run their `before` step; one of them may refuse.
3. A refused flow answers as the table below says and audits the real reason: `hook:<code>` for a refusal, `hook_error` for a hook that threw or timed out.
4. Otherwise the flow runs, and the `after` hooks see its result, failures included (`status: 'invalid'` is a result, not an error).

No input carries a password, a secret or a code. No output carries a session id: the change output is `{ status: 'changed' }`. The redeem output of a password it set names the identity, `{ status: 'reset', purpose, id }` (`PasswordResetOutput`); its input runs before the lookup and names none. users' [`UserPasswordStateHook`](../users/07-identity-and-password-stores.md#the-password-state) reads it.

## Actions

None of these actions has a mutable input key.

| Action | Method | Input | Refusable | Refused answer |
| --- | --- | --- | --- | --- |
| `authn.password.change` | `change` | `id`, `session`, `ctx` | yes | `{ status: 'refused', code }`; HTTP 400 `{ code }` |
| `authn.password.set` | `set` | `id`, `actor?`, `ctx` | yes | `{ status: 'refused', code }` |
| `authn.password.reset.request` | `requestReset` | `login`, `ctx` | yes | `{ status: 'accepted' }`, no mail |
| `authn.password.reset.redeem` | `redeemReset` | `login`, `ctx` | yes | `{ status: 'refused', code }`; the secret is not spent |
| `authn.password.invite` | `invite` | `id`, `actor?`, `ctx` | yes | throws `ActionRefused` |
| `authn.password.expire` | `expire` | `id`, `opts`, `ctx` | yes, except `cause: 'aged'` | throws `ActionRefused`; nothing expires |
| `authn.address.verify.request` | `requestVerification` | `id`, `ctx` | yes | `{ status: 'accepted' }`, no mail |
| `authn.address.verify` | `redeemVerification` | `ctx` | yes | `{ status: 'invalid' }`; the secret is not spent |

`code` is the hook's refusal code, or `hook_error` for a hook that failed.

The input types are exported from `@spinajs/authn-local`: `PasswordChangeInput`, `PasswordSetInput`, `PasswordLoginInput`, `PasswordInviteInput`, `PasswordExpireInput`, `AddressVerifyRequestInput`, `AddressVerifyInput`.

### Where each hook runs

| Action | After | Before |
| --- | --- | --- |
| `authn.password.change` | the policy check, the session and impersonation checks | the reauth throttle and the old-password verify |
| `authn.password.set` | the policy check | the write |
| `authn.password.reset.request` | the throttle | the deferred lookup and mail |
| `authn.password.reset.redeem` | the throttle | the account lookup and the secret redemption |
| `authn.address.verify` | nothing | the secret is read |

A refused change counts nothing in the reauth throttle. A refused reset redemption or verification leaves the secret usable.

## Example: notify the user after a password change

```ts sample
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, AfterContext } from '@spinajs/hooks';
import type { IdentityRef } from '@spinajs/authn';
import '@spinajs/authn-local';

interface SecurityNotices {
  passwordChanged(identity: IdentityRef, ip?: string): Promise<void>;
}

export class PasswordChangedNotice extends ActionHook<'authn.password.change'> {
  public static notices: SecurityNotices = { passwordChanged: async () => undefined };

  readonly actions: readonly ActionPattern[] = ['authn.password.change'];

  public async after(ctx: AfterContext<'authn.password.change'>): Promise<void> {
    if (ctx.output.status === 'changed') {
      await PasswordChangedNotice.notices.passwordChanged(ctx.input.id, ctx.input.ctx.ip);
    }
  }
}
```

Register it with `DI.register(PasswordChangedNotice).as(ActionHook)` before the app boots. See [Writing a hook](../hooks/01-writing-a-hook.md).

## Important behaviour

- **Hooks get copies.** Each input key is a frozen copy (`hookView`), a mutable key a plain copy (`hookCopy`), and the after hooks get a frozen copy of the output. The action reads what it acts on from its own values, so a write in place in a hook reaches nothing. Without a matching hook nothing is copied.
- **The `session` input is a copy of the `SessionHandle`** (`{ id, state }`), plain data like every other input.
- **A refused set still hashes the password,** as a set does, so a refusal nested in a registration costs what a taken address does.
- **No enumeration.** A refused reset request or verification request answers `accepted`, like any other login. Only the audit shows the refusal.
- **An aged expiry always completes.** The expiration job's `authn.password.expire` runs with `refusable: false`: a refusal or an error in a `before` hook is logged and the password expires anyway.
- **A refused invite throws.** `users` reports it as `UserCreatedIncomplete` with `resendInvite: true`.
- **A refused admin expiry throws** `ActionRefused`, so the credential admin route answers 403 `{ code }` instead of `{ expired: true }`.
- **Without deps.hooks no hook runs.** `new LocalPasswordService(deps)` uses `deps.hooks` (a `Hooks`); without it the flows run alone. The container-built service always injects `Hooks`.

## Related

- [Password service](11-password-service.md): the flows these actions wrap.
- [Audit events](12-audit-events.md): the `hook:<code>` and `hook_error` reasons.
- [`@spinajs/hooks`](../hooks/README.md): the runner, the contract and the test kit.
