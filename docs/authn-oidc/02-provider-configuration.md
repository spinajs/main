# Provider configuration

You configure each IdP under `authn.oidc.providers.<name>`. Each provider becomes the strategy `oidc:<name>`, which you list in `authn.strategies`, and gets the routes `/auth/oidc/<name>`.

## How it works

1. Importing `@spinajs/authn-oidc` registers the `authn.oidc` configuration schema (`AUTHN_OIDC_CONFIGURATION_SCHEMA`) and the `OidcBootstrapper`.
2. `OidcBootstrapper.bootstrap()` registers the schema again, resolves `Configuration` (which validates `authn.oidc` and fills its defaults), then calls `registerOidcStrategies(providerNamesOf(config))`.
3. `registerOidcStrategies()` registers one factory per provider name as an `AuthenticationStrategy`, named `oidc:<name>`. A name already registered in the container is left as it is.
4. The core's `StrategyRegistry` reads `authn.strategies` and resolves the service `oidc:<name>`. The factory resolves `OidcProviders` and returns its strategy for that name.
5. `OidcProviders.resolve()` reads the app env, the global `authn.linking` switches and `authn.oidc`, and calls `buildOidcOptions()`. It then builds one `OidcProvider` (one discovery cache, one JWKS cache) and one `OidcStrategy` per provider.
6. `buildOidcOptions()` checks what the schema cannot: the https rule, the subject mapping, the clock skew and finite `requiredClaims` numbers. It merges the preset and the defaults, and deep-freezes the result. A failure throws `InvalidOption` naming the provider and the key, never a value.

`OidcProviders` resolves the first time something needs it: the strategy registry resolving `oidc:<name>`, or `OidcController` being built. A bad provider fails at that point.

## Configuration

### `authn.oidc`

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.oidc.providers` | object | `{}` | names matching `^[a-z0-9_-]{1,59}$` | The providers, by name. The name gives the strategy `oidc:<name>` and the provider stored on every link. |
| `authn.oidc.redirects.success` | string | `'/'` | app-relative path | See [Login flow](01-login-flow.md#configuration). |
| `authn.oidc.redirects.failure` | string | `'/'` | app-relative path | See [Login flow](01-login-flow.md#configuration). |

An app-relative path has one leading `/`, never `//` or `/\`, and no space, backslash or control character. Any other key under `authn.oidc` fails validation.

### `authn.oidc.providers.<name>`: the source

Each provider takes exactly one source: an `issuer`, or a `preset` with the extra keys of that preset. A source key that does not belong to the chosen source fails validation.

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `…<name>.issuer` | string | none | https URL without credentials, query or fragment | A generic OIDC provider. Discovery reads `<issuer>/.well-known/openid-configuration`. Required without `preset`. |
| `…<name>.preset` | string | none | `google`, `entra`, `keycloak`, `auth0`, `okta`, `github` | A well-known provider. See [Presets](03-presets.md). |
| `…<name>.tenant` | string | none | a GUID | `entra` only, required. |
| `…<name>.baseUrl` | string | none | https URL without credentials, query or fragment | `keycloak` only, required. |
| `…<name>.realm` | string | none | one path segment, never `.` or `..` | `keycloak` only, required. |
| `…<name>.domain` | string | none | a host name with an optional port | `auth0` and `okta`, required. |
| `…<name>.authorizationServer` | string or `null` | `'default'` | one path segment, or `null` | `okta` only. `null` is the org authorization server. |
| `…<name>.host` | string | `'github.com'` | a host name with an optional port | `github` only: a GitHub Enterprise Server host. |

### `authn.oidc.providers.<name>`: the client

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `…<name>.clientId` | string | none | non-empty | Required. The client id at the IdP. |
| `…<name>.clientSecret` | object | none | `{ secret: string }` | Required. A secret reference (for example `env://OIDC_SECRET`) that the configuration resolves. A bare string fails validation. |
| `…<name>.tokenEndpointAuth` | string | the preset's, else `'client_secret_basic'` | `client_secret_basic`, `client_secret_post` | How the client authenticates at the token endpoint. |
| `…<name>.redirectUri` | string | `<origin>/auth/oidc/<name>/callback` | absolute https URL without credentials or fragment; a query is allowed | The `redirect_uri`. The IdP must have it registered exactly. |
| `…<name>.scopes` | string[] | the preset's, else `['openid', 'email', 'profile']` | unique RFC 6749 scope tokens | Requested scopes. An ID token provider always gets `openid`, prepended when missing. |
| `…<name>.claims` | object | the preset's mapping | `subject`, `email`, `emailVerified`, `name`, `groups` | Merged member by member over the preset's mapping. See [Claims mapping](04-claims-mapping.md). |
| `…<name>.algorithms` | string[] | all of `OIDC_SIGNING_ALGORITHMS` | `RS256`, `RS384`, `RS512`, `PS256`, `PS384`, `PS512`, `ES256`, `ES384`, `ES512`, `EdDSA` | Allowed ID token algorithms; at least one, unique. |
| `…<name>.clockSkewSeconds` | integer | `30` | `0` to `300` | Leeway for `exp`, `iat` and `nbf`. |
| `…<name>.userinfo` | boolean | fetch when the provider has a userinfo endpoint | `true`, `false`; `github` takes only `true` | Fetch userinfo after the token exchange. `true` with no userinfo endpoint fails every login. |
| `…<name>.requiredClaims` | object | `{}` | string, finite number or boolean values | Top-level claims the login must carry with exactly these values, such as `{ hd: 'example.com' }`. See [Claims mapping](04-claims-mapping.md#required-claims). |
| `…<name>.authorizationParams` | object | `{}` | string values; no reserved key | Extra authorization request parameters such as `prompt`, `login_hint`, `hd`, `domain_hint`. |
| `…<name>.linking.jit` | boolean | `false` | | JIT provisioning for this provider. Needs `authn.linking.jit` too. See [Identity linking](05-identity-linking.md). |
| `…<name>.linking.byVerifiedEmail` | boolean | `false` | | Link a first login by verified email. Needs `authn.linking.byVerifiedEmail` too. |

`OIDC_RESERVED_PARAMS` lists the keys `authorizationParams` refuses: the flow's own `response_type`, `response_mode`, `client_id`, `redirect_uri`, `scope`, `state`, `nonce`, `code_challenge`, `code_challenge_method`, and `request`, `request_uri`, `max_age`, `acr_values`. Nothing checks `auth_time` or `acr`, so `max_age` and `acr_values` would promise a check that does not happen.

```ts
export default {
  authn: {
    strategies: [
      { name: 'local', service: 'LocalPasswordStrategy' },
      { name: 'oidc:corp', service: 'oidc:corp' },
      { name: 'oidc:google', service: 'oidc:google' },
    ],
    linking: { jit: false, byVerifiedEmail: true },
    oidc: {
      redirects: { success: '/app', failure: '/login' },
      providers: {
        corp: {
          issuer: 'https://sso.example.com/realms/corp',
          clientId: 'reports-app',
          clientSecret: { secret: 'env://OIDC_CORP_SECRET' },
          claims: { groups: ['realm_access', 'roles'] },
          authorizationParams: { prompt: 'select_account' },
        },
        google: {
          preset: 'google',
          clientId: '1234567890-abc.apps.googleusercontent.com',
          clientSecret: { secret: 'env://OIDC_GOOGLE_SECRET' },
          requiredClaims: { hd: 'example.com' },
          linking: { byVerifiedEmail: true },
        },
      },
    },
  },
};
```

## Boot checks

The schema refuses, when the configuration validates:

- an unknown key under `authn.oidc`, under a provider, under `claims`, `clientSecret` or `linking`;
- a provider name outside `^[a-z0-9_-]{1,59}$`;
- a provider with neither `issuer` nor `preset`, a missing required preset key, or a source key of another preset;
- an `entra` `tenant` that is not a GUID, a `realm` or `authorizationServer` that is not one path segment, a `domain` or `host` that is not a host name;
- an `authorizationParams` key from `OIDC_RESERVED_PARAMS`, a `scopes` entry that is not a scope token, an `algorithms` entry outside the list;
- a `redirects` path that is not app-relative.

`buildOidcOptions()` refuses, when `OidcProviders` resolves:

- an `issuer` or `baseUrl` that is not an https URL without credentials, query or fragment;
- a `redirectUri` that is not an absolute https URL without credentials or fragment;
- a `claims.subject` whose last path segment is `email`, `upn`, `preferred_username`, `login` or `name` (any case);
- a `clockSkewSeconds` that is not an integer from 0 to 300;
- a `requiredClaims` number that is `NaN` or infinite.

In development and test, `http` URLs pass both checks. An unset env counts as production.

It only warns when a provider's `linking.<key>` is on and `authn.linking.<key>` is off: that switch has no effect.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Strategy per provider | `AuthenticationStrategy`, a factory named `oidc:<name>`, registered by `OidcBootstrapper` | `OidcStrategy` from `OidcProviders` | none | Not meant to be replaced. `registerOidcStrategies()` skips a name already registered in the container, so a second call is harmless. |
| Provider registry | `OidcProviders`, `@PerChildInstance()` | `OidcProviders` | none | One per container, so a child container reads its own `authn.oidc`. `strategies()` and `strategy(name)` give the built strategies. |
| Bootstrapper | `Bootstrapper`, registered with `@Injectable(Bootstrapper)` on import | `OidcBootstrapper` | none | Not meant to be replaced. Call `registerOidcStrategies(names, container)` yourself for a container the bootstrapper does not cover. |
| Options | none | `buildOidcOptions(config, env, extra)` | none | Exported for tests and tools that check an `authn.oidc` value without booting. |

## Important behaviour

- **Renaming a provider unlinks its users.** Every link stores the provider as `oidc:<name>`. A new name finds no link.
- **One issuer per name.** `sub` is unique per issuer only. A new issuer needs a new provider name, not an edited `issuer`.
- **Changing `claims.subject` unlinks every user** of the provider: the stored subjects no longer match.
- **The secret stays readable but never prints.** The built options keep `clientSecret.secret`; `JSON.stringify` and `util.inspect` show `[redacted]`.
- **The app must import the package.** The controller scan finds `OidcController` alone, but the strategies are registered only by `OidcBootstrapper`, which runs when the package is imported.
- **List every provider.** A provider missing from `authn.strategies` is not a login candidate: its start route still redirects to the IdP, but the core finds no strategy for the callback, which gets the failure answer.

## Best practices

- Keep `clientSecret.secret` a reference (`env://…`, or a secret store protocol). The configuration resolves it; the config file never holds the value.
- Set `requiredClaims` for a multi-domain IdP, such as Google's `hd` or Entra's `tid`, so only your organisation signs in.
- Narrow `algorithms` to what your IdP signs with, such as `['RS256']`.

## Patterns and antipatterns

```ts
// Don't: email is mutable at many IdPs (nOAuth); boot refuses it as the subject
corp: { issuer: 'https://sso.example.com', clientId: 'app', clientSecret: { secret: 'env://S' }, claims: { subject: 'email' } },

// Do: the IdP's immutable subject, the default
corp: { issuer: 'https://sso.example.com', clientId: 'app', clientSecret: { secret: 'env://S' } },
```

```ts
// Don't: a bare string fails validation, and an inline secret leaks through the config file
clientSecret: 'f3c9…',

// Do
clientSecret: { secret: 'env://OIDC_CORP_SECRET' },
```

## Examples

### Check a provider config in a unit test without booting the app

```ts sample
import { buildOidcOptions } from '@spinajs/authn-oidc';
import type { ConfiguredOidc } from '@spinajs/authn-oidc';

const config: ConfiguredOidc = {
  providers: {
    corp: {
      issuer: 'https://sso.example.com/realms/corp',
      clientId: 'reports-app',
      clientSecret: { secret: 'resolved-secret' },
      clockSkewSeconds: 30,
      algorithms: ['RS256'],
      requiredClaims: {},
      authorizationParams: {},
      linking: { jit: false, byVerifiedEmail: false },
    },
  },
  redirects: { success: '/app', failure: '/login' },
};

const options = buildOidcOptions(config, 'production');
const corp = options.providers.get('corp')!;
console.log(corp.strategy, corp.scopes, corp.tokenEndpointAuth); // oidc:corp [ 'openid', 'email', 'profile' ] client_secret_basic
```

`ConfiguredOidc` is the shape after the schema filled its defaults, so the sample sets `clockSkewSeconds`, `algorithms`, `requiredClaims`, `authorizationParams` and `linking` itself.

## Related

- [`@spinajs/authn`, Strategies](../authn/03-strategies.md): how `authn.strategies` lists strategies.
- [`@spinajs/authn`, Config](../authn/13-configuration-and-boot-checks.md): `authn.linking` and the other `authn.*` keys.
- [Presets](03-presets.md): what each `preset` fills in.
