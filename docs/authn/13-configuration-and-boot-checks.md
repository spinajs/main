# Configuration and boot checks

Every authentication package reads the `authn.*` root. `@spinajs/authn` owns `AUTHN_CONFIGURATION_SCHEMA`, and each package that owns a subtree ships a schema for it. The schemas fill the defaults and refuse bad values at boot. `DefaultAuthnService` adds the checks a schema cannot express, and `checkAuthnConfig` reports all of them without throwing.

## How it works

1. `AuthnConfigBootstrapper` (a `Bootstrapper` the root entry registers) calls `registerConfigurationSchema(AUTHN_CONFIGURATION_SCHEMA)`. The configuration then validates the merged tree and fills the defaults.
2. A module that reads `authn.*` but may load where the root entry never does (a directory scan, a CLI command) imports `@spinajs/authn/register-schema`, which registers the schema at import.
3. Each package that owns a subtree registers its schema the same two ways: in its own bootstrapper, and from its `register-schema` module, which every module that reads the subtree imports. The owners are `authn-session` (`authn.session`), `authn-local` (`authn.local`), `authn-token` (`authn.token`, `authn.jwt`), `authn-keys` (`authn.keys`), `authn-totp` (`authn.mfa.totp`), `authn-http` (`authn.http`) and `authn-oidc` (`authn.oidc`). Each package exports its schema from its root and from a `./schemas` entry that has no side effects. A module of another package that reads `authn.session` imports `@spinajs/authn-session/register-schema`.
4. `@spinajs/authn` ships a config file with the defaults of `strategies` (empty), `mfa.policy`, `throttle`, `freshAuth`, `linking`, `impersonation` and `audit`. It lists no strategy, no MFA step and no `throttle.service`: config arrays concatenate across files, and a config file loads whether or not its package is imported.
5. When `DefaultAuthnService` resolves, it:
   1. logs a warning when no app env was set (see [App env](#app-env));
   2. runs `checkAuthnSecrets` and fails the boot on its errors;
   3. calls the throttle's `checkConfiguration` (a throw fails the boot);
   4. warns when the throttle has no `peek` and a per-request strategy is listed.
6. `checkAuthnConfig(container)` (from `@spinajs/authn/boot`) returns `AuthnConfigFinding[]` (`topic`, `level`, `message`). It validates against the authn schema and every `authn.*` schema registered in the container lineage. `@spinajs/authn-http` serves it as the CLI command `authn:check-config`.

## Configuration

Keys of the core. The full table of each feature is on its page.

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.strategies` | `{ name, service }[]` | `[]` | Unique names | [Strategies](03-strategies.md) |
| `authn.mfa.policy.service` | `string` | `'DefaultMfaPolicy'` | A registered `MfaPolicy` | [MFA](04-mfa-policy-and-steps.md#configuration) |
| `authn.mfa.policy.force` | `boolean` | `false` | | [MFA](04-mfa-policy-and-steps.md#configuration) |
| `authn.mfa.policy.forceForRoles` | `string[]` | `[]` | | [MFA](04-mfa-policy-and-steps.md#configuration) |
| `authn.mfa.steps` | `{ name, service }[]` | `[]` | Unique names, not `recovery` | [MFA](04-mfa-policy-and-steps.md#configuration) |
| `authn.mfa.encryptionKey.secret`, `.previous` | `string \| null`, `string[]` | unset | 32 bytes as hex, base64 or base64url | [MFA](04-mfa-policy-and-steps.md#configuration) |
| `authn.throttle.*` | object | see page | | [Throttling](05-throttling.md#configuration) |
| `authn.audit.*` | object | see page | | [Audit events](06-audit-events.md#configuration) |
| `authn.freshAuth.maxAgeSeconds` | `integer` | `300` | ≥ 1 | [Fresh authentication](09-fresh-authentication.md#configuration) |
| `authn.linking.jit`, `.byVerifiedEmail` | `boolean` | `false` | | [Account linking](10-account-linking.md#configuration) |
| `authn.impersonation.*` | object | see page | | [Impersonation](11-impersonation-and-active-role.md#configuration) |

Keys of the other packages. Each is validated by the schema of the package in the last column, except the keys the authn schema keeps because a package reads them without depending on their owner: `authn.session.expiration.maxLifetime` (the impersonation service), `authn.token.prefix`, `authn.token.headerName` and `authn.keys.assertion.typ` (the `authn-http` extractors), and `authn.http.trustProxy` (`http-socket`).

| Key | Type | Default | Allowed values | Read by |
| --- | --- | --- | --- | --- |
| `authn.local.hasher.service` | `string` | unset | | [`authn-local`](../authn-local/README.md) |
| `authn.local.hasher.maxConcurrent` | `integer` | `8` | ≥ 1 | `authn-local` |
| `authn.local.pepper.secret` | `string \| null` | `null` | non-empty | `authn-local` |
| `authn.local.pepper.version` | `integer` | `1` | 1 to 999999999 | `authn-local` |
| `authn.local.pepper.previous` | `{ secret, version }[]` | unset | Versions unique and unlike `version` | `authn-local` |
| `authn.local.policy.minLength`, `.maxLength` | `integer` | `8`, `128` | 8 to 128, `maxLength` ≥ `minLength` | `authn-local` |
| `authn.local.policy.rule` | `object \| null` | `null` | A JSON schema | `authn-local` |
| `authn.local.policy.description` | `string` | unset | | `authn-local` |
| `authn.local.policy.blocklist` | `string \| null` | `null` | A `PasswordBlocklist` service | `authn-local` |
| `authn.local.generator.length` | `integer` | `16` | ≥ 1 | `authn-local` |
| `authn.local.generator.characters` | `string[]` | lower, upper, digits | ≥ 1 entry | `authn-local` |
| `authn.local.reset.ttlSeconds`, `.url`, `.revokeTokens` | `integer`, `string`, `boolean` | `3600`, `''`, `true` | | `authn-local` |
| `authn.local.invite.ttlSeconds` | `integer` | `900` | ≥ 1 | `authn-local` |
| `authn.local.expiration.enabled`, `.maxAgeDays` | `boolean`, `number` | `false`, `31` | `maxAgeDays` > 0 | `authn-local` |
| `authn.session.service` | `string` | unset | | [`authn-session`](../authn-session/README.md) |
| `authn.session.expiration.service`, `.ttl`, `.maxLifetime` | `string`, `integer`, `integer` | unset, `30`, `480` | minutes, ≥ 1 | `authn-session`; `maxLifetime` also bounds [impersonation](11-impersonation-and-active-role.md) |
| `authn.session.pendingTtlSeconds` | `integer` | `300` | ≥ 1 | `authn-session` |
| `authn.session.cookie.name` | `string` | `'ssid'` | | `authn-session` |
| `authn.session.cookie.hostPrefix`, `.secure` | `boolean \| 'auto'` | `'auto'` | `true`, `false`, `'auto'`, `'true'`, `'false'` | `authn-session` |
| `authn.session.cookie.sameSite` | `string \| boolean` | `'strict'` | `strict`, `lax`, `none` (any case), `true`, `false` | `authn-session` |
| `authn.session.hashIds` | `boolean` | `true` | `true` only | `authn-session` |
| `authn.mfa.totp.*` | object | issuer `SpinaJS`, `SHA1`, 6 digits, 30 s, window 1, 10 codes | | [`authn-totp`](../authn-totp/README.md) |
| `authn.token.prefix`, `.length` | `string`, `integer` | `'spt_'`, `32` | non-empty, ≥ 32 | [`authn-token`](../authn-token/README.md) |
| `authn.token.generation.service` | `string` | unset | | `authn-token` |
| `authn.token.maxTtlDays`, `.defaultTtlDays`, `.agentMaxTtlMinutes` | `integer` | `90`, `30`, `1440` | ≥ 1 | `authn-token` |
| `authn.token.headerName`, `.lastUsedUpdateInterval` | `string`, `number` | `'x-api-key'`, `60` | | `authn-token` |
| `authn.jwt.issuers` | object[] | `[]` | Unique `issuer`; asymmetric algorithms only; `jwksUri` or `keys` | `authn-token` |
| `authn.keys.algorithms` | `string[]` | `['EdDSA', 'ES256']` | `EdDSA`, `ES256` | [`authn-keys`](../authn-keys/README.md) |
| `authn.keys.challenge.*`, `.assertion.*`, `.httpSignature.*` | object | see owner | | `authn-keys` |
| `authn.http.publicOrigin` | `string \| null` | unset | `scheme://host[:port]` | [`authn-http`](../authn-http/README.md) |
| `authn.http.trustProxy` | `string[] \| integer \| null` | unset | CIDRs or a hop count; `null` falls back to `http.trustProxy` | `authn-http`, `authn-oidc` |
| `authn.http.csrf.enabled`, `.allowedOrigins`, `.unauthenticatedRoutes` | `boolean`, `string[]`, `string[]` | `true`, `[]`, the six credential-taking auth paths | origins, absolute paths | `authn-http` |
| `authn.http.routes.prefix` | `string` | unset | | Accepted by the `authn-http` schema; no package reads it |

`authn.oidc.*` has its own schema in [`@spinajs/authn-oidc`](../authn-oidc/README.md).

A subtree is checked and gets its defaults only while its package is loaded, so an app without `authn-local` has no `authn.local` tree. With its package loaded, an object is created with its defaults when unset. `authn-local` classes built with `deps` or `options` instead of the configuration fall back to `AUTHN_LOCAL_DEFAULTS`, which reads the schema defaults.

`@spinajs/authn-http` ships two `logger.filters` entries, `RateLimitFilter`s on the `authn-http` logger's `CsrfOriginGuard` refusal lines (`event: 'authn-http.csrf-refused'`): one line per (Origin, own origin) pair a minute, 20 a minute in all. The guard logs every refusal; the filters decide how many are written. Config arrays concatenate, so they join the app's own filters. See [log filters](../log/09-filters.md#ratelimitfilter).

## Secrets

`checkAuthnSecrets` checks two settings. A problem is an **error outside development and test**, which fails the boot, and a warning in development and test.

| Setting | Problem |
| --- | --- |
| `http.cookie.secret` | Missing or empty, or the public default `@spinajs/http` ships (`AUTHN_PUBLIC_COOKIE_SECRET`). Not a string is always an error |
| `authn.mfa.encryptionKey.secret` | Missing while a listed MFA step has `storesSecrets: true`, or the steps cannot be resolved to tell |

Messages name keys, never values. Set secrets (`authn.mfa.encryptionKey`, `authn.local.pepper.secret`, `authn.audit.hashKey.secret`, `http.cookie.secret`) from secret references, never inline.

## App env

`authnAppEnv(config)` returns the env the configuration resolved from `--env`, `APP_ENV` or `NODE_ENV`. When none of them was set, the configuration falls back to `development`, but `authnEnvFellBack(config)` is `true` and `authnAppEnv` returns `undefined`: **authn treats such a deployment as production**. `isLenientAuthnEnv(env)` is `true` only for development and test. A development env named only in a config file relaxes nothing.

## `checkAuthnConfig` findings

| Topic | Level | Finding |
| --- | --- | --- |
| `schema` | error | Each violation of the authn schema or a registered `authn.*` schema, by path and rule, never the value |
| `env` | warning | No app env set; the deployment counts as production |
| `strategies` | warning, error | No strategy listed; a listed service that is not registered |
| `secrets` | error, warning | The secret checks above |
| `mfa` | error | The policy cannot be resolved; users enrolled in a step `authn.mfa.steps` does not list (asks every `MfaEnrolments` source, so it opens the authn store); a source that fails |
| `throttle` | error | No throttle can be selected, or the selected one refuses the configuration |
| `proxy` | warning | Neither `authn.http.trustProxy` nor `http.trustProxy` is set |
| `cors` | warning | `http.cors` is set with an empty or missing `origins` list, or `origins` is not a list |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthnConfigBootstrapper` | `Bootstrapper` | `AuthnConfigBootstrapper` | `@spinajs/authn/register-schema` | Import `register-schema` in a module that reads `authn.*` without the root entry |
| Subtree schemas | `Bootstrapper` | `AuthnSessionConfigBootstrapper`, `AuthnLocalConfigBootstrapper`, `AuthnTokenConfigBootstrapper`, `AuthnKeysConfigBootstrapper`, `AuthnTotpConfigBootstrapper`, `AuthnHttpConfigBootstrapper` | Each package's `register-schema` module | Import the owner's `register-schema` in a module that reads its subtree |

## Important behaviour

- Without an app env, the secret checks are strict: a missing or public cookie secret fails the boot. [`@spinajs/authn-session`](../authn-session/README.md) reads the env the same way for the cookie. Set `APP_ENV` or `NODE_ENV` in every deployment.
- `authn.audit` and `authn.throttle` refuse unknown keys, so a typo fails the boot instead of being dropped.
- Switches that disable a protection (`authn.impersonation.requirePassword`, `requireMfa`, `authn.audit.hashIdentifiers`, `authn.local.reset.revokeTokens`, `authn.http.csrf.enabled`) take only `true` or `false`; `null` is refused rather than read as `false`.

## Best practices

- Run `authn:check-config` in CI and before a release: it reports what the boot accepts but an operator should fix.
- Keep `authn.strategies` and `authn.mfa.steps` in one config file of the app.

## Examples

### Fail a deployment script on configuration errors

```ts sample
import { DI } from '@spinajs/di';
import { checkAuthnConfig } from '@spinajs/authn/boot';

export async function assertAuthnConfig(): Promise<void> {
  const findings = await checkAuthnConfig(DI.RootContainer);
  for (const f of findings) console.log(`${f.level} [${f.topic}] ${f.message}`);
  if (findings.some((f) => f.level === 'error')) throw new Error('authn configuration has errors');
}
```

## Related

- [Contracts and packages](02-contracts-and-packages.md): which package reads which key group.
- [`@spinajs/configuration`](../configuration/README.md): schemas, secret references and env resolution.
