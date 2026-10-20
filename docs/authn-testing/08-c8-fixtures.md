# C8 golden tickets

`loadC8Fixtures(dir?)` returns a vendored set of Ed25519 test keys and compact JWS tickets: 3 valid tickets with their claims, and 23 invalid ones, each with the `JwsErrorCode` a verifier must report. Use them to check a `JwsSigner` byte for byte and a `JwsVerifier` against every failure class.

The tickets come from the canvas C8 contract: `typ` `canvas-rt+jwt`, issuer `canvas-api`, audience `canvas-realtime`. The keys are public test keys from RFC 8037 A.1 and RFC 8032 section 7.1 TEST 2; never use them outside tests.

## How it works

1. `loadC8Fixtures()` finds the package's own `fixtures/c8/` folder by resolving `@spinajs/authn-testing/fixtures/c8/keys.json` from the current working directory. Pass `dir` to read another copy.
2. It reads `keys.json` and `tickets.json` and checks each file's SHA-256 against `C8_SOURCE`.
3. A mismatch throws `C8 fixture <file> in <dir> has sha256 <actual>, expected <expected> ...`: the copy was changed or re-encoded (for example line endings).
4. It returns `{ keys, tickets }`, parsed.

## Schema

### `keys.json` (`C8KeysFile`)

| Field | Type | Meaning |
| --- | --- | --- |
| `warning` | `string` | States that the keys are test keys |
| `signing` | `C8Jwk[]` with `d` | Two private Ed25519 JWKs (`kty` `OKP`, `crv` `Ed25519`, `kid`, `x`, `d`) |
| `jwks` | `{ keys: C8Jwk[] }` | The matching public JWKS |

### `tickets.json` (`C8TicketsFile`)

| Field | Type | Meaning |
| --- | --- | --- |
| `valid[]` | `{ name, kid, now, claims, token }` | A token, the key that signed it, its claims, and the verification time `now` in Unix seconds |
| `invalid[]` | `{ name, now, error, token }` | A token, the verification time, and the expected error code |

`C8_ERROR_CODES` lists the codes: `malformed`, `bad_header`, `unknown_key`, `bad_signature`, `invalid_claims`, `wrong_issuer`, `wrong_audience`, `expired`, `not_yet_valid`. `C8ErrorCode` is `JwsErrorCode` from `@spinajs/authn/contracts`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `dir` | `string` | the package's `fixtures/c8/` | a folder holding `keys.json` and `tickets.json` | Where to read the files from |

The files are also importable as `@spinajs/authn-testing/fixtures/c8/keys.json` and `@spinajs/authn-testing/fixtures/c8/tickets.json`. `C8_SOURCE` records the source repository, branch, commit and the SHA-256 and size of each file; `fixtures/c8/SOURCE.md` in the package describes how to refresh them.

## Important behaviour

- The loader refuses any copy whose bytes differ, including a line-ending conversion; `fixtures/c8/.gitattributes` keeps Git from converting them.
- Without `dir`, resolution starts at `process.cwd()`. Run the tests from a folder where `@spinajs/authn-testing` resolves.
- `invalid_claims` tickets fail a claims rule specific to canvas tickets. A verifier reports them only with that rule plugged in; `@spinajs/authn-keys` tests show one.

## Best practices

- Verify each ticket at its own `now` (`new Date(ticket.now * 1000)`), never at the current time: the tickets expire.
- Check the signer by re-signing each valid ticket's `claims` with its `kid` and comparing the token string.

## Examples

### Check that every invalid ticket has a known code

```ts sample
import 'mocha';
import assert from 'node:assert/strict';
import { C8_ERROR_CODES, loadC8Fixtures } from '@spinajs/authn-testing';

describe('C8 golden tickets', () => {
  it('cover every JWS error code', () => {
    const { keys, tickets } = loadC8Fixtures();
    assert.equal(keys.jwks.keys.length, keys.signing.length);
    const codes = new Set(tickets.invalid.map((t) => t.error));
    for (const code of C8_ERROR_CODES) assert.ok(codes.has(code), code);
  });
});
```

### Run a verifier over the invalid tickets

`JwsVerifier.verify(token, options)` answers `{ ok: false, code }` for a bad token. `options(nowSeconds)` builds the `JwsVerifyOptions`: `typ` `'canvas-rt+jwt'`, `algorithms` `['EdDSA']`, the public JWKS as `keys`, the canvas claims rule, issuer, audience, `now: new Date(nowSeconds * 1000)`, a 30 s skew and a 600 s maximum lifetime, as the `@spinajs/authn-keys` tests do.

```ts
for (const t of fixtures.tickets.invalid) {
  const r = await verifier.verify(t.token, options(t.now));
  assert.deepStrictEqual(r, { ok: false, code: t.error }, t.name);
}
```

## Related

- [`@spinajs/authn-keys`](../authn-keys/README.md): the JWS signer and verifier these tickets check.
- [Test helpers](07-test-helpers.md): `signCompactJws` and `generateKeyPair` for tokens of your own.
- [Behaviour rules](05-behaviour-rules.md): rule A17 checks JWS error codes with generated keys.
