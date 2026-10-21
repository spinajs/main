# Setup and configuration

## What importing the package registers

`import '@spinajs/authn-webauthn'` registers, each under its contract:

| Class | Registered as | Used when |
| --- | --- | --- |
| `PasskeyStrategy` | `AuthenticationStrategy` | `authn.strategies` lists `{ name: 'passkey', service: 'PasskeyStrategy' }` |
| `WebAuthnMfaStep` | `MfaStep` | `authn.mfa.steps` lists `{ name: 'webauthn', service: 'WebAuthnMfaStep' }` |
| `WebAuthnPasskeyService` | `PasskeyService` | the passkey routes of `@spinajs/authn-http` |
| `AuthnWebAuthnConfigBootstrapper` | `Bootstrapper` | always: validates `authn.webauthn` and fills its defaults |

Registered strategies and steps never run until the configuration lists them.

`import '@spinajs/authn-webauthn/db'` registers the ORM stores (`DbWebAuthnCredentialStore`, `DbWebAuthnChallengeStore`, `DbWebAuthnRecoveryCodeStore`) and the `AuthnWebauthn_2026_10_21_00_00_00` migration, and loads `@spinajs/authn-orm`. Without it, or another registration of the three stores, every ceremony fails with an error naming the missing store. Tests register the memory stores instead (see [Stores](05-stores.md)).

## `authn.webauthn`

| Key | Default | Meaning |
| --- | --- | --- |
| `rpId` | `'localhost'` | The registrable domain credentials are scoped to, e.g. `example.com`. Changing it orphans every registered credential. |
| `rpName` | `'SpinaJS'` | Shown by the authenticator. |
| `origins` | `[]` | Exact origins (scheme, host, port) a ceremony may come from. With none, every ceremony fails. |
| `userVerification` | `'preferred'` | Asked of the authenticator. Only `'required'` refuses an assertion without user verification. |
| `challengeTtlSeconds` | `300` | How long a challenge stays usable (30 to 600). |
| `recoveryCodes` | `10` | Recovery codes issued when the second factor is confirmed (0 to 100). |

## Assurance (D7)

A passkey proves possession of the authenticator, and with user verification (PIN or biometrics) also something the user knows or is. So a passkey login with user verification yields `assurance: 'aal2'`, and one without it `aal1`. `PasskeyStrategy` reports the value in `StrategyOutcome.assurance`; `DefaultAuthnService` writes it into the session facts. The default MFA policy asks no further step for a passkey login (its method is `webauthn`, not `password`).
