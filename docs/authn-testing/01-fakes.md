# Fakes

In-memory implementations of the `@spinajs/authn` contracts. Use them to test code that needs identities, passwords, sessions, MFA or a throttle without a database, and as the ports you do not own when you run the [behaviour rules](04-behaviour-runner.md).

Every fake extends the contract class from `@spinajs/authn/contracts`, so it fits wherever that contract is expected. The kit registers nothing in DI: you construct the fakes and wire them yourself.

## How it works

1. Build the fakes your test needs. Most take no arguments; the ones that do take options with defaults.
2. Seed data through the fake's own methods (`FakeIdentityStore.add`, `FakeMfaStep.enrol`) or through `fakeSeedPort`.
3. Pass the fakes to the code under test, or to [`FakeAuthnService`](02-fake-authn-service.md) to run a full login.
4. Assert on the recorded calls: most fakes keep public `calls`, `verifyCalls`, `writes`, `attempts` or `all()` lists.

Time comes from two places. `ctx.now` (from `FakeClock.ctx()`) drives the throttle fakes. `Date.now()` drives `MemorySessionIssuer`, `MemorySecretStore` and `MemoryLinkStore`, so install the clock when a test moves time for those (see [`FakeClock`](#fakeclock)).

## The fakes

| Fake | Contract | What it does | Recorded for assertions |
| --- | --- | --- | --- |
| `FakeClock` | none | Fakes `Date` only; builds `AuthnContext` values | `now()` |
| `FakeIdentityStore` | `IdentityStore` | Identities in a map; finds by login or email, case-insensitive | `calls.findByLogin`, `calls.status`, `calls.provision` |
| `MemoryPasswordCredentialStore` | `PasswordCredentialStore` | Hashes per identity, with an atomic compare-and-set | `writes` |
| `MemorySecretStore` | `SecretStore` | Single-use secrets stored as SHA-256, one live secret per identity and purpose | `rows()` |
| `MemorySessionIssuer` | `SessionIssuer` | Sessions keyed by the SHA-256 of the id, idle and absolute timeouts, pending sessions | `storage.storedKeys()` |
| `MemoryLinkStore` | `IdentityLinkStore` | External links; `(provider, subject)` is unique | `links` |
| `MemoryTokenService` | `TokenService` | Tokens in memory with rotation and narrowing; takes its time from `ctx.now`; no owner status or role checks | none |
| `FakeMfaStep` | `MfaStep` | Six-digit codes, each accepted once; optional recovery codes | `verifyCalls` |
| `EnrolledMfaPolicy` | `MfaPolicy` | Requires every configured step the identity is enrolled in | none |
| `FakeStrategy` | `AuthenticationStrategy` | A strategy from two functions, plus `password`, `bearer` and `external` presets | `verifyCalls`, `keyCalls` |
| `RecordingThrottle` | `AuthnThrottle` | Allows everything except the refusals you script | `attempts`, `succeeds` |
| `FakeBackoffThrottle` | `AuthnThrottle` | Per-key exponential backoff, never a lock, with an atomic `peek` | protected `rows` |
| `RecordingEventSink` | `AuthnEventSink` | Keeps every published event, frozen | `all()`, `ofType()`, `clear()` |
| `RecordingPrincipalFactory` | `PrincipalFactory` | Builds a `Principal` from the identity, facts and extras | `calls` |
| `FakeImpersonationGuard` | `ImpersonationGuard` | Allows every impersonation until you deny one target or all | `calls` |
| `FakeImpersonationStartHook(() => guard)` | `ActionHook` on `authn.impersonation.start` | The start check as users registers it: asks the guard about `input.actor` and `input.target` and refuses with its code. Register it beside the guard, or every start is refused (`no_guard`) | none |
| `FakeRoleSource` | `RoleSource` | Roles you grant per identity | none |
| `fakeSeedPort(identities, passwords)` | `SeedPort` | Seeds users into the two fakes; passwords stored with `fakeHash` | none |

### `FakeClock`

| Member | Effect |
| --- | --- |
| `new FakeClock(start?)` | Starts at `start`, or at the current time truncated to whole seconds |
| `now()` | The clock's time as a new `Date` |
| `tick(ms)` | Moves forward by `ms`; throws for a negative or `NaN` value |
| `set(at)` | Jumps to `at` |
| `install()` / `uninstall()` | Fakes the global `Date` through `@sinonjs/fake-timers`; `installed` tells whether it is on |
| `ctx(over?)` | An `AuthnContext`: `now` from the clock, `ip` `'192.0.2.10'`, `userAgent` `'authn-testing'`, `purpose` `'login'`, then `over` |

Only `Date` is faked. Timers, `performance.now()` and `process.hrtime` stay real, and the clock does not advance by itself.

### `FakeIdentityStore`

- `add({ login, email?, name?, type?, id?, status? })` returns an `IdentityRef`. `type` defaults to `'user'`, `id` to a random UUID, and the status to active, not banned, not deleted.
- `setStatus(id, flags)` merges status flags; `remove(id)` deletes the identity.
- `status()` of an unknown identity answers `exists: false`.
- `new FakeIdentityStore({ jit: true })` adds `provision()`, which creates an identity whose login is the external email, or `<provider>:<subject>` without one. Without `jit` the store has no `provision` method.

### `MemoryPasswordCredentialStore` and the fake hash

- `set(id, hash, expected?)`: with `expected` undefined it writes and answers `true`. With `expected` (or `null` for "no password") it writes only when the stored value still equals it, and answers whether it wrote.
- `fakeHash(password)` gives `'fake$' + sha256hex(password)`; `fakeVerify(hash, password)` compares in constant time. `FAKE_DUMMY_HASH` is the hash `FakeStrategy.password` verifies against for an unknown login, so unknown and known logins cost the same.
- These hashes exist for tests only; they are not argon2.

### `MemorySecretStore`

- `issue()` returns a 32-byte random base64url secret and keeps only its SHA-256; with a fourth argument `value` it issues that string instead. Issuing again for the same identity and purpose replaces the older secret.
- `redeem()` succeeds once, for the right identity and purpose, before `expiresAt`, comparing in constant time.
- `rows()` lists the stored rows; `seedHash(identity, purpose, hashHex, expiresAt, createdAt)` plants a row directly.

### `MemorySessionIssuer`

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `idleMinutes` | `number` | `30` | An active session expires after this long without a `restore` |
| `absoluteMinutes` | `number` | `480` | No session lives longer than this, active or not |
| `pendingTtlSeconds` | `number` | `300` | Lifetime of a pending (pre-MFA) session; `restore` does not extend it |
| `container` | `IContainer` | `DI.RootContainer` | Container that `restore` passes to `resolveSession` |

- Ids are 16 random bytes in base64url; the store keys rows by their SHA-256. `facts.sessionHandle` and `list()` give a handle derived from that key, never the id or the key.
- `restore()` looks a row up by the SHA-256 of the id only; an id equal to a stored key restores nothing.
- `elevate()` refuses an active session; `set()` refuses the reserved keys `Subject`, `Impersonator`, `State` and `authn:facts`.
- `revoke()` answers `true` only for the call that removed the row.

### `FakeMfaStep` and `EnrolledMfaPolicy`

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | `string` | `'fake'` | Step name; `'recovery'` throws, since `completeMfa` reserves it |
| `recoveryCodes` | `number \| false` | `10` | Recovery codes issued by `confirmEnrolment` and `regenerateRecoveryCodes`; `false` removes `verifyRecovery` and `regenerateRecoveryCodes` |

- `enrol(id)` enrols directly. `nextCode(id)` returns a fresh six-digit code that `verify` accepts once.
- `challenge: true` gives the step a `challenge(id, ctx)` that records its calls in `challenges`, as a step that mails its code has.
- `MemoryMfaEnrolmentMarks` is the in-memory `MfaEnrolmentMarks`: `mark` answers `false` for an identity marked already.
- `beginEnrolment` returns `fake://enrol?code=<code>`; `confirmEnrolment` with that code enrols and returns the recovery codes.
- `new EnrolledMfaPolicy(steps, { methods })` requires the steps the identity is enrolled in, only for logins whose method is in `methods` (default `['password']`).

### `FakeStrategy`

`new FakeStrategy({ name, kinds, interactive, verify, keys, linking? })` builds a strategy from a `verify` and a `keys` function. Three presets cover the common cases:

| Preset | Kind | Interactive | Verifies | Throttle keys |
| --- | --- | --- | --- | --- |
| `FakeStrategy.password({ identities, passwords, name? })` | `password` | yes | Login and password against the two fakes; name `'local'` | `account` (lower-cased login), `account-ip` |
| `FakeStrategy.bearer({ tokens, name?, attributes? })` | `bearer` | no | The token as a key of the `tokens` map; name `'token'` | `account` and `account-ip` from a hash prefix of the token, never the token |
| `FakeStrategy.external({ provider, subjects, name?, linking? })` | `external` | yes | `payload.subject` against the `subjects` map; answers an `external` subject; name `'fake-idp'` | `account` `<provider>:<subject>` |

An unexpected kind answers `unsupported_credentials`; a wrong secret answers `invalid_credentials`. `linkingFor()` answers the `linking` switches; `external` turns both on unless you pass `linking`.

### `RecordingThrottle` and `FakeBackoffThrottle`

- `RecordingThrottle.refuse(retryAfterSeconds, times = 1)` refuses the next `times` attempts with that delay. Every other attempt is allowed.
- `new FakeBackoffThrottle(params)` takes `ThrottleParams` (use `DEFAULT_THROTTLE` or `throttleParams(config)`). After `free` counted attempts a key waits `min(baseDelayMs × 2^(n − free), maxDelayMs)`. A refused attempt counts nothing; `account-ip` only keeps bookkeeping. A success resets the account key and takes that account's attempts off the IP key, except in the `reset` flow. A key idle for `resetAfterSeconds` starts over.
- `FakeBackoffThrottle.peek()` answers like `attempt()` without counting.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Throttle backoff | None; you construct it | `FakeBackoffThrottle` | `RecordingThrottle` | Subclass and override the protected `delayMs(p, n)` or `onRefused(row, p, nowMs)` |
| Strategy | None; you construct it | `FakeStrategy` presets | Your own `verify` and `keys` functions | `new FakeStrategy({ ... })` with your functions |
| Principal shape | None; you construct it | `RecordingPrincipalFactory` | none | Pass `derive: (id) => attributes` to add attributes to every principal |

### Use the fakes inside a booted app

`@spinajs/authn` looks strategies, the throttle and MFA steps up by the `service` name in `authn.*` config (`authn.strategies[].service`, `authn.throttle.service`, `authn.mfa.steps[].service`). The `@spinajs/authn-http` tests register a named factory that answers with a fake, then name it in config.

```ts
import { DI } from '@spinajs/di';
import { AuthenticationStrategy } from '@spinajs/authn/contracts';
import { FakeIdentityStore, FakeStrategy, MemoryPasswordCredentialStore } from '@spinajs/authn-testing';

const identities = new FakeIdentityStore();
const passwords = new MemoryPasswordCredentialStore();
const strategy = FakeStrategy.password({ identities, passwords });

// The function name is the registration name the config refers to.
const TestPasswordStrategy = () => strategy;
DI.register(TestPasswordStrategy).as(AuthenticationStrategy);

// config: authn.strategies = [{ name: 'local', service: 'TestPasswordStrategy' }]
```

Swap the fakes per test by making the factory answer with the current instance, and uncache the services that hold state with `DI.uncache(<type>)`, never `DI.clearCache()`. See [the harness rules](04-behaviour-runner.md#harness-factory).

## Important behaviour

- The fakes keep their state in the instance. Build new instances per test; nothing is shared between two `FakeIdentityStore` objects.
- `MemorySessionIssuer`, `MemorySecretStore` and `MemoryLinkStore` read `Date.now()`. A `FakeClock` that is not installed does not move their time.
- `FakeClock.install()` fakes the global `Date` for the whole process. Always pair it with `uninstall()` in a `finally` or an `after` hook.
- `RecordingEventSink.all()` returns a copy; events published later do not appear in an earlier copy.
- `fakeSeedPort` stores `fakeHash(password)`. Only `FakeStrategy.password` (or your own code using `fakeVerify`) accepts those hashes; a real argon2 strategy does not.

## Best practices

- Build the throttle from `throttleParams(config)` when a test sets `authn.throttle` overrides; it merges them over `DEFAULT_THROTTLE` the way the behaviour rules expect.
- Use `RecordingThrottle.refuse()` to test how your code handles a throttled answer; use `FakeBackoffThrottle` with a `FakeClock` to test the backoff schedule itself.
- Give `FakeMfaStep` the step name your app configures (for example `'totp'`), so step names in results and routes match.

## Patterns and antipatterns

```ts
// Don't: the session issuer reads Date.now(), so ticking a clock that is not installed changes nothing
const clock = new FakeClock();
clock.tick(31 * 60_000);
assert.equal(await sessions.restore(session.id), null); // fails: the session is still live

// Do
const clock = new FakeClock();
clock.install();
try {
  clock.tick(31 * 60_000);
  assert.equal(await sessions.restore(session.id), null);
} finally {
  clock.uninstall();
}
```

## Examples

### Expire an idle session

```ts sample
import 'mocha';
import assert from 'node:assert/strict';
import type { AuthnFacts } from '@spinajs/authn/contracts';
import { FakeClock, MemorySessionIssuer } from '@spinajs/authn-testing';

describe('session timeout', () => {
  it('ends a session after 30 idle minutes', async () => {
    const clock = new FakeClock();
    clock.install();
    try {
      const sessions = new MemorySessionIssuer({ idleMinutes: 30 });
      const facts: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: clock.now() };
      const session = await sessions.issue({ type: 'user', id: 'u-1' }, facts);

      clock.tick(29 * 60_000);
      assert.ok(await sessions.restore(session.id), 'still live, and the restore extends it');

      clock.tick(31 * 60_000);
      assert.equal(await sessions.restore(session.id), null);
    } finally {
      clock.uninstall();
    }
  });
});
```

### Answer a throttled login

```ts sample
import 'mocha';
import {
  ALICE,
  EnrolledMfaPolicy,
  FakeAuthnService,
  FakeClock,
  FakeIdentityStore,
  FakeStrategy,
  MemoryLinkStore,
  MemoryPasswordCredentialStore,
  MemorySessionIssuer,
  RecordingEventSink,
  RecordingPrincipalFactory,
  RecordingThrottle,
  expectThrottled,
  fakeSeedPort,
  pw,
} from '@spinajs/authn-testing';

describe('login form', () => {
  it('passes Retry-After through when the throttle refuses', async () => {
    const identities = new FakeIdentityStore();
    const passwords = new MemoryPasswordCredentialStore();
    const throttle = new RecordingThrottle();
    const service = new FakeAuthnService({
      strategies: [FakeStrategy.password({ identities, passwords })],
      throttle,
      identities,
      links: new MemoryLinkStore(),
      linking: { jit: false, byVerifiedEmail: false },
      policy: new EnrolledMfaPolicy([]),
      steps: [],
      sessions: new MemorySessionIssuer(),
      sinks: [new RecordingEventSink()],
      principals: new RecordingPrincipalFactory(),
    });
    await fakeSeedPort(identities, passwords).user({ login: ALICE.login, password: ALICE.password });

    throttle.refuse(30);
    const result = await service.authenticate(pw(ALICE.login, ALICE.password), new FakeClock().ctx());
    expectThrottled(result, 30);
  });
});
```

## Related

- [Fake authentication service](02-fake-authn-service.md): runs the login flow over these fakes.
- [Conformance suites](03-conformance-suites.md): the same suites that check your stores pass on these fakes.
- [`@spinajs/authn`](../authn/README.md): the contracts the fakes implement.
