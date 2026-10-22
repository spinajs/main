# Action hooks

`TotpService` runs the owner's enrolment actions and the admin reset through the [`@spinajs/hooks`](../hooks/README.md) runner. A hook can refuse them and observe each before and after it runs. Use one for an app rule around the second factor, such as telling the user that an admin removed it.

## How it works

1. The owner method runs its own checks first (see [Where each hook runs](#where-each-hook-runs)). A failed check answers its result code and reaches no hook. `adminReset` has no checks of its own.
2. The method calls `runHookedAction` (`@spinajs/authn/hooks`). With no matching hook (`Hooks.has(action)` is false), it runs alone and copies nothing.
3. The `before` hooks run; one may refuse with `ctx.refuse(code)`.
4. The action runs on its own values: the identity always comes from the restored session, never from the hook input.
5. The `after` hooks see the input and the output, failure results included.

## Actions

No input key is mutable.

| Action | Method | Input | Refusable | Refused answer |
| --- | --- | --- | --- | --- |
| `authn.mfa.enrol.begin` | `begin` | `session`, `ctx` | yes | throws; no secret is drawn; HTTP 403 on `POST user/mfa` |
| `authn.mfa.enrol.confirm` | `confirm` | `session`, `ctx` | yes | throws; the enrolment stays pending; HTTP 403 on `POST user/mfa/confirm` |
| `authn.mfa.disable` | `disable` | `session`, `ctx` | yes | throws; the enrolment and the codes stay; HTTP 403 on `POST user/mfa/disable` |
| `authn.mfa.recovery.regenerate` | `regenerateRecoveryCodes` | `session`, `ctx` | yes | throws; the old codes stay valid; HTTP 403 on `POST user/mfa/recovery-codes` |
| `authn.mfa.adminReset` | `adminReset` | `actor`, `target`, `ctx` | yes | `{ reset: false }`; nothing is removed |

The owner methods throw the runner's error, because `MfaBeginResult`, `MfaConfirmResult`, `MfaDisableResult` and `MfaRegenerateResult` have no member for a refusal:

- `ActionRefused` (`@spinajs/hooks`) for `ctx.refuse(code)`;
- `ActionHookFailed` for a `before` hook that threw, timed out or failed to resolve.

The `/user/mfa` routes of [`@spinajs/authn-http`](../authn-http/23-action-hooks.md) answer either with 403 `{ error: 'action_refused', code, message }`, `code` being `hook_error` for a failed hook. Another caller catches both errors.

The input and output types are exported from `@spinajs/authn-totp`: `MfaEnrolInput`, `MfaAdminResetInput`, `MfaBeginOutput`, `MfaConfirmOutput`, `MfaRegenerateOutput`. Importing the package brings their `HookActions` declaration.

### Audit

A refusal publishes an event with outcome `failure` and the reason `hook:<code>`, or `hook_error`:

| Action | Event | Extra |
| --- | --- | --- |
| `authn.mfa.enrol.begin`, `authn.mfa.enrol.confirm` | `mfa.enrol` | the identity and the session |
| `authn.mfa.recovery.regenerate` | `mfa.enrol` | the identity, the session and `data: { recoveryCodes: 'regenerated' }` |
| `authn.mfa.disable` | `mfa.disable` | the identity and the session |
| `authn.mfa.adminReset` | `mfa.disable` | `identity: target`, `actor`, `data: { reset: true }` |

## Where each hook runs

| Action | After | Before |
| --- | --- | --- |
| `authn.mfa.enrol.begin` | the session restore and the fresh-auth check (`reauth` included) | the new secret |
| `authn.mfa.enrol.confirm` | the session restore and the check that an enrolment is pending | the `mfa` throttle and the code check |
| `authn.mfa.disable` | the session restore, the fresh-auth check and the check that TOTP is enrolled | the `mfa` throttle and the code check |
| `authn.mfa.recovery.regenerate` | the session restore and the fresh-auth check | the new code set |
| `authn.mfa.adminReset` | nothing | the enrolment read and the removal |

A refused confirm or disable counts no attempt in the `mfa` throttle. A `reauth` credential is verified before the hooks run.

## What hooks never see

- **No code.** The input of confirm and disable carries neither the TOTP code nor a recovery code the caller sent.
- **No secret.** The begin, confirm and regenerate outputs are `{ ok: true }` on success, without the provisioning URI or the recovery codes; failure results pass as they are. The caller still gets the URI or the codes.

## Important behaviour

- **Hooks get copies.** Each input key is a frozen copy (`hookView`), and the after hooks get a frozen copy of the output. A write in place in a hook reaches nothing the action acts on.
- **The `session` input is a copy of the `SessionHandle`** (`{ id, state }`), plain data like every other input. A pending session that enrols at first login reaches the begin and confirm hooks with `state: 'pending'`.
- **A refused admin reset looks like a reset of nobody.** `{ reset: false }` is also the answer for an identity without an enrolment, so the admin route answers 200 `{ reset: false }` and `authn:mfa-reset` logs `No MFA enrolment for <login>`. Only the audit event tells them apart.
- **`adminReset` does not decide who may reset whom.** The admin route runs it as the effect of `authn.admin.credentials`, whose `CredentialAdminRule` must allow first. The rule, the `authn.admin.credentials` hooks and the `authn.mfa.adminReset` hooks must all allow; `authn:mfa-reset` runs the hooks with the actor `{ type: 'system', id: 'cli' }`.
- **Without hooks.** A service built with `new TotpService(deps)` runs `deps.hooks` when given and no hook otherwise.

## Example: tell the user an admin removed their second factor

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, AfterContext } from '@spinajs/hooks';
import type { IdentityRef, PrincipalRef } from '@spinajs/authn/contracts';
import '@spinajs/authn-totp';

export abstract class SecurityNotices {
  abstract mfaRemovedByAdmin(user: IdentityRef, actor: PrincipalRef): Promise<void>;
}

/** Mails the account owner after an admin reset that removed an enrolment, so a reset they did not ask for is noticed. */
@Injectable(ActionHook)
export class MfaResetNotice extends ActionHook<'authn.mfa.adminReset'> {
  readonly actions: readonly ActionPattern[] = ['authn.mfa.adminReset'];

  @Autoinject(SecurityNotices)
  protected Notices: SecurityNotices;

  public async after(ctx: AfterContext<'authn.mfa.adminReset'>): Promise<void> {
    if (ctx.output.reset) await this.Notices.mfaRemovedByAdmin(ctx.input.target, ctx.input.actor);
  }
}
```

An `after` hook that throws is logged and never fails the reset.

## Related

- [Enrolment](02-enrolment.md), [Recovery codes](04-recovery-codes.md) and [Disable and admin reset](05-disable-and-reset.md): the methods these actions wrap.
- [`@spinajs/authn-http` action hooks](../authn-http/23-action-hooks.md): the route answers.
- [Writing a hook](../hooks/01-writing-a-hook.md): the hook contract, ordering, timeouts and the depth limit.
