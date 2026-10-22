# Email domains

`EmailDomainHook` refuses an email address whose domain `@spinajs/email-verification` rejects (disposable-address lists, DNS, domain age, HTTP checkers). It is an `ActionHook` that users registers on import. The check itself stays off until `emailVerification.enabled` is true; see the [email-verification docs](../email-verification/README.md) for the verifiers, the lists and the refusal code (`emailVerification.refuseCode`, default `email_domain_refused`).

## Paths

`users.emailDomains.apply` switches each path. All three default to `true`.

```ts
export default {
  users: { emailDomains: { apply: { registration: true, usersCreate: true, emailChange: true } } },
};
```

| Key | Action | Address checked | Refused answer |
| --- | --- | --- | --- |
| `registration` | `authn.registration` | `input.email` | `POST /auth/register` answers 400 `{ code }`. The audit holds `identity.register` with reason `hook:<code>`. No user is created and no mail is requested. |
| `usersCreate` | `users.create` | `input.data.Email` | `create()` throws `ActionRefused`. users-http answers 403 `{ code }`. |
| `emailChange` | `users.update`, only when `data.Email` is set and differs from the user's email | `input.data.Email` | `update()` throws `ActionRefused`. users-http answers 403 `{ code }`. |

`users.create` also covers the registrar, invites and OIDC provisioning. Self-service registration runs `authn.registration` first, so with both switches on the second check is served from the verifier cache and only the first refuses. With `registration` off, a refusal from `users.create` inside the registrar is answered like a taken address (202), as for every action the registrar runs.

Only the `code` reaches the client. The verifier `source` and `reason` stay in the logs of `EmailVerification`.
