# JWT bearer

`JwtBearerStrategy` authenticates a request that carries a JWT from an identity provider you trust, such as a CI system or another company service. It is a per-request strategy named `jwt` for credentials of kind `bearer`. It verifies the signature, issuer, audience and lifetime, and answers the token's subject as an external subject; the core maps that subject to one of your identities through identity links.

It does **not** issue JWTs and does **not** accept HMAC-signed or unsigned tokens.

## How it works

1. [`@spinajs/authn-http`](../authn-http/README.md) turns `Authorization: Bearer <a.b.c>` into `{ kind: 'bearer', token }`. A three-part value whose JWS header `typ` is `authn.keys.assertion.typ` becomes a `jws-assertion` for [`@spinajs/authn-keys`](../authn-keys/README.md) instead.
2. `JwtBearerStrategy.accepts` is `true` only while at least one issuer is configured, and only for a value of at most 8192 characters in compact JWT form (three base64url parts). An API token (`spt_…`) gets `false`, so `TokenStrategy` takes it.
3. The core peeks at the throttle with `throttleKeys`: `account` is `jwt:` plus 32 hex characters of `SHA-256('authn-jwt-throttle:' + token)`, `account-ip` adds `|<ip>`. They come from a hash of the whole token, never from its claims.
4. `JwtBearerStrategy.verify`:
   1. `ctx.now` must be a valid `Date`, else `invalid_credentials`.
   2. It decodes the unverified `iss` and picks that issuer from `authn.jwt.issuers`. An unknown issuer fails with no key fetch.
   3. A token whose protected header `typ` is `spinajs-client+jwt` (any case, with or without `application/`) fails: client assertions never pass as a bearer.
   4. `jose`'s `jwtVerify` checks the signature with the issuer's keys, `iss`, `aud`, the issuer's `algorithms`, a required `exp`, and `nbf`, at the instant `ctx.now`, with `clockSkewSeconds` of tolerance.
   5. The subject is the issuer's `subjectClaim` (default `sub`), read as an own property of the payload. It must be a string of 1 to 255 characters.
   6. The answer is `{ ok: true, method: 'jwt', external: { provider, subject, email?, claims } }`. `email` is copied when it is a string of at most 255 characters; `emailVerified` is never set.
   
   An expired token with a valid signature fails as `expired`; every other error, including a JWKS that cannot be fetched, as `invalid_credentials`. Nothing is thrown.
5. `DefaultAuthnService` maps `(provider, subject)` to an identity with the `IdentityLinkStore` ([authn-orm's `authn_identity`](../authn-orm/03-identity-links.md)). An unlinked subject fails as `not_linked`, unless JIT provisioning is on for that issuer (step 6).
6. JIT: `JwtBearerStrategy.linkingFor(external)` answers `{ jit: <issuer's linking.jit>, byVerifiedEmail: false }`. The core provisions an unlinked subject only when that switch **and** `authn.linking.jit` are on.
7. The core checks the identity's status and returns a principal with `authn.method = 'jwt'` and no session. A JWT sets no ceiling.

```mermaid
sequenceDiagram
  participant Client
  participant A as DefaultAuthnService
  participant J as JwtBearerStrategy
  participant K as JWKS (issuer)
  participant L as IdentityLinkStore
  participant I as IdentityStore
  Client->>A: Authorization: Bearer eyJ… (via authn-http)
  A->>J: accepts(credentials)
  A->>A: throttle peek (hash of the token)
  A->>J: verify(credentials, ctx)
  J->>J: pick issuer by unverified iss, refuse client-assertion typ
  J->>K: fetch keys (cached; on an unknown kid at most once a minute)
  J->>J: jwtVerify: signature, iss, aud, alg, exp, nbf at ctx.now
  J-->>A: external { provider: jwt:<issuer>, subject, claims }
  A->>L: find(provider, subject)
  L-->>A: identity (or JIT when both switches are on)
  A->>I: status(identity)
  A-->>Client: Principal, authn.method = 'jwt'
```

### Keys and rotation

- **`jwksUri`**: one remote key set per issuer, built once at boot and kept, so its cache lives across requests.
  - A token with a `kid` the cached set lacks triggers a refetch, at most once every 60 seconds.
  - The cached set is refetched once it is older than 10 minutes.
  - A fetch times out after 5 seconds.
  - After a failed fetch (network error, a status other than `200`, a body that is not a JWK Set) no fetch runs for 60 seconds. Known keys keep verifying from the cached set meanwhile.
  - Each failed fetch logs one warning on the `authn-token` logger, without the token.
- **`keys`**: a fixed list of public JWKs. Nothing is fetched; rotating means a config change and a restart.

To rotate a signing key at a JWKS issuer, publish the new key in the set before the issuer signs with it. The first token with the new `kid` triggers the refetch.

## Configuration

`authn.jwt.issuers` is a list of issuer objects. The schema refuses unknown members and requires exactly one of `jwksUri` and `keys`.

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.strategies` | `{ name, service }[]` | `[]` | | Must contain `{ name: 'jwt', service: 'JwtBearerStrategy' }`. Owned by `@spinajs/authn`. |
| `authn.jwt.issuers` | `JwtIssuerConfig[]` | `[]` | each `issuer` once | Trusted issuers. Empty: the strategy accepts nothing. |
| `authn.jwt.issuers[].issuer` | `string` | required | non-empty | Expected `iss`; also selects the issuer for a token. |
| `authn.jwt.issuers[].audience` | `string` | required | non-empty | Expected `aud`. |
| `authn.jwt.issuers[].jwksUri` | `string` | | `https:` URL; `http:` only for `localhost`, `[::1]` or `127.*` | Remote JWK Set. |
| `authn.jwt.issuers[].keys` | `JWK[]` | | at least one public JWK, `kty` `RSA`, `EC` or `OKP` | Fixed verification keys. No private members (`d`, `p`, `q`, `dp`, `dq`, `qi`, `oth`, `k`); `use` only `sig`; `key_ops` only `['verify']`; `alg`, when set, one of the issuer's `algorithms`. |
| `authn.jwt.issuers[].algorithms` | `string[]` | required | `RS256`, `RS384`, `RS512`, `PS256`, `PS384`, `PS512`, `ES256`, `ES384`, `ES512`, `EdDSA` | Accepted `alg` values; never `none` or HMAC. |
| `authn.jwt.issuers[].clockSkewSeconds` | `integer` | `30` | `0` to `60` | Tolerance for `exp` and `nbf`. |
| `authn.jwt.issuers[].subjectClaim` | `string` | `'sub'` | non-empty | Claim that holds the subject. |
| `authn.jwt.issuers[].provider` | `string` | `'jwt:<issuer>'` | 1 to 128 characters, unique across issuers | Provider name of the identity links. |
| `authn.jwt.issuers[].linking.jit` | `boolean` | `false` | | Lets this issuer's unlinked subjects be provisioned, together with `authn.linking.jit`. |
| `authn.linking.jit` | `boolean` | `false` | | Global JIT switch. Owned by `@spinajs/authn`. |

```ts
authn: {
  strategies: [{ name: 'jwt', service: 'JwtBearerStrategy' }],
  jwt: {
    issuers: [
      {
        issuer: 'https://token.actions.githubusercontent.com',
        audience: 'https://api.example.com',
        jwksUri: 'https://token.actions.githubusercontent.com/.well-known/jwks',
        algorithms: ['RS256'],
      },
    ],
  },
}
```

`JwtBearerStrategy.resolve()` fails boot when:

- `authn.jwt.issuers` is unset, which means the `@spinajs/authn` schema is not registered;
- an issuer has an empty `audience`, a `clockSkewSeconds` outside 0 to 60, or a provider over 128 characters (an explicit one, or `jwt:` plus a long issuer);
- two issuers share an issuer or a provider (explicit or derived);
- a `jwksUri` is not a URL, or is plain `http:` to a host that is not loopback;
- a key is not a valid public JWK, is an RSA key under 2048 bits, or fits none of the issuer's algorithms (EC keys need the curve of the algorithm: `P-256`, `P-384`, `P-521`; `EdDSA` needs `Ed25519`).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| JWT strategy | `AuthenticationStrategy`; singleton; `@Injectable(AuthenticationStrategy)` when the package loads | `JwtBearerStrategy` | none | Subclass, register with `@Injectable(AuthenticationStrategy)`, and name your class as the `service` of the `jwt` entry in `authn.strategies`. |
| Identity links | `IdentityLinkStore` (`@spinajs/authn/contracts`), resolved by the core | none in this package | `@spinajs/authn-orm`'s `DbIdentityLinkStore` | See [Identity links](../authn-orm/03-identity-links.md). Without a store every JWT fails as `not_linked`. |
| JIT provisioning | `IdentityStore.provision` | none in this package | your `IdentityStore` | Implement `provision(external)`; used only with both JIT switches on. |

### JWT strategy: custom implementation

Subclass `JwtBearerStrategy` to require a claim on top of the standard checks, such as a GitHub Actions token from one repository. Override `verify`, call `super`, and read the verified claims from `external.claims`.

```ts sample
import { JwtBearerStrategy } from '@spinajs/authn-token';
import { AuthenticationStrategy } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, StrategyOutcome } from '@spinajs/authn/contracts';
import { Injectable } from '@spinajs/di';

const DEPLOY_REPOSITORY = 'acme/orders-service';

/** Only CI runs of one repository may call the API; config: { name: 'jwt', service: 'RepositoryJwtStrategy' }. */
@Injectable(AuthenticationStrategy)
export class RepositoryJwtStrategy extends JwtBearerStrategy {
  public async verify(c: Credentials, ctx: AuthnContext): Promise<StrategyOutcome> {
    const outcome = await super.verify(c, ctx);
    if (outcome.ok && outcome.external?.claims?.repository !== DEPLOY_REPOSITORY) {
      return { ok: false, reason: 'invalid_credentials' };
    }
    return outcome;
  }
}
```

The strategy's `name` stays `jwt`, and both classes are registered; only the one named in `authn.strategies` runs.

## Important behaviour

- **Allow-list only.** A token is checked only against the keys of the issuer its `iss` names. An unknown issuer, `alg: none`, an HMAC token signed with a public key as the secret, or an algorithm outside the issuer's list all fail.
- **`exp` is required**, and `nbf` is honoured, both with the issuer's skew. Time comes from `ctx.now`, read once.
- **A JWT never links by email.** The strategy never sets `emailVerified` and answers `byVerifiedEmail: false`, whatever `authn.linking.byVerifiedEmail` says.
- **JIT needs two switches.** Turning `authn.linking.jit` on does not open an issuer whose own `linking.jit` is off.
- **Providers are identity.** Links are stored under `provider`; renaming an issuer or its `provider`, or changing `subjectClaim`, unlinks its subjects.
- **No I/O for foreign values.** A value that is not a compact JWT, or any value while no issuer is configured, gets `unsupported_credentials` and no throttle keys without a fetch.
- **A forged token cannot slow a victim.** Throttle keys come from a hash of the token, not from its `iss` or `sub`.
- **JWKS outages fail closed.** While the JWKS host is down, tokens signed with cached keys keep working until the set is 10 minutes old; after that every token of that issuer fails until a fetch succeeds.
- **No ceiling, no delegation.** The principal of a JWT has the linked identity's full rights; authz-rbac's token role rules do not apply (they read `authn.method === 'token'`).

## Best practices

- Pin `audience` to a value only your API accepts, so a token minted for another service of the same issuer fails.
- Give each issuer its own `provider` only when you migrate links; the default `jwt:<issuer>` is stable.
- Link machine identities explicitly with `IdentityLinkStore.link` and keep JIT off for bearer JWTs; see [Link a service account to a CI issuer's subject](../authn-orm/03-identity-links.md#link-a-service-account-to-a-ci-issuers-subject).
- Prefer `jwksUri` over `keys` for issuers that rotate keys.

## Patterns and antipatterns

```ts
// Don't: one issuer entry trusts tokens meant for every service of that provider.
{ issuer: 'https://login.example.com/', audience: 'https://login.example.com/', jwksUri, algorithms: ['RS256'] }

// Do: the audience names this API only.
{ issuer: 'https://login.example.com/', audience: 'api://orders', jwksUri, algorithms: ['RS256'] }
```

## Examples

### Trust a partner's tokens signed with a fixed key

```ts sample
import type { JwtIssuerConfig } from '@spinajs/authn-token';
import { FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';

/** The partner signs with one Ed25519 key that they hand over out of band. */
const partner: JwtIssuerConfig = {
  issuer: 'https://partner.example.net',
  audience: 'api://orders',
  algorithms: ['EdDSA'],
  keys: [{ kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', use: 'sig' }],
  clockSkewSeconds: 10,
};

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      authn: {
        strategies: [
          { name: 'token', service: 'TokenStrategy' },
          { name: 'jwt', service: 'JwtBearerStrategy' },
        ],
        jwt: { issuers: [partner] },
      },
    });
  }
}
```

The partner's subjects must be linked to identities in `authn_identity` under the provider `jwt:https://partner.example.net` before their tokens authenticate.

## Related

- [API token authentication](02-token-authentication.md): the other `bearer` strategy.
- [`@spinajs/authn` authentication flow](../authn/01-authentication-flow.md): candidate selection, external subject mapping, JIT and status checks.
- [`@spinajs/authn` account linking](../authn/10-account-linking.md): how the core links an external subject, JIT and `authn.linking.*`.
- [Identity links](../authn-orm/03-identity-links.md): the `authn_identity` table that maps `(provider, subject)` to an identity.
- [`@spinajs/authn-keys`](../authn-keys/README.md): client assertions, which share the compact JWS form but never pass here.
- [`@spinajs/authn-http`](../authn-http/README.md): how `Authorization: Bearer` is routed to `bearer` or `jws-assertion`.
