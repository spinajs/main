# Action hooks

`WebAuthnPasskeyService` runs passkey registration and removal through the [`@spinajs/hooks`](../hooks/README.md) runner. A hook can refuse them and observe each before and after it runs.

## Actions

| Action | Method | Input | Refusable | Refused answer |
| --- | --- | --- | --- | --- |
| `authn.passkey.register` | `register` | `identity`, `credentialId`, `ctx` | yes | throws `ActionRefused`; the route answers 403 `{ code }` |
| `authn.passkey.revoke` | `remove` | `identity`, `credentialId`, `ctx` | yes | the same |

No input key is mutable. `ctx.session` is the caller's session. A refusal leaves the credential store unchanged and is audited as `passkey.register` or `passkey.remove` with outcome `failure` and the reason `hook:<code>`, or `hook_error` for a hook that failed.

## Important behaviour

- **Registration runs its hooks once the attestation verifies,** so `credentialId` is the new credential's. An invalid response answers `invalid_response` and reaches no hook. The registration challenge is spent before the hooks run.
- **A refusal throws.** `PasskeyRegisterResult` has no member for it, so a caller other than the passkey routes catches `ActionRefused` and `ActionHookFailed`.
- **Without hooks.** A service built with `new WebAuthnPasskeyService(deps)` runs `deps.hooks` when given and no hook otherwise.

## Related

- [Passkey management](03-passkey-management.md): the methods these actions wrap.
- [`@spinajs/authn-http` action hooks](../authn-http/23-action-hooks.md): the route answers.
