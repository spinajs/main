# Credential extractors

A `CredentialExtractor` reads request headers and returns `Credentials`, or `null` when none of its kind are present. `AuthnMiddleware` asks the extractors in ascending `order` and keeps the first non-null answer. Extractors never verify anything: verification runs in the strategy, after the throttle. Add your own to accept credentials from another header.

## How it works

1. `AuthnMiddleware.extract()` runs when the request has no active session. A target that does not start with `/` (absolute-form, `*`) gives no credentials.
2. It builds a `SignedRequest`: `method`, `targetUri` (path and query), `headers` (lower-case names from `req.rawHeaders`, repeated headers joined with `, `), and `body`, read on first access.
3. It calls `extract(signed)` on each extractor in ascending `order`. The first non-null answer is the credentials; the rest are not asked.
4. The credentials go to the [principal resolvers](03-principal-resolvers.md). They are never stored on the request.

The shipped extractors, in order:

| Order | Extractor | Reads | Gives |
| --- | --- | --- | --- |
| 10 | `HttpSignatureExtractor` | `signature` and `signature-input` headers | `{ kind: 'http-signature', request }` with `targetUri` = `authn.http.publicOrigin` + path. `null` without `authn.http.publicOrigin`. |
| 20 | `AuthorizationBearerExtractor` | `Authorization: Bearer <value>`, scheme in any case | A value starting with `authn.token.prefix`: `{ kind: 'bearer', token }`. A three-part value whose JWS header `typ` is `authn.keys.assertion.typ`: `{ kind: 'jws-assertion', jws }`. Any other three-part value: `{ kind: 'bearer', token }` (a JWT). Anything else: `null`. |
| 30 | `ApiKeyHeaderExtractor` | the `authn.token.headerName` header | A value starting with `authn.token.prefix`: `{ kind: 'bearer', token }`. Anything else: `null`. |

**Body bytes for signatures.** `body` is `req.rawBody` when a body parser kept it. A request that has a body (`Transfer-Encoding`, or a non-zero `Content-Length`) without raw bytes gets 32 random bytes, so it never verifies as body-less. Only the signature extractor reads `body`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.http.publicOrigin` | `string` or `null` | unset | `scheme://host[:port]` | Prefix of an HTTP signature's target. Never taken from `Host`. Unset or `null`: signature headers give no credentials. |
| `authn.token.prefix` | `string` | `'spt_'` | non-empty | Marks API tokens. `AuthorizationBearerExtractor` and `ApiKeyHeaderExtractor` accept only values with it (apart from JWTs). |
| `authn.token.headerName` | `string` | `'x-api-key'` | non-empty header name | Header `ApiKeyHeaderExtractor` reads. |
| `authn.keys.assertion.typ` | `string` | `'spinajs-client+jwt'` | non-empty | JWS `typ` that marks a key assertion. |

The token and key keys belong to [`@spinajs/authn-token`](../authn-token/README.md) and [`@spinajs/authn-keys`](../authn-keys/README.md); the extractors read them at call time.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `CredentialExtractor` (abstract, from `@spinajs/authn/contracts`) | Registered `.as(CredentialExtractor)`, resolved by `AuthnMiddleware` as an `Array.ofType` list; the shipped ones are `@PerChildInstance()` | `HttpSignatureExtractor`, `AuthorizationBearerExtractor`, `ApiKeyHeaderExtractor`, registered at package load | your own | Extend `CredentialExtractor`, set `order`, implement `extract()`, `DI.register(Mine).as(CredentialExtractor)` before `HttpServer` resolves. Subclass a shipped one and register it `.as(TheShippedClass)` to change it. |

Members:

| Member | Meaning |
| --- | --- |
| `order: number` | Lower is asked first. |
| `extract(req: SignedRequest): Credentials \| null` | Synchronous. Header names are lower case. `null`: none of this extractor's credentials. |

### `CredentialExtractor`: custom implementation

Write an extractor when clients send credentials in a place the shipped ones do not read. Return a credential kind that a listed strategy accepts; `AuthnService` then verifies it with throttle and audit. Pick an `order` relative to 10, 20 and 30.

```ts sample
import '@spinajs/authn-http';
import { DI } from '@spinajs/di';
import { CredentialExtractor } from '@spinajs/authn/contracts';
import type { Credentials, SignedRequest } from '@spinajs/authn/contracts';

/** Mobile clients send their API token in `X-Auth-Token`. */
export class XAuthTokenExtractor extends CredentialExtractor {
  // After Authorization (20), before x-api-key (30).
  public readonly order = 25;

  public extract(req: SignedRequest): Credentials | null {
    const value = req.headers['x-auth-token']?.trim();
    return value && value.startsWith('spt_') && !value.includes(',') ? { kind: 'bearer', token: value } : null;
  }
}

DI.register(XAuthTokenExtractor).as(CredentialExtractor);
```

`TokenPrincipalResolver` then resolves the `bearer` credential like one from `Authorization`.

## Important behaviour

- **Foreign tokens are ignored.** An `Authorization` bearer without the token prefix that is not a three-part value gives no credentials: no strategy runs and no failure is counted. A telemetry service's token on the same header costs nothing.
- **A malformed bearer of ours stops resolution.** A malformed or repeated `Authorization` header whose value starts with the token prefix still gives a `bearer` credential. It fails, and `x-api-key` is not tried.
- **An opaque bearer lets `x-api-key` through.** When `Authorization` carries someone else's token, `ApiKeyHeaderExtractor` still answers.
- **Signatures win.** Signature headers are asked first, so they win over an `Authorization` header on the same request.
- **Repeated headers fail.** A header sent twice reaches the extractors joined with `, `, which the token patterns never match.
- **Any session state is checked first.** With an active session cookie no extractor runs.
- A malformed `authn.http.publicOrigin` set at runtime fails only signed requests; anonymous ones still pass.

## Best practices

- Keep `extract()` cheap and synchronous: it runs on every request without an active session.
- Return `null` for values that are clearly not yours, so a foreign token does not count as a failed login.
- Return the credential for a malformed value that is clearly yours, so resolution stops at it instead of trying weaker credentials.

## Patterns and antipatterns

```ts
// Don't: verify in the extractor; it bypasses the throttle and the audit
public extract(req: SignedRequest) {
  const token = req.headers['x-auth-token'];
  return this.tokens.isValid(token) ? { kind: 'bearer', token } : null;
}

// Do: hand over the raw value; AuthnService verifies it
public extract(req: SignedRequest) {
  const token = req.headers['x-auth-token'];
  return token?.startsWith('spt_') ? { kind: 'bearer', token } : null;
}
```

## Related

- [Request authentication](01-request-authentication.md): where `extract()` runs in the request.
- [Principal resolvers](03-principal-resolvers.md): what happens to the credentials next.
- [`@spinajs/authn-token`](../authn-token/README.md): the `token` and `jwt` strategies for `bearer` credentials.
- [`@spinajs/authn-keys`](../authn-keys/README.md): the strategies for `jws-assertion` and `http-signature` credentials.
- [`@spinajs/http-socket` principal sources](../http-socket/08-principal-sources.md): sockets reuse the extractors for handshake credentials.
