# Passkey management

`WebAuthnPasskeyService` implements `PasskeyService` from `@spinajs/authn/contracts`. The routes of `AuthnPasskeyController` (`@spinajs/authn-http`) call it for the caller's own session only.

| Route | Needs | Answers |
| --- | --- | --- |
| `POST /auth/passkeys/challenge` | nothing; a pending session gets an MFA challenge for its identity | `{ challengeId, options }` |
| `POST /auth/passkeys/login` | `{ challengeId, response }` | the login answer |
| `POST /user/passkeys/options` | a full session, fresh auth (`reauthPassword` when stale) | `{ challengeId, options }` for `navigator.credentials.create()` |
| `POST /user/passkeys` | a full session, fresh auth; `{ challengeId, response, name? }` | `{ id, name, transports, createdAt, lastUsedAt }` |
| `GET /user/passkeys` | a full session | the caller's passkeys, oldest first |
| `DELETE /user/passkeys/:id` | a full session | `null`; 404 `passkey_not_found` for any id that is not the caller's |

The routes are off (404 `not_found`) while no `PasskeyService` is registered or `authn.strategies` lists no strategy for `webauthn` credentials. A token or key caller gets 403 `session_required`, an impersonation 403 `impersonating`, a stale session without the password 403 `fresh_auth_required`.

## Registration

`registrationOptions(id, ctx)` asks for a discoverable credential (`residentKey: 'required'`), with `attestation: 'none'`, the identity's id as the WebAuthn user id and its existing credentials excluded. `register(id, { challengeId, response, name? }, ctx)` answers `{ ok: true, passkey }`, or `{ ok: false, code }`:

- `invalid_response`: a used, expired or foreign challenge, a wrong origin or an attestation that does not verify (HTTP 400 `invalid_response`);
- `duplicate`: the credential is registered already (HTTP 409 `passkey_taken`).

A refused attempt uses its challenge up.

## Audit

`passkey.register` (success and failure) and `passkey.remove` events, with the identity. No event carries a challenge, a public key or an attestation.
