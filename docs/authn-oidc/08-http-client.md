# Provider HTTP client, discovery and keys

Every request to an IdP (discovery, JWKS, token, userinfo) goes through one port, `OidcHttpClient`. Replace it to route provider calls through your own HTTP stack, or to play the IdP in memory in tests. Discovery documents and key sets are cached per provider.

## How it works

### `FetchOidcHttpClient.send(url, init)`

1. Refuses any URL that is not `https:`; `http:` passes only in development and test. The env comes from the `relaxed` constructor argument, else from the app configuration (unset: production).
2. Calls the global `fetch()` with `redirect: 'manual'` and a 5-second timeout (`OIDC_HTTP_TIMEOUT_MS`).
3. A 3xx answer throws: the client follows no redirect.
4. A `Content-Type` other than `application/json` or `application/<x>+json` throws.
5. Reads at most 1 MiB (`OIDC_HTTP_MAX_BODY_BYTES`); a larger body throws.
6. Parses the JSON and returns `{ status, json }`. The caller checks the status and the shape.

`getJson(url, headers)` adds `accept: application/json`. `postForm(url, form, headers)` sends an `application/x-www-form-urlencoded` body.

### Discovery, `OidcDiscovery.metadata(now)`

1. A cached document younger than one hour (`DISCOVERY_MAX_AGE_MS`) is returned.
2. Otherwise one fetch of `<issuer>/.well-known/openid-configuration` runs; concurrent callers share it.
3. `validate()` checks: `issuer` equals the configured issuer exactly; `authorization_endpoint`, `token_endpoint`, `jwks_uri` and (when present) `userinfo_endpoint` are absolute https URLs without credentials or fragment; `response_types_supported`, when present, lists `code`; `code_challenge_methods_supported`, when present, lists `S256`. An `end_session_endpoint` that is no such URL is dropped instead of failing the document, since only [RP-initiated logout](12-rp-initiated-logout.md) uses it.
4. It keeps `authorization_response_iss_parameter_supported === true` as the RFC 9207 flag: the callback must then carry `iss`.
5. A failed fetch keeps the last good document. The next attempt waits 60 seconds (`DISCOVERY_RETRY_MS`); with no document at all, calls fail until then.

### Keys, `OidcJwks.key(header, now)`

1. The token's `alg` must be one of `OIDC_SIGNING_ALGORITHMS`, and a `kid` must be a string.
2. The key set is fetched from the discovery `jwks_uri` when absent or older than one hour (`JWKS_MAX_AGE_MS`).
3. Each published key is filtered: no private members, `use` absent or `sig`, `key_ops` absent or exactly `['verify']`, RSA of at least 2048 bits, EC on P-256, P-384 or P-521, OKP on Ed25519. Only the public members reach `jose`.
4. With a `kid`, exactly one key with that `kid` must fit the algorithm (key type and curve, and the JWK's own `alg` when it names one). Without a `kid`, exactly one key of the whole set must fit.
5. No key with the `kid`, or no fitting key: one refresh, at most once a minute (`JWKS_REFRESH_MS`), then the lookup again. A key that is there but refused, or two that fit, fails without a refresh.
6. Imported keys are cached until the next fetch.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Provider HTTP client | `OidcHttpClient`, singleton, registered with `@Injectable(OidcHttpClient)` on import | `FetchOidcHttpClient` | none shipped | `@Injectable(OidcHttpClient)` on your class, imported after `@spinajs/authn-oidc`: the last registration wins. Register it before `OidcProviders` first resolves; each provider keeps the client it got. |
| Discovery cache | none; one `OidcDiscovery` per `OidcProvider` | `OidcDiscovery` | none | Built by `OidcProvider`; not injected. |
| Key cache | none; one `OidcJwks` per `OidcProvider` | `OidcJwks` | none | Built by `OidcProvider`; not injected. |

`OidcHttpClient` has two abstract methods. An implementation throws on a transport failure or a body that is not JSON:

```ts
abstract getJson(url: string, headers?: OidcHttpHeaders): Promise<OidcHttpResponse>;
abstract postForm(url: string, form: Readonly<Record<string, string>>, headers?: OidcHttpHeaders): Promise<OidcHttpResponse>;
```

To keep the https, redirect, content type and size rules, subclass `FetchOidcHttpClient` and override `send()`, `readCapped()` or `allowsHttp()`. A class that extends `OidcHttpClient` directly takes over those rules itself.

### Provider HTTP client: custom implementation

```ts sample
import { FetchOidcHttpClient, OidcHttpClient } from '@spinajs/authn-oidc';
import type { OidcHttpResponse } from '@spinajs/authn-oidc';
import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';

/** Logs how long each IdP call takes, to spot a slow provider before users report it. */
@Injectable(OidcHttpClient)
export class TimedOidcHttpClient extends FetchOidcHttpClient {
  @Logger('authn-oidc')
  protected Log!: Log;

  protected async send(url: string, init: RequestInit): Promise<OidcHttpResponse> {
    const started = Date.now();
    try {
      return await super.send(url, init);
    } finally {
      this.Log.info(`IdP ${init.method ?? 'GET'} ${new URL(url).host} took ${Date.now() - started} ms`);
    }
  }
}
```

## Important behaviour

- **https everywhere outside development and test**, for discovery, JWKS, token and userinfo. A deployment with no env set counts as production.
- **One cache per provider per container.** `OidcProviders` builds each `OidcProvider` once, so the refresh limits hold for the life of the container.
- **A key rotation costs at most one refresh a minute.** A token signed with a new `kid` triggers a refresh; a flood of unknown `kid`s cannot hammer the IdP.
- **Userinfo is JSON only.** A signed or encrypted userinfo answer fails the `Content-Type` check. Userinfo requests send `user-agent: spinajs-authn-oidc`, which GitHub's API requires.
- **Errors never carry tokens.** Messages name the check or the HTTP status.

## Best practices

- Subclass `FetchOidcHttpClient` rather than `OidcHttpClient` unless you re-implement the same limits.
- In tests, implement `OidcHttpClient` as an in-memory IdP and register it before the app boots; the package's own tests do this.

## Patterns and antipatterns

```ts
// Don't: following redirects lets a compromised endpoint send the token request elsewhere
const res = await fetch(url, { redirect: 'follow' });

// Do: keep FetchOidcHttpClient's redirect: 'manual' by calling super.send()
return super.send(url, init);
```

## Examples

### Serve a fixed discovery document in a test

```ts sample
import { OidcDiscovery, OidcHttpClient } from '@spinajs/authn-oidc';
import type { OidcHttpHeaders, OidcHttpResponse } from '@spinajs/authn-oidc';

const ISSUER = 'https://idp.test';

class StaticIdp extends OidcHttpClient {
  public async getJson(url: string, _headers?: OidcHttpHeaders): Promise<OidcHttpResponse> {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return {
        status: 200,
        json: {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          code_challenge_methods_supported: ['S256'],
        },
      };
    }
    return { status: 404, json: {} };
  }

  public async postForm(_url: string, _form: Readonly<Record<string, string>>): Promise<OidcHttpResponse> {
    return { status: 400, json: { error: 'invalid_grant' } };
  }
}

const discovery = new OidcDiscovery(ISSUER, new StaticIdp(), false);
discovery.metadata().then((m) => console.log(m.token_endpoint)); // https://idp.test/token
```

## Related

- [Login flow](01-login-flow.md): where discovery, JWKS, token and userinfo calls happen.
- [Security guarantees](09-security.md): the checks on the answers.
