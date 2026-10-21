# JWKS route

`AuthnJwksController` serves `GET /.well-known/jwks.json`: the public keys of the registered `JwsSigner` as a JWK Set (RFC 7517), so services that verify your tokens can fetch the keys. The route is on while a `JwsSigner` is registered, which `authn.keys.signer` of [`@spinajs/authn-keys`](../authn-keys/10-signing-keys.md) does; otherwise it answers 404.

## How it works

1. The controller carries the gate `JwsSignerRegistered` (a `ServiceGate`): `404 { "error": "not_found" }` while no `JwsSigner` is registered.
2. The handler resolves the `JwsSigner` per request and maps `publicKeys()` to `{ keys: [...] }`.
3. Each key is written as `{ kty, crv, x, y?, kid, alg, use: "sig" }`. Members are copied one by one, so a private member can never reach the wire.
4. The answer is `200` with `Content-Type: application/jwk-set+json` and `Cache-Control: public, max-age=300`. It needs no credentials and does not negotiate on `Accept`.

## Example

```json
{
  "keys": [
    { "kty": "OKP", "crv": "Ed25519", "x": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", "kid": "sig-2026-10", "alg": "EdDSA", "use": "sig" }
  ]
}
```

## Important behaviour

- Every configured key is listed, the signing one and the ones kept for verification, so verifiers can follow a [rotation](../authn-keys/10-signing-keys.md#rotation-runbook).
- Verifiers may cache the set for five minutes; plan rotations around that.
