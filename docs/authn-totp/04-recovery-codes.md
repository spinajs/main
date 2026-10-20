# Recovery codes

Recovery codes let a user who lost the authenticator device finish a login. `TotpMfaStep` issues them at confirmation and on regeneration, stores only their SHA-256 hashes, and accepts each one once.

## How it works

### Issue

1. `TotpMfaStep.confirmEnrolment` (see [Enrolment](02-enrolment.md)) or `regenerateRecoveryCodes` draws `authn.mfa.totp.recoveryCodes` distinct codes. Each is 10 random bytes (80 bits) as 16 base32 characters.
2. `MfaSecretStore.replaceRecoveryCodes(identity, codes)` voids the identity's earlier codes and stores the SHA-256 hex of each new one.
3. The codes are returned once, as `XXXX-XXXX-XXXX-XXXX`.

### Log in with a recovery code

1. The client posts the code to `POST auth/mfa/recovery` with the pending session (`@spinajs/authn-http`).
2. `AuthnService.completeMfa(pending, 'recovery', code, ctx)` counts the attempt into the `mfa` throttle. `recovery` is a reserved step name, not a step.
3. `completeMfa` picks the first listed step that has `verifyRecovery` and in which the identity is enrolled, and calls `TotpMfaStep.verifyRecovery(identity, code)`.
4. `verifyRecovery` normalises the input: ASCII only, upper case, dashes and whitespace removed, then exactly 16 base32 characters. Anything else returns `false` with no store call.
5. It returns `false` unless the enrolment is confirmed, then calls `MfaSecretStore.redeemRecoveryCode(identity, normalised)`. The store marks the code used; of parallel calls with one code, exactly one gets `true`.
6. On `true`, `completeMfa` elevates the session to `aal2` with `mfa: ['recovery']`.

### Regenerate, `TotpService.regenerateRecoveryCodes(session, ctx, reauth?)`

1. `TotpService` restores the session; it must be active and not impersonated. Otherwise `no_session`.
2. It checks fresh auth as `begin` does: a recent login, or a valid `reauth`. Otherwise `not_fresh`.
3. `TotpMfaStep.regenerateRecoveryCodes(identity)` throws `TotpNotEnrolled` without a confirmed enrolment; the service answers `not_enrolled`.
4. Otherwise it issues a new set, voids the old one and returns `{ ok: true, recoveryCodes }`.
5. Every outcome except `no_session` is audited as `mfa.enrol` with `data.recoveryCodes = 'regenerated'`; a success adds `data.count`. The contract has no event type of its own for regeneration.

Over HTTP, `POST user/mfa/recovery-codes` with `{ reauthPassword? }` calls it.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.mfa.totp.recoveryCodes` | `number` | `10` | integer 0 to 100 | Codes per set. `0` issues none and makes regeneration only void the old set. |

## Schema

`DbMfaSecretStore` keeps the hashes in `authn_recovery_code` of `@spinajs/authn-orm`: one row per code with `code_hash` (hex SHA-256, unsalted) and `used_at`. Columns: [MFA store](../authn-orm/05-mfa-store.md).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Code storage | `MfaSecretStore`, singleton | `DbMfaSecretStore` | `MemoryMfaSecretStore` | Implement `replaceRecoveryCodes`, `redeemRecoveryCode`, `countRecoveryCodes`, `removeRecoveryCodes`; see [Secret store](06-secret-store.md). |

## Important behaviour

- The codes are shown once, at confirmation or regeneration. The store keeps only their hashes; nothing can show them again.
- Codes are unsalted SHA-256, so they need high entropy: each has 80 bits.
- Entry ignores case, dashes and ASCII whitespace: `abcd efgh-ijkl mnop` and `ABCD-EFGH-IJKL-MNOP` are the same code.
- Non-ASCII input is refused before upper-casing, so `ß` cannot turn into `SS`.
- A new confirmation voids codes left from an earlier enrolment.
- `TotpMfaStep.disable` removes every recovery code of the identity together with the enrolment.
- `verify` refuses a recovery code, and `verifyRecovery` refuses a TOTP code.
- `TotpService.disable` accepts a recovery code in place of a TOTP code; that use spends it.
- `MemoryMfaSecretStore` and `DbMfaSecretStore` refuse a set with an empty or repeated code with `InvalidArgument`.

## Best practices

- Show the codes in the `XXXX-XXXX-XXXX-XXXX` form `TotpMfaStep` returns, and offer a download or print step before the user leaves the page.
- Warn users who are running low: `MfaSecretStore.countRecoveryCodes(identity)` returns the unused codes.

## Examples

### Warn a user with fewer than three recovery codes left

```ts sample
import '@spinajs/authn-totp/db';
import { MfaSecretStore } from '@spinajs/authn-totp';
import { DI } from '@spinajs/di';

export async function recoveryCodesRunningLow(userUuid: string): Promise<boolean> {
  const store = await DI.resolve(MfaSecretStore);
  const user = { type: 'user', id: userUuid };
  const enrolment = await store.get(user, 'totp');
  if (!enrolment?.confirmedAt) {
    return false;
  }
  return (await store.countRecoveryCodes(user)) < 3;
}
```

## Related

- [Enrolment](02-enrolment.md): the first set comes with confirmation.
- [The TOTP step at login](03-login-verification.md): the normal second factor.
- [`@spinajs/authn`](../authn/README.md): `completeMfa` and the reserved `recovery` step name.
- [`@spinajs/authn-orm` MFA store](../authn-orm/05-mfa-store.md): `authn_recovery_code` and single use in SQL.
- [`@spinajs/authn-http` login and MFA routes](../authn-http/08-login-logout-and-mfa-routes.md): `POST auth/mfa/recovery`.
