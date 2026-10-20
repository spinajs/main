# `@spinajs/authn-keys`

Public-key authentication for SpinaJS. Users, services and agents register Ed25519 or P-256 public keys, then prove who they are with a signed JWS client assertion, an RFC 9421 HTTP message signature, or a signed login challenge.

It does **not** generate or store private keys: clients hold them, the server keeps only public JWKs. It does **not** ship HTTP routes or credential extractors: [`@spinajs/authn-http`](../authn-http/README.md) maps requests to credentials and serves `/user/keys` and `/auth/keys/*`. It does **not** create the `authn_nonce` table: [`@spinajs/authn-orm`](../authn-orm/README.md) does.

## Install

```sh
npm install @spinajs/authn-keys @spinajs/authn @spinajs/authn-orm @spinajs/orm
```

Add one ORM driver, for example `@spinajs/orm-sqlite` or `@spinajs/orm-postgres`.

## Features

| Feature | What it does |
| --- | --- |
| [Setup and configuration](01-setup-and-configuration.md) | What importing the package registers, the services it needs, the `authn.keys.*` keys, and how to list the three strategies |
| [Key registry](02-key-registry.md) | `DefaultKeyRegistry`: register, list, revoke and rotate keys, from `POST /user/keys`, the `authn:key-*` CLI or code |
| [Key store](03-key-store.md) | `KeyStore`, `OrmKeyStore`, `MemoryKeyStore`: where key records live; the `authn_key` table and its migration |
| [Challenge login](04-challenge-login.md) | `KeyRegistry.challenge` and `KeyChallengeStrategy` (`keys-challenge`): sign a one-time nonce to prove possession or to log in with a session |
| [JWS client assertions](05-jws-assertions.md) | `JwsAssertionStrategy` (`keys-jws`): `Authorization: Bearer <jws>` signed by a registered key, per request |
| [HTTP message signatures](06-http-signatures.md) | `HttpSignatureStrategy` (`keys-httpsig`): an RFC 9421 subset with `Content-Digest`, per request |
| [Replay protection](07-replay-protection.md) | `KeyNonceStore`, `DbKeyNonceStore`, `MemoryKeyNonceStore`: each assertion `jti` and signature nonce is accepted once |
| [JWS and key material](08-jws-and-key-material.md) | `StrictJwsVerifier`, `LocalJwsSigner`, JWK checks, thumbprints, strict base64url and JSON, structured-field parsers |
| [Custom key strategies](09-custom-key-strategies.md) | `KeyStrategy`, the helpers and the protected hooks for writing or extending a strategy that verifies registered keys |

## Quick start

Register a key for a CI runner and build the client assertion it sends as `Authorization: Bearer <jws>`:

```ts sample
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import { KeyRegistry } from '@spinajs/authn/contracts';
import { LocalJwsSigner, assertionIssuer } from '@spinajs/authn-keys';

/** Registers a fresh Ed25519 key for the runner and returns one assertion signed with it. */
export async function runnerAssertion(audience: string): Promise<string> {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;

  const registry = await DI.resolve(KeyRegistry);
  const result = await registry.register(
    {
      owner: { type: 'service', id: 'ci-runner' },
      actor: { type: 'system', id: 'deploy-script' },
      jwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
      name: 'CI runner',
    },
    { now: new Date(), purpose: 'request' },
  );
  if (!result.ok) {
    throw new Error(`key not registered: ${result.code}`);
  }

  // The client side: the private key never reaches the server.
  const signer = new LocalJwsSigner([{ kty: 'OKP', crv: 'Ed25519', kid: result.key.kid, x: jwk.x, d: jwk.d }]);
  const now = Math.floor(Date.now() / 1000);
  return signer.sign({ iss: assertionIssuer(result.key.owner), aud: audience, iat: now, exp: now + 60, jti: randomUUID() }, { typ: 'spinajs-client+jwt' });
}
```

The server accepts it once `keys-jws` is listed in `authn.strategies` and `authn.keys.assertion.audience` equals `audience`. See [Setup and configuration](01-setup-and-configuration.md).

## Security guarantees

- Only Ed25519 (canonical, not small-order points) and P-256 (on-curve) public keys are accepted; a JWK with a private part is refused. See [JWS and key material](08-jws-and-key-material.md#important-behaviour).
- The algorithm comes from the key record, never from a token header or a signature parameter.
- A revoked or expired key fails on the next request. See [Key registry](02-key-registry.md#important-behaviour).
- An unknown, revoked or expired key costs the same signature work and gets the same answer as a bad signature (A02). The real reason goes to audit only.
- Every assertion `jti`, signature `nonce` and challenge is single use. See [Replay protection](07-replay-protection.md).
- A challenge signature names its purpose and this service's audience, so it proves nothing elsewhere. See [Challenge login](04-challenge-login.md#important-behaviour).
- Credentials longer than 8,192 characters are refused before any parsing.
- A user's key needs a proof of possession whoever registers it.

## Related packages

- [`@spinajs/authn`](../authn/README.md): the contracts this package implements (`KeyRegistry`, `JwsVerifier`, `JwsSigner`, `AuthenticationStrategy`), the `authn.keys` schema, strategy dispatch, throttling and sessions.
- [`@spinajs/authn-http`](../authn-http/README.md): the extractors that build `jws-assertion` and `http-signature` credentials, and the `/user/keys` and `/auth/keys/*` routes.
- [`@spinajs/authn-orm`](../authn-orm/README.md): the `authn_nonce` table, the `SecretStore` behind challenges, and the database throttle.
- [`@spinajs/authn-token`](../authn-token/README.md): API tokens and JWT bearer; shares the `Authorization: Bearer` header, told apart by the JWS `typ`.
- [`@spinajs/orm`](../orm/README.md): the models and the migration of `authn_key`.
- [`@spinajs/cli`](../cli/README.md): runs the `authn:key-add`, `authn:key-list` and `authn:key-revoke` commands.
