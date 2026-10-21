# Passkey login

`PasskeyStrategy` (name `passkey`, credential kind `webauthn`, interactive) logs a user in with a discoverable credential.

## The ceremony

1. `POST /auth/passkeys/challenge` (anonymous) counts the client ip in the `login` throttle flow (429 with `Retry-After` when refused) and answers `{ challengeId, options }`. A pending session's MFA challenge is not throttled here. While the store holds `authn.webauthn.challenges.maxRows` challenges the route answers `503 { error: 'challenge_store_full' }` with `Retry-After: 30` and logs one warning until a challenge is stored again. `options` is a `PublicKeyCredentialRequestOptionsJSON` without `allowCredentials`, so the authenticator offers any passkey it holds for the relying party.
2. The browser passes `options` to `navigator.credentials.get()` (or `startAuthentication()` of `@simplewebauthn/browser`).
3. `POST /auth/passkeys/login` with `{ challengeId, response }` authenticates `{ kind: 'webauthn', challengeId, response }` through `AuthnService.authenticate`, sets the session cookie and answers as `POST /auth/login` does. Any failure is the one login failure answer (A02).

In code, without HTTP:

```ts
const { challengeId, options } = await passkeys.challenge({ now: new Date(), purpose: 'login' });
// ... the browser signs options.challenge ...
const result = await authn.authenticate({ kind: 'webauthn', challengeId, response }, ctx);
```

## What is checked

- The challenge is taken from the challenge store before anything else: a challenge works once, and only before it expires. A registration or MFA challenge never logs in.
- The credential is looked up by the assertion's id. An unknown id is checked against a key nobody holds, so it costs the same as a known one, and fails `invalid_credentials`.
- `@simplewebauthn/server` checks the challenge, the origin against `authn.webauthn.origins`, the rp id hash, user presence, user verification when `userVerification` is `'required'`, the signature counter and the signature.
- A user handle sent by the authenticator must be the stored owner's. The identity always comes from the stored credential.
- The counter moves by compare-and-set (`WebAuthnCredentialStore.advance`): an assertion whose counter does not grow past the stored one, or that loses a race with another, fails. Authenticators that keep the counter at 0 are accepted while it stays 0.

## Assurance

`assurance: 'aal2'` when the authenticator set the user-verified flag, else `'aal1'` (D7). `method` is `'webauthn'`.

## Throttling

The account key of an attempt is `webauthn:<credential id>`, next to the client ip key that `DefaultAuthnService` adds.
