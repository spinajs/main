# Presets

A preset fills in the issuer (or the fixed endpoints), the scopes, the claims mapping and the token endpoint authentication of a well-known IdP. You add the client id, the secret and the preset's own keys.

## How it works

1. You set `preset` on a provider instead of `issuer`. The schema checks that the preset's required keys are there and that no other source key is.
2. `buildOidcOptions()` takes the preset from `OIDC_PRESETS[preset]`.
3. `resolveIssuer(source)` fills the preset's issuer template, such as `https://login.microsoftonline.com/{tenant}/v2.0`, from your keys. Discovery then finds the endpoints. For `github`, `resolveEndpoints(source)` builds the fixed endpoints instead.
4. Your `claims` are merged over the preset's mapping member by member. Your `scopes` and `tokenEndpointAuth` replace the preset's when set.

`OIDC_PRESET_IDS` lists every preset id.

## Configuration

| Preset | Extra keys | Issuer | Scopes | Mapping differences | Token endpoint auth |
| --- | --- | --- | --- | --- | --- |
| `google` | none | `https://accounts.google.com`; `iss` may also be `accounts.google.com` | `openid email profile` | `groups` not mapped | `client_secret_basic` |
| `entra` | `tenant` (GUID, required) | `https://login.microsoftonline.com/<tenant>/v2.0` (tenant lower-cased) | `openid email profile` | `emailVerified` not mapped | `client_secret_basic` |
| `keycloak` | `baseUrl`, `realm` (required) | `<baseUrl>/realms/<realm>` (trailing `/` of `baseUrl` removed) | `openid email profile` | none | `client_secret_basic` |
| `auth0` | `domain` (required) | `https://<domain>/` | `openid email profile` | `groups` not mapped | `client_secret_basic` |
| `okta` | `domain` (required), `authorizationServer` (default `'default'`) | `https://<domain>/oauth2/<authorizationServer>`; with `authorizationServer: null`, `https://<domain>` | `openid email profile` | none | `client_secret_basic` |
| `github` | `host` (default `github.com`) | none: plain OAuth2, no discovery, no ID token | `read:user user:email` | `subject: 'id'`; `emailVerified` and `groups` not mapped | `client_secret_post` |

The default mapping, used by a generic `issuer` provider and as the base of every OIDC preset: `subject: 'sub'`, `email: 'email'`, `emailVerified: 'email_verified'`, `name: 'name'`, `groups: 'groups'` (`DEFAULT_CLAIMS`).

GitHub endpoints:

| Endpoint | `github.com` | GitHub Enterprise Server `host` |
| --- | --- | --- |
| Authorization | `https://github.com/login/oauth/authorize` | `https://<host>/login/oauth/authorize` |
| Token | `https://github.com/login/oauth/access_token` | `https://<host>/login/oauth/access_token` |
| Userinfo | `https://api.github.com/user` | `https://<host>/api/v3/user` |

```ts
providers: {
  google: { preset: 'google', clientId: '…apps.googleusercontent.com', clientSecret: { secret: 'env://GOOGLE_SECRET' }, requiredClaims: { hd: 'example.com' } },
  entra: { preset: 'entra', tenant: '3f2b6a1c-8d4e-4b7a-9c21-5e6f7a8b9c0d', clientId: '…', clientSecret: { secret: 'env://ENTRA_SECRET' } },
  keycloak: { preset: 'keycloak', baseUrl: 'https://sso.example.com', realm: 'corp', clientId: 'app', clientSecret: { secret: 'env://KC_SECRET' } },
  auth0: { preset: 'auth0', domain: 'example.eu.auth0.com', clientId: '…', clientSecret: { secret: 'env://AUTH0_SECRET' } },
  okta: { preset: 'okta', domain: 'example.okta.com', clientId: '…', clientSecret: { secret: 'env://OKTA_SECRET' } },
  github: { preset: 'github', clientId: 'Iv1.…', clientSecret: { secret: 'env://GITHUB_SECRET' } },
}
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Preset table | none; the frozen constant `OIDC_PRESETS` | six presets | a generic `issuer` provider | The table is frozen and not configurable. For an IdP without a preset, use `issuer` with your own `claims`, `scopes` and `tokenEndpointAuth`. |

## Important behaviour

- **Entra: one tenant, by GUID.** A domain, `common`, `organizations` or `consumers` would not match the `iss` of the tenant's tokens. Multi-tenant Entra is not supported.
- **Entra: email never verified.** Entra's `email` claim is mutable and unverified (nOAuth), so the preset maps no `emailVerified`. Matching by verified email never fires for Entra.
- **GitHub: email never verified, userinfo always on.** The subject is the numeric `id` from userinfo, so `userinfo` takes only `true`. No GitHub login links by verified email.
- **GitHub: no ID token checks.** It has no ID token, no nonce and no RFC 9207 `iss`; a callback that carries `iss` fails. Its identity comes from the userinfo answer over the access token.
- **Auth0 groups.** Auth0 sends groups only in a namespaced custom claim. Map it yourself, for example `claims: { groups: 'https://example.com/groups' }`: a string path is one top-level claim name, dots included.
- **Google issuer alias.** Google documents both `https://accounts.google.com` and `accounts.google.com` as `iss`; both pass.
- The package tests resolve a recorded discovery document for every OIDC preset.

## Best practices

- With `google`, set `requiredClaims: { hd: '<your domain>' }`; without it any Google account can sign in.
- With `entra`, add `requiredClaims: { tid: '<tenant id>' }` as a second guard next to the issuer check.
- With `github`, rely on links or JIT, never on email matching: the preset never marks an email verified.

## Patterns and antipatterns

```ts
// Don't: 'common' is no GUID; validation refuses it, and the iss of a tenant token would never match it
entra: { preset: 'entra', tenant: 'common', clientId: '…', clientSecret: { secret: 'env://ENTRA_SECRET' } },

// Do: one provider per tenant
entra: { preset: 'entra', tenant: '3f2b6a1c-8d4e-4b7a-9c21-5e6f7a8b9c0d', clientId: '…', clientSecret: { secret: 'env://ENTRA_SECRET' } },
```

## Examples

### Let staff sign in with Google Workspace and GitHub

```ts sample
import { OIDC_PRESET_IDS } from '@spinajs/authn-oidc';
import type { OidcConfig } from '@spinajs/authn-oidc';

const oidc: OidcConfig = {
  providers: {
    google: {
      preset: 'google',
      clientId: '1234567890-abc.apps.googleusercontent.com',
      clientSecret: { secret: 'env://OIDC_GOOGLE_SECRET' },
      requiredClaims: { hd: 'example.com' },
    },
    github: {
      preset: 'github',
      clientId: 'Iv1.0123456789abcdef',
      clientSecret: { secret: 'env://OIDC_GITHUB_SECRET' },
    },
  },
  redirects: { success: '/app', failure: '/login' },
};

console.log(OIDC_PRESET_IDS.join(', ')); // google, entra, keycloak, auth0, okta, github

export default {
  authn: {
    strategies: [
      { name: 'oidc:google', service: 'oidc:google' },
      { name: 'oidc:github', service: 'oidc:github' },
    ],
    oidc,
  },
};
```

## Related

- [Provider configuration](02-provider-configuration.md): every provider key.
- [Claims mapping](04-claims-mapping.md): what each mapping member does.
- [Identity linking](05-identity-linking.md): why an unverified email never links.
