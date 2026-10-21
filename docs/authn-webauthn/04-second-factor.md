# Second factor

`WebAuthnMfaStep` (step name `webauthn`) is an `MfaStep`: list `{ name: 'webauthn', service: 'WebAuthnMfaStep' }` in `authn.mfa.steps`. Every credential of the identity counts, its passkeys included.

The `MfaStep` contract passes strings, so the step speaks JSON:

| Method | Takes | Gives |
| --- | --- | --- |
| `beginEnrolment(id)` | | `{ provisioning }`: `JSON.stringify({ challengeId, options })`, the creation options |
| `confirmEnrolment(id, response)` | `JSON.stringify({ challengeId, response, name? })` | `{ recoveryCodes }`, once |
| `challenge(id)` | | `{ challengeId, options }`: request options allowing only the identity's credentials |
| `verify(id, response)` | `JSON.stringify({ challengeId, response })` for a challenge of `challenge(id)` | `true` once per challenge |

`confirmEnrolment` throws `WebAuthnInvalidResponse` for a response that does not register a new credential of the identity. `verify` answers `false` for a used or expired challenge, another identity's challenge, an unknown credential, a wrong origin, a counter that did not grow, or a recovery code.

Over HTTP, a pending session asks `POST /auth/passkeys/challenge` for its challenge and sends the JSON above as the code of `POST /auth/mfa/verify` with step `webauthn`.

## Recovery codes

Confirmation issues `authn.webauthn.recoveryCodes` codes (`XXXX-XXXX-XXXX-XXXX`), stored as SHA-256. With the ORM store they share authn-orm's `authn_recovery_code` set with the TOTP step: confirming either step replaces it. `verifyRecovery` is single use; `regenerateRecoveryCodes` voids the old set and throws `WebAuthnNotEnrolled` without a credential. `disable` removes every credential and the codes.

## Not yet

The enrolment routes of `AuthnMfaEnrolmentController` serve the TOTP step only; a WebAuthn second factor is enrolled through `/user/passkeys` or `WebAuthnMfaStep` in code.
