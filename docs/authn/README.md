# `@spinajs/authn`

The authentication core of SpinaJS. It answers one question, who is calling and how sure we are, and hands the answer to authorization as a `Principal`. It holds the contracts every `authn-*` package implements, the login flow (`AuthnService`), the strategy registry, the MFA policy, the throttle, the audit fan-out, fresh authentication, account linking, impersonation and the `authn.*` config schema.

It does **not** ship a login method, a session store, a second factor or HTTP routes. Passwords, tokens, keys, OIDC, TOTP, sessions and routes come from the packages under [Related packages](#related-packages). It does not decide what a caller may do: that is [`@spinajs/authz`](../authz/README.md).

Moving a 2.x app: read [the migration guide](../authz/migration-guide.md), in particular [the authentication keys](../authz/migration-guide.md#32-authentication-keys) and [the steps for an app](../authz/migration-guide.md#8-steps-for-an-app). 3.0 starts from an empty database; no migration carries 2.x data.

## Install

```sh
npm install @spinajs/authn
```

## Features

| Feature | What it does |
| --- | --- |
| [Authentication flow](01-authentication-flow.md) | `AuthnService`: login, MFA completion, re-authentication and `principalOf`, step by step |
| [Contracts and packages](02-contracts-and-packages.md) | Every contract, the package that implements it, the entry points and the package set per app type |
| [Strategies](03-strategies.md) | `AuthenticationStrategy`, `StrategyRegistry`, `authn.strategies` and writing a login method |
| [MFA policy and steps](04-mfa-policy-and-steps.md) | `MfaPolicy`, `DefaultMfaPolicy`, `MfaStep`, `MfaEnrolments` and `authn.mfa.*` |
| [Throttling](05-throttling.md) | `AuthnThrottle`, `MemoryAuthnThrottle`, `StoreAuthnThrottle`, the keys and `authn.throttle.*` |
| [Audit events](06-audit-events.md) | `AuthnEvent`, `AuthnEventSink`, `AuthnAudit`, `LogAuthnAuditSink` and `authn.audit.*` |
| [Principal and authorization](07-principal-and-authz.md) | `Principal`, `AuthnFacts`, `PrincipalFactory`, and how the principal reaches authz |
| [Session contract](08-session-contract.md) | `SessionIssuer`, the `Session` class, `SessionKeys` and a custom session class |
| [Fresh authentication](09-fresh-authentication.md) | `FreshAuthCheck`, `isFresh` and `authn.freshAuth.maxAgeSeconds` |
| [Account linking](10-account-linking.md) | Linking at login, `AccountLinkService`, `IdentityLinkStore` and `authn.linking.*` |
| [Impersonation and the active role](11-impersonation-and-active-role.md) | `AuthnImpersonationService`, `ImpersonationGuard`, the role switch and `authn.impersonation.*` |
| [Integration hooks](12-integration-hooks.md) | `AuthnResponseExtension`, `RoleSource`, `SessionStartHook`, `CredentialAdminGuard`, `CredentialExtractor` |
| [Configuration and boot checks](13-configuration-and-boot-checks.md) | `AUTHN_CONFIGURATION_SCHEMA`, every `authn.*` key, the secret and env checks, `checkAuthnConfig` |
| [Action hooks](14-action-hooks.md) | The authn actions of `@spinajs/hooks` (`authn.login`, `authn.login.identified`, MFA, step-up, impersonation, linking): inputs, mutable keys, refused answers, the `authn.login` timing rule, and `hookView`, `hookCopy`, `hookRefusalOf` for packages that run their own actions |

## Quick start

Install the packages of a session web app (see [the package set](02-contracts-and-packages.md#package-set-per-app-type)), import `@spinajs/users` in the app entry, and list the login methods in the app's config:

```ts
export default {
  authn: {
    strategies: [
      { name: 'local', service: 'LocalPasswordStrategy' },
      { name: 'token', service: 'TokenStrategy' },
    ],
    throttle: { service: 'DbAuthnThrottle' },
  },
};
```

`@spinajs/authn-http` then serves `POST /auth/login`. To log a user in from code:

```ts sample
import { DI } from '@spinajs/di';
import { AuthnService } from '@spinajs/authn';
import type { Principal } from '@spinajs/authn';

export async function signIn(login: string, password: string, ip: string): Promise<Principal | 'mfa_required' | null> {
  const authn = await DI.resolve(AuthnService);
  const result = await authn.authenticate({ kind: 'password', login, password }, { ip, now: new Date(), purpose: 'login' });
  if (result.status === 'mfa_required') return 'mfa_required';
  if (result.status === 'failure') return null;
  return authn.principalOf(result);
}
```

## Related packages

- [`@spinajs/authn-http`](../authn-http/README.md): the middleware that resolves `req.storage.AuthnPrincipal`, the credential extractors, the login, MFA, session, token, key and impersonation routes, and `authn:check-config`.
- [`@spinajs/authn-local`](../authn-local/README.md): the `local` password strategy and `PasswordService` (change, reset, invite, expiry).
- [`@spinajs/authn-token`](../authn-token/README.md): API and agent tokens (`TokenStrategy`, `TokenService`) and external JWT bearers (`JwtBearerStrategy`).
- [`@spinajs/authn-keys`](../authn-keys/README.md): public keys, JWS client assertions, HTTP message signatures and challenge login.
- [`@spinajs/authn-oidc`](../authn-oidc/README.md): OIDC and OAuth2 single sign-on, one `oidc:<provider>` strategy per provider.
- [`@spinajs/authn-totp`](../authn-totp/README.md): `TotpMfaStep` and recovery codes.
- [`@spinajs/authn-session`](../authn-session/README.md): `DefaultSessionIssuer`, the session cookie and expiration.
- [`@spinajs/authn-orm`](../authn-orm/README.md): the database stores: `DbAuthnThrottle`, `DbAuthnAuditSink`, `DbIdentityLinkStore`, `DbSecretStore`, `DbNonceStore`, `DbMfaEnrolments`.
- [`@spinajs/session-provider-db`](../session-provider-db/README.md), [`@spinajs/session-provider-redis`](../session-provider-redis/README.md), [`@spinajs/session-provider-dynamodb`](../session-provider-dynamodb/README.md): session stores for `authn-session`.
- [`@spinajs/authn-testing`](../authn-testing/README.md): fakes, conformance suites and the behaviour rules for strategies and stores.
- [`@spinajs/users`](../users/README.md): `IdentityStore`, `PasswordCredentialStore`, `PrincipalFactory`, the guards and the event sinks over the user model.
- [`@spinajs/authz`](../authz/README.md): decides what the principal may do; imports only the principal types from `@spinajs/authn/contracts`.
