# Action hooks

The routes run their own actions through the [`@spinajs/hooks`](../hooks/README.md) runner, and map the refusals of the services behind them. A hook can refuse a logout, a session revoke, a role switch, a credential admin action, a registration or a code request, and observe each before and after it runs.

## How it works

1. The route runs its own checks first: the session, fresh authentication, the field checks, the throttle. Who may administer whose credentials is a hook too: the `CredentialAdminRule`, the first before hook of `authn.admin.credentials`.
2. It runs the action with [`runHookedAction`](../authn/14-action-hooks.md#runhookedaction): with no matching hook the action runs alone; otherwise a `before` hook may refuse.
3. A refusal answers `{ error: 'action_refused', code, message }` with 403, or 400 for a registration. A hook that threw or timed out answers the code `hook_error`. Most refusals are audited (see the table) with the reason `hook:<code>` or `hook_error`.
4. A route whose service refused through its own hooks (passwords, tokens, keys, passkeys, TOTP) answers the same way.

In the tables below, 403 `{ code }` stands for that `action_refused` body.

## Actions of the routes

| Action | Route | Input | Mutable | Output (`after` hooks) | Refused answer | Audited as |
| --- | --- | --- | --- | --- | --- | --- |
| `authn.logout` | `POST /auth/logout` | `session`, `ctx` | none | `void` | 403 `{ code }`; the session, the cookie and the site data are kept | `logout` failure |
| `authn.sessions.revoke` | `DELETE /user/sessions/:handle`, `DELETE /user/sessions` | `subject`, `handle` (`'others'` for every session but the current one), `ctx` | none | the number of sessions ended (`1` or `0` for one handle) | 403 `{ code }`; every session is kept | `session.revoke` failure |
| `authn.role.switch` | `POST /auth/active-role` | `session`, `role`, `ctx` | none | the narrowed `Principal` | 403 `{ code }`; the role and the session id are unchanged | not audited |
| `authn.admin.credentials` | every `/authn/admin/users/:uuid/...` route, through `runCredentialAdmin()`; users-http's admin routes run it too | `actor` (the admin's whole `Principal`), `target`, `action` | none | the route's answer body | the rule's own codes: 403 `forbidden`, `protected_role`, `escalation` or 404 `not_found`, not audited; any other hook: 403 `{ code }`; nothing changes | `password.change` (`password-reset`), `mfa.disable` (`mfa-reset`), `session.revoke` (`sessions`), `token.revoke` (`tokens`) failure, `data: { action }` |
| `authn.registration` | `POST /auth/register`, before `IdentityRegistrar.register` | `login`, `email`, `ctx` | `login`, `email` | `RegistrationOutput`: `{ status: 'created' \| 'exists', id }`; the shipped `RegistrationMailHook` sends the mails from it | 400 `{ code }` | `identity.register` failure |
| `authn.code.request` | `POST /auth/code/request` | `login`, `ctx` | none | `CodeRequestResult` | the same 202 `{ Ok: true }`; no mail | `code.request` failure, `data: { via: 'login' }` |
| `authn.request` | every request, in `AuthnMiddleware`, when `authn.http.hooks.request` is `true` | `principal` (`null` for anonymous), `method`, `path` (without the query string), `ip?` | none | `void` | 403 `{ code }` | not audited |

The input types are exported from `@spinajs/authn-http`: `LogoutInput`, `SessionsRevokeInput`, `RoleSwitchInput`, `CredentialAdminInput`, `RegistrationInput`, `CodeRequestInput`, `RequestInput`, and the output type `RegistrationOutput`. `authn.admin.credentials` and `CredentialAdminInput` are declared by `@spinajs/authn/hooks`; authn-http re-exports the type.

## Hooks authn-http ships

| Hook | Action | Phase | What it does | To change it |
| --- | --- | --- | --- | --- |
| `RegistrationMailHook` | `authn.registration` | `after` | Requests the verification mail of a created account and the account-exists mail of a taken address (`authn.http.registration.notifyExisting`). See [Registration route](22-registration-route.md). | Extend it and override `send(outcome, ctx)`, or `DI.unregister(RegistrationMailHook)` before the application boots. |

The `CredentialAdminRule` of `authn.admin.credentials` comes from `@spinajs/users` (`AuthzCredentialAdminRule`); see [Credential admin routes](16-credential-admin-routes.md).

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

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.http.hooks.request` | `boolean` | `false` | `true`, `false` | Runs `authn.request` on every request once its principal is resolved. Any value but `true` is off. |

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

- **Hooks get copies.** Each input key is a frozen copy (`hookView`), a mutable key a plain copy (`hookCopy`), and the after hooks get a frozen copy of the output. The action reads what it acts on from its own values, so a write in place in a hook reaches nothing. `authn.request` hooks see a frozen copy of the principal: they cannot drop its ceiling or change its id. Without a matching hook nothing is copied.
- **A `Session` handed to a hook is a plain copy:** it has the data (`handle`, `identity`, `facts`) but none of the class getters (`state`, `impersonator`, `activeRole`); see [authn action hooks](../authn/14-action-hooks.md).
- **A route answers only its own action's refusal.** A refusal of another action that escapes the service is rethrown, not answered as this route's.
- **A refusal inside the registrar answers 202.** Only a new address reaches what the IdentityRegistrar runs (`users.create`, `authn.password.set`), so its refusal, or the `password` InvalidArgument users makes of a refused set, answers the accepted 202 of a taken address and is audited as an `identity.register` failure with its reason (`hook:<code>`, `hook_error` or `password_refused`) and `data.action`, the nested action, when known. Only an `authn.registration` refusal answers 400.
- **No audit event for a refused role switch or `authn.request`:** no event type fits either, so only the 403 answer tells.
- **`authn.request` costs a hook run per request.** Leave it off unless a rule needs every request. The hooks then see anonymous requests too (`principal: null`). A refusal reaches `next(err)` as a `Forbidden` carrying `error: 'action_refused'` and `code`, so the 403 comes from the `@spinajs/http` error handler; any other error fails the request as a store error does.
- **A refused admin password reset audits once.** An `authn.password.expire` refusal inside the `password-reset` route answers the same 403 `{ code }`; `LocalPasswordService.expire()` writes its audit event, the route writes none.
- **A registration hook must not branch on whether the account exists.** It runs before the registrar looks the account up, so the answer stays the same for a new and a taken address. A changed `login` or `email` meets the password policy again (400 `password_rejected` with `violations`), then the registrar's own validation (400 `invalid_registration`).
- **A code request answers the same when refused.** Only the `code.request` audit event, with `hook:<code>`, tells.
- **A refused logout keeps everything:** no revoke, no cleared cookie, no `Clear-Site-Data`, no logout extension.
- **The rule runs first.** The `CredentialAdminRule` has order `-1000`, so it runs before hooks of the default order. When it refuses, no other `authn.admin.credentials` hook runs. The rule and every other hook must all allow. An effect that no rule admitted is refused 403 `forbidden`, for example when the rule was registered after the hooks runner resolved.

## Related

- [`@spinajs/hooks`](../hooks/README.md): the runner and the contract.
- The service actions: [`@spinajs/authn-local`](../authn-local/16-action-hooks.md), [`@spinajs/authn-token`](../authn-token/10-action-hooks.md), [`@spinajs/authn-keys`](../authn-keys/11-action-hooks.md), [`@spinajs/authn-totp`](../authn-totp/10-action-hooks.md), [`@spinajs/authn-webauthn`](../authn-webauthn/06-action-hooks.md).
