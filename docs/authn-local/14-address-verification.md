# Address verification

`LocalPasswordService` can prove that an account's email address reaches its owner: it mails a single-use link, and redeeming the link marks the address verified. With `authn.login.requireVerifiedAddress`, the authn core then refuses logins of accounts whose address is not verified yet.

The flow uses the same pieces as reset and invite: a `SecretStore` for the secret, the [mail pipeline](13-mail-delivery.md) for the mail, and an `IdentityAddressVerifier` (from `@spinajs/authn`) that stores the result. [`@spinajs/users`](../users/README.md) ships `UserAddressVerifier`, which writes `users.EmailVerifiedAt`. [`@spinajs/authn-http`](../authn-http/21-verification-routes.md) serves the two routes.

## How it works

1. `requestVerification(id, ctx)` counts the attempt in the `reset` throttle flow under its own account key (`verify:<type>:<id>`), so it never uses up the reset request of the same account. A throttled request answers `{ status: 'throttled', retryAfterSeconds }`.
2. When the identity can verify (it exists, is not deleted or banned, and is active or invite-pending) and its address is not verified yet, it dispatches an `AuthnMailRequest` of purpose `verify`. Like every authn mail, the request holds no secret.
3. Either way it answers `{ status: 'accepted' }`. An address already verified gets no mail.
4. When the mail is delivered, `deliver()` issues a `SecretStore` secret of purpose `verify` with a lifetime of `authn.local.verify.ttlSeconds`. It mails it with `authn.local.verify.url`, from the `authn/verify.mjml` template of `@spinajs/email`.
5. `redeemVerification(secret, ctx)` redeems the secret once and calls `IdentityAddressVerifier.markVerified(id, ctx.now)`: `{ status: 'verified' }`. Every refusal answers `{ status: 'invalid' }`: a wrong, used or expired secret, a reset or invite secret, or an identity that can no longer verify.

The mailed secret is `base64url(JSON [type, id]).<raw secret>`. `POST /auth/verify` takes the secret alone, and a `SecretStore` redeems per identity, so the link carries its identity. The identity part is not secret. Only the SHA-256 of the raw part is stored.

An identity whose store does not track verification (`IdentityStatus.addressVerified` undefined) is never refused at login.

The `authn.address.verify.request` [action hooks](16-action-hooks.md) run after the throttle of step 1, around steps 2 and 3; a refusal answers `{ status: 'accepted' }` and mails nothing. The `authn.address.verify` hooks run around step 5, before the secret is read; a refusal answers `{ status: 'invalid' }` and leaves the secret usable.

## Example

```ts
// config/authn.ts in your app
export default {
  authn: {
    login: { requireVerifiedAddress: true },
    local: {
      verify: { url: 'https://app.example.com/verify', ttlSeconds: 86400 },
    },
  },
};
```

The page at `authn.local.verify.url` reads the `token` query parameter and posts it as `{ secret }` to `POST /auth/verify`.

## Important behaviour

- `requireVerifiedAddress` applies to login methods only (`local`, OIDC): a token or a key is not a login. The refusal comes after the credentials are verified, so a wrong password still answers `invalid_credentials`. A correct password of an unverified account answers `unverified_address`.
- Redeeming an invite also marks the address verified in `@spinajs/users`, because the invite secret was mailed to it.
- A second verify secret voids the earlier one, as for every secret purpose.
- Without an `IdentityAddressVerifier`, `redeemVerification` throws `InvalidOperation`.

## Audit events

| Type | Outcome | Reason | Fields | When |
| --- | --- | --- | --- | --- |
| `throttle.block` | `failure` | `throttled` | `identity`, `data: { flow: 'verify' }` | `requestVerification()` |
| `address.verify.request` | `failure` | `status` or `verified` | `identity` | `requestVerification()`: no mail |
| `address.verify.request` | `success` or `failure` | `no_mailer` on failure | `identity` | `requestVerification()` |
| `address.verify` | `failure` | `malformed`, `unknown_identity`, `status` or `secret` | `identity` when it exists | `redeemVerification()` |
| `address.verify` | `success` | | `identity` | `redeemVerification()` |
| `address.verify.request` | `failure` | `hook:<code>` or `hook_error` | `identity` | `requestVerification()`: an action hook refused or failed |
| `address.verify` | `failure` | `hook:<code>` or `hook_error` | | `redeemVerification()`: an action hook refused or failed |

## Configuration

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `authn.local.verify.ttlSeconds` | integer >= 1 | `86400` | Lifetime of a verify secret and of its queued request. |
| `authn.local.verify.url` | string | `''` | The page that redeems the secret. Empty: the mail shows the secret instead of a link. Set it when you serve the routes. |
| `authn.login.requireVerifiedAddress` | boolean | `false` | Refuse logins of accounts whose address the `IdentityStore` reports unverified (`@spinajs/authn`). |
| `email.password.verify.subject` | string | `'Confirm your email address'` | Subject of the verify mail (`@spinajs/email`). |
| `email.password.verify.template` | `.mjml` path or `{ file, fs }` | `{ file: 'authn/verify.mjml', fs: 'email-builtin-templates' }` | Template of the verify mail (`@spinajs/email`). |
