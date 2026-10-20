# Programmatic API

The routes are a thin express layer over framework-free classes. Use these classes to serve OIDC from your own controller, to test a provider config, or to build tools. Most apps need none of this: the [login flow](01-login-flow.md) runs on configuration alone.

## How it works

The layers, from the outside in:

1. `OidcController` (not exported) maps express to an `OidcRequest` and an `OidcAnswer` back to express.
2. `OidcLogin` holds the route logic: `begin()`, `callback()`, `beginLink()`, `unlink()`, `failure()`. It takes its dependencies in the constructor (`OidcLoginDeps`), with no DI.
3. `OidcStrategy` is the `AuthenticationStrategy` the core calls: `accepts()`, `verify()`, `verifyLink()`, `linkingFor()`, `throttleKeys()`.
4. `OidcProvider` is one configured IdP at run time: `endpoints()`, `begin()`, `complete()`. It owns one `OidcDiscovery` and one `OidcJwks`.
5. Pure functions do each step: the flow cookie, the authorization URL, the token exchange, the ID token checks, userinfo and the claims mapping.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Route logic | none; `new OidcLogin(deps)` | `OidcLogin` | your own controller over it | Build it with `OidcProviders.strategies()`, `AuthnService`, `SessionIssuer`, the redirects, the env, a session cookie function and a callback path function. |
| Provider runtime | none; `new OidcProvider(options, http, states, relaxed)` | `OidcProvider` | none | `states` is any `OidcStateStore` (`claim(key, expiresAt, now)`); `NonceStore` fits. Build one per provider and keep it: the caches live in it. |
| Strategy | none; `new OidcStrategy(deps)` | `OidcStrategy` | none | `OidcStrategyDeps`: `provider`, `links`, optional `identities` and global `linking`. |

## Exports by feature

| Feature | Exports |
| --- | --- |
| Configuration | `OidcConfig`, `OidcProviderConfig`, `OidcClientConfig`, `OidcProviderSource`, `OidcSecretRef`, `OidcTokenEndpointAuth`, `OidcAuthorizationParams`, `OidcReservedParam`, `OidcAppPath`, `OidcEntraTenantId`, `ConfiguredOidc`, `ConfiguredProvider`, `OidcOptions`, `OidcProviderOptions`, `BuildOidcOptionsExtra`, `buildOidcOptions`, `AUTHN_OIDC_CONFIGURATION_SCHEMA`, `AUTHN_OIDC_PROVIDER_SCHEMA`, `OIDC_RESERVED_PARAMS`, `OIDC_PROVIDER_NAME_PATTERN`, `OIDC_APP_PATH_PATTERN`, `OIDC_ENTRA_TENANT_PATTERN`, `OIDC_HOST_PATTERN`, `OIDC_SEGMENT_PATTERN` ([Provider configuration](02-provider-configuration.md)) |
| Presets | `OidcPresetId`, `OIDC_PRESET_IDS`, `OidcPreset`, `OidcEndpoints`, `OIDC_PRESETS`, `DEFAULT_CLAIMS`, `resolveIssuer`, `resolveEndpoints` ([Presets](03-presets.md)) |
| Claims | `OidcClaimPath`, `OidcClaimsMapping`, `OidcMappedClaims`, `OidcExternalSubject`, `readClaim`, `rawClaims`, `mapClaims`, `hasRequiredClaims`, `MAX_SUBJECT_LENGTH`, `MAX_EMAIL_LENGTH` ([Claims mapping](04-claims-mapping.md)) |
| Registration | `OidcBootstrapper`, `OidcProviders`, `registerOidcStrategies`, `providerNamesOf`, `appEnvOf`, `OidcStrategyName` |
| Strategy | `OidcStrategy`, `OidcStrategyDeps`, `OidcCallbackPayload` |
| Provider runtime | `OidcProvider`, `OidcStateStore`, `OidcEndpointSet`, `OidcCallbackQuery` |
| Routes | `OidcLogin`, `OidcLoginDeps`, `OidcRequest`, `OidcAnswer`, `OIDC_FAILURE_BODY`, `requestOrigin`, `OriginFacts` |
| Flow cookie | `OidcFlow`, `OidcFlowSecrets`, `FlowCookie`, `newFlow`, `flowSecrets`, `encodeFlow`, `decodeFlow`, `flowIsLive`, `stateClaim`, `flowCookie`, `clearFlowCookie`, `flowCookieName`, `sessionBindingOf`, `sha256hex`, `codeChallengeOf`, `appPathOrNull`, `OIDC_FLOW_TTL_SECONDS`, `OIDC_FLOW_FUTURE_SKEW_SECONDS`, `OIDC_FLOW_COOKIE_BASE_NAME`, `OIDC_FLOW_COOKIE_MAX_LENGTH` |
| Authorization request | `authorizationUrl`, `AuthorizationRequest` |
| Tokens | `exchangeCode`, `CodeExchange`, `OidcTokenSet`, `validateIdToken`, `IdTokenRules`, `IdTokenClaims`, `atHashOf`, `fetchUserinfo`, `OidcSigningAlgorithm`, `OIDC_SIGNING_ALGORITHMS` ([Security guarantees](09-security.md)) |
| HTTP, discovery, keys | `OidcHttpClient`, `FetchOidcHttpClient`, `OidcHttpHeaders`, `OidcHttpResponse`, `OIDC_HTTP_TIMEOUT_MS`, `OIDC_HTTP_MAX_BODY_BYTES`, `OidcDiscovery`, `OidcProviderMetadata`, `discoveryUrlOf`, `DISCOVERY_MAX_AGE_MS`, `DISCOVERY_RETRY_MS`, `OidcJwks`, `JwksUriSource`, `JWKS_MAX_AGE_MS`, `JWKS_REFRESH_MS` ([Provider HTTP client](08-http-client.md)) |
| Account linking | `OidcAccountLinks`, `CoreOidcAccountLinks`, `OidcLinkResult` ([Account linking](06-account-linking.md)) |

### Serving the routes from your own controller

`OidcLogin` returns an `OidcAnswer`: a status, an optional `location`, cookies to set, and a JSON `body` or an `html` page. Your layer sends it as is, with `Cache-Control: no-store`.

```ts
const login = new OidcLogin({
  strategies: providers.strategies(),
  service: await DI.resolve(AuthnService),
  sessions,
  redirects: providers.options.redirects,
  env: providers.env,
  sessionCookie: (h) => sessionCookie(h.id, cookieConfig, undefined, providers.env),
  callbackPath: (p) => `/sso/${encodeURIComponent(p)}/callback`,
  linker,
  links,
});

const answer = await login.callback('corp', {
  origin: 'https://app.example.com',
  cookies: req.cookies,
  query: req.query,
  navigation: req.get('sec-fetch-mode') === 'navigate',
  ctx: { now: new Date(), purpose: 'login', ip: req.storage.ClientIp },
  session: req.storage.AuthnSession?.handle ?? null,
});
```

Register the callback path you pass in `callbackPath` at the IdP, since it builds the default redirect URI.

## Important behaviour

- **The core flow still runs.** `OidcLogin.callback()` calls `AuthnService.authenticate()`, so the strategy must be listed in `authn.strategies`, and throttling, audit, linking and hooks apply.
- **One `OidcProvider` per provider.** A new instance per request resets the discovery and JWKS caches and their refresh limits.
- **`OidcLogin` never throws for a client error.** Every failure is an `OidcAnswer`; unexpected errors are logged through `deps.log` with the error class only.

## Best practices

- Resolve `OidcProviders` from DI instead of building providers yourself in an app: it applies the boot checks and shares one provider per container.
- Use the pure functions (`newFlow`, `flowSecrets`, `authorizationUrl`, `mapClaims`) in unit tests of your own code that touches OIDC.

## Examples

### Build a GitHub authorization URL without booting the app

```ts sample
import { MemoryNonceStore } from '@spinajs/authn-orm';
import { FetchOidcHttpClient, OidcProvider, buildOidcOptions, flowCookie } from '@spinajs/authn-oidc';

const options = buildOidcOptions(
  {
    providers: {
      github: {
        preset: 'github',
        clientId: 'Iv1.0123456789abcdef',
        clientSecret: { secret: 'resolved-secret' },
        clockSkewSeconds: 30,
        algorithms: ['RS256'],
        requiredClaims: {},
        authorizationParams: {},
        linking: { jit: false, byVerifiedEmail: false },
      },
    },
    redirects: { success: '/', failure: '/login' },
  },
  'production',
);

const provider = new OidcProvider(options.providers.get('github')!, new FetchOidcHttpClient(), new MemoryNonceStore(), false);

provider
  .begin({ redirectUri: 'https://app.example.com/auth/oidc/github/callback', returnTo: '/settings', mode: 'login', now: new Date() })
  .then(({ flow, location }) => {
    console.log(location); // https://github.com/login/oauth/authorize?response_type=code&client_id=…&code_challenge_method=S256
    console.log(flowCookie(flow, 'production').Name); // __Host-spinajs-oidc
  });
```

The `github` preset has fixed endpoints, so `begin()` makes no network call.

## Related

- [Login flow](01-login-flow.md): the routes these classes serve.
- [`@spinajs/authn`](../authn/README.md): `AuthnService` and the strategy contract.
- [Nonce store](../authn-orm/04-nonce-store.md): `MemoryNonceStore` for tests.
