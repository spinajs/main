# Contracts and packages

`@spinajs/authn` holds the contracts every authentication package codes against, and the services that run the flow. The login methods, the stores and the HTTP layer live in other packages and plug in through these contracts.

Use this page to find which package implements a contract and which packages an app needs.

## How it works

1. A contract is an abstract class (a DI token) or an interface in `@spinajs/authn/contracts`.
2. A package implements it and registers the class with `@Injectable(<Contract>)` when the app imports the package.
3. The core resolves the implementation: by type, by name from config (`authn.strategies`, `authn.mfa.policy.service`, `authn.throttle.service`), or as the list of every registration (`AuthnEventSink`, `ExternalLoginHook`, `MfaEnrolments`).

Three families keep one direction:

| Family | Config root | Answers |
| --- | --- | --- |
| Identity (`@spinajs/users*`) | `users.*` | Who exists: user records, profile, lifecycle |
| Authentication (`@spinajs/authn*`) | `authn.*` | Who is calling and how sure we are |
| Authorization (`@spinajs/authz*`) | `authz.*` | What that caller may do |

No `authn*` package imports `authz*` or `users*`. `@spinajs/authz` imports only the principal types from `@spinajs/authn/contracts`. Anything authn needs from authorization is a hook contract that `@spinajs/users` implements: `ImpersonationGuard`, `CredentialAdminGuard`, `RoleSource` and `AuthnResponseExtension`.

## Entry points

| Import | Holds | Side effects |
| --- | --- | --- |
| `@spinajs/authn` | Everything below, plus the services | Registers `DefaultAuthnService`, `DefaultMfaPolicy`, `MemoryAuthnThrottle`, `LogAuthnAuditSink` and `AuthnConfigBootstrapper` |
| `@spinajs/authn/contracts` | The contracts, `Session`, `SessionKeys`, `isFresh`, `SYSTEM`, `UNATTENDED`, `principalKey`, `ceilingHash`, and the [shared constants and helpers](#shared-constants-and-helpers) | None |
| `@spinajs/authn/schemas` | `AUTHN_CONFIGURATION_SCHEMA` | None |
| `@spinajs/authn/register-schema` | Registers `AUTHN_CONFIGURATION_SCHEMA` at import | For modules that read `authn.*` and may load where the root never does |
| `@spinajs/authn/env` | `authnAppEnv`, `authnEnvFellBack`, `isLenientAuthnEnv`, the throttle param checks | None |
| `@spinajs/authn/mfa-enrolments` | `MfaEnrolments`, `MfaStepNotListed`, `MfaEnrolmentMismatch` | None |
| `@spinajs/authn/store-throttle` | `StoreAuthnThrottle` | None |
| `@spinajs/authn/nonces` | `MemoryNonceStore` | None |
| `@spinajs/authn/audit` | `AuthnAudit`, `AuthnEventBody`, `AuthnAuditor` | None |

A store package imports a subpath, not the root, when it must not register the core services.

### Shared constants and helpers

The satellite packages take these from `@spinajs/authn/contracts` instead of keeping copies:

| Export | What |
| --- | --- |
| `AUTHN_FAILURE_BODY` | The 401 body of every authentication failure: `{ error: { code: 'E_AUTH_FAILED', message }, message }`. The login routes, re-authentication and the OIDC callback answer it. |
| `PASSWORD_HARD_CAP` | 1024. A longer password never verifies; HTTP routes cap credential fields at it. |
| `CLI_ACTOR`, `cliContext()` | The audit actor (`{ type: 'system', id: 'cli' }`) and context of every operator command. |
| `identityThrottleKeys(id, ctx)` | The `account`, `account-ip` and `ip` keys of the `mfa` and `reauth` flows, shared by `AuthnService`, `PasswordService.change` and MFA enrolment. |
| `sameRef(a, b)` | Same type and id. |
| `BackoffParams`, `backoffDelayMs` | Re-exported from `@spinajs/util`. |

## Contracts and their implementations

| Contract | Role | Implemented by | Docs |
| --- | --- | --- | --- |
| `AuthnService`, `PrincipalFactory` | The flow; building a `Principal` | `DefaultAuthnService` (core); `UserPrincipalFactory` (users) | [Flow](01-authentication-flow.md), [Principal](07-principal-and-authz.md) |
| `AuthenticationStrategy` | One login method | `LocalPasswordStrategy`, `TokenStrategy`, `JwtBearerStrategy`, `JwsAssertionStrategy`, `HttpSignatureStrategy`, `KeyChallengeStrategy`, `oidc:<name>` | [Strategies](03-strategies.md) |
| `CredentialExtractor` | Request headers to `Credentials` | `@spinajs/authn-http` | [Integration hooks](12-integration-hooks.md#credentialextractor) |
| `IdentityStore`, `PasswordCredentialStore` | Find an identity, read its status; store its password hash | `UserIdentityStore`, `UserPasswordStore` (users) | [`@spinajs/users`](../users/README.md) |
| `SessionIssuer` | Issue, restore, rotate and revoke sessions | `DefaultSessionIssuer` (authn-session) | [Session contract](08-session-contract.md) |
| `MfaPolicy`, `MfaStep`, `MfaEnrolments` | Which factors a login needs; one factor; stored enrolments | `DefaultMfaPolicy` (core); `TotpMfaStep` (authn-totp); `DbMfaEnrolments` (authn-orm) | [MFA](04-mfa-policy-and-steps.md) |
| `AuthnThrottle` | Backoff per key | `MemoryAuthnThrottle` (core); `DbAuthnThrottle` (authn-orm) | [Throttling](05-throttling.md) |
| `AuthnEventSink` | Receives every authentication event | `LogAuthnAuditSink` (core); `DbAuthnAuditSink` (authn-orm); `QueueAuthnEventSink`, `UserAccountSink` (users); `SseSessionEndSink` (authz-http) | [Audit events](06-audit-events.md) |
| `IdentityLinkStore` | External subjects of an identity | `DbIdentityLinkStore` (authn-orm) | [Account linking](10-account-linking.md) |
| `SecretStore` | Single-use secrets: reset, invite, key challenge | `DbSecretStore` (authn-orm) | [`@spinajs/authn-orm`](../authn-orm/README.md) |
| `NonceStore` | Single-use values until they expire: an OIDC `state` | `MemoryNonceStore` (core, `@spinajs/authn/nonces`, not registered); `DbNonceStore` (authn-orm) | [Nonce store](../authn-orm/04-nonce-store.md) |
| `MfaEnrolmentService` | The owner's enrolment in one MFA step and its admin reset, behind the `/user/mfa` routes | `TotpService` (authn-totp) | [`@spinajs/authn-totp`](../authn-totp/README.md) |
| `PasswordService` | Change, reset, invite, expire a password | `LocalPasswordService` (authn-local) | [`@spinajs/authn-local`](../authn-local/README.md) |
| `TokenService` | API and agent tokens | `DbTokenService` (authn-token) | [`@spinajs/authn-token`](../authn-token/README.md) |
| `KeyRegistry`, `JwsVerifier`, `JwsSigner` | Public keys, strict JWS | `DefaultKeyRegistry` and the verifier (authn-keys) | [`@spinajs/authn-keys`](../authn-keys/README.md) |
| `ImpersonationGuard`, `RoleSource`, `CredentialAdminGuard`, `AuthnResponseExtension` | Authorization questions authn asks | `AuthzImpersonationGuard`, `RbacRoleSource`, `AuthzCredentialAdminGuard`, `AccessResponseExtension` (users) | [Integration hooks](12-integration-hooks.md) |
| `ExternalLoginHook` | Runs after an external login | Your app | [Integration hooks](12-integration-hooks.md#externalloginhook) |

The contract files describe the obligations of each method. Read them before you implement one: for example `SessionIssuer.revoke` resolves `true` only for the call that ended the session.

## Package set per app type

| App type | Packages |
| --- | --- |
| Session web app | `users`, `users-http`, `authn`, `authn-orm`, `authn-session`, `authn-local`, `authn-http`, one `session-provider-*`, and the authz packages. Add `authn-totp` for a second factor and `authn-token` for API tokens |
| SSO app | The session web app set plus `authn-oidc` |
| Machine-only service | `authn`, `authn-orm`, `authn-http`, `authn-keys` or `authn-token`, and the authz packages |

A machine-only service still needs an `IdentityStore`, a `PrincipalFactory` and a `SessionIssuer` registered: `DefaultAuthnService` fails its boot without them, also when only per-request strategies are listed. Import `@spinajs/users` and `@spinajs/authn-session`, or register your own implementations.

**Import `@spinajs/users` in the app entry** when you use it. No authn package depends on it, so nothing imports it for you.

`@spinajs/authn-http` registers a route group only while the matching service is registered. An app that forgets a package has no route for it.

## Important behaviour

- Strategies and MFA steps are found by class name among the registrations of `AuthenticationStrategy` and `MfaStep`, in the container and its ancestors. Registered but unlisted ones never run.
- The core checks strategies, steps and throttles by shape, not by `instanceof`: an implementation built against another copy of the contracts (the CJS and the ESM build) still passes.
- Packages ship no `authn.strategies` and no `authn.mfa.steps` entry. Config arrays concatenate across files, so an entry a package listed could not be removed by the app.

## Related

- [Authentication flow](01-authentication-flow.md): the order in which the contracts are called.
- [Configuration and boot checks](13-configuration-and-boot-checks.md): the keys that name implementations.
- [`@spinajs/authn-testing`](../authn-testing/README.md): fakes for every contract and the conformance suites.
