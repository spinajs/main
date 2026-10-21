# Stores

| Contract | Memory | ORM (`@spinajs/authn-webauthn/db`) |
| --- | --- | --- |
| `WebAuthnCredentialStore` | `MemoryWebAuthnCredentialStore` | `DbWebAuthnCredentialStore`, table `authn_webauthn_credential` |
| `WebAuthnChallengeStore` | `MemoryWebAuthnChallengeStore` | `DbWebAuthnChallengeStore`, table `authn_webauthn_challenge` |
| `WebAuthnRecoveryCodeStore` | `MemoryWebAuthnRecoveryCodeStore` | `DbWebAuthnRecoveryCodeStore`, authn-orm's `authn_recovery_code` |

The memory stores lose everything on restart and are not shared between processes: use them in tests and single-process tools only.

## `WebAuthnCredentialStore`

- `add(c)` throws `WebAuthnCredentialExists` for a credential id that is taken, by any identity.
- `get(credentialId)`, `listFor(identity)` (oldest first), `remove(identity, credentialId)` (false unless the identity holds it).
- `advance(credentialId, expected, next, at)` is a compare-and-set of the signature counter: false when the stored counter is not `expected`. It also records `lastUsedAt`.

`authn_webauthn_credential` is keyed by the SHA-256 of the credential id (`id_hash`), since a credential id may be up to 1023 bytes. The COSE public key is stored as base64url, the transports as a JSON array.

## `WebAuthnChallengeStore`

`put(c)` and `take(id, now)`: a challenge is taken once, and never after `expiresAt`. `DbWebAuthnChallengeStore.take` keeps a row only if its own delete removed it, so a challenge is taken once across processes; `put` purges expired rows in batches.

## Migration

`AuthnWebauthn_2026_10_21_00_00_00` creates both tables on the `default` connection. It runs with the app's other migrations when the connection has `Migration.OnStartup`.

## In tests

```ts
import { DI } from '@spinajs/di';
import { MemoryWebAuthnChallengeStore, MemoryWebAuthnCredentialStore, MemoryWebAuthnRecoveryCodeStore, WebAuthnChallengeStore, WebAuthnCredentialStore, WebAuthnRecoveryCodeStore } from '@spinajs/authn-webauthn';

DI.register(MemoryWebAuthnCredentialStore).as(WebAuthnCredentialStore);
DI.register(MemoryWebAuthnChallengeStore).as(WebAuthnChallengeStore);
DI.register(MemoryWebAuthnRecoveryCodeStore).as(WebAuthnRecoveryCodeStore);
```

`SoftAuthenticator` of `@spinajs/authn-testing` plays the browser and the authenticator: one Ed25519 discoverable credential, `none` attestation, deterministic signatures for a given seed and challenge.
