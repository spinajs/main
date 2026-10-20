# JWS and key material

The building blocks under every key strategy: the public-key checks, strict base64url and JSON readers, raw signatures, `StrictJwsVerifier` (the `JwsVerifier` contract) and `LocalJwsSigner` (a `JwsSigner`). They follow the canvas C8 rules, so tokens verify the same way here and in the C8 Rust verifier. Use them directly to sign or verify your own JWS types, or to build a client.

## How it works

### Public keys

`checkPublicJwk(input, allowed = KEY_ALGORITHMS)` returns `{ alg, jwk }` (`KeyMaterial`) or `null`:

1. `input` is a plain object with no `d` member.
2. Ed25519: `{ kty: 'OKP', crv: 'Ed25519', x }`, `x` is 32 bytes of strict base64url, a canonical point (`isCanonicalPoint`), and not of small order (`isSmallOrder`, the 8 encodings in `SMALL_ORDER`). The algorithm is `EdDSA`.
3. P-256: `{ kty: 'EC', crv: 'P-256', x, y }`, both 32 bytes of strict base64url. The algorithm is `ES256`.
4. The algorithm is in `allowed`, and `node:crypto` imports the key (a P-256 point off the curve does not import).
5. Every other member (`alg`, `kid`, `use`, ...) is dropped, never trusted.

Related helpers:

| Export | What it does |
| --- | --- |
| `KEY_ALGORITHMS` | `['EdDSA', 'ES256']` |
| `isValidKid(kid)` | `true` for 1-64 of `[A-Za-z0-9._-]` |
| `thumbprint(jwk)` | RFC 7638: required members in lexicographic order, SHA-256, base64url (43 characters) |
| `publicKeyObject(material)` | The `node:crypto` key for a material that passes `checkPublicJwk` with its own algorithm, else `null`; caches up to 1,024 keys |
| `verifySignature(material, data, signature)` | Verifies with the material's own algorithm; `false` for a weak key or a signature that is not 64 bytes |
| `signRaw(alg, privateKey, data)` | A raw signature: Ed25519, or ES256 over SHA-256 as IEEE P1363 |
| `dummyVerify(alg, data, signature)` | One verification under a key nobody holds; always `false`. Equalises the time of an unknown key |
| `SIGNATURE_BYTES` | `64`, for both algorithms |
| `decodeB64url(text)` / `encodeB64url(data)` | Strict unpadded base64url: one text form per value, `null` for anything else |
| `parseStrictJson(bytes, uintKeys?)` | JSON as `serde_json` reads it, or `undefined` |
| `isJsonObject(value)` | `true` for a non-array object; deprecated, use `isPlainObject` from `@spinajs/util` |

`parseStrictJson` refuses invalid UTF-8, lone surrogates (keys included), nesting deeper than 127, numbers beyond `f64`, and top-level `uintKeys` whose number is not written as a plain integer. A duplicate key keeps its last value. It never throws.

### `StrictJwsVerifier`

`verify(token, opts)` runs these checks in order. The first failure is the result's `code`; a bad token never throws.

| # | Code | Fails when |
| --- | --- | --- |
| 1 | `malformed` | not a string, not three parts, a part that is not strict base64url, a signature that is not 64 bytes |
| 2 | `bad_header` | the header is not exactly `{ alg, kid, typ }` with string values, `alg` is not in `opts.algorithms`, or `typ` differs from `opts.typ` |
| 3 | `unknown_key` | `opts.keys(kid)` returns `null`, a key whose `alg` differs from the header's, or a key that fails the key checks |
| 4 | `bad_signature` | the signature does not verify with the key's own algorithm |
| 5 | `invalid_claims` | the payload is not an object; `iss` or `aud` is not a string; `iat` or `exp` is not a non-negative safe integer written as one; `exp <= iat`; `exp - iat > opts.maxLifetimeSeconds`; `opts.claims(payload)` returns `null` |
| 6 | `wrong_issuer` | `iss` differs from `opts.issuer`, or `opts.issuer(iss, key)` returns `false` |
| 7 | `wrong_audience` | `aud` differs from `opts.audience` |
| 8 | `expired` | `now >= exp + skewSeconds` (whole seconds) |
| 9 | `not_yet_valid` | `iat > now + skewSeconds` |

Success returns `{ ok: true, header, claims, key }`.

### `LocalJwsSigner`

`new LocalJwsSigner(privateJwks, { current? })` holds private JWKs the app loads, for example from a secret reference.

1. Each JWK is checked: `kid` matches `isValidKid`, the public part passes `checkPublicJwk`, `d` is 32 bytes, the key loads, and the public part matches `d`. A failure throws `InvalidArgument`, naming the `kid`.
2. A `kid` given twice throws `InvalidArgument`. `current` (default: the first key's `kid`) must be one of them.
3. `sign(claims, { typ, kid? })` signs with `kid` or the current key. It writes the header as `{"alg","kid","typ"}` in that order and the claims as `JSON.stringify` writes them, in your key order. EdDSA is deterministic, so the C8 golden tickets come out byte for byte.
4. `sign` throws `InvalidArgument` for an unknown `kid`, an empty `typ`, claims without string `iss` and `aud` and integer `iat < exp`, and claims a strict reader would refuse.
5. `publicKeys()` returns the public `JwsKey`s, for a JWKS route or a verifier's key lookup.

## Configuration

Neither class reads configuration. The assertion strategy passes `authn.keys.algorithms` and `authn.keys.assertion.*` to the verifier; see [JWS client assertions](05-jws-assertions.md#configuration).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| JWS verifier | `JwsVerifier` (`@spinajs/authn/contracts`), singleton; also registered as `StrictJwsVerifier` | `StrictJwsVerifier` | none | `@Injectable(JwsVerifier)` on your class, imported after `@spinajs/authn-keys`. Keep the check order and codes: `JwsAssertionStrategy` relies on `unknown_key` |
| JWS signer | `JwsSigner` (`@spinajs/authn/contracts`) | none registered | `LocalJwsSigner` | Subclass `LocalJwsSigner` with a no-argument constructor and `@Injectable(JwsSigner)`, as below |

### JWS signer: custom implementation

Register a signer whose keys come from the environment, with a current key for rotation:

```ts sample
import { Injectable } from '@spinajs/di';
import { JwsSigner } from '@spinajs/authn/contracts';
import { LocalJwsSigner } from '@spinajs/authn-keys';
import type { PrivateJwk } from '@spinajs/authn-keys';

/** TICKET_SIGNING_JWKS holds a JSON array of private JWKs; TICKET_SIGNING_KID names the one that signs. */
@Injectable(JwsSigner)
export class EnvJwsSigner extends LocalJwsSigner {
  constructor() {
    super(JSON.parse(process.env.TICKET_SIGNING_JWKS ?? '[]') as PrivateJwk[], { current: process.env.TICKET_SIGNING_KID });
  }
}
```

To rotate: add the new key to the list and publish `publicKeys()` so verifiers learn it, then switch `TICKET_SIGNING_KID`, then drop the old key once its tokens expired. A verifier whose lookup no longer returns a key answers `unknown_key` for every token it signed, which is also the emergency path for a leaked key.

## Important behaviour

- The algorithm always comes from the key. A header `alg` is only compared with the key's; it never selects the verification.
- Ed25519 keys and signatures get checks `node:crypto` skips: non-canonical and small-order public points are refused, and so is a signature whose `R` has small order (OpenSSL accepts one, and a key holder can make one for any message).
- Keys from a caller's lookup are checked again (`publicKeyObject`), so a weak key never verifies anything, whoever supplies it.
- Base64url has one accepted text form per value: padding, the standard alphabet and stray bits are refused.
- The JSON reader agrees with `serde_json`, so this verifier and the C8 Rust one accept and refuse the same tokens.
- Header members `__proto__` and non-string values are `bad_header`; a duplicate member keeps its last value.
- `iat` and `exp` must be written as plain integers: `1.0e9` or `1790000000.0` is `invalid_claims`.
- `LocalJwsSigner` is not registered in DI. Nothing in the package signs on its own.

## Best practices

- Pass `issuer` as a function when the issuer depends on the key, as `JwsAssertionStrategy` does with `assertionIssuer(key.owner)`.
- Give each JWS type its own `typ` and check it. A token of one type then never passes as another.
- Keep private JWKs in a secret store and load them at boot; `LocalJwsSigner` checks them then and fails fast.

## Patterns and antipatterns

```ts
// Don't: trust the JWK's own alg member; checkPublicJwk drops it and takes the algorithm from kty and crv
const alg = (input as { alg: string }).alg;

// Do
const material = checkPublicJwk(input);
const alg = material?.alg;
```

## Examples

### Verify room tickets your API signs

```ts sample
import { DI } from '@spinajs/di';
import { JwsVerifier } from '@spinajs/authn/contracts';
import type { JwsClaims, JwsKey } from '@spinajs/authn/contracts';

interface RoomTicket extends JwsClaims {
  readonly room: string;
}

/** `keys` comes from the signer's publicKeys(), fetched from its JWKS route. */
export async function verifyRoomTicket(token: string, keys: readonly JwsKey[]): Promise<RoomTicket | null> {
  const verifier = await DI.resolve(JwsVerifier);
  const result = await verifier.verify<RoomTicket>(token, {
    typ: 'room-ticket+jwt',
    algorithms: ['EdDSA'],
    keys: async (kid) => keys.find((key) => key.kid === kid) ?? null,
    claims: (payload) => (typeof payload.room === 'string' ? (payload as unknown as RoomTicket) : null),
    issuer: 'https://api.example.com',
    audience: 'room-server',
    now: new Date(),
    skewSeconds: 30,
    maxLifetimeSeconds: 300,
  });
  return result.ok ? result.claims : null;
}
```

### Check a JWK before you store it elsewhere

```ts sample
import { checkPublicJwk, thumbprint } from '@spinajs/authn-keys';

/** Returns the algorithm and RFC 7638 thumbprint of an uploaded public key, or null when it is not acceptable. */
export function describeUploadedKey(input: unknown): { alg: string; thumbprint: string } | null {
  const material = checkPublicJwk(input);
  return material ? { alg: material.alg, thumbprint: thumbprint(material.jwk) } : null;
}
```

## Related

- [JWS client assertions](05-jws-assertions.md): the strategy built on `StrictJwsVerifier`.
- [HTTP message signatures](06-http-signatures.md): the strategy built on `verifySignature`.
- [`@spinajs/authn`](../authn/README.md): the `JwsVerifier` and `JwsSigner` contracts.
