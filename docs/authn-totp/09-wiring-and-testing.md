# Wiring and testing

`TotpMfaStep` and `TotpService` take every dependency from DI on first use, unless you pass it to their constructor. Passing dependencies is how unit tests run them without a database, and how an app with per-child-container MFA steps points `TotpService` at the right steps.

## How it works

### `TotpMfaStep(deps?: TotpMfaStepDeps)`

1. DI builds the step with no arguments (`@Injectable(MfaStep)`). Each dependency left out of `deps` comes from DI.
2. On the first call, the step resolves all four at once and keeps them:

| Dependency | From `deps` | From DI when left out |
| --- | --- | --- |
| `store` | `MfaSecretStore` | the registered `MfaSecretStore` (optional; none throws `InvalidOperation` on use) |
| `keys` | `MfaKeyRing` | `mfaKeyRingFrom(authn.mfa.encryptionKey)` |
| `options` | `TotpOptions` | `authn.mfa.totp` |
| `identities` | `IdentityStore \| null`; `null` means none | the registered `IdentityStore`, else none |

3. It checks `options` against the floor (`digits` 6 to 10, `period` 1 to 300, `window` 0 to 10, `recoveryCodes` 0 to 100, all integers) and throws `InvalidOption` otherwise.
4. Without an `IdentityStore`, the `otpauth://` label is `id.id` instead of the email or name.

### `TotpService(deps?: TotpServiceDeps)`

1. DI builds the service with no arguments (`@Injectable()`, under the name `TotpService`).
2. Each dependency is resolved on first use, one by one, and kept. `adminReset` therefore needs only the step and the audit sinks.

| Dependency | From `deps` | From DI when left out | When missing |
| --- | --- | --- | --- |
| `step` | `TotpMfaStep` | the first `TotpMfaStep` among `DI.resolve(Array.ofType(MfaStep))` | `InvalidOperation`: `TotpService: no TotpMfaStep is registered` |
| `steps` | `MfaStep[]` | every registered `MfaStep` | `[]` |
| `sessions` | `SessionIssuer` | the registered `SessionIssuer` | `InvalidOperation` |
| `authn` | `AuthnService` | the registered `AuthnService` | `InvalidOperation` |
| `throttle` | `AuthnThrottle` | the registered `AuthnThrottle` | `InvalidOperation` |
| `sinks` | `AuthnEventSink[]` | every registered `AuthnEventSink` | `[]` |
| `maxAgeSeconds` | `number` | `authn.freshAuth.maxAgeSeconds` | |

3. `steps` is what "the identity is enrolled in no MFA step" checks against; see [Enrolment](02-enrolment.md).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| TOTP step | `MfaStep`, singleton | `TotpMfaStep`, built by DI with no `deps` | | Construct `new TotpMfaStep(deps)` in tests, or pass one as `TotpServiceDeps.step`. |
| Owner service | `TotpService`, singleton | `TotpService`, built by DI with no `deps` | | Construct `new TotpService(deps)` in tests or for per-container steps. |

## Important behaviour

- `TotpService` looks up DI services in the root container (`DI`). An app that registers MFA steps per child container passes `steps` (and `step`) itself.
- `@spinajs/authn-http` resolves `TotpService` by name from its own container and requires an instance of `TotpService`; it also requires a listed step that is an instance of `TotpMfaStep` named exactly `TotpMfaStep`. A renamed subclass turns its enrolment routes off (404).
- Both classes keep what they resolved for their lifetime. A test that swaps a registration after the first call needs a new instance.
- `@spinajs/authn-testing` has the helpers the package's own tests use: `totp(secret, at, options)` computes a code, `parseOtpauth(uri)` reads the secret and options of a URI, and `FakeClock` controls `Date.now()`.

## Best practices

- In unit tests pass `identities: null` to `TotpMfaStep`, so the step never resolves an `IdentityStore` another test registered.
- Pass `maxAgeSeconds` to `TotpService` in tests that check fresh auth, instead of changing the config.

## Examples

### Unit-test enrolment and replay protection without a database

```ts sample
import { MemoryMfaSecretStore, TotpMfaStep, mfaKeyRingFrom } from '@spinajs/authn-totp';
import { parseOtpauth, totp } from '@spinajs/authn-testing';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

export async function totpCodeWorksOnce(): Promise<void> {
  const step = new TotpMfaStep({
    store: new MemoryMfaSecretStore(),
    keys: mfaKeyRingFrom({ secret: randomBytes(32).toString('hex') }),
    options: { issuer: 'Acme Test', algorithm: 'SHA1', digits: 6, period: 30, window: 1, recoveryCodes: 10 },
    identities: null,
  });
  const jane = { type: 'user', id: '3b1f2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' };

  const { provisioning } = await step.beginEnrolment(jane);
  const otp = parseOtpauth(provisioning);
  const { recoveryCodes } = await step.confirmEnrolment(jane, totp(otp.secret, new Date(), otp));
  assert.equal(recoveryCodes?.length, 10);

  // confirmEnrolment spent the current time step; a code of the next one is inside window 1.
  const next = totp(otp.secret, new Date(Date.now() + 30_000), otp);
  assert.equal(await step.verify(jane, next), true);
  assert.equal(await step.verify(jane, next), false);
}
```

## Related

- [Secret store](06-secret-store.md): `MemoryMfaSecretStore` and custom stores.
- [Encryption keys](07-encryption-keys.md): `mfaKeyRingFrom` and `MfaKeyRing`.
- [`@spinajs/authn-testing`](../authn-testing/README.md): the behaviour suites and helpers for authn packages.
