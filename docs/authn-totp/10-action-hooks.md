# Action hooks

`TotpService` runs the owner's enrolment actions and the admin reset through the [`@spinajs/hooks`](../hooks/README.md) runner. A hook can refuse them and observe each before and after it runs.

## Actions

| Action | Method | Input | Refusable | Refused answer |
| --- | --- | --- | --- | --- |
| `authn.mfa.enrol.begin` | `begin` | `session`, `ctx` | yes | throws `ActionRefused`; the route answers 403 `{ code }` |
| `authn.mfa.enrol.confirm` | `confirm` | `session`, `ctx` | yes | the same |
| `authn.mfa.disable` | `disable` | `session`, `ctx` | yes | the same |
| `authn.mfa.recovery.regenerate` | `regenerateRecoveryCodes` | `session`, `ctx` | yes | the same |
| `authn.mfa.adminReset` | `adminReset` | `actor`, `target`, `ctx` | yes | `{ reset: false }` |

No input key is mutable. A refusal changes no enrolment row and is audited as `mfa.enrol` or `mfa.disable` with outcome `failure` and the reason `hook:<code>`, or `hook_error` for a hook that failed.

## Where each hook runs

The owner actions run their hooks once the session is restored and found fresh where the method needs it, and before anything is counted or written: a refused confirm or disable counts no attempt in the `mfa` throttle. A hook does not see the code the caller sent.

No output carries a secret. The begin, confirm and regenerate outputs are `{ ok: true }` on success, without the provisioning URI or the recovery codes.

## Important behaviour

- **The owner actions throw on a refusal.** `MfaBeginResult`, `MfaConfirmResult`, `MfaDisableResult` and `MfaRegenerateResult` have no member for it, so a caller other than the `/user/mfa` routes catches `ActionRefused` and `ActionHookFailed`.
- **Without hooks.** A service built with `new TotpService(deps)` runs `deps.hooks` when given and no hook otherwise.

## Related

- [Enrolment](02-enrolment.md) and [Disable and admin reset](05-disable-and-reset.md): the methods these actions wrap.
- [`@spinajs/authn-http` action hooks](../authn-http/23-action-hooks.md): the route answers.
