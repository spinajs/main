# Encryption keys

TOTP secrets are stored AES-256-GCM encrypted under `authn.mfa.encryptionKey`. `MfaKeyRing` holds the current key and earlier ones: it encrypts with the current key, stores that key's id next to the cipher text, and decrypts each row with the key whose id the row names. Rotation needs no data migration.

## How it works

1. On first use, `TotpMfaStep` calls `mfaKeyRingFrom(authn.mfa.encryptionKey)`.
2. `mfaKeyRingFrom` throws `InvalidOption` (`authn.mfa.encryptionKey.secret is not set`) when `secret` is missing or empty.
3. It builds an `MfaKey` from `secret` and from each entry of `previous` with `mfaKeyFrom` of `@spinajs/authn-orm/cipher`. A bad entry of `previous` throws `InvalidOption` naming its index, for example `authn.mfa.encryptionKey.previous[1]`.
4. `new MfaKeyRing(current, previous)` indexes the keys by `keyId`. A key id that repeats keeps its first key.
5. `MfaKeyRing.encrypt(identity, step, plain)` returns `{ secretEnc, keyId }`, always under the current key. `TotpMfaStep.beginEnrolment` stores both.
6. `MfaKeyRing.decrypt(identity, step, secretEnc, keyId)` picks the key by `keyId` and decrypts. An unknown `keyId` throws `InvalidArgument` that says to add the key to `authn.mfa.encryptionKey.previous`.
7. `TotpMfaStep` turns any decrypt failure into `UnexpectedServerError`: a missing key or a damaged row is a server fault, never a wrong code.

The cipher format (`v1.<iv>.<tag>.<ct>`, bound to `<identity>|<step>`) and the key id derivation belong to `@spinajs/authn-orm`: [The MFA cipher](../authn-orm/05-mfa-store.md#the-mfa-cipher).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.mfa.encryptionKey.secret` | `string \| null` | unset | 32 bytes as 64 hex characters, or as base64 or base64url | The current key. Every new enrolment is encrypted with it. |
| `authn.mfa.encryptionKey.previous` | `string[]` | unset | keys in the same formats | Retired keys. Rows written under them still decrypt. |

```ts
const config = {
  authn: {
    mfa: {
      encryptionKey: {
        secret: process.env.MFA_KEY_2026,
        previous: [process.env.MFA_KEY_2025],
      },
    },
  },
};
export default config;
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Key ring | not in DI; one per `TotpMfaStep`, built on first use | `mfaKeyRingFrom(authn.mfa.encryptionKey)` | `new MfaKeyRing(current, previous)` | Pass `keys` in `TotpMfaStepDeps`; see [Wiring and testing](09-wiring-and-testing.md). |

Exports: `MfaKeyRing` (`current`, `encrypt`, `decrypt`), `mfaKeyRingFrom(options)` and the `MfaEncryptionKeyOptions` type (`{ secret: string; previous?: readonly string[] }`).

## Important behaviour

- Rotation is lazy. Rows keep the key they were written with until the user enrols again; `previous` must keep a key as long as any row uses it.
- A row whose key is gone from the ring fails every login of that user with a server error. `completeMfa` answers it as a wrong code and audits `step_error`.
- `TotpMfaStep` builds the ring once and keeps it. A new key takes effect after a restart.
- The root entry imports from `@spinajs/authn-orm` only the side-effect-free `@spinajs/authn-orm/cipher` and `@spinajs/authn-orm/identity`, so building a key ring registers no DB service.
- Outside development and test, `@spinajs/authn` fails boot when a listed step stores secrets and `authn.mfa.encryptionKey` is missing.

## Best practices

- Rotate in two moves: set the new key as `secret` and move the old one into `previous`; drop the old key only after no `authn_mfa` row has its `key_id`.
- Generate a key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Patterns and antipatterns

```ts
// Don't: replacing the key outright makes every existing enrolment undecryptable
encryptionKey: { secret: process.env.MFA_KEY_2026 }

// Do: keep the retired key in previous
encryptionKey: { secret: process.env.MFA_KEY_2026, previous: [process.env.MFA_KEY_2025] }
```

## Examples

### Check the MFA keys at startup, before the first login needs them

```ts sample
import { mfaKeyRingFrom } from '@spinajs/authn-totp';

export function checkMfaKeys(secret: string, previous: string[]): void {
  const ring = mfaKeyRingFrom({ secret, previous });
  const probe = { type: 'system', id: 'startup-check' };
  const { secretEnc, keyId } = ring.encrypt(probe, 'totp', 'JBSWY3DPEHPK3PXP');
  if (ring.decrypt(probe, 'totp', secretEnc, keyId) !== 'JBSWY3DPEHPK3PXP') {
    throw new Error('the MFA encryption key does not round-trip');
  }
}
```

## Related

- [Turning TOTP on](01-setup.md): where the key fits in the setup.
- [`@spinajs/authn-orm` MFA store](../authn-orm/05-mfa-store.md): the cipher functions and the `key_id` column.
- [`@spinajs/authn`](../authn/04-mfa-policy-and-steps.md): the boot check on `authn.mfa.encryptionKey`.
