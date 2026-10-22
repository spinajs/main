# Claims mapping

The claims mapping turns the IdP's claims into the `OidcExternalSubject` that the core links and every [`authn.login.identified` hook](07-login-hooks.md) receives as `input.external`. `requiredClaims` refuses a login whose claims lack fixed values.

## How it works

1. `OidcProvider.complete()` has the validated ID token claims (none for plain OAuth2) and, when fetched, the userinfo claims.
2. `rawClaims(idToken, userinfo)` merges them: the ID token's claims, then the userinfo claims the ID token lacks. The ID token wins a conflict.
3. `hasRequiredClaims(raw, requiredClaims)` checks that each required claim is an own top-level member of the merged claims and equals the configured value (`===`). A miss fails the login.
4. `mapClaims(provider, mapping, raw, sources)` reads each mapped member with `readClaim()` and builds the subject. A missing or unusable subject fails the login.

### Reading a claim, `readClaim(claims, path)`

- A string path is one top-level claim name. Dots belong to the name, so `'https://example.com/groups'` reads Auth0's namespaced claim.
- An array path walks nested objects: `['realm_access', 'roles']` reads `claims.realm_access.roles`.
- Only own properties count. A missing step gives `undefined`.

### What each member becomes

| Mapping member | Read from | Result |
| --- | --- | --- |
| `subject` | the merged claims | A string of 1 to 255 characters, or a non-negative safe integer turned into a string (GitHub's numeric `id`). Anything else fails the login. |
| `email` | the first source, ID token then userinfo, where the claim is a string | `email` when 1 to 255 characters; else no email. |
| `emailVerified` | the same source as `email` | `emailVerified: true` only for a boolean `true`; `false` for anything else. Absent when there is no email. |
| `name` | the merged claims | `claims.name` when a string of at most 255 characters. |
| `groups` | the merged claims | `claims.groups`: a string becomes one group, an array keeps its string items of at most 255 characters. Absent when unmapped, missing, of another type or longer than 256 items. |

The mapped subject:

```ts
interface OidcExternalSubject {
  provider: `oidc:${string}`;          // the strategy name, stored on the link
  subject: string;
  email?: string;
  emailVerified?: boolean;
  claims: {
    name?: string;
    groups?: readonly string[];        // absent is not the same as []
    raw: Readonly<Record<string, unknown>>; // the merged claims; never a token
  };
}
```

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.oidc.providers.<name>.claims.subject` | string or string[] | `'sub'` (`github`: `'id'`) | a claim path; never `null` | The immutable subject. Its last segment may not be `email`, `upn`, `preferred_username`, `login` or `name`. |
| `authn.oidc.providers.<name>.claims.email` | string, string[] or `null` | `'email'` | a claim path, or `null` for not mapped | The email. |
| `authn.oidc.providers.<name>.claims.emailVerified` | string, string[] or `null` | `'email_verified'` (`entra`, `github`: `null`) | a claim path, or `null` | The verified flag of the email. |
| `authn.oidc.providers.<name>.claims.name` | string, string[] or `null` | `'name'` | a claim path, or `null` | The display name. |
| `authn.oidc.providers.<name>.claims.groups` | string, string[] or `null` | `'groups'` (`google`, `auth0`, `github`: `null`) | a claim path, or `null` | The group list for hooks. |
| `authn.oidc.providers.<name>.requiredClaims` | object | `{}` | string, finite number or boolean values | Top-level claims that must be present with exactly these values. |

```ts
corp: {
  issuer: 'https://sso.example.com/realms/corp',
  clientId: 'reports-app',
  clientSecret: { secret: 'env://OIDC_CORP_SECRET' },
  claims: { name: 'preferred_username', groups: ['realm_access', 'roles'] },
  requiredClaims: { email_verified: true },
},
```

### Required claims

`requiredClaims` compares against the merged claims, so a value from userinfo counts when the ID token lacks the claim. Only top-level claims can be required. A required claim that the IdP sends as a string `"true"` does not equal the boolean `true`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Mapping functions | none; exported functions | `readClaim`, `rawClaims`, `mapClaims`, `hasRequiredClaims` | none | Not replaceable. To act on more claims, read `external.claims.raw` in an [`authn.login.identified` hook](07-login-hooks.md). |

## Important behaviour

- **The email and its flag come from the same document.** An ID token's `email_verified: true` never vouches for a different email in userinfo.
- **The provider's switch gates the flag.** Without `linking.byVerifiedEmail` on the provider, `OidcStrategy` sets `emailVerified: false` before the core and the hooks see the subject. See [Identity linking](05-identity-linking.md).
- **`groups` absent is not `[]`.** An unmapped or missing groups claim leaves `claims.groups` out. A hook must then leave memberships alone, not remove them all.
- **`raw` holds claims, never tokens.** The access token and the ID token itself are not in the subject.
- **Mutable subjects are refused at boot** (nOAuth): an email, UPN or username can be changed or reassigned at the IdP, so it never identifies an account.
- Changing `claims.subject` unlinks every user of the provider: stored links hold the old subject values.

## Best practices

- Leave `subject` at the default `sub` unless the IdP documents another immutable id (GitHub's `id`).
- Map `groups` to the claim your IdP really sends, and check `claims.groups !== undefined` in hooks before you sync.
- Use `requiredClaims` for tenant and domain pinning (`hd`, `tid`), not hooks: it fails before the core touches any identity.

## Patterns and antipatterns

```ts
// Don't: a dotted string is one top-level claim name, so this reads a claim literally named "realm_access.roles"
claims: { groups: 'realm_access.roles' },

// Do: an array walks nested objects
claims: { groups: ['realm_access', 'roles'] },
```

## Examples

### Read the groups from Keycloak realm roles and keep only verified emails

```ts sample
import type { OidcConfig } from '@spinajs/authn-oidc';

const oidc: OidcConfig = {
  providers: {
    corp: {
      preset: 'keycloak',
      baseUrl: 'https://sso.example.com',
      realm: 'corp',
      clientId: 'reports-app',
      clientSecret: { secret: 'env://OIDC_CORP_SECRET' },
      claims: { groups: ['realm_access', 'roles'] },
      requiredClaims: { email_verified: true },
    },
  },
};

export default { authn: { strategies: [{ name: 'oidc:corp', service: 'oidc:corp' }], oidc } };
```

### Map claims in a unit test

```ts sample
import { DEFAULT_CLAIMS, mapClaims } from '@spinajs/authn-oidc';

const external = mapClaims('oidc:corp', { ...DEFAULT_CLAIMS, groups: ['realm_access', 'roles'] }, {
  sub: '5f1c2a9e',
  email: 'ada@example.com',
  email_verified: true,
  name: 'Ada Lovelace',
  realm_access: { roles: ['reports-viewer', 'offline_access'] },
});

console.log(external.subject, external.emailVerified, external.claims.groups); // 5f1c2a9e true [ 'reports-viewer', 'offline_access' ]
```

## Related

- [Presets](03-presets.md): the mapping each preset sets.
- [Login hooks](07-login-hooks.md): where the mapped claims are used.
- [Identity links](../authn-orm/03-identity-links.md): the `provider` and `subject` columns the mapping fills.
