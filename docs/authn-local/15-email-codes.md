# Email codes

`@spinajs/authn-local` can mail a 6-digit one-time code to the account's verified address and use it in two ways: as a second factor after a password login (`EmailCodeMfaStep`, step `email-code`), and as a way to log in without a password (`EmailCodeStrategy`, strategy `email-code`).

Both use the same pieces as reset and invite: a `SecretStore` for the code, the [mail pipeline](13-mail-delivery.md) for the mail, and `LocalPasswordService` for throttling and audit. The code mail is the `authn/code.mjml` template of [`@spinajs/email`](../email/08-password-mailer.md). [`@spinajs/authn-http`](../authn-http/22-code-routes.md) serves `POST /auth/mfa/challenge`, `POST /auth/code/request` and `POST /auth/code/login`.

## How a code lives

1. Asking for a code dispatches an `AuthnMailRequest` of purpose `code`. Like every authn mail the request holds no secret, so the queue never carries a code.
2. When the mail is delivered, `PasswordService.deliver()` issues the code: 6 random digits, stored as a `SecretStore` secret of purpose `email-code` with a lifetime of `authn.local.emailCode.ttlSeconds`. A new code replaces the older one of the identity.
3. A code is single use. Each code also has five attempts: five single-use tickets of purpose `email-code-try-<n>` are issued with it, and every verify spends one before it looks at the code. After five verifies, right or wrong, the code is void until a new one is issued. The tickets live in the `SecretStore`, so the limit holds across processes.
4. Every verify, for a known or an unknown identity, spends the same six `SecretStore` redeems, so its time tells nothing about the account.

The `SecretStore` must keep a chosen value: `SecretStore.issue(identity, purpose, ttlSeconds, value?)` takes the code as `value`. `DbSecretStore` and `MemorySecretStore` do. A store that returns a random secret instead makes issuing a code throw `InvalidOperation`.

The code is stored as the SHA-256 of 6 digits, which anyone with the table can reverse. It is protected by its short lifetime, its single use and its five attempts, not by hashing.

## Second factor: `EmailCodeMfaStep`

List the step like any other: `authn.mfa.steps: [{ name: 'email-code', service: 'EmailCodeMfaStep' }]`. The step needs a `SecretStore`, an `IdentityStore`, a `PasswordService` that sends codes (`LocalPasswordService`) and a `MfaEnrolmentMarks` (`DbMfaEnrolmentMarks` of [`@spinajs/authn-orm`](../authn-orm/05-mfa-store.md)). It keeps no secret, so `storesSecrets` is `false` and no `authn.mfa.encryptionKey` is needed.

| Method | Behaviour |
| --- | --- |
| `enrolled(id)` | Whether the identity has the enrolment mark. |
| `beginEnrolment(id)` | Throws `EmailCodeAlreadyEnrolled` when enrolled. Throws `EmailCodeAddressUnverified` unless the identity has an address and the `IdentityStore` reports `addressVerified === true` (a store that does not track it counts as unverified here). Otherwise it mails a code and answers `{ provisioning }`, the masked address (`a***@example.com`). Throws `EmailCodeThrottled` while the code throttle refuses another mail. |
| `confirmEnrolment(id, code)` | Verifies the code (`EmailCodeInvalid` when wrong) and sets the mark. It returns no recovery codes: the mailbox is the recovery. |
| `verify(id, code)` | `true` once, for an enrolled identity and the right unexpired code. |
| `challenge(id, ctx)` | Mails a code to an enrolled identity. A throttled, unenrolled or ineligible request sends nothing and says nothing. |
| `disable(id)` | Removes the mark. |

A login flow with the step is: password login, `mfa_required` with `['email-code']`, `POST /auth/mfa/challenge` to get the code mailed, then `POST /auth/mfa/verify` with `{ code }`. The session becomes `aal2` with `mfa: ['email-code']`.

Enrolment is a mark per identity and step, kept as a confirmed `authn_mfa` row by `DbMfaEnrolmentMarks`. `MfaEnrolments` sees it, so an identity enrolled in `email-code` while `authn.mfa.steps` does not list it is refused at login, like any stored factor.

There are no HTTP routes to enrol, confirm or disable the step yet: the `/user/mfa` routes serve TOTP only. Call `beginEnrolment`, `confirmEnrolment` and `disable` from your own routes or admin tooling, after your own fresh-authentication check.

## Login: `EmailCodeStrategy`

List the strategy: `authn.strategies: [{ name: 'email-code', service: 'EmailCodeStrategy' }]`. Credentials are `{ kind: 'email-code', login, code }`.

1. `PasswordService.requestCode(login, ctx)` counts the attempt in the `reset` throttle flow under the keys `code:<normalised login>` and the client ip, answers `{ status: 'accepted' }` at once, and does the lookup and the mail as deferred work. An unknown login, a login that is not active, and a login whose address the store reports unverified (`addressVerified === false`) get no mail and the same answer. A store that does not track verification still gets the mail.
2. `authenticate({ kind: 'email-code', login, code })` verifies the code once: `method: 'email-code'`, `assurance: 'aal1'`. A wrong, spent, expired or voided code, an unknown login and a malformed code all answer `invalid_credentials`.
3. A code login is a single factor like a password. `authn.mfa.policy.methods` defaults to `['password']`, so it asks for no second step. Set the list to `['password', 'email-code']` to ask for one. The list replaces the default, so keep `password` in it: without it, password logins no longer get a second step.

The strategy counts in the account key `code:<normalised login>` of the `login` flow, not in the password one, so wrong codes and a successful code login neither use up nor clear the password backoff. `authn.login.requireVerifiedAddress` applies to it like to any login method.

## Example

```ts
// config/authn.ts in your app
export default {
  authn: {
    strategies: [
      { name: 'local', service: 'LocalPasswordStrategy' },
      { name: 'email-code', service: 'EmailCodeStrategy' },
    ],
    mfa: { steps: [{ name: 'email-code', service: 'EmailCodeMfaStep' }] },
    local: { emailCode: { ttlSeconds: 600 } },
  },
};
```

```ts
const step = await DI.resolve(EmailCodeMfaStep);
await step.beginEnrolment(identity); // mails a code
await step.confirmEnrolment(identity, codeFromTheMail);
```

## Important behaviour

- The code mail needs the `authn/code.mjml` template and a `PasswordMailer`. Without a mailer nothing is sent and the request is audited with reason `no_mailer`.
- Codes are asked for in the `reset` throttle flow under `code:` keys: the first request is free and a repeat inside the backoff is refused, so the mail address cannot be flooded. A refused `challenge` sends nothing and the route still answers 202.
- A mail address that was never verified cannot enrol, and a code login never mails an address the store marks unverified. Without that, someone who registered an account with another person's address could receive that person's login.
- The `AuthnMailJob` payload names the identity and the purpose only. The retry of a failed job issues a fresh code and voids the earlier one.

## Audit events

| Type | Outcome | Reason | Fields | When |
| --- | --- | --- | --- | --- |
| `throttle.block` | `failure` | `throttled` | `identity` when known, `data: { flow: 'code' }` | `requestCode()` and `challengeCode()` |
| `code.request` | `failure` | `unknown_login` | `data: { via: 'login' }` | `requestCode()`, deferred |
| `code.request` | `failure` | `status` or `unverified_address` | `identity`, `data: { via: 'login' \| 'mfa' }` | the identity cannot get a code |
| `code.request` | `success` or `failure` | `no_mailer` on failure | `identity`, `data: { via: 'login' \| 'mfa' }` | the request was dispatched |

Verifying a code is audited by the core as `login` (strategy `email-code`) or `mfa.verify`. No event holds a code.

## Configuration

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `authn.local.emailCode.ttlSeconds` | integer >= 1 | `600` | Lifetime of a code and of its queued request. |
| `authn.mfa.steps` | `{ name, service }[]` | `[]` | List `{ name: 'email-code', service: 'EmailCodeMfaStep' }` to use the second factor. |
| `authn.strategies` | `{ name, service }[]` | `[]` | List `{ name: 'email-code', service: 'EmailCodeStrategy' }` to allow code login. |
| `email.password.code.subject` | string | `'Your sign-in code'` | Subject of the code mail (`@spinajs/email`). |
| `email.password.code.template` | `.mjml` path or `{ file, fs }` | `{ file: 'authn/code.mjml', fs: 'email-builtin-templates' }` | Template of the code mail (`@spinajs/email`). |
