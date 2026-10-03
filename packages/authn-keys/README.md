# `@spinajs/authn-keys`

Public-key authentication for SpinaJS: a key registry, strict JWS (the
canvas C8 rules), JWS client assertions, RFC 9421 HTTP signatures and a
challenge-response login. Design: `docs/plans/2026-10-01-authz-v3-design.md`
§22.10, rules A17 and A18.

## Keys

- Ed25519 (`{ "kty": "OKP", "crv": "Ed25519", "x" }`, RFC 8037) and P-256
  (`{ "kty": "EC", "crv": "P-256", "x", "y" }`) public JWKs only. The
  algorithm comes from the key type (`EdDSA`, `ES256`), never from a token.
- Refused: private parts (`d`), other key types and curves, values that are
  not strict unpadded base64url of 32 bytes, Ed25519 points that are not
  canonical or have small order, P-256 points off the curve.
- `kid`: 1–64 of `[A-Za-z0-9._-]`; default: the RFC 7638 thumbprint.
- Owners: a user, a service or an agent. A user's key needs a proof of
  possession (below); services and agents are registered by an admin route
  or the CLI.
- Table `authn_key` (migration `AuthnKeys_2026_10_02_00_00_00`).

`DefaultKeyRegistry` implements `KeyRegistry` over a `KeyStore`
(`OrmKeyStore` by default, `MemoryKeyStore` for tests) and a `SecretStore`.

## Challenges

`KeyRegistry.challenge` answers `{ id, nonce, expiresAt }`. The client signs
the UTF-8 bytes of

```
spinajs-key-<purpose>:<nonce>:<audience>
```

where `<purpose>` is `register` (proof of possession when a user adds a
key) or `login` (challenge-response login), `<nonce>` is the `nonce`
exactly as received (base64url, so it holds no `:`), and `<audience>` is
the service's `authn.keys.challenge.audience` (default: its
`authn.keys.assertion.audience`). The client knows the audience from its
own configuration of the service, never from the challenge answer: a
service that relays another one's challenge then gets a signature the
other one refuses. It sends the raw signature as unpadded base64url:
64 bytes for Ed25519, and for P-256 an ECDSA SHA-256 signature as
IEEE P1363 `r || s` (64 bytes, not DER). It names the challenge by its
`id`, unchanged: the id carries the nonce back to the server, so treat it
as opaque.

- Registration: `{ owner, jwk, proof: { challengeId: id, signature } }`.
- Login: credentials `{ kind: 'key-challenge', keyId, challengeId: id, signature }`.

A challenge is single use, lives `authn.keys.challenge.ttlSeconds` (default
120 s), and is redeemed only after the signature holds. A login challenge
counts against the `login` flow's IP throttle key.

With OpenSSL 3, for an Ed25519 key in `key.pem`:

```sh
printf 'spinajs-key-login:%s:%s' "$NONCE" "$AUDIENCE" > input.bin
openssl pkeyutl -sign -inkey key.pem -rawin -in input.bin | basenc --base64url | tr -d '=\n'
```

From Node: `signChallenge(challenge, 'login', audience, privateKey, 'EdDSA')`.

## JWS

`StrictJwsVerifier` implements `JwsVerifier` under the C8 D4 rules. Checks
run in this order and the first failure gives the code: `malformed`,
`bad_header` (exactly `{ alg, kid, typ }`), `unknown_key`, `bad_signature`
(with the key's own algorithm), `invalid_claims` (JSON read as serde_json
reads it; integer `iat < exp`, lifetime within the limit), `wrong_issuer`,
`wrong_audience`, `expired` (`now ≥ exp + skew`), `not_yet_valid`
(`iat > now + skew`).

`LocalJwsSigner` implements `JwsSigner` over private JWKs the app loads:
`new LocalJwsSigner(privateJwks, { current: kid })`. It writes the header
as `{"alg","kid","typ"}` and the claims in the caller's order, so the canvas
C8 golden tickets come out byte for byte.

## JWS client assertions (`keys-jws`)

`Authorization: Bearer <jws>` → credentials `{ kind: 'jws-assertion', jws }`.

- Header: `{ "alg": "EdDSA" | "ES256", "kid": "<kid>", "typ": "spinajs-client+jwt" }`.
- Claims: `iss` is the key owner as `<type>:<id>` (`user:<uuid>`,
  `service:runner-1`), `aud` is `authn.keys.assertion.audience` (required),
  integer `iat` and `exp` with `exp − iat ≤ 300` (or the configured
  `maxLifetimeSeconds`), and a `jti` of 1–128 characters.
- A `jti` is accepted once per key until `exp` plus the skew (`authn_nonce`
  or memory).

## HTTP signatures (`keys-httpsig`)

An RFC 9421 subset with exactly one signature:

```
Signature-Input: sig1=("@method" "@target-uri" "content-digest");created=1790000000;expires=1790000300;nonce="<random>";keyid="<kid>"
Signature: sig1=:<standard base64 of the raw signature>:
Content-Digest: sha-256=:<standard base64 of SHA-256(body)>:
```

- Any label; the `Signature-Input` member must be in canonical RFC 8941
  form (single spaces, no parameters on components).
- Covered: `@method` and `@target-uri` always; `content-digest` whenever
  the request has a body (RFC 9530, `sha-256` or `sha-512`, checked against
  the body); also each name in `authn.keys.httpSignature.requiredComponents`.
  `@authority`, `@path`, `@query` and present request headers may be
  covered too.
- Parameters: `created`, `expires`, `nonce`, `keyid` required; `alg`
  optional (`ed25519` or `ecdsa-p256-sha256`, and then it must name the
  key's algorithm); nothing else.
- `expires − created ≤ maxAgeSeconds` (300), `created` not ahead of now by
  more than the skew, `now < expires`; the nonce is accepted once per key.
- The signature base is RFC 9421 §2.5; its `@signature-params` line is the
  `Signature-Input` member value as sent.

## Strategies

| Name | Credentials kind | Session |
|---|---|---|
| `keys-jws` (`JwsAssertionStrategy`) | `jws-assertion` | no |
| `keys-httpsig` (`HttpSignatureStrategy`) | `http-signature` | no |
| `keys-challenge` (`KeyChallengeStrategy`) | `key-challenge` | yes |

Each refuses credentials over 8 KiB before parsing them, verifies only
usable keys (not revoked, not expired), answers an
unknown key with the same work and result as a bad signature, throttles by
`key:<kid>`, and returns the key owner as the identity with the key's
`scope` as the ceiling.

## Configuration (`authn.keys`)

| Key | Default |
|---|---|
| `algorithms` | `['EdDSA', 'ES256']` |
| `challenge.ttlSeconds` | `120` |
| `challenge.audience` | `null` (then `assertion.audience`; challenges need one) |
| `assertion.typ` | `'spinajs-client+jwt'` |
| `assertion.audience` | `null` (required for `keys-jws`) |
| `assertion.maxLifetimeSeconds` | `300` (at most 300) |
| `assertion.skewSeconds` | `30` |
| `httpSignature.maxAgeSeconds` | `300` (at most 300) |
| `httpSignature.skewSeconds` | `30` |
| `httpSignature.requiredComponents` | `['@method', '@target-uri', 'content-digest']` |

`authn_nonce` comes with `@spinajs/authn-orm`'s `AuthnInitial` migration.
