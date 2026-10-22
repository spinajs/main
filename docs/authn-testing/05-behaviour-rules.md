# Behaviour rules

The kit ships 29 behaviour rules, A01 to A31 (there is no A28 or A29). Each rule is a security or correctness promise of SpinaJS authentication, written as test cases you run with [`runAuthnBehaviour`](04-behaviour-runner.md). Each case belongs to one facet, `<rule>/<kind>`, and lists the ports it needs.

The registry is `AUTHN_RULES` (`ReadonlyMap<RuleId, AuthnRule>`); `RULE_IDS` lists the ids, `FACET_KINDS` the kinds. Case titles start with the rule id. Cases that pin a numbered security requirement carry it in the title, for example `A05 SR-05 parallel burst verifies only free attempts`.

## How it works

1. Pick the rules that touch what you ship, using the table [Which facets to claim](#which-facets-to-claim).
2. Build a harness with the ports those facets need, listed per rule [below](#the-rules).
3. Pass the rule ids to `runAuthnBehaviour` and claim the facets you own.
4. Read the pending summary: every case you cannot serve yet is named there with its missing ports or config.

## Which facets to claim

| You ship | Facets |
| --- | --- |
| An `AuthnService` (the login flow) | `A01/core`, `A02/core`, `A02/external`, `A05/core`, `A06/core`, `A09/core`, `A13/core`, `A19/core`, `A20/core`, `A21/core`, `A23/core`, `A24/boot` |
| A `SessionIssuer` | `A07/store`, `A08/store`, `A09/store` |
| An `AuthnThrottle` | `A05/store`, `A06/store` |
| A `SecretStore` | `A11/store` |
| An `IdentityLinkStore` | `A19/store` |
| The local password strategy and `PasswordService` | `A02/local`, `A03/argon2`, `A04/local`, `A11/local`, `A13/local`, `A30/local` |
| An `MfaStep` | `A10/step`; a TOTP step also `A10/totp` |
| The email code step and strategy | `A36/step`, `A36/local` |
| The authn action hooks (`@spinajs/hooks`) | `A37/core`; with `AccountLinkService` also `A37/flow` |
| A `TokenService` and token strategies | `A14/token`, `A15/token`, `A16/jwt` |
| Key registration, JWS and HTTP signatures | `A17/keys`, `A17/jws`, `A17/core`, `A18/core` |
| The HTTP layer | the `*/http` facets, `A31/config` |
| OIDC login | `A02/external`, `A13/oidc`, `A19/oidc`, `A27/oidc` |
| Identity lifecycle and metadata | `A08/lifecycle`, `A12/identity`, `A12/flow`, `A12/api` |

The repository's `packages/authn-testing/README.md` lists which SpinaJS package claims which facet today.

## The rules

| Rule | What the cases check | Facets | Ports and needs |
| --- | --- | --- | --- |
| A01 credentials go to the listed strategy for their kind | Credentials reach the listed strategy for their kind; an unknown kind fails with `unsupported_credentials`; an unlisted strategy never runs; an unknown service name fails boot | `core` | `boot` |
| A02 every authentication failure answers alike | Every failure answers the same result and HTTP shape; audit keeps the real reason; a throttled answer carries the same Retry-After for known and unknown logins; an unknown login costs a hash (timing) | `core`, `local`, `external`, `http` | `service`, `seed`, `events`, `external`, `http`, route `login` |
| A03 passwords are hashed with argon2id at the library defaults | The stored hash uses the argon2 defaults and the pepper version; a hash under other parameters is rehashed on the next login; at most `maxConcurrent` hashes run; with every slot busy and no queue, concurrent logins answer `throttled` with `retryAfterSeconds` 1 | `argon2` | `seed`, `passwordStore`, `hasher`, `service` |
| A04 passwords are 8 to 128 characters, never trimmed, policy applied whenever set | Bounds on check, set, change, reset and login; no trimming; the policy rule and blocklist apply on every path; a reset violation keeps the secret | `local` | `password`, `seed`, `sessions`, `outbox`, `service`, `hasher`, `passwordStore` |
| A05 attempts are counted atomically per key | A parallel burst verifies only the free attempts; one backoff slot admits one attempt; refused attempts count nothing; per-request strategies count failures only; a spoofed `X-Forwarded-For` is ignored | `store`, `core`, `http` | `throttle`, `service`, `seed`, `spy`, `attributed`, `http` |
| A06 backoff per key, never a lock | The account key follows the schedule; an attacker cannot lock the owner out; a success resets the account key; idle keys start over; flows count apart; MFA counts in the `mfa` flow | `store`, `core` | `throttle`, `fakeDate`, `service`, `seed`, `events`, `spy`, `attributed`, `mfa` |
| A07 session ids are strong, hashed and rotated | Ids have 128 bits or more; stores keep only a hash; a stored hash never works as an id; rotation; cookie flags per env; no planted id survives a login | `store`, `http` | `sessions`, `sessionStorage`, `seed`, `http`, routes `login`, `whoami`, `mfa` |
| A08 sessions end by timeout, logout and revocation | Idle and absolute timeouts; of parallel revokes exactly one reports the end; `revokeAll` with `except`; logout clears the cookie; ban and deactivation revoke every session, impersonations included | `store`, `http`, `lifecycle` | `sessions`, `seed`, `fakeDate`, `http`, routes `login`, `logout`, `whoami`, `lifecycle` |
| A09 a session before MFA is pending and yields no principal | A login with MFA returns a pending session; `completeMfa` elevates to `aal2` and rotates; a pending session expires, is not extended, yields no principal and reaches only the MFA routes | `core`, `store`, `http` | `service`, `seed`, `mfa`, `events`, `sessions`, `fakeDate`, `http`, routes `login`, `whoami`, `mfaVerify`, `mfaEnrol`, `sessionsList`, `impersonateStart` |
| A10 MFA codes are throttled, single use and kept secret | A code works once; recovery codes are single use and voided on regeneration; TOTP secrets are encrypted and recovery codes hashed at rest; codes count into the throttle; enrolment and disabling need fresh auth | `step`, `totp`, `core`, `http` | `mfa`, `mfa.recovery`, `mfaStorage`, `seed`, `fakeDate`, `service`, `sessions`, `http`, routes `login`, `mfaEnrol`, `mfaVerify`, `mfaDisable` |
| A11 single-use secrets are strong, hashed, bound, short-lived and opaque | 128-bit secrets stored as SHA-256, redeemed once, bound to identity and purpose, latest one live, expiring; reset answers alike for unknown logins, counts in the `reset` flow and revokes all sessions | `store`, `local`, `http` | `secrets`, `secretStorage`, `seed`, `fakeDate`, `password`, `outbox`, `service`, `sessions`, `tokens`, `http`, routes `passwordResetRequest`, `passwordReset` |
| A12 authentication state never travels through identity metadata | Reserved metadata keys (`2fa:`, `user:2fa:`, `user:pwd_reset:`, `user:pwd:`, `user:login:`, `user:ban:`, `user:invite:`) cannot be written, read, updated or deleted by owner or admin; login flows write no state into metadata | `api`, `identity`, `flow` | `metadata`, `identityMeta`, `seed`, `service`, `password` |
| A13 sensitive actions need fresh authentication | `reauthenticate` passes with the right password and changes nothing; failures count into the `reauth` flow; password change verifies the old password inline; minting a token needs fresh auth; `POST /auth/reauth` refreshes `authenticatedAt` under a new id and counts wrong passwords; an OIDC re-authentication asks for `prompt=login` and `max_age=0` and refreshes `authenticatedAt` | `core`, `local`, `http`, `oidc` | `service`, `seed`, `sessions`, `password`, `links`, `oidc`, `http`, routes `login`, `reauth`, `tokenCreate`, `tokenList`, `fakeDate` |
| A14 API tokens are strong, bounded, revocable and checked on every use | Prefix and 256 bits; a token without expiry, already expired or beyond `maxTtlDays` is refused; plaintext shown once; owner-bound revoke; expiry; each use checks the owner; `revokeAllFor` includes agent tokens | `token`, `http` | `tokens`, `seed`, `http` |
| A15 agent tokens act for their owner inside a ceiling | An agent token yields an agent identity for its owner; lifetime at most `agentMaxTtlMinutes`; kind and scope must agree | `token`, `core` | `tokens`, `seed`, `service` |
| A16 JWT bearers only from configured issuers and links | A JWT from a configured issuer maps `sub` through its link; bad tokens are refused; `exp` and `nbf` skew; JWKS refresh at most once a minute; unknown subject is `not_linked` with JIT off | `jwt` | `service`, `links`, `seed`, `fakeDate` |
| A17 keys are Ed25519 or P-256 and JWS follows the C8 rules | Only Ed25519 and P-256 keys register; a user's key needs a proof over a register challenge; `kid` is the RFC 7638 thumbprint; JWS error codes; assertions live at most 300 s; `jti` single use; challenges single use and throttled | `keys`, `jws`, `core`, `http` | `keys`, `keyProofs`, `assertion`, `jws`, `seed`, `service`, `throttle`, `fakeDate`, `http`, routes `keyChallenge`, `keyLogin` |
| A18 HTTP signatures cover method, target and digest, once | A signed request authenticates; bad signatures are refused; a nonce is single use | `core` | `service`, `keys`, `keyProofs`, `seed`, `fakeDate` |
| A19 one identity, many links, unique subjects, guarded changes | Many links per identity; `(provider, subject)` unique; linking needs the identity's own fresh session; the last usable credential cannot be unlinked; email matching only with `byVerifiedEmail` | `store`, `core`, `oidc` | `links`, `seed`, `accountLinks`, `service`, `external`, `sessions`, `fakeDate`, `oidc`, `http` |
| A20 impersonation is guarded, rotated, bounded and audited | Start rotates into a session carrying `authn.impersonator`; the guard decides; fresh auth; stop issues a new session; expiry after `maxMinutes`; banning or losing the right ends it | `core`, `http` | `impersonation`, `service`, `sessions`, `seed`, `mfa`, `guard`, `events`, `fakeDate`, `http`, routes `login`, `mfaVerify`, `impersonateStart`, `logout` |
| A21 every event reaches every sink and carries no secret | Every sink gets every event; logins and impersonation are audited; no passwords, secrets or raw session ids; `session` is the listed handle; failed logins log no login string | `core` | `service`, `seed`, `sinks`, `events`, `mfa`, `sessions`, `logs` |
| A22 cookie-authenticated unsafe requests need the app's own origin | Own and listed origins pass; cross-origin, `null`, other port, scheme or host are refused; fetch metadata rules; safe methods and cookie-less requests are exempt; the guard can be turned off | `http` | `http`, `seed`, route `login` |
| A23 a success becomes a principal with authn facts | Results become principals with facts; MFA gives `aal2`; `sessionHandle` is the listed handle; strategy attributes reach `PrincipalFactory`; sessions do not keep them | `core`, `http` | `service`, `seed`, `mfa`, `sessions`, `principals`, `attributed`, `http`, route `login` |
| A24 secrets refuse public or missing values outside development and test | A production boot with strong secrets starts; public or missing secrets fail it; development and test boot; the config check reports each topic | `boot` | `boot` |
| A25 credential admin routes need `users:credentials` and the target guard | Each admin route needs the right; a protected target is refused; a password reset revokes sessions and tokens and returns no secret; an MFA reset returns no secret | `http` | `http`, `actors`, `seed`, `targetGuard`, `tokens`, `outbox`, `secretStorage`, `mfa`, `events`, routes `login`, `adminPasswordReset`, `adminMfaReset`, `adminSessionsRevoke`, `adminTokensRevoke` |
| A26 role switch takes only held roles and rotates | A held role sets `ceiling.roles`; others are refused; the switch rotates the session; a `requirePassword` role needs fresh auth | `http` | `http`, `roles`, `seed`, routes `login`, `activeRoleSet`, `whoami`, `fakeDate` |
| A27 OIDC login is code flow with PKCE and full ID token checks | Code flow with PKCE S256; a linked subject logs in; every tampered ID token fails like a failed login; a replayed state fails; JIT off and on | `oidc` | `oidc`, `http`, `links`, `seed`, route `login` |
| A30 a voluntary change keeps tokens and ends other sessions | A change keeps API and agent tokens, ends other sessions (impersonations included) and rotates the current one; an admin expiry revokes tokens | `local`, `http` | `password`, `sessions`, `tokens`, `seed`, `service`, `http`, routes `login`, `passwordChange` |
| A36 an email code is a second factor and a way to log in | A code is accepted once; five wrong codes void it; it expires after `authn.local.emailCode.ttlSeconds`; enrolment needs a verified address; a password login, challenge and code reach `aal2`; a code login (request, mail, login) is `aal1` with method `email-code` and fails alike for a wrong code, another login and an unknown login; an unknown or unverified login is mailed nothing | `step`, `local` | `mfa`, `seed`, `service`, `password`, `outbox`, `fakeDate` |
| A31 CORS allows only listed origins | An empty list sends no CORS headers; a listed origin is echoed with `Vary: Origin`; origins match exactly; the config check warns on an empty list | `http`, `config` | `http`, `boot` |
| A37 action hooks run around authn actions, narrow them and never widen them | `before` and `after` (or `failed`) run once each, in order, around `authn.login`, `authn.login.identified`, `authn.mfa.verify`, `authn.reauth`, `authn.session.stepUp`, `authn.impersonation.start`, `authn.impersonation.stop`, `authn.link` and `authn.unlink`; a refusal gives the documented answer and audit reason `hook:<code>`; a change to a key that is not mutable does not reach the action; `authn.login` input has no identity; `authn.impersonation.stop` completes when refused | `core`, `flow` | `service`, `seed`, `hooks`, `events`, `spy`, `sessions`, `mfa`, `impersonation`, `guard`, `accountLinks`, `links` |
| A34 step-up raises an active session to aal2 under a new id | `reissue` raises an active session and keeps its data under a new id, and refuses a pending one; a route behind `MfaSatisfied` refuses `aal1` and passes the same cookie jar after `POST /auth/mfa/step-up` | `store`, `http` | `sessions`, `seed`, `mfa`, `http`, routes `login`, `mfaStepUp`, `mfaGated` |

The `needs` of every case are in `src/behaviour/A*.spec.ts` of the package; a harness that lacks one sees the exact list in the pending reason.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Rule definitions | `defineRule`, `defineCase`, `table` | the A01 to A31 rules | none | Build `AuthnRule` and `AuthnCase` values; run them with `executeCase` or `settleCase`, since `runAuthnBehaviour` runs only `AUTHN_RULES` |
| Case helpers | exported from `steps` | `ALICE`, `pw`, `expectFailure`, `send`, … | none | Reuse them in your own tests; see [Test helpers](07-test-helpers.md) |

## Important behaviour

- Timing cases (A02 `SR-04`, the strategy conformance timing case) allow up to 600 s each and can take minutes on a loaded machine.
- Facets with the same kind in different rules are independent: claiming `A07/store` does not claim `A08/store`.
- A case that sets config you cannot apply goes pending even when you have every port. Claimed, it fails.
- Several cases need `fakeDate`. With `fakeDate: false` they go pending.

## Best practices

- Run every rule that names a port you provide, and claim only your facets. The pending list then shows the gaps the other packages own.
- Build the HTTP facets against your real app: the cases compare status codes, headers and bodies, which only the real stack produces.

## Patterns and antipatterns

```ts
// Don't: claim a whole rule when you own only one facet of it; the other facets then fail
runAuthnBehaviour(['A07'], harness, { claim: ['A07'] });

// Do
runAuthnBehaviour(['A07'], harness, { claim: ['A07/store'] });
```

## Examples

### Run the session rules of a session package

```ts sample
import 'mocha';
import { FakeIdentityStore, MemoryPasswordCredentialStore, MemorySessionIssuer, fakeSeedPort, runAuthnBehaviour } from '@spinajs/authn-testing';

runAuthnBehaviour(
  ['A07', 'A08', 'A09'],
  (ctx) => {
    const s = ctx.config.authn?.session;
    const sessions = new MemorySessionIssuer({ idleMinutes: s?.expiration?.ttl, absoluteMinutes: s?.expiration?.maxLifetime, pendingTtlSeconds: s?.pendingTtlSeconds });
    return { sessions, sessionStorage: sessions.storage, seed: fakeSeedPort(new FakeIdentityStore(), new MemoryPasswordCredentialStore()) };
  },
  { title: 'session rules', claim: ['A07/store', 'A08/store', 'A09/store'] },
);
```

The `http`, `core` and `lifecycle` facets of these rules go pending here, each naming its missing ports.

## Related

- [Behaviour runner](04-behaviour-runner.md): how cases run, ports, config and time rules.
- [Conformance suites](03-conformance-suites.md): the store facets as ready-made suites.
- [`@spinajs/authn`](../authn/README.md): the behaviour each rule pins down.
