# Test helpers

Building blocks the behaviour rules use, exported for your own tests: kit users and values, result assertions, timing comparison, parallel bursts, backoff walks, key pairs, JWS and HTTP signatures, TOTP codes, id entropy and a local JWKS server.

## Kit users and values

| Export | Value |
| --- | --- |
| `ALICE`, `BOB`, `CAROL`, `DAVE` | `KitUser` (`{ login, password }`), for example `alice@example.test` / `Alice-Pass-1234` |
| `NOBODY` | `'nobody@example.test'`, a login nobody has |
| `WRONG`, `NEW_PW` | A wrong password and a valid new password |
| `IP_A`, `IP_B`, `SPOOF_IP` | `192.0.2.10`, `192.0.2.20`, `203.0.113.66` |
| `attackerIp(i)` | A distinct address `198.18.x.y` per `i` |
| `ORIGIN_EVIL`, `ORIGIN_PARTNER` | `https://evil.example.net`, `https://partner.example.org` |
| `KIT_ATTRIBUTES` | `{ profile: 'kit-p' }`, the attributes the `attributed` port's strategies return |

Every kit password is 14 or 15 characters long, inside the 8 to 128 bounds of rule A04.

## Building blocks

| Export | Effect |
| --- | --- |
| `pw(login, password)` | Password `Credentials` |
| `pwKeys(login, ip)` | The `account`, `account-ip` and `ip` throttle keys of a password login |
| `auth(h, k, credentials, over?)` | `h.service.authenticate(credentials, k.ctx(over))` |
| `seedUser(h, user, status?)` | Seeds a `KitUser` through the `seed` port |
| `storedHash(h, id)` | The hash the `passwordStore` port holds for `id`, or `null` |
| `factsAal1(k)` | Password `aal1` facts with `authenticatedAt` from the case clock |
| `hasEvent(events, type, outcome?)` | Whether the events port holds such an event |
| `throttleParams(config?)` | `authn.throttle` overrides merged over `DEFAULT_THROTTLE` per flow and key |

## Result assertions

| Assertion | Passes when |
| --- | --- |
| `expectSuccess(res)` | `status` is `'success'`; narrows the type |
| `expectMfaRequired(res)` | `status` is `'mfa_required'`; narrows the type |
| `expectFailure(res, reason)` | A failure with that reason and no `retryAfterSeconds` |
| `expectThrottled(res, seconds)` | Exactly `{ status: 'failure', reason: 'throttled', retryAfterSeconds: seconds }` |
| `expectFail(res)` | Any failure |
| `expectFailOrReject(promise)` | The promise rejects, or resolves to anything but a success |
| `expectAllowed(r)`, `expectRefused(r, seconds)` | A throttle verdict is exactly allowed, or refused with that delay |
| `isFailure(res, reason)`, `isThrottled(res, seconds)` | The same checks as booleans |

## Timing comparison

`assertSameTiming(a, b, options?)` fails when two operations take measurably different time, the check behind "unknown accounts cost the same as known ones". `compareTiming` returns the `TimingReport` instead of throwing.

1. Each side is a `TimedSource`: `prepare(count)` builds the calls outside the timed region. `repeat(fn)` makes a source whose calls are all `fn`.
2. It runs `warmup` calls per side, then `runs` timed calls per side, alternating which side goes first.
3. It compares the medians: the attempt passes when `|p50a − p50b| ≤ max(tolerance × max(p50a, p50b), noiseFloorMs)`.
4. A failed attempt is repeated up to `retries` times; any passing attempt passes.

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `runs` | `number` | `200` | integer ≥ 0 | Timed calls per side |
| `warmup` | `number` | `20` | integer ≥ 0 | Untimed calls per side first |
| `tolerance` | `number` | `0.1` | fraction | Allowed relative difference of the medians |
| `noiseFloorMs` | `number` | `2` under CI, else `0.5` | ms | Smallest difference that counts; env `AUTHN_TESTING_TIMING_FLOOR_MS` |
| `retries` | `number` | `4` under CI, else `2` | integer ≥ 0 | Extra attempts; env `AUTHN_TESTING_TIMING_RETRIES` |

`timingDefaults(env?)` returns these defaults; `timingTimeoutMs(options, perCallMs)` returns a case timeout of `(retries + 1) × 2 × (warmup + runs) × perCallMs × 1.5`, at least 60 s.

## Other helpers

| Export | Effect |
| --- | --- |
| `burst(n, fn)` | Starts `fn(0..n-1)` in one tick, before any is awaited, then settles all; returns `outcomes`, `fulfilled()`, `rejected()`, `count(pred)` |
| `backoffDelayMs(params, n)` | Delay after counted attempt `n`: `0` below `free`, else `min(baseDelayMs × 2^(n − free), maxDelayMs)` |
| `backoffSchedule(params, count)` | Earliest offsets of attempts `1..count` |
| `retryAfterSeconds(ms)` | `ceil(ms / 1000)` |
| `walkBackoff(options)` | Makes `attempts` counted attempts on a throttle along the schedule, moving a `FakeClock`; between them it probes early attempts, asserts they are refused, and relies on them not being counted |
| `generateKeyPair(alg)` | An Ed25519 (`'EdDSA'`) or P-256 key pair as `KitKeyPair`, `kid` the RFC 7638 thumbprint |
| `thumbprint(jwk)`, `b64url`, `b64urlDecode`, `sha256hex`, `sha256b64` | Encoding and hashing helpers |
| `signCompactJws(header, payload, key)` | A compact JWS; `key` may be `'none'` (empty signature) or `{ hmacKey }` (HS256) for negative tests |
| `compactJws([h, p, s])` | Joins three parts, for malformed tokens |
| `signHttpRequest(req, key, kid, params)` | An RFC 9421 signed request with `content-digest`, `signature-input` and `signature` (label `sig1`, no `alg` parameter) |
| `contentDigest(body)`, `signatureBase(req, components, params)` | The pieces of an HTTP signature |
| `totp(secret, at, options?)`, `totpFromProvisioning(uri, at)`, `parseOtpauth(uri)`, `base32Decode(s)` | RFC 6238 codes from a base32 secret or an `otpauth://` URI |
| `idBits(id)` | Estimated entropy: UUID v4 122 bits, other UUIDs 0, hex 4 bits a character, base64url 6 bits a character |
| `startJwksServer(keys)` | A JWKS at `http://127.0.0.1:<port>/jwks.json`; `hits()`, `setKeys()`, `close()` |

## Important behaviour

- `assertSameTiming` measures with `process.hrtime`, which the case clock does not fake.
- `burst` starts every call before any is awaited. A store that checks and then writes with an await in between lets more than one call win.
- `signHttpRequest` writes `nonce` and `keyid` unescaped; they must not hold quotes or backslashes.
- `startJwksServer` counts every `GET`, whatever its path, and answers 404 on other paths.
- The JWS and HTTP signature helpers write ES256 signatures as 64-byte `ieee-p1363`, as JOSE expects.

## Best practices

- Build single-use credentials (fresh `jti`, nonce) in `TimedSource.prepare`, never inside the timed call.
- Use `burst` with an exact count assertion (`count((r) => r.status === 'success') === free`) when testing a throttle or a single-use secret.
- Close a `startJwksServer` in `after` or the case's `close()`; it holds a listening socket.

## Patterns and antipatterns

```ts
// Don't: awaiting in a loop runs the calls one after another, so no race ever happens
const results = [];
for (let i = 0; i < 20; i++) results.push(await redeem(secret));

// Do: start every call in the same tick
const r = await burst(20, () => redeem(secret));
assert.equal(r.count((ok) => ok === true), 1);
```

## Examples

### Prove an unknown login costs the same as a known one

```ts sample
import 'mocha';
import {
  ALICE,
  FakeClock,
  FakeIdentityStore,
  FakeStrategy,
  MemoryPasswordCredentialStore,
  NOBODY,
  WRONG,
  assertSameTiming,
  fakeSeedPort,
  pw,
  repeat,
} from '@spinajs/authn-testing';

describe('login timing', function () {
  this.timeout(60_000);

  it('answers an unknown login as slowly as a wrong password', async () => {
    const identities = new FakeIdentityStore();
    const passwords = new MemoryPasswordCredentialStore();
    await fakeSeedPort(identities, passwords).user({ login: ALICE.login, password: ALICE.password });
    const strategy = FakeStrategy.password({ identities, passwords });
    const ctx = new FakeClock().ctx();

    await assertSameTiming(
      repeat(() => strategy.verify(pw(ALICE.login, WRONG), ctx)),
      repeat(() => strategy.verify(pw(NOBODY, WRONG), ctx)),
    );
  });
});
```

### Get a TOTP code from an enrolment

```ts sample
import assert from 'node:assert/strict';
import { totpFromProvisioning } from '@spinajs/authn-testing';

const uri = 'otpauth://totp/App:alice?secret=JBSWY3DPEHPK3PXP&issuer=App&digits=6&period=30';
const code = totpFromProvisioning(uri, new Date('2026-10-20T12:00:00Z'));
assert.match(code, /^\d{6}$/);
```

## Related

- [Behaviour rules](05-behaviour-rules.md): where these helpers are used.
- [Conformance suites](03-conformance-suites.md#strategy-conformance): the timing case of strategy conformance.
- [C8 golden tickets](08-c8-fixtures.md): fixed keys and tokens to test a JWS verifier.
