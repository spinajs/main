# Signing keys and rotation

`authn.keys.signer` makes the app a token issuer: it registers a `JwsSigner` built from private JWKs, and [`@spinajs/authn-http`](../authn-http/20-jwks-route.md) publishes the matching public keys at `GET /.well-known/jwks.json`. Use it for tickets and tokens your API signs and other services verify. Client keys registered by users (the rest of this package) are a separate thing: those are public keys the server only verifies.

## How it works

1. At boot, `AuthnKeysSignerBootstrapper` reads `authn.keys.signer`. When it is `null` (the default), nothing is registered and the JWKS route answers 404.
2. Otherwise each entry of `keys` is a secret reference the configuration has already resolved to the text of a private JWK (a JSON object with `kty`, `crv`, `kid`, `x`, `y` for P-256, and `d`).
3. `LocalJwsSigner` checks every key (see [JWS and key material](08-jws-and-key-material.md#localjwssigner)) and the bootstrapper registers it as `JwsSigner`. A bad reference fails the boot, naming `authn.keys.signer.keys.<index>` and never the value.
4. `sign(claims, { typ })` signs with the key named by `current`; `publicKeys()` lists every configured key.

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `authn.keys.signer` | `{ current, keys } \| null` | `null` | `null` registers no signer |
| `authn.keys.signer.current` | `string` | none | `kid` of the key that signs; must be the `kid` of one of `keys` |
| `authn.keys.signer.keys` | `string[]` | none | Non-empty. Secret references that resolve to private JWKs as JSON text. Each `kid` appears once |

```ts
authn: {
  keys: {
    signer: {
      current: 'sig-2026-10',
      keys: ['aws-parameters://prod/authn/sig-2026-10', 'aws-parameters://prod/authn/sig-2026-04'],
    },
  },
}
```

Never write a private JWK inline in a config file.

## Rotation runbook

Verifiers cache the key set for up to five minutes (`Cache-Control: public, max-age=300`), and tokens stay valid until they expire. Rotate in this order:

1. **Add the next key.** Generate an Ed25519 or P-256 key with a new `kid`, store it as a secret, and append its reference to `keys`. Leave `current` alone. Deploy. The new public key is now published but signs nothing.
2. **Wait for the caches.** Give verifiers at least five minutes, so every one has fetched a set that contains the new key.
3. **Switch `current`** to the new `kid` and deploy. New tokens carry the new `kid`; tokens signed by the old key still verify, because the old key is still published.
4. **Remove the old key** from `keys` once the longest token lifetime has passed since step 3. Tokens still carrying the old `kid` then fail with `unknown_key`.

During a rolling deploy, nodes on the old and new config both run. Steps 1 and 3 are safe because every node publishes every key it may be asked to verify before any node signs with it.

### Emergency rotation

When a private key leaks, skip the waiting: switch `current` to a fresh key and remove the leaked key in the same deploy. Every token signed by the leaked key fails with `unknown_key` once a verifier refreshes its set, within five minutes. Tokens cannot be told apart from forgeries, so there is no grace period.

## Important behaviour

- The JWKS output is built member by member (`kty`, `crv`, `x`, `y`, `kid`, `alg`, `use`). It never contains `d`, `p`, `q`, `dp`, `dq`, `qi` or `k`.
- Registering a `JwsSigner` yourself (`@Injectable(JwsSigner)`, see [JWS and key material](08-jws-and-key-material.md#jws-signer-custom-implementation)) and setting `authn.keys.signer` both register one; the later registration wins. Use one of the two.
- The configuration is read once at boot. A changed `keys` list takes effect on restart.

## Best practices

- Put the date or a counter in the `kid` (`sig-2026-10`), so a token header says which key signed it.
- Keep the old key in `keys` for at least the longest token lifetime after switching `current`.
- Alert on `unknown_key` verification failures after a rotation; they show a verifier with a stale set.

## Related

- [JWS and key material](08-jws-and-key-material.md): `LocalJwsSigner` and `StrictJwsVerifier`.
- [JWKS route](../authn-http/20-jwks-route.md): `GET /.well-known/jwks.json`.
