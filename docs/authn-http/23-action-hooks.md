# Action hooks

The routes run their own actions through the [`@spinajs/hooks`](../hooks/README.md) runner, and map the refusals of the services behind them. A hook can refuse a logout, a session revoke, a role switch, a credential admin action, a registration or a code request, and observe each before and after it runs.

## How it works

1. The route runs its own checks first: the session, fresh authentication, the field checks, the throttle, the `CredentialAdminGuard`.
2. It calls `Hooks.run`; a `before` hook may refuse.
3. A refusal answers 403 `{ error: 'action_refused', code, message }`, or 400 for a registration, and is audited with the reason `hook:<code>`. A hook that threw or timed out answers the code `hook_error` and is audited as `hook_error`.
4. A route whose service refused through its own hooks (passwords, tokens, keys, passkeys, TOTP) answers the same way.

## Actions of the routes

| Action | Route | Input | Mutable | Refused answer |
| --- | --- | --- | --- | --- |
| `authn.logout` | `POST /auth/logout` | `session`, `ctx` | none | 403 `{ code }`; the session, the cookie and the site data are kept |
| `authn.sessions.revoke` | `DELETE /user/sessions/:handle`, `DELETE /user/sessions` | `subject`, `handle` (`'others'` for every session but the current one), `ctx` | none | 403 `{ code }`; every session is kept |
| `authn.role.switch` | `POST /auth/active-role` | `session`, `role`, `ctx` | none | 403 `{ code }`; the role and the session id are unchanged |
| `authn.admin.credentials` | every `/authn/admin/users/:uuid/...` route, after `CredentialAdminGuard.allowed` | `actor`, `target`, `action` | none | 403 `{ code }`; nothing changes |
| `authn.registration` | `POST /auth/register`, before `IdentityRegistrar.register` | `login`, `email`, `ctx` | `login`, `email` | 400 `{ code }` |
| `authn.code.request` | `POST /auth/code/request` | `login`, `ctx` | none | the same 202 `{ Ok: true }`; no mail |
| `authn.request` | every request, in `AuthnMiddleware`, when `authn.http.hooks.request` is `true` | `principal`, `method`, `path`, `ip?` | none | 403 `{ code }` |

The input types are exported from `@spinajs/authn-http`: `LogoutInput`, `SessionsRevokeInput`, `RoleSwitchInput`, `CredentialAdminInput`, `RegistrationInput`, `CodeRequestInput`, `RequestInput`.

## Refusals of the services

| Route | Service action | Answer |
| --- | --- | --- |
| `PATCH /user/password` | `authn.password.change` | 400 `{ code }` |
| `POST /auth/password/reset` | `authn.password.reset.redeem` | 400 `{ code }` |
| `POST /authn/admin/users/:uuid/password-reset` | `authn.password.expire` | 403 `{ code }` |
| `POST /authn/admin/users/:uuid/mfa-reset` | `authn.mfa.adminReset` | 200 `{ reset: false }` |
| `/user/tokens` routes | `authn.token.create`, `.revoke`, `.rotate`, `.update` | 403 `{ code }` |
| `POST /user/keys` | `authn.key.register` | 403 `{ code }` |
| `DELETE /user/keys/:kid` | `authn.key.revoke` | 404 `key_not_found`, as for an unknown key |
| `/user/passkeys` routes | `authn.passkey.register`, `.revoke` | 403 `{ code }` |
| `/user/mfa` routes | `authn.mfa.enrol.begin`, `.confirm`, `authn.mfa.disable`, `authn.mfa.recovery.regenerate` | 403 `{ code }` |

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `authn.http.hooks.request` | `boolean` | `false` | Runs `authn.request` on every request once its principal is resolved. Any value but `true` is off. |

```js
export default {
  authn: {
    http: {
      hooks: { request: true },
    },
  },
};
```

## Example: company addresses only

```ts sample
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import '@spinajs/authn-http';

export class CompanyAddressesOnly extends ActionHook<'authn.registration'> {
  readonly actions: readonly ActionPattern[] = ['authn.registration'];

  public before(ctx: BeforeContext<'authn.registration'>): void {
    ctx.input.email = ctx.input.email.trim().toLowerCase();
    if (!ctx.input.email.endsWith('@example.com')) ctx.refuse('company_address_required');
  }
}
```

## Important behaviour

- **`authn.request` costs a hook run per request.** Leave it off unless a rule needs every request. The hooks then see anonymous requests too (`principal: null`).
- **A registration hook must not branch on whether the account exists.** It runs before the registrar looks the account up, so the answer stays the same for a new and a taken address. A changed `login` or `email` meets the password policy again, then the registrar's own validation.
- **A code request answers the same when refused.** Only the `code.request` audit event, with `hook:<code>`, tells.
- **A refused logout keeps everything:** no revoke, no cleared cookie, no `Clear-Site-Data`, no logout extension.
- **The guard runs first.** With `CredentialAdminGuard` denying, no `authn.admin.credentials` hook runs; guard and hooks must both allow.

## Related

- [`@spinajs/hooks`](../hooks/README.md): the runner and the contract.
- The service actions: [`@spinajs/authn-local`](../authn-local/16-action-hooks.md), [`@spinajs/authn-token`](../authn-token/10-action-hooks.md), [`@spinajs/authn-keys`](../authn-keys/11-action-hooks.md), [`@spinajs/authn-totp`](../authn-totp/10-action-hooks.md), [`@spinajs/authn-webauthn`](../authn-webauthn/06-action-hooks.md).
