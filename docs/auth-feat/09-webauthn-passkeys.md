# WebAuthn and Passkeys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WebAuthn security keys as the MFA step `webauthn` (phase 1), then passkeys as a first factor through a `passkey` strategy (phase 2), in a new package `@spinajs/authn-webauthn`.

**Architecture:** `WebAuthnMfaStep` implements the existing `MfaStep` contract on `@simplewebauthn/server` and widens plan 08's optional `MfaStep.challenge?` to `Promise<Readonly<Record<string, unknown>> | void>`, so a step whose client needs the challenge (WebAuthn request options) returns it and `POST /auth/mfa/challenge` passes it through. Challenges are single-use `SecretStore` secrets bound to the identity (or, for passkey logins, to a random login id carried inside the challenge). Credentials live in `authn_webauthn_credential` and `authn_webauthn_user` (authn-orm, like `authn_mfa`), behind a `WebAuthnCredentialStore` contract with a memory store for tests and a `/db` entry for apps, mirroring authn-totp. `WebAuthnService` is the owner side (register, list, rename, remove, admin reset); the 3.0 HTTP layer gets `{ Challenge }` from `POST /auth/mfa/challenge`, a `response` field on `POST /auth/mfa/verify`, the `/user/mfa/webauthn` routes and, in phase 2, `POST /auth/passkey/options` and `{ passkey }` on `POST /auth/login`.

**Tech Stack:** TypeScript (node16 ESM and CommonJS builds), `@simplewebauthn/server` 14.0.3 (pinned), `@spinajs/di`, `@spinajs/configuration` (`@Config` plus AJV schema), `@spinajs/authn-orm` (sqlite, postgres), mocha through `ts-mocha`, a node:crypto software authenticator in `@spinajs/authn-testing`.

## Global Constraints

- Code comments, identifiers and commit messages are in English. Comment only what the code cannot say.
- Work on branch `authz-v3-refactor`, one commit per task, and run the package suites before each commit.
- Every test command runs from the package directory: `npx ts-mocha -p tsconfig.json <file>`. A package's full suite is `npm test`.
- A package that consumes a changed package reads it from `lib/`. Rebuild before testing dependants: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json` in the changed package.
- Working-copy files use CRLF. Keep them CRLF (new files too: run `unix2dos <file>` after creating one).
- A value check goes into the module's JSON schema; defaults go into the schema (`default`, applied by `useDefaults`). Code keeps only checks a schema cannot make (DI lookups, compiling, cross-domain merges, here: origins against the app env and rpId).
- Never add a schema default that changes an effective access or security value (`.superpowers/sdd/mechanism-notes.md`). Every `authn.webauthn.*` key is new.
- Secrets are secret references, never inline values (this plan adds no secret).
- Each new behaviour rule gets a row in `packages/authn-testing`, continuing the A-series (last existing: A32). Rule ids are assigned centrally in `docs/auth-feat/README.md`; this plan takes **A40**.
- Message IDs come from the range `1007000–1007999` (info) and `4007000–4007999` (user errors) only, added the way plan 03 prescribes ("How a consumer plan adds messages"); an ID is never reused with another meaning.
- Audit event types added: `webauthn.register`, `webauthn.remove`. Use is `mfa.verify` (second factor) or `login` (passkey).
- HTTP work targets the 3.0 layer (`packages/authn-http/src/v3`), never the 2.x controllers.
- Commit only your own hunks: build the index from HEAD plus your change and check `git diff --cached` before each commit (other agents work in this tree).

---

## Current state

- `MfaStep` (`packages/authn/src/contracts/mfa.ts:6-25`) has `enrolled`, `beginEnrolment`, `confirmEnrolment`, `verify`, `verifyRecovery?`, `regenerateRecoveryCodes?`, `disable`. Nothing issues a per-attempt server challenge, which a WebAuthn assertion needs.
- `TotpMfaStep` (`packages/authn-totp`) is the only step. It resolves its store from DI on first use, takes test `deps`, ships a `/db` entry that registers a DB adapter over authn-orm's `DbMfaStore`, and `TotpService` is the owner side with result objects, fresh auth, the pending-session enrolment rule and audit through the sinks.
- The 3.0 HTTP layer has `POST /auth/mfa/verify` and `/auth/mfa/recovery` (`AuthnMfaController`), the login route takes passwords only, and the `/user/mfa/*` enrolment routes are not built (TODO(N8b), `docs/authn/README.md:368-374`). The design lists `GET/POST /user/mfa`, `/user/mfa/confirm`, `/user/mfa/disable`, `/user/mfa/recovery-codes` (`docs/plans/2026-10-01-authz-v3-design.md:3976`).
- Plans 03 (message IDs) and 08 (email code) are written but not landed: `packages/authn/src/messages/` does not exist yet. Plan 03 is a prerequisite of this plan (README: 09 depends on 03); Task 6 checks it.
- Plan 08 adds `MfaStep.challenge?(id: IdentityRef): Promise<void>` ("issues and sends one", counted in the `code` throttle flow), `AuthnService.challengeMfa?` answering `{ status: 'sent' | 'throttled' | 'refused' }`, `POST /auth/mfa/challenge`, and `loginCredentialsOf(req, passwordCap)` in `packages/authn-http/src/v3/routes.ts` (`docs/auth-feat/08-passwordless-email-code.md:147-149`, `:388-414`, `:2396-2405`). Its type is pinned: `same<MfaStep['challenge'], ((id: IdentityRef) => Promise<void>) | undefined>` (`:260`).

## Facts verified (2026-10-06)

- `MfaStep.verify(id, response: string)` (`packages/authn/src/contracts/mfa.ts:15`); `completeMfa` passes the client's string unchanged (`packages/authn/src/service/default-authn-service.ts:250-307`, `passMfa` at `:469-483`). A step that throws is audited as `mfa.verify` failure `step_error` with `data.error` = the error's `name` and answers `invalid_credentials` (`:265-271`, `errorClass` at `:97`). A strategy that throws is audited `strategy_error` (`:379-393`).
- `@spinajs/exceptions` `Exception` never sets `name` (`packages/exceptions/src/index.ts:4-14`), so an error class must set `this.name` for the audit to show it.
- The core hardcodes `assurance: 'aal1'` at login (`default-authn-service.ts:418`); `checkOutcome` validates outcomes (`:101-111`); `DefaultMfaPolicy` requires steps for `method === 'password'` only (`packages/authn/src/flow/default-mfa-policy.ts:55`), so a passkey login gets no MFA step.
- Throttle keys: the service rewrites a strategy's `account` key to `login:<value>`, adds `account-ip` and `ip` (`default-authn-service.ts:533-555`). `MemoryAuthnThrottle.succeed` gives back to the ip key only the attempts of `account-ip` runs (`packages/authn/src/throttle/memory-throttle.ts:160-190`), so a strategy with no account key never gives its successes back to the ip.
- `reauthenticate` takes any interactive strategy whose verified identity is the session's (`default-authn-service.ts:323`, `:486-490`), so a passkey works as an inline re-authentication once listed.
- `Credentials` (`packages/authn/src/contracts/credentials.ts:5-16`) ends with a catch-all member; `StrategyOutcome` (`:76-93`) has no assurance. Both shapes are pinned by `packages/authn/test/contracts/credentials.test.ts:46` and `:196`; `MfaStep` members by `packages/authn/test/contracts/mfa.test.ts:199-219`; `AuthnEventType` by `packages/authn/test/contracts/audit.test.ts:23`, `:155`, `:189`.
- `SecretStore.issue/redeem` (`packages/authn/src/contracts/secrets.ts:4-9`): `DbSecretStore` issues 32 random bytes as base64url, deletes the older secret of the same identity and purpose, purges spent rows now and then (`packages/authn-orm/src/secrets/db-secret-store.ts:41-58`); `purpose` is `varchar(32)` (`packages/authn-orm/src/migrations/AuthnInitial_2026_10_02_00_00_00.ts:55`). The kit's `MemorySecretStore` does the same (`packages/authn-testing/src/fakes/secrets.ts:17-44`).
- `NonceStore.claim(key, expiresAt, now)` (`packages/authn-orm/src/nonces/nonce-store.ts:24-29`) and authn-keys' `KeyNonceStore` (`packages/authn-keys/src/nonce/store.ts:8-11`) only claim client-chosen values; they cannot hold a challenge the server issued. Key challenges use `SecretStore` with a per-challenge purpose `key-challenge:<rid>` and redeem only after the signature holds (`packages/authn-keys/src/challenge/challenge.ts:10-24`, `packages/authn-keys/src/strategies/challenge.ts:59-64`).
- `FreshAuthCheck.check` (`packages/authn/src/freshauth/fresh-auth-check.ts:42-49`); `TotpService` checks freshness itself with an optional `reauth` credential, lets a pending session enrol only while enrolled in no step, and publishes to the sinks (`packages/authn-totp/src/service/totp-service.ts:202-254`). `TotpService.disable` removes the last factor even under `force` (`:136-165`).
- `AccountLinkService` refuses removing the last credential, counting a password, other links and usable keys (`packages/authn/src/link/account-link-service.ts:137`, `:162-168`); it knows no MFA rule and no WebAuthn credential.
- `TotpMfaStep`: `@Injectable(MfaStep)`, `deps` with DI fallback, store missing names the `/db` import (`packages/authn-totp/src/step/totp-step.ts:21-26`, `:39-54`, `:201-215`); the `/db` entry (`packages/authn-totp/src/db.ts:1`, `src/store/db.ts:12-24`, `package.json` `exports["./db"]`).
- Env leniency: `authnAppEnv` and `isLenientAuthnEnv` (`packages/authn/src/service/boot/env.ts:27-35`), exported as `@spinajs/authn/env` (`packages/authn/package.json` `exports["./env"]`), used by authn-session (`packages/authn-session/src/cookie.ts:2`, `:53-57`). A missing app env counts as production.
- A sub-module schema with `$configurationModule: 'authn.webauthn'` validates `config.get('authn.webauthn')`; an unconfigured module gets defaults only when `{}` validates (`packages/configuration/src/configuration.ts:418-445`); example `AUTHZ_HTTP_CONFIGURATION_SCHEMA` and its bootstrapper (`packages/authz-http/src/http-config.ts:43-83`). The `authn` root schema does not close its property names (`packages/authn/src/schemas/authn.configuration.ts:83-88`).
- `AuthnMfaController` caps `code` at `PASSWORD_HARD_CAP` = 1024 (`packages/authn-http/src/v3/controllers/AuthnMfaController.ts:51`, `packages/authn-http/src/policies/v3/fresh-auth.ts:17`). `AuthnLoginController` builds password credentials only (`AuthnLoginController.ts:44-49`). `PendingMfaEnrolment` (`packages/authn-http/src/policies/v3/mfa.ts:50-70`); group 404 policies (`packages/authn-http/src/policies/v3/groups.ts:9-38`); `passwordCredentials` is module-private (`fresh-auth.ts:20`). The v3 test app boots with no app env (`packages/authn-http/test/v3-app/app.ts:164-170`), lists `ACCOUNT_ROUTES_V3` (`test/v3-app/suites/route-table.ts:26-40`), and its `Client` sends only GET, POST and DELETE (`app.ts:227-262`).
- The ORM's `Migration.down(name)` plans only the named migration (`packages/orm/src/migration-runner.ts:240`), so `test/migration.test.ts` of authn-orm is unaffected by a new migration.
- The A-series registry: `RULE_IDS`, `FACET_KINDS`, `portNames` (`packages/authn-testing/src/behaviour/types.ts:8-55`), `ALL` (`behaviour/index.ts:40`), pinned by `packages/authn-testing/test/registry.test.ts:7`, `:48-50`.
- Plan 03's consumer API (`docs/auth-feat/03-message-ids.md:113-118`): a part `packages/authn/src/messages/<topic>.ts` exporting `<TOPIC>_MESSAGES = { ... } as const satisfies Readonly<Record<string, AuthnMessageDefinition>>`, added to `PARTS` and `DEFINITIONS` in `catalogue.ts` (`:456-459`), rows in `PINNED` and the range test (`:226-233`) of `test/messages/catalogue.test.ts`, docs regenerated with `UPDATE_GOLDEN=1`. HTTP helpers `errorBody(code, message)`, `refused(code, message)`, `notFound(code, message)` add `messages` (`:825-852`); `authnMessage(code)` builds one message.
- `@simplewebauthn/server` 14.0.3 (npm, 2026-10-06): `engines.node >=20.0.0`; repo packages declare `>=16.11`, the runtime is Node 24.14.1. `generateRegistrationOptions` UTF-8-encodes a string challenge and base64url-encodes a `Uint8Array` one, mutates `authenticatorSelection`, always adds `credProps`; `verifyAuthenticationResponse` refuses a non-rising counter **before** it checks the signature, returns `verified: false` for a bad signature and throws for everything else; `expectedChallenge` may be a function.
- WebAuthn Level 3 caps a credential id at 1023 bytes, 1364 base64url characters: too long for a portable unique index (MySQL InnoDB 3072 bytes, SQL Server 1700 bytes), so the unique index goes on a SHA-256 of the id.
- The design note "No WebAuthn/passkeys … in 3.0" (`docs/plans/2026-10-01-authz-v3-design.md:383`) is superseded by `docs/auth-feat/README.md` (plan 09).

## Decisions (confirm before Task 1)

1. **One `MfaStep.challenge?`, widened.** Plan 08 declares `challenge?(id: IdentityRef): Promise<void>` for steps that send a code. WebAuthn needs the request options back, which `void` cannot carry, so the shared signature is `challenge?(id: IdentityRef): Promise<Readonly<Record<string, unknown>> | void>`: `email-code` returns nothing, `webauthn` returns its options. Whichever of 08 and 09 lands second widens (09 second) or keeps (08 second) this signature, and `AuthnService.challengeMfa` and `POST /auth/mfa/challenge` must pass a returned object through: `MfaChallengeResult` `sent` gains `challenge?`, the route answers `{ Challenge }`. Task 6 and Task 10 give the exact code for both orders. Under plan 08 a WebAuthn challenge counts in the `code` throttle flow (account: 3 free, then 60 s doubling): only a user who asks for many prompts in a row waits. `WebAuthnMfaStep.challenge` returns `assertionOptions(id)`, the typed form the package's own code uses.
2. **Challenges on `SecretStore`.** Registration (`webauthn-register`, `webauthn-passkey`) and MFA (`webauthn-mfa`) challenges are 32-byte secrets bound to the identity, one live per purpose: a new one voids the unanswered one. The bytes of the secret are the challenge, so `clientDataJSON.challenge` is the secret itself. Passkey login challenges are `<rid>.<secret>` (UTF-8) under purpose `passkey:<rid>` and identity `webauthn:passkey-login`, so parallel logins never void each other. No pre-session cookie: the challenge is single use, short-lived and useless without the authenticator, and WebAuthn origin binding already stops relaying.
3. **Order of checks.** Signature, origin and rp id first (the library, with counter 0), then the challenge is redeemed, then the counter is compared. A wrong signature burns no challenge; an unsigned or replayed counter never counts as a clone.
4. **Clone detection.** A signed counter at or below the stored one, while either is non-zero (WebAuthn §6.1.1), throws `WebAuthnSignCountRegression`. The core audits it (`step_error` / `strategy_error`, `data.error`) and answers the one failure. The credential stays usable: disabling it would let anyone who replays an old signed answer with a fresh challenge lock the owner out, and the real owner can remove it. Counters that stay 0 (synced passkeys) are accepted.
5. **Storage.** Tables `authn_webauthn_credential` and `authn_webauthn_user` in authn-orm with `DbWebAuthnStore` (as `authn_mfa` / `DbMfaStore`); authn-webauthn owns the `WebAuthnCredentialStore` contract, `MemoryWebAuthnCredentialStore`, and `DbWebAuthnCredentialStore` in its `/db` entry (as `DbMfaSecretStore`). Unique index on `credential_hash` (SHA-256 hex of the id); the public key is stored as base64url COSE text (portable, and public). Every app that installs authn-orm gets the two empty tables, as it gets `authn_mfa`.
6. **User handle.** A random 32-byte handle per identity in `authn_webauthn_user`, created on the first registration options, kept when credentials are removed, never the user uuid (an authenticator shows it to anyone holding the device).
7. **Passkey and second-factor credentials share one table** with a `passkey` flag set by the ceremony (`residentKey: 'required'`, `userVerification: 'required'`, client-reported `credProps.rk` not `false`). Every credential answers the MFA step; only passkeys log in alone. Phase 1 already registers passkeys at the service level (the code is the same ceremony); phase 2 adds the login and exposes `passkey: true` over HTTP.
8. **Assurance.** A passkey login is `aal1` by default (Kratos parity; `aal2` means "passed a second step" to existing policies). `authn.webauthn.passkey.assurance: 'aal2'` treats a user-verified passkey as a multi-factor cryptographic authenticator (NIST SP 800-63B), through the new optional `StrategyOutcome.assurance`, honoured for interactive strategies only.
9. **User verification.** MFA: `authn.webauthn.mfa.userVerification` (default `preferred`). Passkeys: always `required`, not configurable.
10. **Attestation.** Only `none` (schema enum). The package keeps no trust anchors; `direct` would verify nothing useful.
11. **No recovery codes from WebAuthn.** The recovery-code table is per identity, not per step, so issuing a set here would void TOTP's. Users register several keys; an admin reset (`authn:webauthn-reset`) covers the rest.
12. **Removal rules.** Removing the last passkey of an identity with no password and no external link answers `last_credential` (keys are not counted: fails closed). Under `authn.mfa.policy.force: true`, removing the last WebAuthn credential of an identity enrolled in no other step answers `last_factor`; `forceForRoles` is not checked (as `TotpService.disable`, the next login forces enrolment).
13. **Throttle.** Ceremony confirmations count into no throttle (nothing to guess). A passkey login counts in flow `login` under `account = passkey:<sha256(credential id)>` plus the ip, so a success gives its attempt back to the ip. `POST /auth/passkey/options` counts nothing: a success never gives an options request back to the ip, so counting it would push every busy NAT into backoff; one `authn_secret` row per call is bounded by its TTL and the store's purge.
14. **Routes.** `/user/mfa/webauthn` (`GET`, `POST options`, `POST`, `PATCH /:id`, `DELETE /:id`) under the design's `/user/mfa` namespace; N8b's generic `/user/mfa/*` stays for code steps. `POST /auth/mfa/challenge` `{ step: 'webauthn' }` (pending session, shared with plan 08); `POST /auth/passkey/options`; `POST /auth/login` with `{ passkey }`. The credential routes answer 404 unless the step `webauthn` or the strategy `passkey` is listed; passkey options unless the strategy `passkey` is listed.
15. **Messages.** `packages/authn/src/messages/webauthn.ts` exports `WEBAUTHN_MESSAGES` in plan 03's catalogue (Task 6), codes prefixed `webauthn_` so no part collides. Bodies follow plan 03: refusals through `errorBody`, `refused`, `notFound` (`{ error, message, messages }`); successes carry `messages: [authnMessage(...)]`.
16. **Library pin.** `@simplewebauthn/server` exactly `14.0.3`; the package declares `engines.node >=20`. COSE algorithms pinned to EdDSA, ES256, RS256 (`-8, -7, -257`) so the set does not follow the runtime's PQC support.

## Security notes

- Origins are an exact allow-list; https is required unless the app env is development or test (`isLenientAuthnEnv(authnAppEnv(config))`, a missing env counts as production); every origin must sit on `rpId` or below it.
- Challenges: 256-bit, single use, TTL `authn.webauthn.timeoutSeconds` (30–600 s, default 120), bound to the identity and the ceremony (purpose), redeemed only after a valid signature.
- Enumeration: the passkey options route takes no identity; a passkey answer for an unknown credential is verified against a dummy key, so it costs what a known one costs (A02); every login failure answers the one A02 body.
- Clone detection is audited, never silent (Decision 4). Events carry no credential id, public key, challenge or assertion.
- `excludeCredentials` and `allowCredentials` go only to the session that owns them.
- A pending (pre-MFA) session may register only a second-factor key and only while enrolled in no step (A09), as TOTP. Options and removal need fresh auth (A13).
- Known limit: `AccountLinkService` does not count passkeys, so unlinking the last OIDC link of a passkey-only user is refused (fails closed).

## File structure

| File | Responsibility |
|---|---|
| `packages/authn-testing/src/helpers/webauthn.ts` | `SoftAuthenticator` (P-256, none attestation) and a minimal CBOR writer |
| `packages/authn-testing/src/behaviour/A40-webauthn.spec.ts` | Rule A40 |
| `packages/authn-testing/src/harness/ports.ts`, `src/behaviour/types.ts`, `src/behaviour/index.ts` | Ports `webauthn`, `passkey`; rule and facet registration |
| `packages/authn/src/contracts/mfa.ts` (and, with plan 08, `service.ts`, `default-authn-service.ts`) | widened `MfaStep.challenge?`, pass-through in `challengeMfa` |
| `packages/authn/src/contracts/audit.ts` | `webauthn.register`, `webauthn.remove` |
| `packages/authn/src/messages/webauthn.ts`, `catalogue.ts` | `WEBAUTHN_MESSAGES` in plan 03's catalogue |
| `packages/authn/src/contracts/credentials.ts`, `src/service/default-authn-service.ts` | Phase 2: `passkey` credentials, `StrategyOutcome.assurance` |
| `packages/authn-orm/src/migrations/AuthnWebAuthn_2026_10_06_00_00_00.ts` | The two tables |
| `packages/authn-orm/src/webauthn/db-webauthn-store.ts` | `DbWebAuthnStore` |
| `packages/authn-webauthn/src/ceremony.ts` | Purposes, algorithms, challenge bytes, response parsing |
| `packages/authn-webauthn/src/assertion.ts` | `checkAssertion`, `counterRegressed` |
| `packages/authn-webauthn/src/config/*` | Schema, options resolver, bootstrapper, shipped config |
| `packages/authn-webauthn/src/store/*` | Contract, memory store, `/db` adapter |
| `packages/authn-webauthn/src/step/*` | `WebAuthnMfaStep`, errors |
| `packages/authn-webauthn/src/service/webauthn-service.ts` | Owner side |
| `packages/authn-webauthn/src/strategy/passkey-strategy.ts` | Phase 2 strategy and login options |
| `packages/authn-webauthn/src/cli/*` | `authn:webauthn-reset` |
| `packages/authn-http/src/v3/controllers/AuthnMfaController.ts` | `response` field on verify; `{ Challenge }` from `POST /auth/mfa/challenge` |
| `packages/authn-http/src/v3/controllers/AuthnWebAuthnLoginController.ts` | phase 2 `POST /auth/passkey/options` |
| `packages/authn-http/src/v3/controllers/AuthnWebAuthnController.ts` | `/user/mfa/webauthn` |
| `packages/authn-http/src/v3/routes.ts`, `AuthnLoginController.ts` | Phase 2: `{ passkey }` login credentials |
| `packages/authn-http/src/policies/v3/groups.ts` | `WebAuthnRoutesOn`, `PasskeyRoutesOn` |

## Task order

```
Phase 1: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10 -> 11 -> 12
Phase 2: 13 -> 14 -> 15 -> 16
```

Prerequisite: plan 03 has landed (Task 6 checks it). Plan 08 is not required; Tasks 6, 10 and 15 give the code for both orders. Tasks 1, 6 and 13 change shared packages (authn-testing, authn); rebuild them and run their dependants one at a time. Task 5 and Task 6 touch disjoint packages and may swap.

---

## Phase 1: WebAuthn as a second factor

### Task 1: A software WebAuthn authenticator in the kit

**Files:**
- Create: `packages/authn-testing/src/helpers/webauthn.ts`
- Modify: `packages/authn-testing/src/helpers/index.ts` (append one export)
- Test: `packages/authn-testing/test/helpers/webauthn.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (from `@spinajs/authn-testing`): `type CborValue`, `cborEncode(v: CborValue): Buffer`, `interface SoftAuthenticatorOptions { origin: string; rpId?: string; counter?: 'counting' | 'zero'; uv?: boolean; synced?: boolean; attachment?: 'platform' | 'cross-platform' }`, `interface SoftOverrides { origin?; rpId?; type?; uv?; up?; counter?: number; userHandle?: string | null; rk?: boolean; badSignature?: boolean }`, `interface SoftCreationOptions { challenge: string; rp?: { id?: string }; user: { id: string } }`, `interface SoftRequestOptions { challenge: string; rpId?: string }`, `interface SoftRegistrationResponse`, `interface SoftAuthenticationResponse`, `class SoftAuthenticator { credentialId: string; publicKey: KeyObject; publicKeyCose: Buffer; counter: number; create(options, over?): SoftRegistrationResponse; get(options, over?): SoftAuthenticationResponse }`. The response shapes are structurally `RegistrationResponseJSON` / `AuthenticationResponseJSON` of `@simplewebauthn/server`; the kit does not depend on it.

- [ ] **Step 1: Write the failing test**

Create `packages/authn-testing/test/helpers/webauthn.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';
import { createHash, verify } from 'node:crypto';

import { SoftAuthenticator, cborEncode } from '../../src/helpers/webauthn.js';
import type { CborValue } from '../../src/helpers/webauthn.js';

const ORIGIN = 'https://app.example.test';
const RP_ID = 'app.example.test';
const CHALLENGE = Buffer.alloc(32, 9).toString('base64url');
const USER = Buffer.alloc(32, 3).toString('base64url');
const sha256 = (b: Uint8Array | string): Buffer => createHash('sha256').update(b).digest();
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const counterOf = (authData: string): number => Buffer.from(authData, 'base64url').readUInt32BE(33);

describe('kit SoftAuthenticator', () => {
  it('cborEncode writes the RFC 8949 forms an authenticator needs', () => {
    assert.strictEqual(hex(cborEncode(0)), '00');
    assert.strictEqual(hex(cborEncode(23)), '17');
    assert.strictEqual(hex(cborEncode(24)), '1818');
    assert.strictEqual(hex(cborEncode(256)), '190100');
    assert.strictEqual(hex(cborEncode(-1)), '20');
    assert.strictEqual(hex(cborEncode(-7)), '26');
    assert.strictEqual(hex(cborEncode(-257)), '390100');
    assert.strictEqual(hex(cborEncode('fmt')), '63666d74');
    assert.strictEqual(hex(cborEncode(new Uint8Array([1, 2]))), '420102');
    assert.strictEqual(hex(cborEncode(new Map([[1, 2]]))), 'a10102');
    assert.throws(() => cborEncode(1.5), RangeError);
  });

  it('create answers a none attestation over sha256(rpId), UP|UV|AT, counter 0 and an ES256 COSE key', () => {
    const device = new SoftAuthenticator({ origin: ORIGIN });
    const r = device.create({ challenge: CHALLENGE, rp: { id: RP_ID }, user: { id: USER } });
    const id = Buffer.from(device.credentialId, 'base64url');
    const authData = Buffer.concat([sha256(RP_ID), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, id.length]), id, device.publicKeyCose]);
    const expected = cborEncode(new Map<string, CborValue>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    assert.strictEqual(r.response.attestationObject, expected.toString('base64url'));
    assert.deepStrictEqual(JSON.parse(Buffer.from(r.response.clientDataJSON, 'base64url').toString('utf8')), { type: 'webauthn.create', challenge: CHALLENGE, origin: ORIGIN, crossOrigin: false });
    assert.strictEqual(r.id, device.credentialId);
    assert.strictEqual(r.rawId, device.credentialId);
    assert.deepStrictEqual(r.clientExtensionResults, { credProps: { rk: true } });
  });

  it('get signs authenticatorData || sha256(clientDataJSON) with the credential key and counts up', () => {
    const device = new SoftAuthenticator({ origin: ORIGIN });
    device.create({ challenge: CHALLENGE, rp: { id: RP_ID }, user: { id: USER } });
    const a = device.get({ challenge: CHALLENGE, rpId: RP_ID });
    const authData = Buffer.from(a.response.authenticatorData, 'base64url');
    assert.strictEqual(hex(authData), hex(Buffer.concat([sha256(RP_ID), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])])));
    const signed = Buffer.concat([authData, sha256(Buffer.from(a.response.clientDataJSON, 'base64url'))]);
    assert.ok(verify('sha256', signed, device.publicKey, Buffer.from(a.response.signature, 'base64url')));
    assert.strictEqual(a.response.userHandle, USER);
    device.get({ challenge: CHALLENGE, rpId: RP_ID });
    assert.strictEqual(device.counter, 2);
  });

  it('signs a zero or a forced counter, drops UV or the user handle, and spoils the signature on request', () => {
    const device = new SoftAuthenticator({ origin: ORIGIN, rpId: RP_ID, counter: 'zero' });
    device.create({ challenge: CHALLENGE, user: { id: USER } });
    assert.strictEqual(counterOf(device.get({ challenge: CHALLENGE }).response.authenticatorData), 0);
    assert.strictEqual(counterOf(device.get({ challenge: CHALLENGE }, { counter: 7 }).response.authenticatorData), 7);
    assert.strictEqual(Buffer.from(device.get({ challenge: CHALLENGE }, { uv: false }).response.authenticatorData, 'base64url')[32], 0x01);
    assert.strictEqual(device.get({ challenge: CHALLENGE }, { userHandle: null }).response.userHandle, undefined);
    const bad = device.get({ challenge: CHALLENGE }, { badSignature: true });
    const signed = Buffer.concat([Buffer.from(bad.response.authenticatorData, 'base64url'), sha256(Buffer.from(bad.response.clientDataJSON, 'base64url'))]);
    assert.strictEqual(verify('sha256', signed, device.publicKey, Buffer.from(bad.response.signature, 'base64url')), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authn-testing && npx ts-mocha -p tsconfig.json test/helpers/webauthn.test.ts`
Expected: FAIL, `Cannot find module '../../src/helpers/webauthn.js'`.

- [ ] **Step 3: Implement**

Create `packages/authn-testing/src/helpers/webauthn.ts`:

```ts
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/** What the kit's CBOR writer covers: integers, byte and text strings, maps. Enough for attestation objects and COSE keys. */
export type CborValue = number | string | Uint8Array | ReadonlyMap<number | string, CborValue>;

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

/** RFC 8949, map entries in insertion order. */
export function cborEncode(v: CborValue): Buffer {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v > 0xffffffff || v < -0x100000000) throw new RangeError('cborEncode: 32-bit integers only');
    return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  }
  if (typeof v === 'string') {
    const bytes = Buffer.from(v, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([cborHead(2, v.length), Buffer.from(v)]);
  const parts: Buffer[] = [cborHead(5, v.size)];
  for (const [key, value] of v) parts.push(cborEncode(key), cborEncode(value));
  return Buffer.concat(parts);
}

const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;

export interface SoftAuthenticatorOptions {
  readonly origin: string;
  /** Default: the rp id of the options. */
  readonly rpId?: string;
  /** 'counting' (default) signs 1, 2, 3…; 'zero' always signs 0, as synced passkeys do. */
  readonly counter?: 'counting' | 'zero';
  /** User verification performed; default true. */
  readonly uv?: boolean;
  /** Backup eligible and backed up; default false. */
  readonly synced?: boolean;
  readonly attachment?: 'platform' | 'cross-platform';
}

export interface SoftOverrides {
  readonly origin?: string;
  readonly rpId?: string;
  readonly type?: string;
  readonly uv?: boolean;
  readonly up?: boolean;
  /** Assertion: sign this counter instead of the next one; the device's own count stays. */
  readonly counter?: number;
  /** Assertion: the userHandle to send, null for none; default the user id seen by `create`. */
  readonly userHandle?: string | null;
  /** Registration: the credProps.rk the client reports; default true. */
  readonly rk?: boolean;
  readonly badSignature?: boolean;
}

export interface SoftCreationOptions {
  readonly challenge: string;
  readonly rp?: { readonly id?: string };
  readonly user: { readonly id: string };
}

export interface SoftRequestOptions {
  readonly challenge: string;
  readonly rpId?: string;
}

export interface SoftRegistrationResponse {
  id: string;
  rawId: string;
  type: 'public-key';
  authenticatorAttachment: 'platform' | 'cross-platform';
  response: { clientDataJSON: string; attestationObject: string; transports: string[] };
  clientExtensionResults: { credProps?: { rk?: boolean } };
}

export interface SoftAuthenticationResponse {
  id: string;
  rawId: string;
  type: 'public-key';
  authenticatorAttachment: 'platform' | 'cross-platform';
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
  clientExtensionResults: { credProps?: { rk?: boolean } };
}

/** One ES256 credential with none attestation, for ceremony tests; it checks nothing a browser would. */
export class SoftAuthenticator {
  readonly credentialId: string;
  readonly publicKey: KeyObject;
  private readonly privateKey: KeyObject;
  private readonly cose: Buffer;
  private count = 0;
  private userHandle: string | undefined;

  constructor(private readonly opts: SoftAuthenticatorOptions) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    const jwk = pair.publicKey.export({ format: 'jwk' });
    this.cose = cborEncode(
      new Map<number, CborValue>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x as string, 'base64url')],
        [-3, Buffer.from(jwk.y as string, 'base64url')],
      ]),
    );
    this.credentialId = randomBytes(32).toString('base64url');
  }

  get publicKeyCose(): Buffer {
    return Buffer.from(this.cose);
  }

  /** The counter of the last assertion signed without a forced value. */
  get counter(): number {
    return this.count;
  }

  create(options: SoftCreationOptions, over: SoftOverrides = {}): SoftRegistrationResponse {
    this.userHandle = options.user.id;
    const id = Buffer.from(this.credentialId, 'base64url');
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(id.length);
    const authData = Buffer.concat([this.head(this.rpIdOf(over, options.rp?.id), over, AT, 0), Buffer.alloc(16), idLength, id, this.cose]);
    const attestationObject = cborEncode(
      new Map<string, CborValue>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      authenticatorAttachment: this.opts.attachment ?? 'platform',
      response: { clientDataJSON: this.clientData('webauthn.create', options.challenge, over), attestationObject: attestationObject.toString('base64url'), transports: ['internal'] },
      clientExtensionResults: { credProps: { rk: over.rk ?? true } },
    };
  }

  get(options: SoftRequestOptions, over: SoftOverrides = {}): SoftAuthenticationResponse {
    let counter = over.counter;
    if (counter === undefined) {
      counter = this.opts.counter === 'zero' ? 0 : this.count + 1;
      this.count = counter;
    }
    const authData = this.head(this.rpIdOf(over, options.rpId), over, 0, counter);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, over);
    const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest()]), this.privateKey);
    if (over.badSignature) signature[signature.length - 1] ^= 0x01;
    const userHandle = over.userHandle === undefined ? this.userHandle : (over.userHandle ?? undefined);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      authenticatorAttachment: this.opts.attachment ?? 'platform',
      response: { clientDataJSON, authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url'), ...(userHandle ? { userHandle } : {}) },
      clientExtensionResults: {},
    };
  }

  private rpIdOf(over: SoftOverrides, fromOptions: string | undefined): string {
    const rpId = over.rpId ?? this.opts.rpId ?? fromOptions;
    if (!rpId) throw new Error('SoftAuthenticator: no rp id in the options or the authenticator');
    return rpId;
  }

  private head(rpId: string, over: SoftOverrides, extra: number, counter: number): Buffer {
    const flags = ((over.up ?? true) ? UP : 0) | ((over.uv ?? this.opts.uv ?? true) ? UV : 0) | (this.opts.synced ? BE | BS : 0) | extra;
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    return Buffer.concat([createHash('sha256').update(rpId, 'utf8').digest(), Buffer.from([flags]), c]);
  }

  private clientData(type: string, challenge: string, over: SoftOverrides): string {
    return Buffer.from(JSON.stringify({ type: over.type ?? type, challenge, origin: over.origin ?? this.opts.origin, crossOrigin: false }), 'utf8').toString('base64url');
  }
}
```

Append to `packages/authn-testing/src/helpers/index.ts`:

```ts
export * from './webauthn.js';
```

- [ ] **Step 4: Run test to verify it passes, then the suite, then rebuild**

Run: `cd packages/authn-testing && npx ts-mocha -p tsconfig.json test/helpers/webauthn.test.ts`
Expected: PASS, 4 passing.
Run: `npm test` (in `packages/authn-testing`). Expected: no new failures.
Run: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
unix2dos packages/authn-testing/src/helpers/webauthn.ts packages/authn-testing/test/helpers/webauthn.test.ts
git add packages/authn-testing/src/helpers/webauthn.ts packages/authn-testing/src/helpers/index.ts packages/authn-testing/test/helpers/webauthn.test.ts
git commit -m "test(authn-testing): a software WebAuthn authenticator for ceremony tests"
```

---

### Task 2: Scaffold `@spinajs/authn-webauthn` on `@simplewebauthn/server` 14.0.3

**Files:**
- Create: `packages/authn-webauthn/package.json`, `tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json`, `.mocharc.json`, `src/index.ts`, `src/ceremony.ts`
- Copy: `.eslintignore`, `.eslintrc.cjs`, `.gitignore`, `.npmignore`, `.prettierrc`, `typedoc.json` from `packages/authn-totp`
- Modify: root `package.json` (dependencies, after `"@spinajs/authn-totp"` at line 102), `tsconfig.build.json` and `tsconfig.build.cjs.json` (after the authn-totp reference, line 86)
- Test: `packages/authn-webauthn/test/library.test.ts`

**Interfaces:**
- Consumes: Task 1 `SoftAuthenticator`.
- Produces: package `@spinajs/authn-webauthn` with entries `.` and `./db`; `WEBAUTHN_ALGORITHMS: readonly number[]` (`[-8, -7, -257]`).

- [ ] **Step 1: Create the package files**

`packages/authn-webauthn/package.json`:

```json
{
  "name": "@spinajs/authn-webauthn",
  "version": "3.0.0-alpha.0",
  "description": "WebAuthn security keys and passkeys for SpinaJS",
  "main": "lib/cjs/index.js",
  "module": "lib/mjs/index.js",
  "exports": {
    ".": {
      "types": "./lib/mjs/index.d.ts",
      "import": "./lib/mjs/index.js",
      "require": "./lib/cjs/index.js"
    },
    "./db": {
      "types": "./lib/mjs/db.d.ts",
      "import": "./lib/mjs/db.js",
      "require": "./lib/cjs/db.js"
    }
  },
  "typesVersions": {
    "*": {
      "db": [
        "lib/cjs/db.d.ts"
      ]
    }
  },
  "type": "module",
  "private": false,
  "publishConfig": {
    "access": "public"
  },
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "npm run clean && npm run compile",
    "compile": "tsc -b tsconfig.mjs.json",
    "compile:cjs": "tsc -b tsconfig.cjs.json",
    "rimraf": "./node_modules/rimraf/bin.js",
    "clean": "rimraf lib/ && rimraf tsconfig.tsbuildinfo",
    "pretest": "npm run compile",
    "test": "ts-mocha -p tsconfig.json",
    "coverage": "nyc npm run test",
    "build-docs": "rimraf docs && typedoc --options typedoc.json src/",
    "format": "prettier --write \"src/**/*.ts\"",
    "lint": "eslint -c .eslintrc.cjs --ext .ts src --fix",
    "preversion": "npm run lint",
    "version": "npm run format && git add -A src"
  },
  "files": [
    "lib/**/*"
  ],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/spinajs/main.git"
  },
  "keywords": [
    "spinajs",
    "authn",
    "webauthn",
    "passkeys"
  ],
  "author": "SpinaJS <spinajs@coderush.pl> (https://github.com/spinajs/main)",
  "license": "MIT",
  "bugs": {
    "url": "https://github.com/spinajs/main/issues"
  },
  "homepage": "https://github.com/spinajs/main#readme",
  "dependencies": {
    "@simplewebauthn/server": "14.0.3",
    "@spinajs/authn": "3.0.0-alpha.0",
    "@spinajs/authn-orm": "3.0.0-alpha.0",
    "@spinajs/cli": "2.0.549",
    "@spinajs/configuration": "2.0.549",
    "@spinajs/di": "2.0.549",
    "@spinajs/exceptions": "2.0.549",
    "@spinajs/log": "2.0.549"
  },
  "devDependencies": {
    "@spinajs/authn-testing": "3.0.0-alpha.0",
    "@spinajs/orm": "2.0.549",
    "@spinajs/orm-sqlite": "2.0.549"
  }
}
```

`packages/authn-webauthn/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./",
    "outDir": "./lib/mjs",
    "module": "node16",
    "moduleResolution": "node16"
  },
  "include": ["src/**/*", "test/**/*"],
  "references": [{ "path": "../authn/tsconfig.json" }, { "path": "../authn-orm/tsconfig.json" }, { "path": "../cli/tsconfig.json" }, { "path": "../configuration/tsconfig.json" }, { "path": "../di/tsconfig.json" }, { "path": "../exceptions/tsconfig.json" }, { "path": "../log/tsconfig.json" }, { "path": "../authn-testing/tsconfig.json" }]
}
```

`packages/authn-webauthn/tsconfig.mjs.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/mjs",
    "module": "node16",
    "moduleResolution": "node16"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../authn/tsconfig.mjs.json" }, { "path": "../authn-orm/tsconfig.mjs.json" }, { "path": "../cli/tsconfig.mjs.json" }, { "path": "../configuration/tsconfig.mjs.json" }, { "path": "../di/tsconfig.mjs.json" }, { "path": "../exceptions/tsconfig.mjs.json" }, { "path": "../log/tsconfig.mjs.json" }]
}
```

`packages/authn-webauthn/tsconfig.cjs.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/cjs",
    "module": "commonjs"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../authn/tsconfig.cjs.json" }, { "path": "../authn-orm/tsconfig.cjs.json" }, { "path": "../cli/tsconfig.cjs.json" }, { "path": "../configuration/tsconfig.cjs.json" }, { "path": "../di/tsconfig.cjs.json" }, { "path": "../exceptions/tsconfig.cjs.json" }, { "path": "../log/tsconfig.cjs.json" }]
}
```

`packages/authn-webauthn/.mocharc.json`:

```json
{
  "extensions": [
    "ts"
  ],
  "spec": [
    "test/**/*.test.ts"
  ],
  "node-option": [
    "experimental-specifier-resolution=node",
    "loader=ts-node/esm"
  ]
}
```

Copy the tool files:

```bash
cp packages/authn-totp/{.eslintignore,.eslintrc.cjs,.gitignore,.npmignore,.prettierrc,typedoc.json} packages/authn-webauthn/
```

Root `package.json`, after the `"@spinajs/authn-totp"` line:

```json
    "@spinajs/authn-webauthn": "file:packages/authn-webauthn",
```

`tsconfig.build.json`, after `{ "path": "packages/authn-totp/tsconfig.mjs.json" },`:

```json
    { "path": "packages/authn-webauthn/tsconfig.mjs.json" },
```

`tsconfig.build.cjs.json`, after `{ "path": "./packages/authn-totp/tsconfig.cjs.json" },`:

```json
    { "path": "./packages/authn-webauthn/tsconfig.cjs.json" },
```

- [ ] **Step 2: Write the failing test**

Create `packages/authn-webauthn/test/library.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { WebAuthnCredential } from '@simplewebauthn/server';
import { SoftAuthenticator } from '@spinajs/authn-testing';
import type { SoftOverrides } from '@spinajs/authn-testing';

import { WEBAUTHN_ALGORITHMS } from '../src/index.js';

const RP_ID = 'app.example.test';
const ORIGIN = 'https://app.example.test';

async function registered(device: SoftAuthenticator): Promise<WebAuthnCredential> {
  const options = await generateRegistrationOptions({ rpName: 'Example', rpID: RP_ID, userName: 'alice', userID: new Uint8Array(32).fill(7), supportedAlgorithmIDs: [...WEBAUTHN_ALGORITHMS] });
  const r = await verifyRegistrationResponse({ response: device.create(options), expectedChallenge: options.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, supportedAlgorithmIDs: [...WEBAUTHN_ALGORITHMS] });
  assert.ok(r.verified);
  assert.strictEqual(r.registrationInfo.aaguid, '00000000-0000-0000-0000-000000000000');
  return r.registrationInfo.credential;
}

async function refused(credential: WebAuthnCredential, device: SoftAuthenticator, over: SoftOverrides): Promise<boolean> {
  const options = await generateAuthenticationOptions({ rpID: RP_ID, allowCredentials: [{ id: credential.id }] });
  try {
    return !(await verifyAuthenticationResponse({ response: device.get(options, over), expectedChallenge: options.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, credential })).verified;
  } catch {
    return true;
  }
}

describe('@simplewebauthn/server 14 against the kit SoftAuthenticator', () => {
  it('verifies a none-attestation registration and the assertion that follows', async () => {
    const device = new SoftAuthenticator({ origin: ORIGIN });
    const credential = await registered(device);
    assert.strictEqual(credential.id, device.credentialId);
    const options = await generateAuthenticationOptions({ rpID: RP_ID, allowCredentials: [{ id: credential.id }] });
    const used = await verifyAuthenticationResponse({ response: device.get(options), expectedChallenge: options.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, credential });
    assert.ok(used.verified);
    assert.strictEqual(used.authenticationInfo.newCounter, 1);
  });

  it('refuses a spoilt signature, another origin, another rp id and a missing user verification', async () => {
    const device = new SoftAuthenticator({ origin: ORIGIN });
    const credential = await registered(device);
    for (const over of [{ badSignature: true }, { origin: 'https://evil.example.test' }, { rpId: 'evil.example.test' }, { uv: false }]) {
      assert.strictEqual(await refused(credential, device, over), true, JSON.stringify(over));
    }
  });
});
```

Create `packages/authn-webauthn/src/ceremony.ts`:

```ts
/** COSE algorithms offered and accepted: EdDSA, ES256, RS256. Pinned, so the set does not follow the runtime's PQC support. */
export const WEBAUTHN_ALGORITHMS: readonly number[] = Object.freeze([-8, -7, -257]);
```

Create `packages/authn-webauthn/src/index.ts`:

```ts
export * from './ceremony.js';
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/authn-webauthn && npx ts-mocha -p tsconfig.json test/library.test.ts`
Expected: FAIL, `Cannot find module '@simplewebauthn/server'` (not installed yet).

- [ ] **Step 4: Install and run again**

Run (repo root): `npm install`
Expected: exit 0; `npm ls @simplewebauthn/server` prints `@simplewebauthn/server@14.0.3` under `@spinajs/authn-webauthn`.
Run: `cd packages/authn-webauthn && npx ts-mocha -p tsconfig.json test/library.test.ts`
Expected: PASS, 2 passing.
Run: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
unix2dos packages/authn-webauthn/package.json packages/authn-webauthn/tsconfig*.json packages/authn-webauthn/.mocharc.json packages/authn-webauthn/src/*.ts packages/authn-webauthn/test/library.test.ts
git add packages/authn-webauthn package.json package-lock.json tsconfig.build.json tsconfig.build.cjs.json
git diff --cached --stat
git commit -m "feat(authn-webauthn): package scaffold on @simplewebauthn/server 14.0.3"
```

---

### Task 3: `authn.webauthn` through its schema

**Files:**
- Create: `packages/authn-webauthn/src/config/schema.ts`, `src/config/options.ts`, `src/config/bootstrap.ts`, `src/config/index.ts`
- Modify: `packages/authn-webauthn/src/index.ts`
- Create: `packages/authn-webauthn/test/support/config-boot.ts`
- Test: `packages/authn-webauthn/test/config.test.ts`

**Interfaces:**
- Consumes: `registerConfigurationSchema` (`@spinajs/configuration`), `isLenientAuthnEnv` (`@spinajs/authn/env`).
- Produces: `WEBAUTHN_CONFIGURATION_SCHEMA`; `type UserVerification = 'required' | 'preferred' | 'discouraged'`; `interface WebAuthnOptions { rpId; rpName; origins: readonly string[]; timeoutSeconds: number; attestation: 'none'; maxCredentials: number; mfa: { userVerification: UserVerification }; passkey: { assurance: 'aal1' | 'aal2' } }`; `resolveWebAuthnOptions(raw: unknown, env: string | undefined): WebAuthnOptions` (throws `InvalidOption`); `class WebAuthnConfigBootstrapper`.

- [ ] **Step 1: Schema additions**

Create `packages/authn-webauthn/src/config/schema.ts`:

```ts
const ORIGIN = '^https?://[a-z0-9.-]+(:[0-9]{1,5})?$';

export const WEBAUTHN_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authn-webauthn.configuration.schema.json',
  $configurationModule: 'authn.webauthn',
  description: 'WebAuthn security keys and passkeys (authn.webauthn.*)',
  type: 'object',
  required: ['rpId', 'rpName', 'origins'],
  propertyNames: { enum: ['rpId', 'rpName', 'origins', 'timeoutSeconds', 'attestation', 'maxCredentials', 'mfa', 'passkey'] },
  properties: {
    rpId: { type: 'string', pattern: '^[a-z0-9.-]{1,253}$', description: 'The site host or a registrable suffix of it; no scheme, no port.' },
    rpName: { type: 'string', minLength: 1, maxLength: 64, description: 'Shown by the authenticator.' },
    origins: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: ORIGIN }, description: 'Exact origins a ceremony may come from; https outside development and test, each on rpId.' },
    timeoutSeconds: { type: 'integer', minimum: 30, maximum: 600, default: 120, description: 'The client ceremony timeout and the life of its challenge.' },
    attestation: { type: 'string', enum: ['none'], default: 'none', description: 'The package keeps no attestation trust anchors.' },
    maxCredentials: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
    mfa: {
      type: 'object',
      default: {},
      propertyNames: { enum: ['userVerification'] },
      properties: { userVerification: { type: 'string', enum: ['required', 'preferred', 'discouraged'], default: 'preferred' } },
    },
    passkey: {
      type: 'object',
      default: {},
      propertyNames: { enum: ['assurance'] },
      properties: { assurance: { type: 'string', enum: ['aal1', 'aal2'], default: 'aal1', description: "What a passkey login proves; 'aal2' counts a user-verified passkey as multi-factor (NIST SP 800-63B)." } },
    },
  },
};
```

- [ ] **Step 2: Write the failing tests**

Create `packages/authn-webauthn/test/support/config-boot.ts`:

```ts
import { Configuration, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

function configurationOf(values: Record<string, unknown>, env = 'test'): Class<Configuration> {
  const json = JSON.stringify(values);
  return class SpecConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      this.Env = env;
    }

    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

const open: IContainer[] = [];

export async function boot(schemas: readonly object[], values: Record<string, unknown>): Promise<{ child: IContainer; configuration: Configuration }> {
  const child = DI.RootContainer.child();
  open.push(child);
  for (const schema of schemas) child.register(schema).asValue('__configurationSchema__');
  child.register(configurationOf(values)).as(Configuration);
  return { child, configuration: await child.resolve(Configuration) };
}

export async function violationsOf(schemas: readonly object[], values: Record<string, unknown>): Promise<string[]> {
  try {
    await boot(schemas, values);
    return [];
  } catch (e) {
    if (e instanceof InvalidConfiguration) return e.violations.map((v) => v.path);
    throw e;
  }
}

export async function disposeBooted(): Promise<void> {
  for (const c of open.splice(0)) await c.dispose();
}
```

Create `packages/authn-webauthn/test/config.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';
import { InvalidOption } from '@spinajs/exceptions';

import { WEBAUTHN_CONFIGURATION_SCHEMA, resolveWebAuthnOptions } from '../src/index.js';
import { boot, disposeBooted, violationsOf } from './support/config-boot.js';

const SCHEMAS = [WEBAUTHN_CONFIGURATION_SCHEMA];
const BASE = { rpId: 'example.test', rpName: 'Example', origins: ['https://app.example.test'] };
const bad = (webauthn: Record<string, unknown>) => violationsOf(SCHEMAS, { authn: { webauthn } });
const full = (over: Record<string, unknown> = {}) => ({ ...BASE, timeoutSeconds: 120, attestation: 'none', maxCredentials: 10, mfa: { userVerification: 'preferred' }, passkey: { assurance: 'aal1' }, ...over });

describe('authn.webauthn', () => {
  afterEach(disposeBooted);

  it('fills the defaults around rpId, rpName and origins', async () => {
    const { configuration } = await boot(SCHEMAS, { authn: { webauthn: BASE } });
    assert.deepStrictEqual(configuration.get('authn.webauthn'), full());
  });

  it('names the bad key', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ rpName: 'X', origins: BASE.origins }, 'authn.webauthn.rpId'],
      [{ ...BASE, origins: [] }, 'authn.webauthn.origins'],
      [{ ...BASE, origins: ['https://app.example.test/'] }, 'authn.webauthn.origins.0'],
      [{ ...BASE, timeoutSeconds: 10 }, 'authn.webauthn.timeoutSeconds'],
      [{ ...BASE, attestation: 'direct' }, 'authn.webauthn.attestation'],
      [{ ...BASE, maxCredentials: 0 }, 'authn.webauthn.maxCredentials'],
      [{ ...BASE, mfa: { userVerification: 'always' } }, 'authn.webauthn.mfa.userVerification'],
      [{ ...BASE, passkey: { assurance: 'aal3' } }, 'authn.webauthn.passkey.assurance'],
      [{ ...BASE, typo: 1 }, 'authn.webauthn.typo'],
    ];
    for (const [webauthn, path] of cases) assert.ok((await bad(webauthn)).includes(path), `${JSON.stringify(webauthn)} -> ${path}`);
  });

  describe('resolveWebAuthnOptions', () => {
    it('takes https origins on rpId or below it, in any env', () => {
      const o = resolveWebAuthnOptions(full({ origins: ['https://example.test', 'https://app.example.test:8443'] }), undefined);
      assert.deepStrictEqual(o.origins, ['https://example.test', 'https://app.example.test:8443']);
    });

    it('takes http origins only in development and test; a missing env is production', () => {
      const local = full({ rpId: 'localhost', origins: ['http://localhost:3000'] });
      assert.strictEqual(resolveWebAuthnOptions(local, 'test').rpId, 'localhost');
      assert.strictEqual(resolveWebAuthnOptions(local, 'development').rpId, 'localhost');
      for (const env of [undefined, 'production', 'staging']) assert.throws(() => resolveWebAuthnOptions(local, env), InvalidOption, String(env));
    });

    it('refuses an origin off rpId, one not written as an exact origin, and missing or out-of-range values', () => {
      const cases: Record<string, unknown>[] = [{ origins: ['https://example.org'] }, { origins: ['https://notexample.test'] }, { origins: ['HTTPS://app.example.test'] }, { origins: ['https://app.example.test:443'] }, { rpId: '' }, { origins: [] }, { timeoutSeconds: 5 }, { maxCredentials: 101 }, { mfa: {} }, { passkey: { assurance: 'aal3' } }];
      for (const over of cases) assert.throws(() => resolveWebAuthnOptions(full(over), 'test'), InvalidOption, JSON.stringify(over));
      assert.throws(() => resolveWebAuthnOptions(undefined, 'test'), InvalidOption);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/authn-webauthn && npx ts-mocha -p tsconfig.json test/config.test.ts`
Expected: FAIL at compile time: `Module '"../src/index.js"' has no exported member 'WEBAUTHN_CONFIGURATION_SCHEMA'` (and `resolveWebAuthnOptions`).

- [ ] **Step 4: Implement**

Create `packages/authn-webauthn/src/config/options.ts`:

```ts
import { InvalidOption } from '@spinajs/exceptions';
import { isLenientAuthnEnv } from '@spinajs/authn/env';

export type UserVerification = 'required' | 'preferred' | 'discouraged';

/** `authn.webauthn` as the schema leaves it. */
export interface WebAuthnOptions {
  readonly rpId: string;
  readonly rpName: string;
  readonly origins: readonly string[];
  readonly timeoutSeconds: number;
  readonly attestation: 'none';
  readonly maxCredentials: number;
  readonly mfa: { readonly userVerification: UserVerification };
  readonly passkey: { readonly assurance: 'aal1' | 'aal2' };
}

const USER_VERIFICATION: readonly unknown[] = ['required', 'preferred', 'discouraged'];

const intIn = (v: unknown, min: number, max: number): boolean => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/**
 * The checks a schema cannot make, and a floor for values that never went through it (deps in tests, a runtime
 * Configuration.set): http origins only when `env` is development or test (a missing env is production), and every
 * origin on rpId or below it (WebAuthn §5.4.1: the RP id is the origin's host or a registrable suffix of it).
 */
export function resolveWebAuthnOptions(raw: unknown, env: string | undefined): WebAuthnOptions {
  const o = (raw ?? {}) as Partial<WebAuthnOptions>;
  if (typeof o.rpId !== 'string' || o.rpId === '' || typeof o.rpName !== 'string' || o.rpName === '' || !Array.isArray(o.origins) || o.origins.length === 0) {
    throw new InvalidOption('authn.webauthn: rpId, rpName and origins must be set');
  }
  if (!intIn(o.timeoutSeconds, 30, 600) || !intIn(o.maxCredentials, 1, 100) || o.attestation !== 'none' || !USER_VERIFICATION.includes(o.mfa?.userVerification) || (o.passkey?.assurance !== 'aal1' && o.passkey?.assurance !== 'aal2')) {
    throw new InvalidOption('authn.webauthn: timeoutSeconds, maxCredentials, attestation, mfa.userVerification or passkey.assurance is outside the allowed values');
  }
  const rpId = o.rpId.toLowerCase();
  for (const origin of o.origins) {
    let url: URL;
    try {
      url = new URL(String(origin));
    } catch {
      throw new InvalidOption(`authn.webauthn.origins: ${JSON.stringify(origin)} is not an origin`);
    }
    if (url.origin !== origin) throw new InvalidOption(`authn.webauthn.origins: ${JSON.stringify(origin)} is not written as an exact origin (lower case, no default port, no path)`);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLenientAuthnEnv(env))) throw new InvalidOption(`authn.webauthn.origins: ${origin} must use https outside development and test`);
    if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) throw new InvalidOption(`authn.webauthn.origins: ${origin} is not on rpId ${rpId}`);
  }
  return Object.freeze({
    rpId,
    rpName: o.rpName,
    origins: Object.freeze([...o.origins]),
    timeoutSeconds: o.timeoutSeconds as number,
    attestation: 'none' as const,
    maxCredentials: o.maxCredentials as number,
    mfa: Object.freeze({ userVerification: o.mfa!.userVerification }),
    passkey: Object.freeze({ assurance: o.passkey!.assurance }),
  });
}
```

Create `packages/authn-webauthn/src/config/bootstrap.ts`:

```ts
import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

import { WEBAUTHN_CONFIGURATION_SCHEMA } from './schema.js';

/** Registers the authn.webauthn schema, so the configuration validates it and fills its defaults. */
@Injectable(Bootstrapper)
export class WebAuthnConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(WEBAUTHN_CONFIGURATION_SCHEMA);
  }
}
```

Create `packages/authn-webauthn/src/config/index.ts`:

```ts
export * from './schema.js';
export * from './options.js';
export * from './bootstrap.js';
```

`packages/authn-webauthn/src/index.ts` becomes:

```ts
export * from './ceremony.js';
export * from './config/index.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/authn-webauthn && npx ts-mocha -p tsconfig.json test/config.test.ts`
Expected: PASS, 5 passing.
Run: `npm test`. Expected: all passing.

- [ ] **Step 6: Commit**

```bash
unix2dos packages/authn-webauthn/src/config/*.ts packages/authn-webauthn/src/index.ts packages/authn-webauthn/test/config.test.ts packages/authn-webauthn/test/support/config-boot.ts
git add packages/authn-webauthn/src packages/authn-webauthn/test
git commit -m "feat(authn-webauthn): authn.webauthn through its schema, origins checked against the env and rpId"
```

---

### Task 4: The credential store contract and the memory store

**Files:**
- Create: `packages/authn-webauthn/src/store/store.ts`, `src/store/memory.ts`, `src/store/index.ts`
- Modify: `packages/authn-webauthn/src/index.ts`
- Create: `packages/authn-webauthn/test/support/store-script.ts`
- Test: `packages/authn-webauthn/test/store.test.ts`

**Interfaces:**
- Consumes: `IdentityRef`.
- Produces: `interface WebAuthnCredentialRecord { identity; credentialId; publicKey; signCount; transports: readonly string[]; aaguid; backupEligible; backedUp; passkey; name: string | null; createdAt: Date; lastUsedAt: Date | null }`; `type NewWebAuthnCredential = Omit<WebAuthnCredentialRecord, 'createdAt' | 'lastUsedAt'>`; `abstract class WebAuthnCredentialStore` with `list(id)`, `find(credentialId)`, `add(c, at): Promise<boolean>`, `recordUse(credentialId, expected, next, backedUp, at): Promise<boolean>`, `rename(id, credentialId, name): Promise<boolean>`, `remove(id, credentialId): Promise<boolean>`, `removeAll(id): Promise<number>`, `userHandle(id): Promise<string | null>`, `ensureUserHandle(id, candidate): Promise<string>`; `class MemoryWebAuthnCredentialStore`; `CREDENTIAL_ID_MAX = 1364`, `CREDENTIAL_NAME_MAX = 64`, `isCredentialId(v): v is string`, `checkedCredentialId(v): string`; test helper `credentialStoreScript(make: () => Promise<WebAuthnCredentialStore>): void`.

- [ ] **Step 1: Write the failing tests**

Create `packages/authn-webauthn/test/support/store-script.ts`:

```ts
import assert from 'node:assert/strict';
import type { IdentityRef } from '@spinajs/authn/contracts';

import type { NewWebAuthnCredential, WebAuthnCredentialStore } from '../../src/index.js';

const ALICE: IdentityRef = { type: 'user', id: 'alice' };
const BOB: IdentityRef = { type: 'user', id: 'bob' };
const T0 = new Date('2026-10-06T10:00:00.000Z');
const later = (s: number): Date => new Date(T0.getTime() + s * 1000);

const credential = (identity: IdentityRef, credentialId: string, over: Partial<NewWebAuthnCredential> = {}): NewWebAuthnCredential => ({
  identity,
  credentialId,
  publicKey: 'pQECAyYgASFYIA',
  signCount: 0,
  transports: ['internal', 'hybrid'],
  aaguid: '00000000-0000-0000-0000-000000000000',
  backupEligible: true,
  backedUp: true,
  passkey: false,
  name: null,
  ...over,
});

/** One script for every WebAuthnCredentialStore; `make` returns an empty store. */
export function credentialStoreScript(make: () => Promise<WebAuthnCredentialStore>): void {
  let store: WebAuthnCredentialStore;

  beforeEach(async () => {
    store = await make();
  });

  it('adds a credential and reads it back field by field', async () => {
    assert.strictEqual(await store.add(credential(ALICE, 'cred-a1', { signCount: 5, passkey: true, name: 'Laptop' }), T0), true);
    const r = await store.find('cred-a1');
    assert.ok(r);
    assert.deepStrictEqual({ ...r, transports: [...r.transports], createdAt: r.createdAt.toISOString() }, { identity: ALICE, credentialId: 'cred-a1', publicKey: 'pQECAyYgASFYIA', signCount: 5, transports: ['internal', 'hybrid'], aaguid: '00000000-0000-0000-0000-000000000000', backupEligible: true, backedUp: true, passkey: true, name: 'Laptop', createdAt: T0.toISOString(), lastUsedAt: null });
    assert.strictEqual(await store.find('cred-none'), null);
  });

  it('refuses a credential id that is registered already, to any identity', async () => {
    assert.strictEqual(await store.add(credential(ALICE, 'cred-dup'), T0), true);
    assert.strictEqual(await store.add(credential(ALICE, 'cred-dup'), later(1)), false);
    assert.strictEqual(await store.add(credential(BOB, 'cred-dup'), later(2)), false);
    assert.strictEqual((await store.list(BOB)).length, 0);
  });

  it("lists only the identity's own credentials, oldest first", async () => {
    await store.add(credential(ALICE, 'cred-l2'), later(2));
    await store.add(credential(BOB, 'cred-lb'), later(1));
    await store.add(credential(ALICE, 'cred-l1'), later(1));
    assert.deepStrictEqual((await store.list(ALICE)).map((r) => r.credentialId), ['cred-l1', 'cred-l2']);
  });

  it('records a use only over the expected counter', async () => {
    await store.add(credential(ALICE, 'cred-u', { signCount: 3, backedUp: false }), T0);
    assert.strictEqual(await store.recordUse('cred-u', 2, 9, true, later(5)), false);
    assert.strictEqual(await store.recordUse('cred-u', 3, 4, true, later(5)), true);
    const r = (await store.find('cred-u'))!;
    assert.deepStrictEqual([r.signCount, r.backedUp, r.lastUsedAt?.toISOString()], [4, true, later(5).toISOString()]);
    assert.strictEqual(await store.recordUse('cred-u', 3, 5, true, later(6)), false);
    assert.strictEqual(await store.recordUse('cred-missing', 0, 1, false, later(6)), false);
  });

  it("renames and removes only the owner's credential", async () => {
    await store.add(credential(ALICE, 'cred-r'), T0);
    assert.strictEqual(await store.rename(BOB, 'cred-r', 'Stolen'), false);
    assert.strictEqual(await store.rename(ALICE, 'cred-r', 'Phone'), true);
    assert.strictEqual((await store.find('cred-r'))!.name, 'Phone');
    assert.strictEqual(await store.rename(ALICE, 'cred-r', null), true);
    assert.strictEqual((await store.find('cred-r'))!.name, null);
    assert.strictEqual(await store.remove(BOB, 'cred-r'), false);
    assert.strictEqual(await store.remove(ALICE, 'cred-r'), true);
    assert.strictEqual(await store.find('cred-r'), null);
  });

  it("removeAll removes the identity's credentials and keeps its user handle", async () => {
    await store.add(credential(ALICE, 'cred-x1'), T0);
    await store.add(credential(ALICE, 'cred-x2'), T0);
    await store.add(credential(BOB, 'cred-xb'), T0);
    assert.strictEqual(await store.ensureUserHandle(ALICE, 'aGFuZGxlLWE'), 'aGFuZGxlLWE');
    assert.strictEqual(await store.removeAll(ALICE), 2);
    assert.deepStrictEqual(await store.list(ALICE), []);
    assert.strictEqual((await store.list(BOB)).length, 1);
    assert.strictEqual(await store.userHandle(ALICE), 'aGFuZGxlLWE');
  });

  it('keeps the first user handle of an identity', async () => {
    assert.strictEqual(await store.userHandle(BOB), null);
    assert.strictEqual(await store.ensureUserHandle(BOB, 'Zmlyc3Q'), 'Zmlyc3Q');
    assert.strictEqual(await store.ensureUserHandle(BOB, 'c2Vjb25k'), 'Zmlyc3Q');
    const [x, y] = await Promise.all([store.ensureUserHandle(ALICE, 'b25l'), store.ensureUserHandle(ALICE, 'dHdv')]);
    assert.strictEqual(x, y);
  });

  it('keeps a credential id of 1364 characters and refuses a longer one', async () => {
    const id = 'A'.repeat(1364);
    assert.strictEqual(await store.add(credential(ALICE, id), T0), true);
    assert.strictEqual((await store.find(id))!.credentialId, id);
    await assert.rejects(store.add(credential(ALICE, 'A'.repeat(1365)), T0));
  });
}
```

Create `packages/authn-webauthn/test/store.test.ts`:

```ts
import 'mocha';

import { MemoryWebAuthnCredentialStore } from '../src/index.js';
import { credentialStoreScript } from './support/store-script.js';

describe('MemoryWebAuthnCredentialStore', () => credentialStoreScript(async () => new MemoryWebAuthnCredentialStore()));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authn-webauthn && npx ts-mocha -p tsconfig.json test/store.test.ts`
Expected: FAIL at compile time: `has no exported member 'MemoryWebAuthnCredentialStore'`.

- [ ] **Step 3: Implement**

Create `packages/authn-webauthn/src/store/store.ts`:

```ts
import type { IdentityRef } from '@spinajs/authn/contracts';

/** One registered WebAuthn credential. */
export interface WebAuthnCredentialRecord {
  readonly identity: IdentityRef;
  /** base64url as the authenticator gave it: at most 1023 bytes (WebAuthn Level 3). */
  readonly credentialId: string;
  /** COSE_Key as base64url. Public, so it is stored in clear. */
  readonly publicKey: string;
  readonly signCount: number;
  readonly transports: readonly string[];
  readonly aaguid: string;
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
  /** Registered in a passkey ceremony (discoverable, user verified): it may log in alone. */
  readonly passkey: boolean;
  readonly name: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

export type NewWebAuthnCredential = Omit<WebAuthnCredentialRecord, 'createdAt' | 'lastUsedAt'>;

/**
 * `authn_webauthn_credential` and `authn_webauthn_user` behind WebAuthnMfaStep and PasskeyStrategy. Apps register
 * `DbWebAuthnCredentialStore` by importing `@spinajs/authn-webauthn/db`; tests use `MemoryWebAuthnCredentialStore`.
 */
export abstract class WebAuthnCredentialStore {
  /** Oldest first. */
  abstract list(id: IdentityRef): Promise<readonly WebAuthnCredentialRecord[]>;
  abstract find(credentialId: string): Promise<WebAuthnCredentialRecord | null>;
  /** False when the credential id is registered already, to this identity or another (WebAuthn §7.1). */
  abstract add(credential: NewWebAuthnCredential, at: Date): Promise<boolean>;
  /** Writes the counter, the backup state and the use time only while the stored counter is `expected`; true when it wrote. */
  abstract recordUse(credentialId: string, expected: number, next: number, backedUp: boolean, at: Date): Promise<boolean>;
  /** Owner-bound: false when `id` holds no such credential. */
  abstract rename(id: IdentityRef, credentialId: string, name: string | null): Promise<boolean>;
  /** Owner-bound: false when `id` holds no such credential. */
  abstract remove(id: IdentityRef, credentialId: string): Promise<boolean>;
  /** How many went. The user handle stays. */
  abstract removeAll(id: IdentityRef): Promise<number>;
  /** The user.id the identity's authenticators hold; null before its first registration. */
  abstract userHandle(id: IdentityRef): Promise<string | null>;
  /** The identity's user handle; stores `candidate` when it has none. Parallel calls answer the same value. */
  abstract ensureUserHandle(id: IdentityRef, candidate: string): Promise<string>;
}
```

Create `packages/authn-webauthn/src/store/memory.ts`:

```ts
import { InvalidArgument } from '@spinajs/exceptions';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { WebAuthnCredentialStore } from './store.js';
import type { NewWebAuthnCredential, WebAuthnCredentialRecord } from './store.js';

/** 1023 bytes, the WebAuthn Level 3 maximum, as unpadded base64url. */
export const CREDENTIAL_ID_MAX = 1364;
export const CREDENTIAL_NAME_MAX = 64;
/** 64 bytes, the WebAuthn maximum of user.id, as unpadded base64url. */
const USER_HANDLE_MAX = 86;
const B64URL = /^[A-Za-z0-9_-]+$/;

export const isCredentialId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= CREDENTIAL_ID_MAX && B64URL.test(value);

export function checkedCredentialId(value: unknown): string {
  if (!isCredentialId(value)) throw new InvalidArgument(`a credential id is 1 to ${CREDENTIAL_ID_MAX} base64url characters`);
  return value;
}

function keyOf(id: IdentityRef): string {
  if (!id || typeof id.type !== 'string' || id.type === '' || id.type.includes(':') || typeof id.id !== 'string') throw new InvalidArgument('MemoryWebAuthnCredentialStore: a malformed identity');
  return `${id.type}:${id.id}`;
}

function checkedCount(v: unknown, label: string): number {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 0xffffffff) throw new InvalidArgument(`MemoryWebAuthnCredentialStore: ${label} must be an unsigned 32-bit integer`);
  return v as number;
}

function checkedName(name: unknown): string | null {
  if (name === null) return null;
  if (typeof name !== 'string' || name.length === 0 || [...name].length > CREDENTIAL_NAME_MAX) throw new InvalidArgument(`a credential name is 1 to ${CREDENTIAL_NAME_MAX} characters`);
  return name;
}

const copy = (r: WebAuthnCredentialRecord): WebAuthnCredentialRecord => Object.freeze({ ...r, identity: { type: r.identity.type, id: r.identity.id }, transports: Object.freeze([...r.transports]), createdAt: new Date(r.createdAt.getTime()), lastUsedAt: r.lastUsedAt && new Date(r.lastUsedAt.getTime()) });

/** One process; loses everything on restart. For tests and single-process apps. */
export class MemoryWebAuthnCredentialStore extends WebAuthnCredentialStore {
  private readonly rows = new Map<string, WebAuthnCredentialRecord>();
  private readonly handles = new Map<string, string>();

  async list(id: IdentityRef): Promise<readonly WebAuthnCredentialRecord[]> {
    const key = keyOf(id);
    return [...this.rows.values()].filter((r) => keyOf(r.identity) === key).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(copy);
  }

  async find(credentialId: string): Promise<WebAuthnCredentialRecord | null> {
    const r = this.rows.get(checkedCredentialId(credentialId));
    return r ? copy(r) : null;
  }

  async add(c: NewWebAuthnCredential, at: Date): Promise<boolean> {
    keyOf(c.identity);
    const credentialId = checkedCredentialId(c.credentialId);
    checkedCount(c.signCount, 'signCount');
    checkedName(c.name);
    if (this.rows.has(credentialId)) return false;
    this.rows.set(credentialId, copy({ ...c, createdAt: at, lastUsedAt: null }));
    return true;
  }

  async recordUse(credentialId: string, expected: number, next: number, backedUp: boolean, at: Date): Promise<boolean> {
    const r = this.rows.get(checkedCredentialId(credentialId));
    checkedCount(expected, 'expected');
    checkedCount(next, 'next');
    if (!r || r.signCount !== expected) return false;
    this.rows.set(credentialId, copy({ ...r, signCount: next, backedUp, lastUsedAt: at }));
    return true;
  }

  async rename(id: IdentityRef, credentialId: string, name: string | null): Promise<boolean> {
    const r = this.rows.get(checkedCredentialId(credentialId));
    if (!r || keyOf(r.identity) !== keyOf(id)) return false;
    this.rows.set(credentialId, copy({ ...r, name: checkedName(name) }));
    return true;
  }

  async remove(id: IdentityRef, credentialId: string): Promise<boolean> {
    const r = this.rows.get(checkedCredentialId(credentialId));
    if (!r || keyOf(r.identity) !== keyOf(id)) return false;
    return this.rows.delete(credentialId);
  }

  async removeAll(id: IdentityRef): Promise<number> {
    const key = keyOf(id);
    let removed = 0;
    for (const [credentialId, r] of this.rows) {
      if (keyOf(r.identity) === key && this.rows.delete(credentialId)) removed++;
    }
    return removed;
  }

  async userHandle(id: IdentityRef): Promise<string | null> {
    return this.handles.get(keyOf(id)) ?? null;
  }

  async ensureUserHandle(id: IdentityRef, candidate: string): Promise<string> {
    const key = keyOf(id);
    const held = this.handles.get(key);
    if (held !== undefined) return held;
    if (typeof candidate !== 'string' || candidate.length > USER_HANDLE_MAX || !B64URL.test(candidate)) throw new InvalidArgument('a user handle is 1 to 64 bytes as base64url');
    this.handles.set(key, candidate);
    return candidate;
  }
}
```

Create `packages/authn-webauthn/src/store/index.ts`:

```ts
export * from './store.js';
export * from './memory.js';
```

Append to `packages/authn-webauthn/src/index.ts`:

```ts
export * from './store/index.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/authn-webauthn && npx ts-mocha -p tsconfig.json test/store.test.ts`
Expected: PASS, 8 passing.

- [ ] **Step 5: Commit**

```bash
unix2dos packages/authn-webauthn/src/store/*.ts packages/authn-webauthn/src/index.ts packages/authn-webauthn/test/store.test.ts packages/authn-webauthn/test/support/store-script.ts
git add packages/authn-webauthn/src packages/authn-webauthn/test
git commit -m "feat(authn-webauthn): credential store contract and the memory store"
```

---

### Task 5: The tables, `DbWebAuthnStore` and the `/db` entry

**Files:**
- Create: `packages/authn-orm/src/migrations/AuthnWebAuthn_2026_10_06_00_00_00.ts`
- Modify: `packages/authn-orm/src/migrations/index.ts` (append one export)
- Create: `packages/authn-orm/src/webauthn/db-webauthn-store.ts`, `src/webauthn/index.ts`
- Modify: `packages/authn-orm/src/index.ts` (after `export * from './mfa/index.js';`)
- Test: `packages/authn-orm/test/webauthn-store.test.ts`
- Create: `packages/authn-webauthn/src/store/db.ts`, `src/db.ts`, `test/support/sqlite.ts`
- Test: `packages/authn-webauthn/test/db-store.test.ts`

**Interfaces:**
- Consumes: authn-orm `StoreConnection`, `identityKey`, `parseIdentityKey`, the `sql.ts` helpers; Task 4 contract and `credentialStoreScript`.
- Produces: migration `AuthnWebAuthn_2026_10_06_00_00_00`; authn-orm `class DbWebAuthnStore` (same methods as `WebAuthnCredentialStore`), `interface WebAuthnCredentialRow`, `type NewWebAuthnCredentialRow`; authn-webauthn `class DbWebAuthnCredentialStore extends WebAuthnCredentialStore` (`@Singleton() @Injectable(WebAuthnCredentialStore)`), loaded only by `@spinajs/authn-webauthn/db`.

- [ ] **Step 1: Write the failing tests**

Create `packages/authn-orm/test/webauthn-store.test.ts`:

```ts
import { expect } from 'chai';
import 'mocha';
import { createHash } from 'node:crypto';
import { QueryContext } from '@spinajs/orm';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { DbWebAuthnStore } from '../src/index.js';
import { DB_KINDS, bootDb, rawQuery } from './support/db.js';
import type { TestDb } from './support/db.js';

const ALICE: IdentityRef = { type: 'user', id: 'alice' };
const T0 = new Date('2026-10-06T10:00:00.000Z');
const row = (credentialId: string, over: Record<string, unknown> = {}) => ({ identity: ALICE, credentialId, publicKey: 'pQECAyYgASFYIA', signCount: 0, transports: ['usb'], aaguid: '00000000-0000-0000-0000-000000000000', backupEligible: false, backedUp: false, passkey: false, name: null, ...over });

for (const kind of DB_KINDS) {
  describe(`DbWebAuthnStore on ${kind}`, function () {
    this.timeout(30000);
    let db: TestDb;
    let store: DbWebAuthnStore;

    before(async function () {
      db = await bootDb(this, kind, 'webauthn');
      store = new DbWebAuthnStore(db.driver);
    });

    after(async () => db?.dispose());

    beforeEach(async () => {
      await rawQuery(db.driver, 'DELETE FROM authn_webauthn_credential', [], QueryContext.Delete);
      await rawQuery(db.driver, 'DELETE FROM authn_webauthn_user', [], QueryContext.Delete);
    });

    it('creates both tables with a unique credential hash', async () => {
      expect(await db.driver.schema().tableExists('authn_webauthn_credential')).to.eq(true);
      expect(await db.driver.schema().tableExists('authn_webauthn_user')).to.eq(true);
      const insert = (id: string) =>
        db.driver.insert().into('authn_webauthn_credential').values({ id, identity: 'user:alice', credential_hash: 'f'.repeat(64), credential_id: 'x', public_key: 'k', sign_count: 0, transports: null, aaguid: '0', backup_eligible: false, backed_up: false, passkey: false, name: null, created_at: '2026-10-06 10:00:00.000', last_used_at: null });
      await insert('11111111-1111-4111-8111-111111111111');
      let failed = false;
      try {
        await insert('22222222-2222-4222-8222-222222222222');
      } catch {
        failed = true;
      }
      expect(failed, 'a second row with the same credential hash').to.eq(true);
    });

    it('keys the row by the SHA-256 of the credential id', async () => {
      await store.add(row('cred-h'), T0);
      const [r] = (await rawQuery(db.driver, 'SELECT credential_hash, credential_id FROM authn_webauthn_credential')) as Record<string, unknown>[];
      expect(r.credential_hash).to.eq(createHash('sha256').update('cred-h', 'utf8').digest('hex'));
      expect(r.credential_id).to.eq('cred-h');
    });

    it('reads back a counter of 2^32 - 1, the flags, the transports and the time', async () => {
      await store.add(row('cred-big', { signCount: 4294967295, backupEligible: true, backedUp: true, passkey: true, transports: ['hybrid', 'internal'] }), T0);
      const r = (await store.find('cred-big'))!;
      expect([r.signCount, r.backupEligible, r.backedUp, r.passkey, r.createdAt.toISOString()]).to.deep.eq([4294967295, true, true, true, T0.toISOString()]);
      expect(r.transports).to.deep.eq(['hybrid', 'internal']);
    });
  });
}
```

Create `packages/authn-webauthn/test/support/sqlite.ts`:

```ts
/** Boots an Orm on sqlite `:memory:` in a child DI container and runs the authn-orm migrations on it. */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import '@spinajs/log';
import { Orm, QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import '@spinajs/authn-orm';

export interface SqliteDb {
  readonly container: IContainer;
  readonly driver: OrmDriver;
  dispose(): Promise<void>;
}

export function rawQuery(driver: OrmDriver, sql: string, bindings: unknown[] = [], context: QueryContext = QueryContext.Select): Promise<unknown> {
  return (driver as unknown as { executeOnDb(sql: string, bindings: unknown[], context: QueryContext): Promise<unknown> }).executeOnDb(sql, bindings, context);
}

export async function bootSqlite(name: string): Promise<SqliteDb> {
  DI.setESMModuleSupport();
  const connection = { Name: `webauthn-${name}`, Driver: 'orm-driver-sqlite', Filename: ':memory:', Migration: { OnStartup: true } };

  class SqliteConfiguration extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      const config = this.Config as Record<string, unknown>;
      config.logger = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };
      config.db = { ...(config.db as object), DefaultConnection: connection.Name, Connections: [connection] };
    }
  }

  const container = DI.child();
  container.register(SqliteConfiguration).as(Configuration);
  container.register(SqliteOrmDriver).as('orm-driver-sqlite');
  container.register(Orm).asSelf();
  await container.resolve(Configuration);
  const orm = await container.resolve(Orm);
  return { container, driver: orm.Connections.get('default')!, dispose: () => orm.dispose() };
}
```

Create `packages/authn-webauthn/test/db-store.test.ts`:

```ts
import 'mocha';
import { QueryContext } from '@spinajs/orm';
import { DbWebAuthnStore } from '@spinajs/authn-orm';

import { DbWebAuthnCredentialStore } from '../src/db.js';
import { bootSqlite, rawQuery } from './support/sqlite.js';
import type { SqliteDb } from './support/sqlite.js';
import { credentialStoreScript } from './support/store-script.js';

describe('DbWebAuthnCredentialStore on sqlite', function () {
  this.timeout(30000);
  let db: SqliteDb | undefined;

  after(async () => db?.dispose());

  credentialStoreScript(async () => {
    db ??= await bootSqlite('store');
    await rawQuery(db.driver, 'DELETE FROM authn_webauthn_credential', [], QueryContext.Delete);
    await rawQuery(db.driver, 'DELETE FROM authn_webauthn_user', [], QueryContext.Delete);
    return new DbWebAuthnCredentialStore(new DbWebAuthnStore(db.driver));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/authn-orm && npx ts-mocha -p tsconfig.json test/webauthn-store.test.ts`
Expected: FAIL at compile time: `has no exported member 'DbWebAuthnStore'`.

- [ ] **Step 3: Implement authn-orm**

Create `packages/authn-orm/src/migrations/AuthnWebAuthn_2026_10_06_00_00_00.ts`:

```ts
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/**
 * WebAuthn credentials (plan 09). A credential id may be 1364 characters, beyond a portable unique index, so the
 * unique key is its SHA-256 hex.
 */
@Migration('default')
export class AuthnWebAuthn_2026_10_06_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('authn_webauthn_credential', (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.string('identity', 100).notNull();
      table.string('credential_hash', 64).notNull();
      table.text('credential_id').notNull();
      table.text('public_key').notNull();
      table.bigint('sign_count').notNull();
      table.string('transports', 255);
      table.string('aaguid', 36).notNull();
      table.boolean('backup_eligible').notNull();
      table.boolean('backed_up').notNull();
      table.boolean('passkey').notNull();
      table.string('name', 64);
      table.dateTime('created_at').notNull();
      table.dateTime('last_used_at');
    });
    await connection.index().unique().table('authn_webauthn_credential').name('authn_webauthn_credential_hash').columns(['credential_hash']);
    await connection.index().table('authn_webauthn_credential').name('authn_webauthn_credential_owner').columns(['identity']);

    await connection.schema().createTable('authn_webauthn_user', (table) => {
      table.string('identity', 100).notNull().primaryKey();
      table.string('user_handle', 86).notNull();
      table.dateTime('created_at').notNull();
    });
    await connection.index().unique().table('authn_webauthn_user').name('authn_webauthn_user_handle').columns(['user_handle']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('authn_webauthn_user');
    await connection.schema().dropTable('authn_webauthn_credential');
  }
}
```

Append to `packages/authn-orm/src/migrations/index.ts`:

```ts
export * from './AuthnWebAuthn_2026_10_06_00_00_00.js';
```

Create `packages/authn-orm/src/webauthn/db-webauthn-store.ts`:

```ts
import { randomUUID } from 'node:crypto';

import type { IdentityRef } from '@spinajs/authn/contracts';
import { Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument, UnexpectedServerError } from '@spinajs/exceptions';
import { OrmDriver } from '@spinajs/orm';

import { identityKey, parseIdentityKey } from '../identity.js';
import { StoreConnection } from '../support/connection.js';
import type { StoreOptions } from '../support/connection.js';
import type { Dialect } from '../support/sql.js';
import { checkedMs, checkedText, columnText, isDuplicate, rowsAffected, selectTime, sha256hex, sqlTime, textMs } from '../support/sql.js';

const CREDENTIALS = 'authn_webauthn_credential';
const USERS = 'authn_webauthn_user';
/** 1023 bytes (WebAuthn Level 3) as unpadded base64url. */
const ID_MAX = 1364;
const HANDLE_MAX = 86;
const NAME_MAX = 64;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** One WebAuthn credential as stored; authn-webauthn's WebAuthnCredentialRecord has the same shape. */
export interface WebAuthnCredentialRow {
  readonly identity: IdentityRef;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly signCount: number;
  readonly transports: readonly string[];
  readonly aaguid: string;
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
  readonly passkey: boolean;
  readonly name: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

export type NewWebAuthnCredentialRow = Omit<WebAuthnCredentialRow, 'createdAt' | 'lastUsedAt'>;

function checkedId(value: unknown): string {
  const id = checkedText(value, ID_MAX, 'DbWebAuthnStore: credentialId');
  if (!B64URL.test(id)) throw new InvalidArgument('DbWebAuthnStore: credentialId must be base64url');
  return id;
}

const hashOf = (credentialId: string): string => sha256hex(checkedId(credentialId));

function checkedCount(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) throw new InvalidArgument(`DbWebAuthnStore: ${label} must be an unsigned 32-bit integer`);
  return value as number;
}

function countOf(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isSafeInteger(n) || n < 0) throw new UnexpectedServerError(`DbWebAuthnStore: sign_count ${String(value)} is not a counter`);
  return n;
}

// sqlite answers 0/1, postgres true/false.
const flag = (value: unknown): boolean => value === true || value === 1 || value === '1' || value === 't';

/**
 * `authn_webauthn_credential` and `authn_webauthn_user` for authn-webauthn (plan 09). Rows are keyed by the SHA-256
 * of the credential id; the counter is written by compare-and-set. The user handle of an identity is created once and
 * kept after its credentials are gone.
 */
@Singleton()
@Injectable()
export class DbWebAuthnStore {
  private readonly connection: StoreConnection;

  /** DI passes nothing: the Orm's `'default'` connection is resolved on first use. */
  constructor(driver?: OrmDriver, options: StoreOptions = {}) {
    this.connection = new StoreConnection('DbWebAuthnStore', driver, options.container);
  }

  public async list(id: IdentityRef): Promise<WebAuthnCredentialRow[]> {
    const identity = identityKey(id);
    const { driver, dialect } = await this.connection.get();
    const rows = (await this.select(driver, dialect).where('identity', identity)) as Record<string, unknown>[];
    return rows
      .filter((r) => r.identity === identity)
      .map((r) => this.row(dialect, r))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  public async find(credentialId: string): Promise<WebAuthnCredentialRow | null> {
    const hash = hashOf(credentialId);
    const { driver, dialect } = await this.connection.get();
    const rows = (await this.select(driver, dialect).where('credential_hash', hash)) as Record<string, unknown>[];
    const r = rows.find((x) => String(x.credential_id) === credentialId);
    return r ? this.row(dialect, r) : null;
  }

  public async add(c: NewWebAuthnCredentialRow, at: Date): Promise<boolean> {
    const identity = identityKey(c.identity);
    const hash = hashOf(c.credentialId);
    checkedText(c.publicKey, Number.MAX_SAFE_INTEGER, 'DbWebAuthnStore: publicKey');
    checkedCount(c.signCount, 'signCount');
    const transports = c.transports.join(',');
    checkedText(transports, 255, 'DbWebAuthnStore: transports', true);
    checkedText(c.aaguid, 36, 'DbWebAuthnStore: aaguid');
    if (c.name !== null) checkedText(c.name, NAME_MAX, 'DbWebAuthnStore: name');
    const t = sqlTime(checkedMs(at, 'DbWebAuthnStore.add: at'));
    const { driver } = await this.connection.get();
    try {
      await driver
        .insert()
        .into(CREDENTIALS)
        .values({ id: randomUUID(), identity, credential_hash: hash, credential_id: c.credentialId, public_key: c.publicKey, sign_count: c.signCount, transports: transports === '' ? null : transports, aaguid: c.aaguid, backup_eligible: c.backupEligible, backed_up: c.backedUp, passkey: c.passkey, name: c.name, created_at: t, last_used_at: null });
      return true;
    } catch (err) {
      if (isDuplicate(err)) return false;
      throw err;
    }
  }

  public async recordUse(credentialId: string, expected: number, next: number, backedUp: boolean, at: Date): Promise<boolean> {
    const hash = hashOf(credentialId);
    checkedCount(expected, 'expected');
    checkedCount(next, 'next');
    const t = sqlTime(checkedMs(at, 'DbWebAuthnStore.recordUse: at'));
    const { driver } = await this.connection.get();
    return rowsAffected(await driver.update().in(CREDENTIALS).update({ sign_count: next, backed_up: backedUp, last_used_at: t }).where('credential_hash', hash).where('sign_count', expected)) === 1;
  }

  public async rename(id: IdentityRef, credentialId: string, name: string | null): Promise<boolean> {
    const identity = identityKey(id);
    const hash = hashOf(credentialId);
    if (name !== null) checkedText(name, NAME_MAX, 'DbWebAuthnStore: name');
    const { driver } = await this.connection.get();
    return rowsAffected(await driver.update().in(CREDENTIALS).update({ name }).where('credential_hash', hash).where('identity', identity)) === 1;
  }

  public async remove(id: IdentityRef, credentialId: string): Promise<boolean> {
    const identity = identityKey(id);
    const hash = hashOf(credentialId);
    const { driver } = await this.connection.get();
    return rowsAffected(await driver.del().from(CREDENTIALS).where('credential_hash', hash).where('identity', identity)) === 1;
  }

  public async removeAll(id: IdentityRef): Promise<number> {
    const identity = identityKey(id);
    const { driver } = await this.connection.get();
    return rowsAffected(await driver.del().from(CREDENTIALS).where('identity', identity));
  }

  public async userHandle(id: IdentityRef): Promise<string | null> {
    const identity = identityKey(id);
    const { driver } = await this.connection.get();
    const rows = (await driver.select().from(USERS).select('identity').select('user_handle').where('identity', identity)) as Record<string, unknown>[];
    const r = rows.find((x) => x.identity === identity);
    return r ? String(r.user_handle) : null;
  }

  public async ensureUserHandle(id: IdentityRef, candidate: string): Promise<string> {
    const identity = identityKey(id);
    checkedText(candidate, HANDLE_MAX, 'DbWebAuthnStore: user handle');
    if (!B64URL.test(candidate)) throw new InvalidArgument('DbWebAuthnStore: a user handle must be base64url');
    const held = await this.userHandle(id);
    if (held !== null) return held;
    const { driver } = await this.connection.get();
    try {
      await driver
        .insert()
        .into(USERS)
        .values({ identity, user_handle: candidate, created_at: sqlTime(checkedMs(new Date(), 'DbWebAuthnStore.ensureUserHandle: the clock')) });
      return candidate;
    } catch (err) {
      if (!isDuplicate(err)) throw err;
    }
    const won = await this.userHandle(id);
    if (won === null) throw new UnexpectedServerError('DbWebAuthnStore.ensureUserHandle: the user handle row vanished');
    return won;
  }

  private select(driver: OrmDriver, dialect: Dialect) {
    const q = driver.select().from(CREDENTIALS).select('identity').select('credential_id').select('public_key').select('sign_count').select('transports').select('aaguid').select('backup_eligible').select('backed_up').select('passkey').select('name');
    return selectTime(dialect, selectTime(dialect, q, 'created_at', 'created_text'), 'last_used_at', 'last_used_text');
  }

  private row(dialect: Dialect, r: Record<string, unknown>): WebAuthnCredentialRow {
    const created = columnText(dialect, r, 'created_at', 'created_text');
    const used = columnText(dialect, r, 'last_used_at', 'last_used_text');
    return Object.freeze({
      identity: parseIdentityKey(String(r.identity)),
      credentialId: String(r.credential_id),
      publicKey: String(r.public_key),
      signCount: countOf(r.sign_count),
      transports: Object.freeze(r.transports ? String(r.transports).split(',').filter((t) => t !== '') : []),
      aaguid: String(r.aaguid),
      backupEligible: flag(r.backup_eligible),
      backedUp: flag(r.backed_up),
      passkey: flag(r.passkey),
      name: r.name === null || r.name === undefined ? null : String(r.name),
      createdAt: new Date(created === null ? NaN : textMs(created)),
      lastUsedAt: used === null ? null : new Date(textMs(used)),
    });
  }
}
```

Create `packages/authn-orm/src/webauthn/index.ts`:

```ts
export * from './db-webauthn-store.js';
```

In `packages/authn-orm/src/index.ts`, after `export * from './mfa/index.js';` add:

```ts
export * from './webauthn/index.js';
```

- [ ] **Step 4: Run the authn-orm tests, the suite, rebuild**

Run: `cd packages/authn-orm && npx ts-mocha -p tsconfig.json test/webauthn-store.test.ts`
Expected: PASS for sqlite (3 passing); the postgres suite passes too, or is skipped with "Postgres … is unreachable, suite skipped".
Run: `npm test` (in `packages/authn-orm`). Expected: no new failures (`migration.test.ts` still undoes only `AuthnInitial_2026_10_02_00_00_00`, since `Migration.down(name)` plans the named migration alone).
Run: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. Expected: exit 0.

- [ ] **Step 5: Implement the `/db` entry of authn-webauthn**

Create `packages/authn-webauthn/src/store/db.ts`:

```ts
import { DbWebAuthnStore } from '@spinajs/authn-orm';
import { DI, Injectable, Singleton } from '@spinajs/di';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { WebAuthnCredentialStore } from './store.js';
import type { NewWebAuthnCredential, WebAuthnCredentialRecord } from './store.js';

/**
 * `WebAuthnCredentialStore` on authn-orm's tables. Only the `@spinajs/authn-webauthn/db` entry loads it, since loading
 * authn-orm registers its migrations and DB defaults.
 */
@Singleton()
@Injectable(WebAuthnCredentialStore)
export class DbWebAuthnCredentialStore extends WebAuthnCredentialStore {
  private resolved: DbWebAuthnStore | undefined;

  /** DI passes nothing: `DbWebAuthnStore` is resolved from DI on first use. */
  constructor(private readonly db?: DbWebAuthnStore) {
    super();
  }

  private store(): DbWebAuthnStore {
    return (this.resolved ??= this.db ?? DI.resolve(DbWebAuthnStore));
  }

  list(id: IdentityRef): Promise<readonly WebAuthnCredentialRecord[]> {
    return this.store().list(id);
  }

  find(credentialId: string): Promise<WebAuthnCredentialRecord | null> {
    return this.store().find(credentialId);
  }

  add(credential: NewWebAuthnCredential, at: Date): Promise<boolean> {
    return this.store().add(credential, at);
  }

  recordUse(credentialId: string, expected: number, next: number, backedUp: boolean, at: Date): Promise<boolean> {
    return this.store().recordUse(credentialId, expected, next, backedUp, at);
  }

  rename(id: IdentityRef, credentialId: string, name: string | null): Promise<boolean> {
    return this.store().rename(id, credentialId, name);
  }

  remove(id: IdentityRef, credentialId: string): Promise<boolean> {
    return this.store().remove(id, credentialId);
  }

  removeAll(id: IdentityRef): Promise<number> {
    return this.store().removeAll(id);
  }

  userHandle(id: IdentityRef): Promise<string | null> {
    return this.store().userHandle(id);
  }

  ensureUserHandle(id: IdentityRef, candidate: string): Promise<string> {
    return this.store().ensureUserHandle(id, candidate);
  }
}
```

Create `packages/authn-webauthn/src/db.ts`:

```ts
export * from './store/db.js';
```

- [ ] **Step 6: Run the authn-webauthn tests**

Run: `cd packages/authn-webauthn && npx ts-mocha -p tsconfig.json test/db-store.test.ts`
Expected: PASS, 8 passing.
Run: `npm test`. Expected: all passing.

- [ ] **Step 7: Commit**

```bash
unix2dos packages/authn-orm/src/migrations/AuthnWebAuthn_2026_10_06_00_00_00.ts packages/authn-orm/src/webauthn/*.ts packages/authn-orm/test/webauthn-store.test.ts packages/authn-webauthn/src/store/db.ts packages/authn-webauthn/src/db.ts packages/authn-webauthn/test/db-store.test.ts packages/authn-webauthn/test/support/sqlite.ts
git add packages/authn-orm/src/migrations packages/authn-orm/src/webauthn packages/authn-orm/src/index.ts packages/authn-orm/test/webauthn-store.test.ts packages/authn-webauthn/src packages/authn-webauthn/test
git diff --cached --stat
git commit -m "feat(authn-orm, authn-webauthn): WebAuthn credential and user handle tables, DbWebAuthnStore and the /db entry"
```

---

### Task 6: `@spinajs/authn`: the widened `MfaStep.challenge?`, audit events and messages

**Files:**
- Modify: `packages/authn/src/contracts/mfa.ts` (`challenge?`), `src/contracts/audit.ts:21` (`AuthnEventType`)
- With plan 08 landed also: `packages/authn/src/contracts/service.ts` (`MfaChallengeResult`), `src/service/default-authn-service.ts` (`challengeMfa`)
- Create: `packages/authn/src/messages/webauthn.ts`
- Modify: `packages/authn/src/messages/catalogue.ts` (imports, `PARTS`, `DEFINITIONS`)
- Test: `packages/authn/test/contracts/mfa.test.ts` (member list, type pin), `test/contracts/audit.test.ts:23`, `test/messages/catalogue.test.ts` (`PINNED`, range test), `docs/authn/messages.md` (regenerated); with plan 08 landed also new `test/service/challenge-pass-through.test.ts`

**Interfaces:**
- Consumes: plan 03's `AuthnMessageDefinition`, `PARTS`, `DEFINITIONS`, `PINNED`; plan 08's `MfaStep.challenge?`, `MfaChallengeResult`, `challengeMfa` when it has landed.
- Produces:
  - `MfaStep.challenge?(id: IdentityRef): Promise<Readonly<Record<string, unknown>> | void>` (Decision 1)
  - with plan 08: `MfaChallengeResult` = `{ readonly status: 'sent'; readonly challenge?: Readonly<Record<string, unknown>> } | { readonly status: 'throttled'; readonly retryAfterSeconds: number } | { readonly status: 'refused' }`; `challengeMfa` returns the step's object as `challenge`
  - `AuthnEventType` members `'webauthn.register'`, `'webauthn.remove'`
  - message codes: `webauthn_registered` 1007001, `webauthn_renamed` 1007002, `webauthn_removed` 1007003, `webauthn_invalid_response` 4007001, `webauthn_limit` 4007002, `webauthn_duplicate` 4007003, `webauthn_not_found` 4007004, `webauthn_last_factor` 4007005, `webauthn_last_credential` 4007006, `webauthn_invalid_name` 4007007, `webauthn_not_discoverable` 4007008

- [ ] **Step 1: Check the prerequisites**

Run (repo root): `ls packages/authn/src/messages/catalogue.ts && grep -n "const PARTS" packages/authn/src/messages/catalogue.ts`
Expected: the file and one `const PARTS = [...] as const;` line. Otherwise plan 03 has not landed: stop.
Run: `grep -n "challenge?(id: IdentityRef)" packages/authn/src/contracts/mfa.ts`
Expected: one line (`Promise<void>`) when plan 08 has landed (**branch A**), nothing otherwise (**branch B**).

- [ ] **Step 2: Write the failing tests**

In `packages/authn/test/contracts/mfa.test.ts`:
- Branch B: in the `MfaStep` member list (`:203-212`) add after the `disable` entry `{ name: 'challenge', modifiers: [], optional: true, params: ['id'] },`; in `MfaStep members have the design types` add the pin below.
- Branch A: plan 08's pin `same<MfaStep['challenge'], ((id: IdentityRef) => Promise<void>) | undefined>(true);` becomes the pin below.

```ts
      same<MfaStep['challenge'], ((id: IdentityRef) => Promise<Readonly<Record<string, unknown>> | void>) | undefined>(true);
```

Branch A only, create `packages/authn/test/service/challenge-pass-through.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';
import { fakeHash } from '@spinajs/authn-testing';

import { MfaStep } from '../../src/index.js';
import type { AuthenticationResult, AuthnContext, IdentityRef } from '../../src/index.js';
import { bind, buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

const ctx = (): AuthnContext => ({ now: new Date(), ip: '192.0.2.10', purpose: 'login' });
const ALICE = { login: 'alice@example.test', password: 'Alice-Pass-1234' };

/** A step whose client needs the challenge back, as WebAuthn's. */
class OptionsStep extends MfaStep {
  readonly name = 'opts';

  async enrolled(): Promise<boolean> {
    return true;
  }

  async beginEnrolment(): Promise<{ provisioning: string }> {
    return { provisioning: 'stub://' };
  }

  async confirmEnrolment(): Promise<{ recoveryCodes?: readonly string[] }> {
    return {};
  }

  async verify(): Promise<boolean> {
    return false;
  }

  async challenge(id: IdentityRef): Promise<Readonly<Record<string, unknown>>> {
    return { for: id.id };
  }

  async disable(): Promise<void> {}
}

describe('AuthnService.challengeMfa passes a returned challenge through', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;

  afterEach(async () => {
    await parts?.dispose();
    parts = undefined;
  });

  it("answers { status: 'sent', challenge } with the step's object", async () => {
    parts = await buildCore({}, { register: (c) => bind(c, MfaStep, 'Step_opts', new OptionsStep()), raw: { authn: { mfa: { steps: [{ name: 'opts', service: 'Step_opts' }] } } } });
    const id = parts.identities.add({ login: ALICE.login, email: ALICE.login });
    await parts.passwords.set(id, fakeHash(ALICE.password));
    const r = (await parts.service.authenticate({ kind: 'password', login: ALICE.login, password: ALICE.password }, ctx())) as Extract<AuthenticationResult, { status: 'mfa_required' }>;
    assert.strictEqual(r.status, 'mfa_required', JSON.stringify(r));
    assert.deepStrictEqual(await parts.service.challengeMfa!(r.pending, 'opts', ctx()), { status: 'sent', challenge: { for: id.id } });
  });
});
```

In `packages/authn/test/contracts/audit.test.ts:23`, append `'webauthn.register', 'webauthn.remove'` as the last members of `EVENT_TYPES` (after `'throttle.block'` and after any member another plan appended).

In `packages/authn/test/messages/catalogue.test.ts`, add `import { WEBAUTHN_MESSAGES } from '../../src/messages/webauthn.js';`, append to `PINNED`:

```ts
  [1007001, 'webauthn_registered', 'info'],
  [1007002, 'webauthn_renamed', 'info'],
  [1007003, 'webauthn_removed', 'info'],
  [4007001, 'webauthn_invalid_response', 'error'],
  [4007002, 'webauthn_limit', 'error'],
  [4007003, 'webauthn_duplicate', 'error'],
  [4007004, 'webauthn_not_found', 'error'],
  [4007005, 'webauthn_last_factor', 'error'],
  [4007006, 'webauthn_last_credential', 'error'],
  [4007007, 'webauthn_invalid_name', 'error'],
  [4007008, 'webauthn_not_discoverable', 'error'],
```

and add to the test `'each part stays in its README range'`:

```ts
    for (const [code, d] of Object.entries(WEBAUTHN_MESSAGES) as [string, AuthnMessageDefinition][]) {
      expect(within(d.id, 1007000, 1007999) || within(d.id, 4007000, 4007999), code).to.eq(true);
    }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/mfa.test.ts test/contracts/audit.test.ts test/messages/catalogue.test.ts` (branch A: add `test/service/challenge-pass-through.test.ts`)
Expected: FAIL: the `challenge` pin does not compile (branch B: the member is missing), `AuthnEventType lists the design members` misses `webauthn.register`, `Cannot find module '../../src/messages/webauthn.js'`; branch A also `expected { status: 'sent' } to deeply equal { status: 'sent', challenge: … }`.

- [ ] **Step 4: Implement**

`packages/authn/src/contracts/mfa.ts`: branch A replaces plan 08's `challenge?` member and its doc, branch B adds it as the last member of `MfaStep` (after `disable`, where plan 08 puts it):

```ts
  /**
   * Steps whose answer covers a fresh server challenge. A step that sends a code (email, SMS) issues and sends one and
   * returns nothing; a step whose client needs the challenge (WebAuthn request options) returns it, and
   * AuthnService.challengeMfa passes it to the client. With plan 08 it is counted in the 'code' throttle flow.
   */
  challenge?(id: IdentityRef): Promise<Readonly<Record<string, unknown>> | void>;
```

Branch A only, `packages/authn/src/contracts/service.ts`, the `sent` member of `MfaChallengeResult` becomes:

```ts
export type MfaChallengeResult = { readonly status: 'sent'; readonly challenge?: Readonly<Record<string, unknown>> } | { readonly status: 'throttled'; readonly retryAfterSeconds: number } | { readonly status: 'refused' };
```

and in `DefaultAuthnService.challengeMfa` the call and the success answer become:

```ts
    let issued: Readonly<Record<string, unknown>> | void;
    try {
      issued = await s.challenge(id);
    } catch (err) {
      await this.audit(ctx, { type: 'code.request', outcome: 'failure', reason: 'step_error', ...about, data: { ...asked, error: errorClass(err) } });
      return { status: 'refused' };
    }
    await this.audit(ctx, { type: 'code.request', outcome: 'success', ...about, data: asked });
    return issued ? { status: 'sent', challenge: issued } : { status: 'sent' };
```

`packages/authn/src/contracts/audit.ts:21`: append ` | 'webauthn.register' | 'webauthn.remove'` before the closing `;` of `AuthnEventType` (after any member another plan appended).

Create `packages/authn/src/messages/webauthn.ts`:

```ts
import type { AuthnMessageDefinition } from './types.js';

// Plan 09's range (docs/auth-feat/README.md, "Message IDs"). Append only: a released id never changes its meaning.
export const WEBAUTHN_MESSAGES = {
  webauthn_registered: { id: 1007001, type: 'info', text: 'The security key was registered.' },
  webauthn_renamed: { id: 1007002, type: 'info', text: 'The security key was renamed.' },
  webauthn_removed: { id: 1007003, type: 'info', text: 'The security key was removed.' },
  webauthn_invalid_response: { id: 4007001, type: 'error', text: 'The authenticator answer could not be verified. Start again.' },
  webauthn_limit: { id: 4007002, type: 'error', text: 'No more security keys can be registered. Remove one first.' },
  webauthn_duplicate: { id: 4007003, type: 'error', text: 'This authenticator is registered already.' },
  webauthn_not_found: { id: 4007004, type: 'error', text: 'There is no such security key.' },
  webauthn_last_factor: { id: 4007005, type: 'error', text: 'This is your last second factor and your account needs one. Add another first.' },
  webauthn_last_credential: { id: 4007006, type: 'error', text: 'This passkey is your only way to sign in. Add a password or another passkey first.' },
  webauthn_invalid_name: { id: 4007007, type: 'error', text: 'A name has 1 to 64 characters.' },
  webauthn_not_discoverable: { id: 4007008, type: 'error', text: 'This authenticator cannot keep a passkey. Use another one.' },
} as const satisfies Readonly<Record<string, AuthnMessageDefinition>>;
```

In `packages/authn/src/messages/catalogue.ts` add `import { WEBAUTHN_MESSAGES } from './webauthn.js';` next to the other part imports, and append the part to both lists (keep every part other plans added):

```ts
const PARTS = [CORE_MESSAGES, PASSWORD_MESSAGES, WEBAUTHN_MESSAGES] as const;
assertDistinctMessages(PARTS);

const DEFINITIONS = { ...CORE_MESSAGES, ...PASSWORD_MESSAGES, ...WEBAUTHN_MESSAGES };
```

- [ ] **Step 5: Regenerate the docs, run the tests, rebuild, dependants**

Run: `cd packages/authn && UPDATE_GOLDEN=1 npx ts-mocha -p tsconfig.json test/messages/doc.test.ts`
Expected: PASS; `docs/authn/messages.md` gains the eleven rows.
Run: the Step 3 command again. Expected: PASS.
Run: `npm test` in `packages/authn`, then `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. Expected: no new failures, exit 0.
Run: `npm test` in `packages/authn-orm`, `packages/authn-totp`, then `packages/authn-http` (they read authn from `lib/`). Expected: no new failures; with plan 08, the `email-code` challenge still answers `{ status: 'sent' }` (its step returns nothing).

- [ ] **Step 6: Commit**

```bash
unix2dos packages/authn/src/messages/webauthn.ts
git add packages/authn/src/contracts packages/authn/src/service/default-authn-service.ts packages/authn/src/messages/webauthn.ts packages/authn/src/messages/catalogue.ts packages/authn/test/contracts packages/authn/test/messages/catalogue.test.ts docs/authn/messages.md
git add packages/authn/test/service/challenge-pass-through.test.ts 2>/dev/null || true
git diff --cached
git commit -m "feat(authn): MfaStep.challenge may return what the client needs; webauthn events and messages"
```

---

### Task 7: `WebAuthnMfaStep`

**Files:**
- Modify: `packages/authn-webauthn/src/ceremony.ts`
- Create: `packages/authn-webauthn/src/assertion.ts`, `src/step/errors.ts`, `src/step/webauthn-step.ts`, `src/step/index.ts`, `src/support/registered.ts`
- Modify: `packages/authn-webauthn/src/index.ts`
- Create: `packages/authn-webauthn/test/support/fixtures.ts`
- Test: `packages/authn-webauthn/test/step.test.ts`

**Interfaces:**
- Consumes: Task 3 `WebAuthnOptions`, `resolveWebAuthnOptions`; Task 4 store; `SecretStore`, `IdentityStore`, `MfaStep`; Task 1 `SoftAuthenticator`; `MemorySecretStore` (kit).
- Produces:
  - `ceremony.ts`: `REGISTER_PURPOSE = 'webauthn-register'`, `PASSKEY_REGISTER_PURPOSE = 'webauthn-passkey'`, `MFA_PURPOSE = 'webauthn-mfa'`, `RESPONSE_CAP = 16384`, `USER_HANDLE_BYTES = 32`, `challengeBytes(raw: string): Uint8Array<ArrayBuffer>`, `isSecretChallenge(c: string): boolean`, `parseResponse(response: unknown): Record<string, unknown> | null`, `knownTransports(v: unknown): string[]`, `sameRef(a, b): boolean`, `reportedResidentKey(r): boolean | undefined`.
  - `assertion.ts`: `interface CheckedAssertion { challenge; counter; backedUp; userHandle: string | null }`, `counterRegressed(stored: number, signed: number): boolean`, `checkAssertion(response, publicKey: string, options, requireUserVerification: boolean, challengeOk: (c: string) => boolean): Promise<CheckedAssertion | null>`.
  - `errors.ts`: `WebAuthnSignCountRegression`, `WebAuthnCredentialLimit`, `WebAuthnRegistrationRefused` (`code: string`), each with `name` set to its class name.
  - `class WebAuthnMfaStep extends MfaStep` (`name = 'webauthn'`, `@Injectable(MfaStep)`), constructor `(deps: WebAuthnStepDeps = {})` with `{ store?, secrets?, options?, identities? }`; MfaStep members; `registrationOptions(id, opts?: { passkey?: boolean }): Promise<RegistrationOptionsResult>`; `register(id, response: unknown, opts?: { name?: string | null }): Promise<RegistrationResult>`; `assertionOptions(id): Promise<PublicKeyCredentialRequestOptionsJSON>`; `challenge(id): Promise<Readonly<Record<string, unknown>>>` (the same options, for `MfaStep` callers; Decision 1); `credentialStore(): Promise<WebAuthnCredentialStore>`. `type RegistrationRefusal = 'invalid_response' | 'limit' | 'duplicate' | 'not_discoverable'`.

- [ ] **Step 1: Write the failing tests**

Create `packages/authn-webauthn/test/support/fixtures.ts`:

```ts
import type { IdentityRef } from '@spinajs/authn/contracts';
import { MemorySecretStore, SoftAuthenticator } from '@spinajs/authn-testing';
import type { SoftAuthenticatorOptions, SoftOverrides, SoftRequestOptions } from '@spinajs/authn-testing';

import { MemoryWebAuthnCredentialStore, WebAuthnMfaStep } from '../../src/index.js';
import type { WebAuthnOptions } from '../../src/index.js';

export const RP_ID = 'example.test';
export const ORIGIN = 'https://app.example.test';

export const OPTIONS: WebAuthnOptions = Object.freeze({ rpId: RP_ID, rpName: 'Example', origins: Object.freeze([ORIGIN]), timeoutSeconds: 120, attestation: 'none', maxCredentials: 3, mfa: Object.freeze({ userVerification: 'preferred' }), passkey: Object.freeze({ assurance: 'aal1' }) });

export interface StepWorld {
  readonly step: WebAuthnMfaStep;
  readonly store: MemoryWebAuthnCredentialStore;
  readonly secrets: MemorySecretStore;
}

export function stepWorld(options: WebAuthnOptions = OPTIONS): StepWorld {
  const store = new MemoryWebAuthnCredentialStore();
  const secrets = new MemorySecretStore();
  return { step: new WebAuthnMfaStep({ store, secrets, options, identities: null }), store, secrets };
}

/** Registers a new software authenticator for `id` through the step. */
export async function enrolDevice(step: WebAuthnMfaStep, id: IdentityRef, opts: Partial<SoftAuthenticatorOptions> & { readonly passkey?: boolean } = {}): Promise<SoftAuthenticator> {
  const { passkey, ...soft } = opts;
  const device = new SoftAuthenticator({ origin: ORIGIN, ...soft });
  const r = await step.registrationOptions(id, { passkey: passkey === true });
  if (!r.ok) throw new Error(`registrationOptions refused: ${r.code}`);
  const done = await step.register(id, device.create(r.options));
  if (!done.ok) throw new Error(`register refused: ${done.code}`);
  return device;
}

/** The assertion JSON, the string completeMfa hands to verify. */
export const answer = (device: SoftAuthenticator, options: unknown, over: SoftOverrides = {}): string => JSON.stringify(device.get(options as SoftRequestOptions, over));
```

Create `packages/authn-webauthn/test/step.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { SoftAuthenticator } from '@spinajs/authn-testing';

import { OPTIONS, ORIGIN, RP_ID, answer, enrolDevice, stepWorld } from './support/fixtures.js';

const ALICE: IdentityRef = { type: 'user', id: 'alice' };
const BOB: IdentityRef = { type: 'user', id: 'bob' };
const isNamed = (name: string) => (e: Error) => e.name === name;

describe('WebAuthnMfaStep', () => {
  describe('enrolment', () => {
    it('beginEnrolment provisions creation options; confirmEnrolment stores the credential', async () => {
      const { step, store } = stepWorld();
      const options = JSON.parse((await step.beginEnrolment(ALICE)).provisioning);
      assert.strictEqual(options.rp.id, RP_ID);
      assert.strictEqual(options.attestation, 'none');
      assert.deepStrictEqual(options.authenticatorSelection, { residentKey: 'discouraged', userVerification: 'preferred', requireResidentKey: false });
      assert.deepStrictEqual(options.pubKeyCredParams.map((p: { alg: number }) => p.alg), [-8, -7, -257]);
      assert.strictEqual(options.user.id, await store.userHandle(ALICE));
      assert.strictEqual(await step.enrolled(ALICE), false);
      const device = new SoftAuthenticator({ origin: ORIGIN });
      assert.deepStrictEqual(await step.confirmEnrolment(ALICE, JSON.stringify(device.create(options))), {});
      assert.strictEqual(await step.enrolled(ALICE), true);
      const [c] = await store.list(ALICE);
      assert.deepStrictEqual([c.credentialId, c.passkey, c.signCount, [...c.transports], c.aaguid], [device.credentialId, false, 0, ['internal'], '00000000-0000-0000-0000-000000000000']);
    });

    it('the user handle is random, 32 bytes, kept per identity and never the identity id', async () => {
      const { step, store } = stepWorld();
      const a = JSON.parse((await step.beginEnrolment(ALICE)).provisioning).user.id;
      assert.strictEqual(JSON.parse((await step.beginEnrolment(ALICE)).provisioning).user.id, a);
      assert.strictEqual(Buffer.from(a, 'base64url').length, 32);
      assert.notStrictEqual(a, Buffer.from(ALICE.id).toString('base64url'));
      assert.strictEqual(await store.userHandle(BOB), null);
    });

    it('lists own credentials as excludeCredentials and stops at maxCredentials', async () => {
      const { step } = stepWorld();
      const devices = [await enrolDevice(step, ALICE), await enrolDevice(step, ALICE)];
      const r = await step.registrationOptions(ALICE);
      assert.ok(r.ok);
      assert.deepStrictEqual(r.options.excludeCredentials!.map((c) => c.id), devices.map((d) => d.credentialId));
      await enrolDevice(step, ALICE);
      assert.deepStrictEqual(await step.registrationOptions(ALICE), { ok: false, code: 'limit' });
      await assert.rejects(step.beginEnrolment(ALICE), isNamed('WebAuthnCredentialLimit'));
    });

    it("refuses another origin, another identity's challenge, a used challenge and malformed answers", async () => {
      const { step } = stepWorld();
      const r = await step.registrationOptions(ALICE);
      assert.ok(r.ok);
      const device = new SoftAuthenticator({ origin: ORIGIN });
      assert.deepStrictEqual(await step.register(ALICE, device.create(r.options, { origin: 'https://evil.example.test' })), { ok: false, code: 'invalid_response' });
      assert.deepStrictEqual(await step.register(BOB, device.create(r.options)), { ok: false, code: 'invalid_response' });
      assert.strictEqual((await step.register(ALICE, device.create(r.options))).ok, true);
      assert.deepStrictEqual(await step.register(ALICE, new SoftAuthenticator({ origin: ORIGIN }).create(r.options)), { ok: false, code: 'invalid_response' });
      assert.deepStrictEqual(await step.register(ALICE, '{"id":'), { ok: false, code: 'invalid_response' });
      assert.deepStrictEqual(await step.register(ALICE, 'x'.repeat(16385)), { ok: false, code: 'invalid_response' });
      await assert.rejects(step.confirmEnrolment(ALICE, '{}'), isNamed('WebAuthnRegistrationRefused'));
    });

    it('a credential id registered to anyone answers duplicate', async () => {
      const { step } = stepWorld();
      const device = await enrolDevice(step, ALICE);
      const r = await step.registrationOptions(BOB);
      assert.ok(r.ok);
      assert.deepStrictEqual(await step.register(BOB, device.create(r.options)), { ok: false, code: 'duplicate' });
    });

    it('with mfa.userVerification required, a registration without UV is refused', async () => {
      const { step } = stepWorld({ ...OPTIONS, mfa: { userVerification: 'required' } });
      const r = await step.registrationOptions(ALICE);
      assert.ok(r.ok);
      assert.deepStrictEqual(await step.register(ALICE, new SoftAuthenticator({ origin: ORIGIN, uv: false }).create(r.options)), { ok: false, code: 'invalid_response' });
    });

    it('a passkey ceremony asks for a discoverable, verified credential and marks it', async () => {
      const { step, store } = stepWorld();
      const first = await step.registrationOptions(ALICE, { passkey: true });
      assert.ok(first.ok);
      assert.deepStrictEqual(first.options.authenticatorSelection, { residentKey: 'required', userVerification: 'required', requireResidentKey: true });
      assert.deepStrictEqual(await step.register(ALICE, new SoftAuthenticator({ origin: ORIGIN, uv: false }).create(first.options)), { ok: false, code: 'invalid_response' });
      const second = await step.registrationOptions(ALICE, { passkey: true });
      assert.ok(second.ok);
      assert.deepStrictEqual(await step.register(ALICE, new SoftAuthenticator({ origin: ORIGIN }).create(second.options, { rk: false })), { ok: false, code: 'not_discoverable' });
      const third = await step.registrationOptions(ALICE, { passkey: true });
      assert.ok(third.ok);
      const done = await step.register(ALICE, new SoftAuthenticator({ origin: ORIGIN }).create(third.options), { name: 'Phone' });
      assert.ok(done.ok);
      assert.deepStrictEqual([done.credential.passkey, done.credential.name], [true, 'Phone']);
      assert.strictEqual((await store.list(ALICE)).length, 1);
    });

    it('disable removes every credential and keeps the user handle', async () => {
      const { step, store } = stepWorld();
      await enrolDevice(step, ALICE);
      await enrolDevice(step, ALICE, { passkey: true });
      const handle = await store.userHandle(ALICE);
      await step.disable(ALICE);
      assert.strictEqual(await step.enrolled(ALICE), false);
      assert.strictEqual(await store.userHandle(ALICE), handle);
    });
  });

  describe('assertions', () => {
    it('verifies an answer over the last options once, and records the counter and the use', async () => {
      const { step, store } = stepWorld();
      const device = await enrolDevice(step, ALICE);
      const options = await step.assertionOptions(ALICE);
      assert.deepStrictEqual(options.allowCredentials!.map((c) => c.id), [device.credentialId]);
      assert.strictEqual(options.userVerification, 'preferred');
      const response = answer(device, options);
      assert.strictEqual(await step.verify(ALICE, response), true);
      assert.strictEqual(await step.verify(ALICE, response), false);
      const [c] = await store.list(ALICE);
      assert.strictEqual(c.signCount, 1);
      assert.ok(c.lastUsedAt instanceof Date);
    });

    it('new options void the unanswered ones', async () => {
      const { step } = stepWorld();
      const device = await enrolDevice(step, ALICE);
      const first = await step.assertionOptions(ALICE);
      const second = await step.assertionOptions(ALICE);
      assert.strictEqual(await step.verify(ALICE, answer(device, first)), false);
      assert.strictEqual(await step.verify(ALICE, answer(device, second)), true);
    });

    it("refuses another identity's credential, a spoilt signature, another origin, an unknown challenge and garbage", async () => {
      const { step } = stepWorld();
      const alice = await enrolDevice(step, ALICE);
      await enrolDevice(step, BOB);
      assert.strictEqual(await step.verify(BOB, answer(alice, await step.assertionOptions(BOB))), false);
      const options = await step.assertionOptions(ALICE);
      assert.strictEqual(await step.verify(ALICE, answer(alice, options, { badSignature: true })), false);
      assert.strictEqual(await step.verify(ALICE, answer(alice, options, { origin: 'https://evil.example.test' })), false);
      assert.strictEqual(await step.verify(ALICE, answer(alice, { challenge: Buffer.alloc(32).toString('base64url'), rpId: RP_ID })), false);
      assert.strictEqual(await step.verify(ALICE, 'not json'), false);
      assert.strictEqual(await step.verify(ALICE, answer(alice, options)), true, 'none of the failures burnt the challenge');
    });

    it('a signed counter at or below the stored one rejects as a clone and changes nothing; an unsigned one just fails', async () => {
      const { step, store } = stepWorld();
      const device = await enrolDevice(step, ALICE);
      assert.strictEqual(await step.verify(ALICE, answer(device, await step.assertionOptions(ALICE))), true);
      await assert.rejects(step.verify(ALICE, answer(device, await step.assertionOptions(ALICE), { counter: 1 })), isNamed('WebAuthnSignCountRegression'));
      assert.strictEqual((await store.list(ALICE))[0].signCount, 1);
      assert.strictEqual(await step.verify(ALICE, answer(device, await step.assertionOptions(ALICE), { counter: 1, badSignature: true })), false);
    });

    it('counters that stay zero keep verifying (synced passkeys)', async () => {
      const { step } = stepWorld();
      const device = await enrolDevice(step, ALICE, { counter: 'zero', synced: true });
      for (let i = 0; i < 3; i++) assert.strictEqual(await step.verify(ALICE, answer(device, await step.assertionOptions(ALICE))), true, `use ${i + 1}`);
    });

    it('with mfa.userVerification required, an answer without UV fails', async () => {
      const { step } = stepWorld({ ...OPTIONS, mfa: { userVerification: 'required' } });
      const device = await enrolDevice(step, ALICE);
      assert.strictEqual(await step.verify(ALICE, answer(device, await step.assertionOptions(ALICE), { uv: false })), false);
    });

    it('MfaStep.challenge returns the request options, so challengeMfa can pass them to the client', async () => {
      const { step } = stepWorld();
      const device = await enrolDevice(step, ALICE);
      const options = await step.challenge(ALICE);
      assert.deepStrictEqual((options.allowCredentials as { id: string }[]).map((c) => c.id), [device.credentialId]);
      assert.strictEqual(await step.verify(ALICE, answer(device, options)), true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authn-webauthn && npx ts-mocha -p tsconfig.json test/step.test.ts`
Expected: FAIL at compile time: `has no exported member 'WebAuthnMfaStep'`.

- [ ] **Step 3: Implement**

`packages/authn-webauthn/src/ceremony.ts` becomes:

```ts
import { InvalidOperation } from '@spinajs/exceptions';
import type { IdentityRef } from '@spinajs/authn/contracts';

/** COSE algorithms offered and accepted: EdDSA, ES256, RS256. Pinned, so the set does not follow the runtime's PQC support. */
export const WEBAUTHN_ALGORITHMS: readonly number[] = Object.freeze([-8, -7, -257]);

/** SecretStore purposes (authn_secret.purpose holds 32 characters); each keeps one live challenge per identity. */
export const REGISTER_PURPOSE = 'webauthn-register';
export const PASSKEY_REGISTER_PURPOSE = 'webauthn-passkey';
export const MFA_PURPOSE = 'webauthn-mfa';

/** The largest ceremony answer taken: a 1023-byte credential id twice, with room. */
export const RESPONSE_CAP = 16384;

export const USER_HANDLE_BYTES = 32;

const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** The challenge of a SecretStore secret is its 32 bytes, so clientDataJSON.challenge is the secret itself. */
export function challengeBytes(raw: string): Uint8Array<ArrayBuffer> {
  if (!SECRET.test(raw)) throw new InvalidOperation('the SecretStore must issue 32-byte base64url secrets for WebAuthn challenges');
  return new Uint8Array(Buffer.from(raw, 'base64url'));
}

export const isSecretChallenge = (challenge: string): boolean => SECRET.test(challenge);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A ceremony answer as JSON text or as an object the HTTP layer parsed; null when neither, or over RESPONSE_CAP. */
export function parseResponse(response: unknown): Record<string, unknown> | null {
  let text: string;
  try {
    text = typeof response === 'string' ? response : (JSON.stringify(response) ?? '');
  } catch {
    return null;
  }
  if (text.length === 0 || text.length > RESPONSE_CAP) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

const TRANSPORTS: ReadonlySet<string> = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

/** Known values only: they go back to clients in allowCredentials. */
export const knownTransports = (value: unknown): string[] => (Array.isArray(value) ? [...new Set(value.filter((t): t is string => typeof t === 'string' && TRANSPORTS.has(t)))] : []);

export const sameRef = (a: IdentityRef, b: IdentityRef): boolean => a.type === b.type && a.id === b.id;

/** `credProps.rk` as the client reported it; undefined when it did not. */
export function reportedResidentKey(response: Record<string, unknown>): boolean | undefined {
  const ext = response.clientExtensionResults;
  const props = isObject(ext) ? ext.credProps : undefined;
  return isObject(props) && typeof props.rk === 'boolean' ? props.rk : undefined;
}
```

Create `packages/authn-webauthn/src/assertion.ts`:

```ts
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

import type { WebAuthnOptions } from './config/options.js';

export interface CheckedAssertion {
  readonly challenge: string;
  readonly counter: number;
  readonly backedUp: boolean;
  readonly userHandle: string | null;
}

/** WebAuthn §6.1.1: a counter that does not rise while either side is non-zero. Synced passkeys always sign 0. */
export const counterRegressed = (stored: number, signed: number): boolean => (signed > 0 || stored > 0) && signed <= stored;

/**
 * Origin, rp id, flags and signature of `response` against `publicKey` (COSE, base64url), over a challenge
 * `challengeOk` accepts; null for anything else. The library gets counter 0: it would refuse a counter that does not
 * rise before checking the signature, and the caller compares counters once the signature and the challenge hold.
 */
export async function checkAssertion(response: Record<string, unknown>, publicKey: string, options: WebAuthnOptions, requireUserVerification: boolean, challengeOk: (challenge: string) => boolean): Promise<CheckedAssertion | null> {
  let seen: string | undefined;
  try {
    const r = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge: (challenge) => {
        seen = challenge;
        return challengeOk(challenge);
      },
      expectedOrigin: [...options.origins],
      expectedRPID: options.rpId,
      credential: { id: String(response.id), publicKey: new Uint8Array(Buffer.from(publicKey, 'base64url')), counter: 0 },
      requireUserVerification,
    });
    if (!r.verified || seen === undefined) return null;
    const inner = response.response as { userHandle?: unknown } | undefined;
    return { challenge: seen, counter: r.authenticationInfo.newCounter, backedUp: r.authenticationInfo.credentialBackedUp, userHandle: typeof inner?.userHandle === 'string' ? inner.userHandle : null };
  } catch {
    return null;
  }
}
```

Create `packages/authn-webauthn/src/step/errors.ts`:

```ts
import { InvalidOperation } from '@spinajs/exceptions';

/**
 * A signed counter at or below the stored one (WebAuthn §6.1.1): the authenticator may be cloned. The core audits the
 * name (`step_error` or `strategy_error`, data.error) and answers the one failure.
 */
export class WebAuthnSignCountRegression extends InvalidOperation {
  constructor(message: string) {
    super(message);
    this.name = 'WebAuthnSignCountRegression';
  }
}

/** beginEnrolment while the identity holds authn.webauthn.maxCredentials credentials. */
export class WebAuthnCredentialLimit extends InvalidOperation {
  constructor(message: string) {
    super(message);
    this.name = 'WebAuthnCredentialLimit';
  }
}

/** confirmEnrolment with an answer `register` refused; `code` is the refusal. */
export class WebAuthnRegistrationRefused extends InvalidOperation {
  constructor(public readonly code: string) {
    super(`the WebAuthn registration was refused: ${code}`);
    this.name = 'WebAuthnRegistrationRefused';
  }
}
```

Create `packages/authn-webauthn/src/support/registered.ts`:

```ts
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';

/**
 * `DI.check` stays true once `DI.unregister` has emptied a registration, and a failed resolve of an abstract class
 * leaves the class itself behind, so this counts only other registered types.
 */
export function registered(type: abstract new (...args: never[]) => unknown): boolean {
  return (DI.getRegisteredTypes(type as unknown as Class<unknown>) ?? []).some((t) => t !== (type as unknown));
}
```

Create `packages/authn-webauthn/src/step/webauthn-step.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON, VerifiedRegistrationResponse } from '@simplewebauthn/server';
import { Config, Configuration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { IdentityStore, MfaStep, SecretStore } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { authnAppEnv } from '@spinajs/authn/env';

import { checkAssertion, counterRegressed } from '../assertion.js';
import { MFA_PURPOSE, PASSKEY_REGISTER_PURPOSE, REGISTER_PURPOSE, USER_HANDLE_BYTES, WEBAUTHN_ALGORITHMS, challengeBytes, isSecretChallenge, knownTransports, parseResponse, reportedResidentKey, sameRef } from '../ceremony.js';
import { resolveWebAuthnOptions } from '../config/options.js';
import type { WebAuthnOptions } from '../config/options.js';
import { WebAuthnCredentialStore } from '../store/store.js';
import type { NewWebAuthnCredential, WebAuthnCredentialRecord } from '../store/store.js';
import { registered } from '../support/registered.js';
import { WebAuthnCredentialLimit, WebAuthnRegistrationRefused, WebAuthnSignCountRegression } from './errors.js';

/** Left out, a dependency is resolved from DI on first use; `identities: null` means none. */
export interface WebAuthnStepDeps {
  readonly store?: WebAuthnCredentialStore;
  readonly secrets?: SecretStore;
  readonly options?: WebAuthnOptions;
  readonly identities?: IdentityStore | null;
}

interface Resolved {
  readonly store: WebAuthnCredentialStore;
  readonly secrets: SecretStore;
  readonly options: WebAuthnOptions;
  readonly identities: IdentityStore | null;
}

export type RegistrationRefusal = 'invalid_response' | 'limit' | 'duplicate' | 'not_discoverable';
export type RegistrationOptionsResult = { readonly ok: true; readonly options: PublicKeyCredentialCreationOptionsJSON } | { readonly ok: false; readonly code: 'limit' };
export type RegistrationResult = { readonly ok: true; readonly credential: WebAuthnCredentialRecord } | { readonly ok: false; readonly code: RegistrationRefusal };

/**
 * WebAuthn security keys and passkeys as the MFA step 'webauthn'. Every ceremony answers a single-use SecretStore
 * challenge bound to the identity and the ceremony; a new challenge replaces the unanswered one. An answer's signature
 * is checked before its challenge is redeemed, so a wrong signature burns nothing, and counters are compared after
 * both, so neither an unsigned nor a replayed counter counts as a clone. `challenge` returns the request options,
 * which POST /auth/mfa/challenge passes to the client.
 */
@Injectable(MfaStep)
export class WebAuthnMfaStep extends MfaStep {
  readonly name = 'webauthn';

  @Config('authn.webauthn')
  protected WebAuthnConfig: unknown;

  private resolved: Resolved | null = null;

  constructor(private readonly deps: WebAuthnStepDeps = {}) {
    super();
  }

  async enrolled(id: IdentityRef): Promise<boolean> {
    const { store } = await this.resolve();
    return (await store.list(id)).length > 0;
  }

  /** `provisioning` is the JSON of the creation options; throws WebAuthnCredentialLimit at authn.webauthn.maxCredentials. */
  async beginEnrolment(id: IdentityRef): Promise<{ provisioning: string }> {
    const r = await this.registrationOptions(id);
    if (!r.ok) throw new WebAuthnCredentialLimit('the identity holds authn.webauthn.maxCredentials credentials already');
    return { provisioning: JSON.stringify(r.options) };
  }

  /** Issues no recovery codes (the recovery-code table is per identity, not per step). */
  async confirmEnrolment(id: IdentityRef, response: string): Promise<{ recoveryCodes?: readonly string[] }> {
    const r = await this.register(id, response);
    if (!r.ok) throw new WebAuthnRegistrationRefused(r.code);
    return {};
  }

  /** A passkey ceremony asks for a discoverable, user-verified credential; a second-factor one for neither. */
  async registrationOptions(id: IdentityRef, opts: { readonly passkey?: boolean } = {}): Promise<RegistrationOptionsResult> {
    const { store, secrets, options } = await this.resolve();
    const own = await store.list(id);
    if (own.length >= options.maxCredentials) return { ok: false, code: 'limit' };
    const handle = await store.ensureUserHandle(id, randomBytes(USER_HANDLE_BYTES).toString('base64url'));
    const shown = await this.shown(id);
    const raw = await secrets.issue(id, opts.passkey ? PASSKEY_REGISTER_PURPOSE : REGISTER_PURPOSE, options.timeoutSeconds);
    const created = await generateRegistrationOptions({
      rpName: options.rpName,
      rpID: options.rpId,
      userName: shown.name,
      userDisplayName: shown.displayName,
      userID: new Uint8Array(Buffer.from(handle, 'base64url')),
      challenge: challengeBytes(raw),
      timeout: options.timeoutSeconds * 1000,
      attestationType: 'none',
      excludeCredentials: own.map((c) => ({ id: c.credentialId, transports: [...c.transports] })),
      authenticatorSelection: opts.passkey ? { residentKey: 'required', userVerification: 'required' } : { residentKey: 'discouraged', userVerification: options.mfa.userVerification },
      supportedAlgorithmIDs: [...WEBAUTHN_ALGORITHMS],
    });
    return { ok: true, options: created };
  }

  /** The redeemed challenge says which ceremony it was; `name` is stored as given (WebAuthnService validates it). */
  async register(id: IdentityRef, response: unknown, opts: { readonly name?: string | null } = {}): Promise<RegistrationResult> {
    const { store, secrets, options } = await this.resolve();
    const parsed = parseResponse(response);
    if (!parsed) return { ok: false, code: 'invalid_response' };
    let seen: string | undefined;
    let verified: VerifiedRegistrationResponse;
    try {
      verified = await verifyRegistrationResponse({
        response: parsed as unknown as RegistrationResponseJSON,
        expectedChallenge: (challenge) => {
          seen = challenge;
          return isSecretChallenge(challenge);
        },
        expectedOrigin: [...options.origins],
        expectedRPID: options.rpId,
        // Decided below, once the redeemed challenge says which ceremony this is.
        requireUserVerification: false,
        supportedAlgorithmIDs: [...WEBAUTHN_ALGORITHMS],
      });
    } catch {
      return { ok: false, code: 'invalid_response' };
    }
    if (!verified.verified || seen === undefined) return { ok: false, code: 'invalid_response' };
    const info = verified.registrationInfo;
    const passkey = await secrets.redeem(id, PASSKEY_REGISTER_PURPOSE, seen);
    if (!passkey && !(await secrets.redeem(id, REGISTER_PURPOSE, seen))) return { ok: false, code: 'invalid_response' };
    if ((passkey || options.mfa.userVerification === 'required') && !info.userVerified) return { ok: false, code: 'invalid_response' };
    if (passkey && reportedResidentKey(parsed) === false) return { ok: false, code: 'not_discoverable' };
    if ((await store.list(id)).length >= options.maxCredentials) return { ok: false, code: 'limit' };
    const credential: NewWebAuthnCredential = {
      identity: { type: id.type, id: id.id },
      credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
      signCount: info.credential.counter,
      transports: knownTransports(info.credential.transports),
      aaguid: info.aaguid,
      backupEligible: info.credentialDeviceType === 'multiDevice',
      backedUp: info.credentialBackedUp,
      passkey,
      name: opts.name ?? null,
    };
    if (!(await store.add(credential, new Date()))) return { ok: false, code: 'duplicate' };
    const stored = await store.find(credential.credentialId);
    if (!stored) throw new InvalidOperation('WebAuthnMfaStep: the credential just added is gone');
    return { ok: true, credential: stored };
  }

  /** Request options over the identity's credentials; replaces unanswered ones. */
  async assertionOptions(id: IdentityRef): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const { store, secrets, options } = await this.resolve();
    const own = await store.list(id);
    const raw = await secrets.issue(id, MFA_PURPOSE, options.timeoutSeconds);
    return generateAuthenticationOptions({
      rpID: options.rpId,
      challenge: challengeBytes(raw),
      timeout: options.timeoutSeconds * 1000,
      userVerification: options.mfa.userVerification,
      allowCredentials: own.map((c) => ({ id: c.credentialId, transports: [...c.transports] })),
    });
  }

  /** What MfaStep callers get: the same options, typed as the contract's object (an interface has no index signature). */
  async challenge(id: IdentityRef): Promise<Readonly<Record<string, unknown>>> {
    return (await this.assertionOptions(id)) as unknown as Readonly<Record<string, unknown>>;
  }

  /** `response`: the JSON of an assertion over the last options of `id`. Throws WebAuthnSignCountRegression for a signed counter that does not rise. */
  async verify(id: IdentityRef, response: string): Promise<boolean> {
    const { store, secrets, options } = await this.resolve();
    const parsed = parseResponse(response);
    const record = parsed && typeof parsed.id === 'string' ? await this.findOwn(store, parsed.id, id) : null;
    if (!parsed || !record) return false;
    const used = await checkAssertion(parsed, record.publicKey, options, options.mfa.userVerification === 'required', isSecretChallenge);
    if (!used || !(await secrets.redeem(id, MFA_PURPOSE, used.challenge))) return false;
    if (counterRegressed(record.signCount, used.counter)) {
      throw new WebAuthnSignCountRegression(`WebAuthnMfaStep: counter ${used.counter} at or below the stored ${record.signCount}`);
    }
    return store.recordUse(record.credentialId, record.signCount, used.counter, used.backedUp, new Date());
  }

  /** Every credential of the identity, passkeys included (admin reset, step off); the user handle stays. */
  async disable(id: IdentityRef): Promise<void> {
    const { store } = await this.resolve();
    await store.removeAll(id);
  }

  /** The store this step reads, for WebAuthnService. */
  async credentialStore(): Promise<WebAuthnCredentialStore> {
    return (await this.resolve()).store;
  }

  private async findOwn(store: WebAuthnCredentialStore, credentialId: string, id: IdentityRef): Promise<WebAuthnCredentialRecord | null> {
    let found: WebAuthnCredentialRecord | null;
    try {
      found = await store.find(credentialId);
    } catch {
      return null;
    }
    return found && sameRef(found.identity, id) ? found : null;
  }

  private async shown(id: IdentityRef): Promise<{ name: string; displayName: string }> {
    const { identities } = await this.resolve();
    const d: { email?: string; name?: string } = identities ? await identities.display(id) : {};
    return { name: d.email || d.name || id.id, displayName: d.name || d.email || '' };
  }

  private async resolve(): Promise<Resolved> {
    if (this.resolved) return this.resolved;
    const store = this.deps.store ?? (registered(WebAuthnCredentialStore) ? await DI.resolve(WebAuthnCredentialStore) : null);
    if (!store) throw new InvalidOperation('WebAuthnMfaStep: no WebAuthnCredentialStore is registered; import "@spinajs/authn-webauthn/db" (DbWebAuthnCredentialStore) or register another');
    const secrets = this.deps.secrets ?? (registered(SecretStore) ? await DI.resolve(SecretStore) : null);
    if (!secrets) throw new InvalidOperation('WebAuthnMfaStep: no SecretStore is registered; import "@spinajs/authn-orm" (DbSecretStore) or register another');
    const options = this.deps.options ?? resolveWebAuthnOptions(this.WebAuthnConfig, authnAppEnv(await DI.resolve(Configuration)));
    const identities = this.deps.identities !== undefined ? this.deps.identities : registered(IdentityStore) ? await DI.resolve(IdentityStore) : null;
    this.resolved = { store, secrets, options, identities };
    return this.resolved;
  }
}
```

Create `packages/authn-webauthn/src/step/index.ts`:

```ts
export * from './errors.js';
export * from './webauthn-step.js';
```

`packages/authn-webauthn/src/index.ts` becomes:

```ts
export * from './ceremony.js';
export * from './assertion.js';
export * from './config/index.js';
export * from './store/index.js';
export * from './step/index.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/authn-webauthn && npx ts-mocha -p tsconfig.json test/step.test.ts`
Expected: PASS, 15 passing.
Run: `npm test`. Expected: all passing.

- [ ] **Step 5: Commit**

```bash
unix2dos packages/authn-webauthn/src/*.ts packages/authn-webauthn/src/step/*.ts packages/authn-webauthn/src/support/registered.ts packages/authn-webauthn/test/step.test.ts packages/authn-webauthn/test/support/fixtures.ts
git add packages/authn-webauthn/src packages/authn-webauthn/test
git commit -m "feat(authn-webauthn): WebAuthnMfaStep with single-use challenges and clone detection"
```

---

### Task 8: `WebAuthnService` and `authn:webauthn-reset`

**Files:**
- Create: `packages/authn-webauthn/src/service/webauthn-service.ts`, `src/service/index.ts`, `src/cli/common.ts`, `src/cli/WebAuthnReset.ts`, `src/cli/index.ts`, `src/config/authn-webauthn.ts`
- Modify: `packages/authn-webauthn/src/index.ts`
- Test: `packages/authn-webauthn/test/service.test.ts`, `packages/authn-webauthn/test/cli.test.ts`

**Interfaces:**
- Consumes: Task 7 `WebAuthnMfaStep` (`registrationOptions`, `register`, `credentialStore`), Task 4 `isCredentialId`, `CREDENTIAL_NAME_MAX`; contracts `AuthnEventSink`, `AuthnService`, `IdentityLinkStore`, `MfaStep`, `PasswordCredentialStore`, `SessionIssuer`, `isFresh`.
- Produces: `interface WebAuthnCredentialView { id; name: string | null; passkey; backedUp; transports: readonly string[]; createdAt: Date; lastUsedAt: Date | null }`; `viewOf(record)`; `credentialName(v: unknown): string | null | undefined`; result types `WebAuthnOptionsResult` (`no_session | not_fresh | limit`), `WebAuthnRegisterResult` (`no_session | invalid_name | RegistrationRefusal`), `WebAuthnListResult`, `WebAuthnRenameResult` (`no_session | invalid_name | not_found`), `WebAuthnRemoveResult` (`no_session | not_fresh | not_found | last_factor | last_credential`); `class WebAuthnService` (`@Injectable()`), constructor `(deps: WebAuthnServiceDeps = {})`: `registrationOptions(session, ctx, opts?: { passkey?: boolean }, reauth?)`, `register(session, response: unknown, ctx, name?: unknown)`, `list(session)`, `rename(session, credentialId: string, name: unknown)`, `remove(session, credentialId: string, ctx, reauth?)`, `adminReset(actor, target, ctx): Promise<{ reset: number }>`; CLI `authn:webauthn-reset <login>` (`class WebAuthnReset`).

- [ ] **Step 1: Write the failing tests**

Create `packages/authn-webauthn/test/service.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';
import type { AuthnContext, AuthnFacts, AuthnService, IdentityRef, SessionHandle } from '@spinajs/authn/contracts';
import { FakeMfaStep, MemoryLinkStore, MemoryPasswordCredentialStore, MemorySessionIssuer, RecordingEventSink, SoftAuthenticator } from '@spinajs/authn-testing';

import { WebAuthnService } from '../src/index.js';
import type { WebAuthnCredentialStore, WebAuthnMfaStep } from '../src/index.js';
import { ORIGIN, stepWorld } from './support/fixtures.js';

const ALICE: IdentityRef = { type: 'user', id: 'alice' };
const BOB: IdentityRef = { type: 'user', id: 'bob' };
const facts = (ageSeconds = 0, over: Partial<AuthnFacts> = {}): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(Date.now() - ageSeconds * 1000), ...over });
const ctx = (): AuthnContext => ({ now: new Date(), ip: '192.0.2.1', purpose: 'reauth' });
const REAUTH = { kind: 'password', login: 'alice@example.test', password: 'pw' } as const;

interface World {
  readonly service: WebAuthnService;
  readonly step: WebAuthnMfaStep;
  readonly store: WebAuthnCredentialStore;
  readonly sessions: MemorySessionIssuer;
  readonly events: RecordingEventSink;
  readonly passwords: MemoryPasswordCredentialStore;
  readonly totp: FakeMfaStep;
  readonly reauth: { ok: boolean; calls: number };
}

function world(forced = false): World {
  const { step, store } = stepWorld();
  const sessions = new MemorySessionIssuer();
  const events = new RecordingEventSink();
  const passwords = new MemoryPasswordCredentialStore();
  const totp = new FakeMfaStep({ name: 'totp' });
  const reauth = { ok: true, calls: 0 };
  const authn = {
    reauthenticate: async () => {
      reauth.calls++;
      return reauth.ok;
    },
  } as unknown as AuthnService;
  const service = new WebAuthnService({ step, steps: [step, totp], sessions, authn, sinks: [events], passwords, links: new MemoryLinkStore(), maxAgeSeconds: 300, forced });
  return { service, step, store, sessions, events, passwords, totp, reauth };
}

async function addKey(w: World, session: SessionHandle, opts: { passkey?: boolean; name?: string } = {}): Promise<SoftAuthenticator> {
  const o = await w.service.registrationOptions(session, ctx(), { passkey: opts.passkey });
  assert.ok(o.ok, JSON.stringify(o));
  const device = new SoftAuthenticator({ origin: ORIGIN });
  const r = await w.service.register(session, device.create(o.options), ctx(), opts.name);
  assert.ok(r.ok, JSON.stringify(r));
  return device;
}

describe('WebAuthnService', () => {
  it('registers on a fresh session and audits webauthn.register without the credential', async () => {
    const w = world();
    const s = await w.sessions.issue(ALICE, facts());
    const device = await addKey(w, s, { name: '  Desk key  ' });
    const listed = await w.service.list(s);
    assert.ok(listed.ok);
    assert.deepStrictEqual(listed.credentials.map((c) => [c.id, c.name, c.passkey]), [[device.credentialId, 'Desk key', false]]);
    const [e] = w.events.ofType('webauthn.register');
    assert.deepStrictEqual([e.outcome, e.identity, e.data], ['success', ALICE, { passkey: false }]);
    assert.strictEqual(JSON.stringify(w.events.all()).includes(device.credentialId), false);
  });

  it('options need fresh auth: a stale session passes only with a re-authentication that holds', async () => {
    const w = world();
    const s = await w.sessions.issue(ALICE, facts(3600));
    assert.deepStrictEqual(await w.service.registrationOptions(s, ctx()), { ok: false, code: 'not_fresh' });
    w.reauth.ok = false;
    assert.deepStrictEqual(await w.service.registrationOptions(s, ctx(), {}, REAUTH), { ok: false, code: 'not_fresh' });
    w.reauth.ok = true;
    assert.strictEqual((await w.service.registrationOptions(s, ctx(), {}, REAUTH)).ok, true);
    assert.strictEqual(w.reauth.calls, 2);
  });

  it('a pending session registers only a second factor, and only while enrolled in no step', async () => {
    const w = world();
    const pending = await w.sessions.issue(ALICE, facts(), { pending: { steps: ['webauthn'] } });
    assert.deepStrictEqual(await w.service.registrationOptions(pending, ctx(), { passkey: true }), { ok: false, code: 'no_session' });
    await addKey(w, pending);
    assert.deepStrictEqual(await w.service.registrationOptions(pending, ctx()), { ok: false, code: 'no_session' });
    w.totp.enrol(BOB);
    const bobPending = await w.sessions.issue(BOB, facts(), { pending: { steps: ['totp'] } });
    assert.deepStrictEqual(await w.service.registrationOptions(bobPending, ctx()), { ok: false, code: 'no_session' });
    assert.deepStrictEqual(await w.service.list(pending), { ok: false, code: 'no_session' });
  });

  it('an impersonated session gets nothing', async () => {
    const w = world();
    const s = await w.sessions.issue(ALICE, facts(0, { impersonator: { type: 'user', id: 'admin' } }));
    assert.deepStrictEqual(await w.service.registrationOptions(s, ctx()), { ok: false, code: 'no_session' });
    assert.deepStrictEqual(await w.service.list(s), { ok: false, code: 'no_session' });
  });

  it('refuses a bad name before the ceremony', async () => {
    const w = world();
    const s = await w.sessions.issue(ALICE, facts());
    for (const name of ['', '   ', 'x'.repeat(65), 42]) assert.deepStrictEqual(await w.service.register(s, {}, ctx(), name), { ok: false, code: 'invalid_name' }, JSON.stringify(name));
  });

  it("renames and removes own credentials; another identity's id or a malformed one answers not_found", async () => {
    const w = world();
    const alice = await w.sessions.issue(ALICE, facts());
    const bob = await w.sessions.issue(BOB, facts());
    const a = await addKey(w, alice);
    const b = await addKey(w, bob);
    assert.deepStrictEqual(await w.service.rename(alice, a.credentialId, 'Phone'), { ok: true });
    assert.deepStrictEqual(await w.service.rename(alice, b.credentialId, 'Mine'), { ok: false, code: 'not_found' });
    assert.deepStrictEqual(await w.service.rename(alice, 'not base64url!', 'x'), { ok: false, code: 'not_found' });
    assert.deepStrictEqual(await w.service.rename(alice, a.credentialId, ''), { ok: false, code: 'invalid_name' });
    assert.deepStrictEqual(await w.service.remove(alice, b.credentialId, ctx()), { ok: false, code: 'not_found' });
    assert.deepStrictEqual(await w.service.remove(alice, a.credentialId, ctx()), { ok: true });
    assert.deepStrictEqual(w.events.ofType('webauthn.remove').map((e) => [e.outcome, e.data]), [['success', { passkey: false }]]);
  });

  it('remove needs fresh auth', async () => {
    const w = world();
    const fresh = await w.sessions.issue(ALICE, facts());
    const device = await addKey(w, fresh);
    const stale = await w.sessions.issue(ALICE, facts(3600));
    assert.deepStrictEqual(await w.service.remove(stale, device.credentialId, ctx()), { ok: false, code: 'not_fresh' });
  });

  it('refuses removing the last passkey of an identity with no password and no link', async () => {
    const w = world();
    const s = await w.sessions.issue(ALICE, facts());
    const device = await addKey(w, s, { passkey: true });
    assert.deepStrictEqual(await w.service.remove(s, device.credentialId, ctx()), { ok: false, code: 'last_credential' });
    assert.deepStrictEqual(w.events.ofType('webauthn.remove').map((e) => [e.outcome, e.reason]), [['failure', 'last_credential']]);
    await w.passwords.set(ALICE, 'hash');
    assert.deepStrictEqual(await w.service.remove(s, device.credentialId, ctx()), { ok: true });
  });

  it('under authn.mfa.policy.force, refuses removing the last second factor unless another step is enrolled', async () => {
    const w = world(true);
    const s = await w.sessions.issue(ALICE, facts());
    const device = await addKey(w, s);
    assert.deepStrictEqual(await w.service.remove(s, device.credentialId, ctx()), { ok: false, code: 'last_factor' });
    w.totp.enrol(ALICE);
    assert.deepStrictEqual(await w.service.remove(s, device.credentialId, ctx()), { ok: true });
  });

  it('adminReset removes every credential and audits the actor', async () => {
    const w = world();
    const s = await w.sessions.issue(ALICE, facts());
    await addKey(w, s);
    await addKey(w, s, { passkey: true });
    assert.deepStrictEqual(await w.service.adminReset({ type: 'system', id: 'cli' }, ALICE, ctx()), { reset: 2 });
    assert.deepStrictEqual(await w.store.list(ALICE), []);
    const [e] = w.events.ofType('webauthn.remove');
    assert.deepStrictEqual([e.actor, e.data], [{ type: 'system', id: 'cli' }, { reset: true, count: 2 }]);
  });
});
```

Create `packages/authn-webauthn/test/cli.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';
import { FakeIdentityStore, MemorySessionIssuer, RecordingEventSink, SoftAuthenticator } from '@spinajs/authn-testing';

import { WebAuthnReset, WebAuthnService } from '../src/index.js';
import { ORIGIN, stepWorld } from './support/fixtures.js';

describe('cli: authn:webauthn-reset', () => {
  it('removes the credentials of the login, prints no secret, refuses an unknown login', async () => {
    const identities = new FakeIdentityStore();
    const alice = identities.add({ login: 'alice', email: 'alice@example.com' });
    const { step } = stepWorld();
    const sessions = new MemorySessionIssuer();
    const service = new WebAuthnService({ step, steps: [step], sessions, sinks: [new RecordingEventSink()], passwords: null, links: null, maxAgeSeconds: 300, forced: false });
    const r = await step.registrationOptions(alice);
    assert.ok(r.ok);
    assert.ok((await step.register(alice, new SoftAuthenticator({ origin: ORIGIN }).create(r.options))).ok);

    const out: string[] = [];
    const cmd = new WebAuthnReset();
    Object.defineProperty(cmd, 'Log', { value: { success: (m: string) => out.push(m) } });
    Object.defineProperty(cmd, 'Identities', { value: identities });
    Object.defineProperty(cmd, 'WebAuthn', { value: service });
    await cmd.execute('alice');
    assert.deepStrictEqual(out, ['1 WebAuthn credential(s) removed for alice']);
    assert.strictEqual(await step.enrolled(alice), false);
    await assert.rejects(cmd.execute('nobody'), /no account with login nobody/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/authn-webauthn && npx ts-mocha -p tsconfig.json test/service.test.ts test/cli.test.ts`
Expected: FAIL at compile time: `has no exported member 'WebAuthnService'` (and `WebAuthnReset`).

- [ ] **Step 3: Implement**

Create `packages/authn-webauthn/src/service/webauthn-service.ts`:

```ts
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
import { Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { AuthnEventSink, AuthnService, IdentityLinkStore, MfaStep, PasswordCredentialStore, SessionIssuer, isFresh } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnEvent, AuthnFacts, Credentials, IdentityRef, PrincipalRef, SessionHandle } from '@spinajs/authn/contracts';

import { WebAuthnMfaStep } from '../step/webauthn-step.js';
import type { RegistrationRefusal } from '../step/webauthn-step.js';
import { CREDENTIAL_NAME_MAX, isCredentialId } from '../store/memory.js';
import type { WebAuthnCredentialRecord } from '../store/store.js';
import { registered } from '../support/registered.js';

export interface WebAuthnCredentialView {
  readonly id: string;
  readonly name: string | null;
  readonly passkey: boolean;
  readonly backedUp: boolean;
  readonly transports: readonly string[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

export type WebAuthnOptionsResult = { readonly ok: true; readonly options: PublicKeyCredentialCreationOptionsJSON } | { readonly ok: false; readonly code: 'no_session' | 'not_fresh' | 'limit' };
export type WebAuthnRegisterResult = { readonly ok: true; readonly credential: WebAuthnCredentialView } | { readonly ok: false; readonly code: 'no_session' | 'invalid_name' | RegistrationRefusal };
export type WebAuthnListResult = { readonly ok: true; readonly credentials: readonly WebAuthnCredentialView[] } | { readonly ok: false; readonly code: 'no_session' };
export type WebAuthnRenameResult = { readonly ok: true } | { readonly ok: false; readonly code: 'no_session' | 'invalid_name' | 'not_found' };
export type WebAuthnRemoveResult = { readonly ok: true } | { readonly ok: false; readonly code: 'no_session' | 'not_fresh' | 'not_found' | 'last_factor' | 'last_credential' };

/** Left out, a dependency is resolved from DI on first use; `null` means none. */
export interface WebAuthnServiceDeps {
  readonly step?: WebAuthnMfaStep;
  /** Every MFA step of the app; a pending session may register only while the identity is enrolled in none. */
  readonly steps?: readonly MfaStep[];
  readonly sessions?: SessionIssuer;
  readonly authn?: AuthnService;
  readonly sinks?: readonly AuthnEventSink[];
  readonly passwords?: PasswordCredentialStore | null;
  readonly links?: IdentityLinkStore | null;
  /** `authn.freshAuth.maxAgeSeconds`. */
  readonly maxAgeSeconds?: number;
  /** `authn.mfa.policy.force`. */
  readonly forced?: boolean;
}

interface Resolved {
  readonly step: WebAuthnMfaStep;
  readonly steps: readonly MfaStep[];
  readonly sessions: SessionIssuer;
  readonly authn: AuthnService;
  readonly sinks: readonly AuthnEventSink[];
  readonly passwords: PasswordCredentialStore | null;
  readonly links: IdentityLinkStore | null;
  readonly maxAgeSeconds: number;
  readonly forced: boolean;
}

interface Current {
  readonly handle: SessionHandle;
  readonly identity: IdentityRef;
  readonly facts: AuthnFacts;
}

export const viewOf = (c: WebAuthnCredentialRecord): WebAuthnCredentialView => Object.freeze({ id: c.credentialId, name: c.name, passkey: c.passkey, backedUp: c.backedUp, transports: c.transports, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt });

/** Trimmed, 1 to 64 characters; null or absent clears the name; undefined: refused. */
export function credentialName(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  return name.length > 0 && [...name].length <= CREDENTIAL_NAME_MAX ? name : undefined;
}

/**
 * The owner's WebAuthn credentials, always those of the restored session's identity, never one the caller names.
 * Refusals are results. Options and removal need fresh auth (A13). A pending session may only register a second
 * factor, and only while the identity is enrolled in no MFA step (A09), as TotpService. A removal must not leave a
 * passkey-only identity without a way in (`last_credential`), nor, under authn.mfa.policy.force, an identity without
 * a second factor (`last_factor`). Registration counts into no throttle: an answer proves a key and guesses nothing.
 * Events never carry a credential id, key or answer (A21). `adminReset` does not check who may reset whom: the caller
 * applies the target guard (A25) first.
 */
@Injectable()
export class WebAuthnService {
  private readonly cache: { -readonly [K in keyof Resolved]?: Resolved[K] } = {};

  @Config('authn.freshAuth.maxAgeSeconds')
  protected MaxAgeSeconds: number;

  @Config('authn.mfa.policy.force')
  protected Force: boolean;

  constructor(private readonly deps: WebAuthnServiceDeps = {}) {}

  async registrationOptions(session: SessionHandle, ctx: AuthnContext, opts: { readonly passkey?: boolean } = {}, reauth?: Credentials): Promise<WebAuthnOptionsResult> {
    const step = await this.need('step');
    const c = await this.current(session, opts.passkey !== true);
    if (!c) return { ok: false, code: 'no_session' };
    if (!(await this.fresh(c, ctx, reauth))) return { ok: false, code: 'not_fresh' };
    const r = await step.registrationOptions(c.identity, { passkey: opts.passkey === true });
    return r.ok ? { ok: true, options: r.options } : { ok: false, code: r.code };
  }

  async register(session: SessionHandle, response: unknown, ctx: AuthnContext, name?: unknown): Promise<WebAuthnRegisterResult> {
    const step = await this.need('step');
    const c = await this.current(session, true);
    if (!c) return { ok: false, code: 'no_session' };
    const shown = credentialName(name);
    if (shown === undefined) return { ok: false, code: 'invalid_name' };
    const r = await step.register(c.identity, response, { name: shown });
    if (!r.ok) {
      await this.audit(ctx, c, { type: 'webauthn.register', outcome: 'failure', reason: r.code });
      return r;
    }
    await this.audit(ctx, c, { type: 'webauthn.register', outcome: 'success', data: { passkey: r.credential.passkey } });
    return { ok: true, credential: viewOf(r.credential) };
  }

  async list(session: SessionHandle): Promise<WebAuthnListResult> {
    const c = await this.current(session, false);
    if (!c) return { ok: false, code: 'no_session' };
    const store = await (await this.need('step')).credentialStore();
    return { ok: true, credentials: (await store.list(c.identity)).map(viewOf) };
  }

  async rename(session: SessionHandle, credentialId: string, name: unknown): Promise<WebAuthnRenameResult> {
    const c = await this.current(session, false);
    if (!c) return { ok: false, code: 'no_session' };
    const shown = credentialName(name);
    if (shown === undefined) return { ok: false, code: 'invalid_name' };
    const store = await (await this.need('step')).credentialStore();
    if (!isCredentialId(credentialId) || !(await store.rename(c.identity, credentialId, shown))) return { ok: false, code: 'not_found' };
    return { ok: true };
  }

  async remove(session: SessionHandle, credentialId: string, ctx: AuthnContext, reauth?: Credentials): Promise<WebAuthnRemoveResult> {
    const c = await this.current(session, false);
    if (!c) return { ok: false, code: 'no_session' };
    if (!(await this.fresh(c, ctx, reauth))) {
      await this.audit(ctx, c, { type: 'webauthn.remove', outcome: 'failure', reason: 'not_fresh' });
      return { ok: false, code: 'not_fresh' };
    }
    const store = await (await this.need('step')).credentialStore();
    const own = await store.list(c.identity);
    const target = isCredentialId(credentialId) ? own.find((x) => x.credentialId === credentialId) : undefined;
    if (!target) return { ok: false, code: 'not_found' };
    const refused = await this.lastOne(c.identity, target, own.filter((x) => x !== target));
    if (refused) {
      await this.audit(ctx, c, { type: 'webauthn.remove', outcome: 'failure', reason: refused });
      return { ok: false, code: refused };
    }
    if (!(await store.remove(c.identity, target.credentialId))) return { ok: false, code: 'not_found' };
    await this.audit(ctx, c, { type: 'webauthn.remove', outcome: 'success', data: { passkey: target.passkey } });
    return { ok: true };
  }

  /** The number of credentials removed; never returns key material (SR-10). */
  async adminReset(actor: PrincipalRef, target: IdentityRef, ctx: AuthnContext): Promise<{ reset: number }> {
    const store = await (await this.need('step')).credentialStore();
    const reset = await store.removeAll(target);
    await this.publish(ctx, { type: 'webauthn.remove', outcome: 'success', identity: target, actor, data: { reset: true, count: reset } });
    return { reset };
  }

  private async lastOne(id: IdentityRef, target: WebAuthnCredentialRecord, rest: readonly WebAuthnCredentialRecord[]): Promise<'last_credential' | 'last_factor' | null> {
    if (target.passkey && !rest.some((x) => x.passkey) && !(await this.otherLogin(id))) return 'last_credential';
    if (rest.length === 0 && (await this.need('forced')) && !(await this.enrolledElsewhere(id))) return 'last_factor';
    return null;
  }

  /** A password or an external link, as AccountLinkService counts them; keys are not counted (fails closed). */
  private async otherLogin(id: IdentityRef): Promise<boolean> {
    const passwords = await this.need('passwords');
    if (passwords && (await passwords.get(id))) return true;
    const links = await this.need('links');
    return links !== null && (await links.list(id)).length > 0;
  }

  /** The restored session, active or pending, unless it is gone or impersonated. */
  private async restored(session: SessionHandle): Promise<Current | null> {
    const id: unknown = (session as Partial<SessionHandle> | null | undefined)?.id;
    if (typeof id !== 'string' || id === '') return null;
    const s = await (await this.need('sessions')).restore(id);
    if (!s || s.facts.impersonator !== undefined || (s.handle.state !== 'active' && s.handle.state !== 'pending')) return null;
    return s;
  }

  private async current(session: SessionHandle, allowPending: boolean): Promise<Current | null> {
    const s = await this.restored(session);
    if (!s) return null;
    if (s.handle.state === 'active') return s;
    return allowPending && !(await this.enrolledAnywhere(s.identity)) ? s : null;
  }

  private async enrolledAnywhere(id: IdentityRef): Promise<boolean> {
    for (const step of await this.need('steps')) if (await step.enrolled(id)) return true;
    return false;
  }

  private async enrolledElsewhere(id: IdentityRef): Promise<boolean> {
    const own = await this.need('step');
    for (const step of await this.need('steps')) if (step !== own && step.name !== own.name && (await step.enrolled(id))) return true;
    return false;
  }

  /** `reauth` is checked only when the session is not fresh, and never for a pending one (reauthenticate refuses it). */
  private async fresh(c: Current, ctx: AuthnContext, reauth?: Credentials): Promise<boolean> {
    if (isFresh(c.facts, ctx.now, await this.need('maxAgeSeconds'))) return true;
    return c.handle.state === 'active' && reauth !== undefined && (await (await this.need('authn')).reauthenticate(c.handle, reauth, ctx));
  }

  private async audit(ctx: AuthnContext, c: Current, e: Pick<AuthnEvent, 'type' | 'outcome' | 'reason' | 'data'>): Promise<void> {
    await this.publish(ctx, { ...e, identity: c.identity, ...(c.facts.sessionHandle ? { session: c.facts.sessionHandle } : {}) });
  }

  private async publish(ctx: AuthnContext, e: Omit<AuthnEvent, 'at' | 'ip' | 'userAgent'>): Promise<void> {
    const event: AuthnEvent = { at: ctx.now, ...(ctx.ip ? { ip: ctx.ip } : {}), ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}), ...e };
    for (const sink of await this.need('sinks')) await sink.publish(event);
  }

  private async need<K extends keyof Resolved>(key: K): Promise<Resolved[K]> {
    const hit = this.cache[key];
    if (hit !== undefined) return hit as Resolved[K];
    const value = (await this.lookup(key)) as Resolved[K];
    this.cache[key] = value;
    return value;
  }

  private async lookup(key: keyof Resolved): Promise<unknown> {
    const d = this.deps;
    switch (key) {
      case 'step':
        return d.step ?? (registered(MfaStep) ? (await DI.resolve(Array.ofType(MfaStep))).find((s) => s instanceof WebAuthnMfaStep) : undefined) ?? missing('WebAuthnMfaStep');
      case 'steps':
        return d.steps ?? (registered(MfaStep) ? await DI.resolve(Array.ofType(MfaStep)) : []);
      case 'sessions':
        return d.sessions ?? (await resolveOne(SessionIssuer)) ?? missing('SessionIssuer');
      case 'authn':
        return d.authn ?? (await resolveOne(AuthnService)) ?? missing('AuthnService');
      case 'sinks':
        return d.sinks ?? (registered(AuthnEventSink) ? await DI.resolve(Array.ofType(AuthnEventSink)) : []);
      case 'passwords':
        return d.passwords !== undefined ? d.passwords : await resolveOne(PasswordCredentialStore);
      case 'links':
        return d.links !== undefined ? d.links : await resolveOne(IdentityLinkStore);
      case 'maxAgeSeconds':
        return d.maxAgeSeconds ?? this.MaxAgeSeconds;
      case 'forced':
        return d.forced ?? this.Force === true;
    }
  }
}

function missing(name: string): never {
  throw new InvalidOperation(`WebAuthnService: no ${name} is registered`);
}

async function resolveOne<T>(type: abstract new (...args: never[]) => T): Promise<T | null> {
  return registered(type) ? ((await DI.resolve(type as unknown as new () => T)) as T) : null;
}
```

Create `packages/authn-webauthn/src/service/index.ts`:

```ts
export * from './webauthn-service.js';
```

Create `packages/authn-webauthn/src/cli/common.ts`:

```ts
import type { AuthnContext, PrincipalRef } from '@spinajs/authn/contracts';

// Copies of authn-totp's CLI actor and context; authn-webauthn does not depend on authn-totp.

export const CLI_ACTOR: PrincipalRef = Object.freeze({ type: 'system', id: 'cli' });

export function cliContext(): AuthnContext {
  return { now: new Date(), purpose: 'request', userAgent: 'spinajs-cli' };
}
```

Create `packages/authn-webauthn/src/cli/WebAuthnReset.ts`:

```ts
import { Autoinject } from '@spinajs/di';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Log, Logger } from '@spinajs/log';
import { IdentityStore } from '@spinajs/authn/contracts';

import { WebAuthnService } from '../service/webauthn-service.js';
import { CLI_ACTOR, cliContext } from './common.js';

@Command('authn:webauthn-reset', 'Removes every WebAuthn credential (security keys and passkeys) of an account')
@Argument('login', true, 'login or email')
export class WebAuthnReset extends CliCommand {
  @Logger('authn-webauthn')
  protected Log: Log;

  @Autoinject(IdentityStore)
  protected Identities: IdentityStore;

  @Autoinject(WebAuthnService)
  protected WebAuthn: WebAuthnService;

  public async execute(login: string): Promise<void> {
    if (typeof this.Identities?.findByLogin !== 'function') throw new Error('authn:webauthn-reset needs a registered IdentityStore');
    const id = await this.Identities.findByLogin(login);
    if (!id) throw new Error(`no account with login ${login}`);
    const { reset } = await this.WebAuthn.adminReset(CLI_ACTOR, id, cliContext());
    this.Log.success(reset > 0 ? `${reset} WebAuthn credential(s) removed for ${login}` : `No WebAuthn credential for ${login}`);
  }
}
```

Create `packages/authn-webauthn/src/cli/index.ts`:

```ts
export * from './WebAuthnReset.js';
```

Create `packages/authn-webauthn/src/config/authn-webauthn.ts` (the package config the configuration loader picks up, as authn-totp's):

```ts
import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authn-webauthn', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

/** Only the CLI directory: WebAuthn is off until the app lists the step or the strategy and sets authn.webauthn. */
const authnWebAuthn = {
  system: {
    dirs: {
      cli: [dir('cli')],
    },
  },
};

export default authnWebAuthn;
```

Append to `packages/authn-webauthn/src/index.ts`:

```ts
export * from './service/index.js';
export * from './cli/index.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/authn-webauthn && npx ts-mocha -p tsconfig.json test/service.test.ts test/cli.test.ts`
Expected: PASS, 11 passing.
Run: `npm test`, then `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. Expected: all passing, exit 0.

- [ ] **Step 5: Commit**

```bash
unix2dos packages/authn-webauthn/src/service/*.ts packages/authn-webauthn/src/cli/*.ts packages/authn-webauthn/src/config/authn-webauthn.ts packages/authn-webauthn/src/index.ts packages/authn-webauthn/test/service.test.ts packages/authn-webauthn/test/cli.test.ts
git add packages/authn-webauthn/src packages/authn-webauthn/test
git commit -m "feat(authn-webauthn): WebAuthnService (register, list, rename, remove, admin reset) and authn:webauthn-reset"
```

---

### Task 9: Behaviour rule A40

**Files:**
- Create: `packages/authn-testing/src/behaviour/A40-webauthn.spec.ts`
- Modify: `packages/authn-testing/src/behaviour/types.ts:8` (`RULE_IDS`), `:11` (`FACET_KINDS`), `portNames` (`:15-55`)
- Modify: `packages/authn-testing/src/harness/ports.ts` (`Harness`, new port interfaces)
- Modify: `packages/authn-testing/src/behaviour/index.ts` (import, `ALL` at `:40`)
- Test: `packages/authn-testing/test/registry.test.ts:7`, `:48-50`; `packages/authn-webauthn/test/behaviour.test.ts`

**Interfaces:**
- Consumes: Task 7 step (`beginEnrolment`, `confirmEnrolment`, `assertionOptions`, `verify`, `disable`); Task 1 `SoftAuthenticator`.
- Produces: rule `A40`, facet `A40/webauthn` (facet kind `webauthn`); ports `webauthn: WebAuthnPort`:
  - `interface WebAuthnDevicePort { answer(options: unknown, over?: { readonly counter?: number; readonly uv?: boolean }): string }`
  - `interface WebAuthnPort { readonly step: MfaStep; options(id: IdentityRef): Promise<unknown>; enrol(id: IdentityRef, opts?: { readonly counter?: 'counting' | 'zero' }): Promise<WebAuthnDevicePort> }`

A40 is the id `docs/auth-feat/README.md` assigns to this plan.

- [ ] **Step 1: Write the failing tests**

`packages/authn-testing/test/registry.test.ts`: append `'A40/webauthn'` at the end of `FACET_MAP` (`:7`) and replace the rule-id test (`:48-50`, keeping every id another plan added before `A40`):

```ts
  it('RULE_IDS are A01–A27, A30–A32 and A40 in order', () => {
    const expected = [...Array.from({ length: 27 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`), 'A30', 'A31', 'A32', 'A40'];
    assert.deepStrictEqual([...RULE_IDS], expected);
    assert.deepStrictEqual([...AUTHN_RULES.keys()], expected);
```

Create `packages/authn-webauthn/test/behaviour.test.ts`:

```ts
import 'mocha';
import { SoftAuthenticator, runAuthnBehaviour } from '@spinajs/authn-testing';
import type { Harness, SoftRequestOptions } from '@spinajs/authn-testing';

import { ORIGIN, stepWorld } from './support/fixtures.js';

function webauthnHarness(): Harness {
  const { step } = stepWorld();
  return {
    webauthn: {
      step,
      options: (id) => step.challenge(id),
      enrol: async (id, opts) => {
        const device = new SoftAuthenticator({ origin: ORIGIN, counter: opts?.counter ?? 'counting' });
        const { provisioning } = await step.beginEnrolment(id);
        await step.confirmEnrolment(id, JSON.stringify(device.create(JSON.parse(provisioning))));
        return { answer: (options, over) => JSON.stringify(device.get(options as SoftRequestOptions, over ?? {})) };
      },
    },
  };
}

runAuthnBehaviour(['A40'], webauthnHarness, { title: 'authn behaviour: WebAuthnMfaStep', facets: ['A40/webauthn'], claim: ['A40/webauthn'] });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/authn-testing && npx ts-mocha -p tsconfig.json test/registry.test.ts`
Expected: FAIL: `RULE_IDS are A01–A27, A30–A32 and A40 in order` (A40 missing).

- [ ] **Step 3: Implement**

`packages/authn-testing/src/behaviour/types.ts`: append `'A40'` to `RULE_IDS` (after the last id), append `'webauthn'` to `FACET_KINDS`, and add `webauthn: 1,` to `portNames` (before `http: 1,`).

`packages/authn-testing/src/harness/ports.ts`: in `Harness`, before `readonly http?: HttpPort;` add:

```ts
  /** A40: the lane's WebAuthn step and software authenticators registered through it. */
  readonly webauthn?: WebAuthnPort;
```

and after `MfaStoragePort` add:

```ts
/** One authenticator registered through the lane's WebAuthn step. */
export interface WebAuthnDevicePort {
  /** The assertion JSON (what completeMfa passes to verify) answering `options`; `counter` signs that value instead of the next one. */
  answer(options: unknown, over?: { readonly counter?: number; readonly uv?: boolean }): string;
}

export interface WebAuthnPort {
  readonly step: MfaStep;
  /** New request options for `id` (what POST /auth/mfa/challenge answers); they void unanswered ones. */
  options(id: IdentityRef): Promise<unknown>;
  /** Registers a new authenticator for `id`; 'zero' signs counter 0 throughout, as synced passkeys do. */
  enrol(id: IdentityRef, opts?: { readonly counter?: 'counting' | 'zero' }): Promise<WebAuthnDevicePort>;
}
```

Create `packages/authn-testing/src/behaviour/A40-webauthn.spec.ts`:

```ts
import assert from 'node:assert/strict';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { defineCase, defineRule } from './types.js';
import type { AuthnRule } from './types.js';

const A: IdentityRef = { type: 'user', id: 'a35-alice' };
const B: IdentityRef = { type: 'user', id: 'a35-bob' };
const isRegression = (e: Error) => e.name === 'WebAuthnSignCountRegression';

export const A40: AuthnRule = defineRule('A40', 'WebAuthn: options answer once and for their identity, and a signed counter never goes back', [
  defineCase({
    name: 'A40 an answer to fresh options verifies once',
    facet: 'A40/webauthn',
    needs: ['webauthn'],
    async run(h) {
      const d = await h.webauthn.enrol(A);
      const answer = d.answer(await h.webauthn.options(A));
      assert.strictEqual(await h.webauthn.step.verify(A, answer), true);
      assert.strictEqual(await h.webauthn.step.verify(A, answer), false);
    },
  }),
  defineCase({
    name: 'A40 new options void the unanswered ones',
    facet: 'A40/webauthn',
    needs: ['webauthn'],
    async run(h) {
      const d = await h.webauthn.enrol(A);
      const first = await h.webauthn.options(A);
      const second = await h.webauthn.options(A);
      assert.strictEqual(await h.webauthn.step.verify(A, d.answer(first)), false);
      assert.strictEqual(await h.webauthn.step.verify(A, d.answer(second)), true);
    },
  }),
  defineCase({
    name: "A40 an answer over another identity's options or with another identity's key fails",
    facet: 'A40/webauthn',
    needs: ['webauthn'],
    async run(h) {
      const a = await h.webauthn.enrol(A);
      await h.webauthn.enrol(B);
      const forB = await h.webauthn.options(B);
      assert.strictEqual(await h.webauthn.step.verify(A, a.answer(forB)), false);
      assert.strictEqual(await h.webauthn.step.verify(B, a.answer(forB)), false);
    },
  }),
  defineCase({
    name: 'A40 a signed counter at or below the stored one is refused as a clone',
    facet: 'A40/webauthn',
    needs: ['webauthn'],
    async run(h) {
      const d = await h.webauthn.enrol(A);
      assert.strictEqual(await h.webauthn.step.verify(A, d.answer(await h.webauthn.options(A))), true);
      await assert.rejects(h.webauthn.step.verify(A, d.answer(await h.webauthn.options(A), { counter: 1 })), isRegression);
    },
  }),
  defineCase({
    name: 'A40 counters that stay zero keep verifying',
    facet: 'A40/webauthn',
    needs: ['webauthn'],
    async run(h) {
      const d = await h.webauthn.enrol(A, { counter: 'zero' });
      for (let i = 0; i < 3; i++) assert.strictEqual(await h.webauthn.step.verify(A, d.answer(await h.webauthn.options(A))), true, `use ${i + 1}`);
    },
  }),
  defineCase({
    name: 'A40 disable leaves no credential that verifies',
    facet: 'A40/webauthn',
    needs: ['webauthn'],
    async run(h) {
      const d = await h.webauthn.enrol(A);
      const options = await h.webauthn.options(A);
      await h.webauthn.step.disable(A);
      assert.strictEqual(await h.webauthn.step.enrolled(A), false);
      assert.strictEqual(await h.webauthn.step.verify(A, d.answer(options)), false);
    },
  }),
]);
```

`packages/authn-testing/src/behaviour/index.ts`: add `import { A40 } from './A40-webauthn.spec.js';` after the `A32` import and append `A40` to `ALL` (`:40`) after the last rule.

- [ ] **Step 4: Run tests, rebuild, run the lane**

Run: `cd packages/authn-testing && npx ts-mocha -p tsconfig.json test/registry.test.ts && npm test`
Expected: PASS; no new failures.
Run: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. Expected: exit 0.
Run: `cd packages/authn-webauthn && npx ts-mocha -p tsconfig.json test/behaviour.test.ts`
Expected: PASS, 6 passing under `authn behaviour: WebAuthnMfaStep`.
Run: `npm test` in `packages/authn`, `packages/authn-totp` and `packages/authn-http` (they run behaviour rules from the kit). Expected: no new failures; A40 is not registered there (their `facets` lists omit it).

- [ ] **Step 5: Commit**

```bash
unix2dos packages/authn-testing/src/behaviour/A40-webauthn.spec.ts packages/authn-webauthn/test/behaviour.test.ts
git add packages/authn-testing/src packages/authn-testing/test/registry.test.ts packages/authn-webauthn/test/behaviour.test.ts
git diff --cached --stat
git commit -m "test(authn-testing): behaviour rule A40 for WebAuthn, run by authn-webauthn"
```

---

### Task 10: HTTP: `POST /auth/mfa/challenge` passes the WebAuthn options through; `response` on `POST /auth/mfa/verify`

**Files:**
- Modify: `packages/authn-http/package.json` (dependency `"@spinajs/authn-webauthn": "3.0.0-alpha.0"`), `tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json` (add `{ "path": "../authn-webauthn/tsconfig[.mjs|.cjs].json" }` after the authn-totp reference)
- Modify: `packages/authn-http/src/v3/routes.ts` (append), `src/v3/controllers/AuthnMfaController.ts` (`:10` import, `:51` `code` line, verify doc `:26-30`, the `mfa/challenge` route)
- Test: `packages/authn-http/test/v3-app/suites/mfa.ts`, new `test/v3-app/suites/webauthn.ts`, `test/v3-app/account.test.ts`, `test/v3-app/suites/route-table.ts:26-40`

**Interfaces:**
- Consumes: Task 6 `MfaStep.challenge?` (widened) and, with plan 08, `MfaChallengeResult.challenge`; Task 7 `WebAuthnMfaStep`, `resolveWebAuthnOptions`, `MemoryWebAuthnCredentialStore`, `WebAuthnCredentialStore`; plan 03 `refused`, `notFound`, `unauthenticated`.
- Produces: `CEREMONY_RESPONSE_CAP = 16384` and `mfaAnswerOf(req, codeCap: number): string | null` (routes.ts); `POST /auth/mfa/challenge` answers `{ Challenge }` when the step returned one; the v3-app suite helpers `webauthnOn()`, `webauthnOff()`, `listSteps(steps)`, `WEBAUTHN`, `ORIGIN`.

- [ ] **Step 1: Write the failing tests**

In `packages/authn-http/test/v3-app/suites/mfa.ts`, inside `mfaSuite`, add:

```ts
  it('verify hands a response object to the step as its JSON text, and refuses one over 16384 characters', async () => {
    const u = await seedUser();
    const c = await pending(u);
    const calls = step.verifyCalls.length;
    const answer = { id: 'x', response: { signature: 's' } };
    expect((await c.post('/auth/mfa/verify', { response: answer })).status).to.eq(401);
    expect(step.verifyCalls.slice(calls).map((x) => x.response)).to.deep.eq([JSON.stringify(answer)]);
    expect((await c.post('/auth/mfa/verify', { response: { pad: 'x'.repeat(16384) } })).status).to.eq(401);
    expect(step.verifyCalls.length).to.eq(calls + 1);
  });
```

Create `packages/authn-http/test/v3-app/suites/webauthn.ts`:

```ts
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { SecretStore } from '@spinajs/authn/contracts';
import { MemorySecretStore, SoftAuthenticator } from '@spinajs/authn-testing';
import type { SoftRequestOptions } from '@spinajs/authn-testing';
import type { MemoryWebAuthnCredentialStore } from '@spinajs/authn-webauthn';

import { AUTHN_FAILURE_BODY } from '../../../src/v3/index.js';
import { Client, bind, config, loggedIn, resetRecorders, seedUser } from '../app.js';
import type { KitUser } from '../app.js';

export const WEBAUTHN = { rpId: 'example.test', rpName: 'v3-app', origins: ['https://app.example.test'], timeoutSeconds: 120, attestation: 'none', maxCredentials: 5, mfa: { userVerification: 'preferred' }, passkey: { assurance: 'aal1' } };
export const ORIGIN = WEBAUTHN.origins[0];
const STEPS_OFF = [{ name: 'totp', service: 'V3AppMfaStep' }];
const STEPS_ON = [...STEPS_OFF, { name: 'webauthn', service: 'WebAuthnMfaStep' }];

let store: MemoryWebAuthnCredentialStore | undefined;
const secrets = new MemorySecretStore();

/** The registry, the policy and the service read authn.mfa.steps when they resolve, so each switch drops them. */
export async function listSteps(steps: readonly object[]): Promise<void> {
  config().set('authn.mfa.steps', steps);
  const { DefaultAuthnService, DefaultMfaPolicy, MfaStepRegistry } = await import('@spinajs/authn');
  DI.uncache(MfaStepRegistry);
  DI.uncache(DefaultMfaPolicy);
  DI.uncache(DefaultAuthnService);
}

/** The v3 app boots with no app env (production rules), so the configured origin is https; the soft authenticator writes it. */
export async function webauthnOn(): Promise<void> {
  if (!store) {
    const { MemoryWebAuthnCredentialStore, WebAuthnCredentialStore } = await import('@spinajs/authn-webauthn');
    const created = new MemoryWebAuthnCredentialStore();
    store = created;
    bind(WebAuthnCredentialStore, 'V3AppWebAuthnStore', () => created);
    bind(SecretStore, 'V3AppSecretStore', () => secrets);
    config().set('authn.webauthn', WEBAUTHN);
  }
  await listSteps(STEPS_ON);
}

export const webauthnOff = (): Promise<void> => listSteps(STEPS_OFF);

/** Registers a key for `u` through a step over the same store and secrets as the app's. */
async function enrolKey(u: KitUser): Promise<SoftAuthenticator> {
  const { WebAuthnMfaStep, resolveWebAuthnOptions } = await import('@spinajs/authn-webauthn');
  const step = new WebAuthnMfaStep({ store, secrets, options: resolveWebAuthnOptions(WEBAUTHN, undefined), identities: null });
  const device = new SoftAuthenticator({ origin: ORIGIN });
  const r = await step.registrationOptions(u.ref);
  if (!r.ok) throw new Error(r.code);
  const done = await step.register(u.ref, device.create(r.options));
  if (!done.ok) throw new Error(done.code);
  return device;
}

async function pendingFor(u: KitUser): Promise<Client> {
  const c = new Client();
  expect((await c.post('/auth/login', { login: u.login, password: u.password })).body).to.deep.eq({ MfaRequired: ['webauthn'] });
  return c;
}

async function webauthnChallenge(c: Client): Promise<SoftRequestOptions> {
  const res = await c.post('/auth/mfa/challenge', { step: 'webauthn' });
  expect(res.status, JSON.stringify(res.body)).to.eq(200);
  expect(res.headers['cache-control']).to.eq('no-store');
  return res.body.Challenge as SoftRequestOptions;
}

export function webauthnSuite(): void {
  beforeEach(resetRecorders);

  describe('with the webauthn step listed', () => {
    before(webauthnOn);
    after(webauthnOff);

    it('a login of an enrolled user completes with a WebAuthn answer at aal2', async () => {
      const u = await seedUser();
      const device = await enrolKey(u);
      const c = await pendingFor(u);
      const options = await webauthnChallenge(c);
      expect((options as unknown as { allowCredentials: { id: string }[] }).allowCredentials.map((x) => x.id)).to.deep.eq([device.credentialId]);
      const done = await c.post('/auth/mfa/verify', { step: 'webauthn', response: device.get(options) });
      expect(done.status, JSON.stringify(done.body)).to.eq(200);
      expect(done.body.Authn).to.include({ assurance: 'aal2' });
      expect(done.body.Authn.mfa).to.deep.eq(['webauthn']);
    });

    it('a replayed answer answers the one failure body and the session stays pending', async () => {
      const u = await seedUser();
      const device = await enrolKey(u);
      const first = await pendingFor(u);
      const answer = device.get(await webauthnChallenge(first));
      expect((await first.post('/auth/mfa/verify', { step: 'webauthn', response: answer })).status).to.eq(200);
      const second = await pendingFor(u);
      const replay = await second.post('/auth/mfa/verify', { step: 'webauthn', response: answer });
      expect(replay.status).to.eq(401);
      expect(replay.body).to.deep.eq(JSON.parse(JSON.stringify(AUTHN_FAILURE_BODY)));
      expect((await second.get('/auth')).body).to.deep.eq({ MfaRequired: ['webauthn'] });
    });

    it('the challenge route takes only a pending session: none 401, active 403', async () => {
      expect((await new Client().post('/auth/mfa/challenge', { step: 'webauthn' })).status).to.eq(401);
      const c = await loggedIn(await seedUser());
      expect((await c.post('/auth/mfa/challenge', { step: 'webauthn' })).status).to.eq(403);
    });
  });
}
```

In `packages/authn-http/test/v3-app/account.test.ts` add `import { webauthnSuite } from './suites/webauthn.js';` and, after `describe('route table', routeTableSuite);`, add:

```ts
    describe('WebAuthn', webauthnSuite);
```

In `packages/authn-http/test/v3-app/suites/route-table.ts`, add `'POST /auth/mfa/challenge',` to `ACCOUNT_ROUTES_V3` unless plan 08 added it already.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json`
Expected: FAIL: `verify hands a response object…` (the 401 comes before the step: `verifyCalls` empty) and the webauthn suite. With plan 08 landed: `POST /auth/mfa/challenge` answers `{ messages: [code_challenge_sent] }` with no `Challenge`. Without it: `expected 404 to equal 200` (no route) and the route table misses `POST /auth/mfa/challenge`.

- [ ] **Step 3: Implement**

Add the dependency and the three tsconfig references named under **Files**, then run `npm install` at the repo root (expected: exit 0).

Append to `packages/authn-http/src/v3/routes.ts`:

```ts
/** A ceremony answer sent as a JSON object (WebAuthn): longer than any code, still bounded. */
export const CEREMONY_RESPONSE_CAP = 16384;

/** `response` as JSON text when it is an object within CEREMONY_RESPONSE_CAP, else the string `code` within `codeCap`; null when neither fits. */
export function mfaAnswerOf(req: Request, codeCap: number): string | null {
  const response = bodyField(req, 'response');
  if (typeof response === 'object' && response !== null && !Array.isArray(response)) {
    const text = JSON.stringify(response);
    return text.length <= CEREMONY_RESPONSE_CAP ? text : null;
  }
  return boundedString(bodyField(req, 'code'), codeCap);
}
```

`packages/authn-http/src/v3/controllers/AuthnMfaController.ts`: add `mfaAnswerOf` to the `'../routes.js'` import (`:10`); the verify doc becomes:

```ts
  /**
   * Verify an MFA step
   * Body `{ code, step? }`, or `{ response, step? }` with a ceremony answer as a JSON object (WebAuthn, at most 16384
   * characters as JSON): `step` when it is one of the pending steps, else the first pending step.
   * @security cookieAuth
   */
```

and in `complete` the line `const code = boundedString(bodyField(req, 'code'), PASSWORD_HARD_CAP);` (`:51`) becomes:

```ts
    const code = recovery ? boundedString(bodyField(req, 'code'), PASSWORD_HARD_CAP) : mfaAnswerOf(req, PASSWORD_HARD_CAP);
```

The challenge route:

- **If plan 08 has landed** (its `@Post('mfa/challenge')` is in the controller): in `challenge`, the `sent` line becomes

```ts
    if (result.status === 'sent') return new Ok(result.challenge ? { Challenge: result.challenge } : { messages: [authnMessage('code_challenge_sent')] }, { Headers: [NO_STORE] });
```

  and its doc gains the sentence `A step whose client needs the challenge (WebAuthn) answers 200 { Challenge } with it.`

- **Otherwise** add the route after `recovery` (plan 08, landing second, moves its body onto `AuthnService.challengeMfa` and keeps the pass-through):

```ts
  /**
   * Ask for an MFA challenge
   * Body `{ step? }`, chosen as for verify. 200 `{ Challenge }` for a step whose client needs one (WebAuthn request
   * options); new options void unanswered ones. 404 for a step that issues none.
   * @security cookieAuth
   */
  @Post('mfa/challenge')
  public async challenge(@Req() req: Request) {
    const session = req.storage.AuthnSession;
    if (!session) throw unauthenticated('this route needs a pending session');
    if (session.handle.state !== 'pending') throw refused('mfa_not_pending', 'this session needs no second factor');
    const steps = await pendingSteps(this.Container, session);
    const asked = bodyField(req, 'step');
    const name = typeof asked === 'string' && steps.includes(asked) ? asked : steps[0];
    // Loaded here, not at module load: the @spinajs/authn root registers its services in every app that imports it.
    const { MfaStepRegistry } = await import('@spinajs/authn');
    const step = name === undefined ? undefined : (await this.Container.resolve(MfaStepRegistry)).get(name);
    const issued = typeof step?.challenge === 'function' ? await step.challenge(session.identity) : undefined;
    if (!issued) throw notFound('not_found', 'this step issues no challenge');
    return new Ok({ Challenge: issued }, { Headers: [NO_STORE] });
  }
```

  with `notFound` added to the `'../../policies/v3/errors.js'` import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/authn-http && npx tsc -b tsconfig.mjs.json && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json`
Expected: PASS, including the four new cases and the route table.
Run: `npm test` in `packages/authn-http`. Expected: no new failures.

- [ ] **Step 5: Commit**

```bash
unix2dos packages/authn-http/test/v3-app/suites/webauthn.ts
git add packages/authn-http/package.json packages/authn-http/tsconfig*.json packages/authn-http/src packages/authn-http/test/v3-app package-lock.json
git diff --cached --stat
git commit -m "feat(authn-http): WebAuthn options through POST /auth/mfa/challenge, answers through /auth/mfa/verify"
```

---

### Task 11: HTTP: the `/user/mfa/webauthn` credential routes

**Files:**
- Modify: `packages/authn-http/src/policies/v3/fresh-auth.ts:20` (export `passwordCredentials`)
- Modify: `packages/authn-http/src/policies/v3/groups.ts` (append `listedEntry`, `WebAuthnRoutesOn`), `src/v3/index.ts:8`
- Create: `packages/authn-http/src/v3/controllers/AuthnWebAuthnController.ts`
- Modify: `packages/authn-http/test/v3-app/app.ts` (`Client.patch`, `send` method union)
- Test: `packages/authn-http/test/v3-app/suites/webauthn.ts`, `test/v3-app/suites/route-table.ts`

**Interfaces:**
- Consumes: Task 8 `WebAuthnService` and its result codes, `WebAuthnCredentialView`; Task 6 message codes; plan 03 `errorBody`, `refused`, `notFound`, `authnFailed`, `unauthenticated`, `authnMessage` (`@spinajs/authn/messages`); `PendingMfaEnrolment`, `Authenticated`, `NoTokenAuthPolicy`, `NoImpersonationPolicy`.
- Produces: `listedEntry(entries: unknown, name: string): boolean`; `WebAuthnRoutesOn` (404 unless the step `webauthn` or the strategy `passkey` is listed); routes `GET /user/mfa/webauthn`, `POST /user/mfa/webauthn/options`, `POST /user/mfa/webauthn`, `PATCH /user/mfa/webauthn/:id`, `DELETE /user/mfa/webauthn/:id`; credential body `{ Id, Name, Passkey, BackedUp, Transports, Created, LastUsed }`; success bodies carry `messages`.

- [ ] **Step 1: Write the failing tests**

In `packages/authn-http/test/v3-app/app.ts`, give `Client` a PATCH (the suite needs it):

```ts
  public patch(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    return this.send('PATCH', path, body, headers);
  }

  public async send(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const agent = chai.request(APP_ORIGIN);
    let call = method === 'GET' ? agent.get(path) : method === 'POST' ? agent.post(path) : method === 'PATCH' ? agent.patch(path) : agent.delete(path);
```

(the rest of `send` is unchanged).

In `packages/authn-http/test/v3-app/suites/webauthn.ts` add, after `pendingFor`:

```ts
async function addKey(c: Client, name?: string): Promise<SoftAuthenticator> {
  const options = await c.post('/user/mfa/webauthn/options', {});
  expect(options.status, JSON.stringify(options.body)).to.eq(200);
  const device = new SoftAuthenticator({ origin: ORIGIN });
  const res = await c.post('/user/mfa/webauthn', { response: device.create(options.body.Options), ...(name ? { name } : {}) });
  expect(res.status, JSON.stringify(res.body)).to.eq(200);
  return device;
}

/** DefaultMfaPolicy reads authn.mfa.policy.force when built, and DefaultAuthnService keeps the policy it resolved. */
async function setForce(on: boolean): Promise<void> {
  config().set('authn.mfa.policy.force', on);
  const { DefaultAuthnService, DefaultMfaPolicy } = await import('@spinajs/authn');
  DI.uncache(DefaultMfaPolicy);
  DI.uncache(DefaultAuthnService);
}
```

add, as the first case of `webauthnSuite`:

```ts
  it('the credential routes answer 404 while neither the webauthn step nor the passkey strategy is listed', async () => {
    const c = await loggedIn(await seedUser());
    expect((await c.get('/user/mfa/webauthn')).status).to.eq(404);
    expect((await c.post('/user/mfa/webauthn/options', {})).status).to.eq(404);
  });
```

and, inside `describe('with the webauthn step listed', …)`:

```ts
    it('registers a key over HTTP, lists it, and a later login completes with it', async () => {
      const u = await seedUser();
      const c = await loggedIn(u);
      const device = await addKey(c, 'Desk key');
      const list = await c.get('/user/mfa/webauthn');
      expect(list.status).to.eq(200);
      expect(list.body).to.have.length(1);
      expect(list.body[0]).to.include({ Id: device.credentialId, Name: 'Desk key', Passkey: false, LastUsed: null });
      const d = await pendingFor(u);
      expect((await d.post('/auth/mfa/verify', { step: 'webauthn', response: device.get(await webauthnChallenge(d)) })).status).to.eq(200);
    });

    it('answers carry the message ids of the catalogue', async () => {
      const c = await loggedIn(await seedUser());
      const options = await c.post('/user/mfa/webauthn/options', {});
      const bad = await c.post('/user/mfa/webauthn', { response: new SoftAuthenticator({ origin: 'https://evil.example.test' }).create(options.body.Options) });
      expect(bad.status).to.eq(400);
      expect(bad.body.error).to.eq('webauthn_invalid_response');
      expect(bad.body.messages.map((m: { id: number }) => m.id)).to.deep.eq([4007001]);
      expect((await c.post('/user/mfa/webauthn', { response: {}, name: '' })).body.messages[0].id).to.eq(4007007);
      const ok = await c.post('/user/mfa/webauthn', { response: new SoftAuthenticator({ origin: ORIGIN }).create((await c.post('/user/mfa/webauthn/options', {})).body.Options) });
      expect(ok.body.messages).to.deep.eq([{ id: 1007001, code: 'webauthn_registered', type: 'info', text: 'The security key was registered.' }]);
    });

    it('renames and removes an own key; another id answers 404', async () => {
      const c = await loggedIn(await seedUser());
      const device = await addKey(c);
      const renamed = await c.patch(`/user/mfa/webauthn/${device.credentialId}`, { name: 'Phone' });
      expect(renamed.status, JSON.stringify(renamed.body)).to.eq(200);
      expect((await c.get('/user/mfa/webauthn')).body[0].Name).to.eq('Phone');
      const missing = await c.patch('/user/mfa/webauthn/AAAA', { name: 'x' });
      expect(missing.status).to.eq(404);
      expect(missing.body.messages[0].id).to.eq(4007004);
      const removed = await c.del(`/user/mfa/webauthn/${device.credentialId}`);
      expect(removed.status, JSON.stringify(removed.body)).to.eq(200);
      expect(removed.body.messages[0].id).to.eq(1007003);
      expect((await c.get('/user/mfa/webauthn')).body).to.deep.eq([]);
    });

    it('a pending session forced to enrol registers its first key', async () => {
      await setForce(true);
      try {
        const u = await seedUser();
        const c = new Client();
        expect((await c.post('/auth/login', { login: u.login, password: u.password })).body).to.deep.eq({ MfaRequired: ['totp'] });
        await addKey(c);
        expect((await c.get('/user/mfa/webauthn')).status, 'listing needs an active session').to.eq(401);
      } finally {
        await setForce(false);
      }
    });
```

In `packages/authn-http/test/v3-app/suites/route-table.ts` append to `ACCOUNT_ROUTES_V3`:

```ts
  'GET /user/mfa/webauthn',
  'POST /user/mfa/webauthn/options',
  'POST /user/mfa/webauthn',
  'PATCH /user/mfa/webauthn/:id',
  'DELETE /user/mfa/webauthn/:id',
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json`
Expected: FAIL: the new webauthn cases (`expected 404 to equal 200` on `/user/mfa/webauthn/options`) and the route table misses the five routes.

- [ ] **Step 3: Implement**

`packages/authn-http/src/policies/v3/fresh-auth.ts:20`: `async function passwordCredentials(` becomes `export async function passwordCredentials(`.

Append to `packages/authn-http/src/policies/v3/groups.ts` (and add `import { Configuration } from '@spinajs/configuration';` to its imports):

```ts
/** True when `entries` (authn.mfa.steps or authn.strategies) has an entry named `name`. */
export const listedEntry = (entries: unknown, name: string): boolean => Array.isArray(entries) && entries.some((e) => typeof e === 'object' && e !== null && (e as { name?: unknown }).name === name);

/** 404 unless authn.mfa.steps lists 'webauthn' or authn.strategies lists 'passkey': the WebAuthn credential routes are off. */
export class WebAuthnRoutesOn extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request, _action: IRoute, _instance: IController): Promise<void> {
    const configuration = await this.Container.resolve(Configuration);
    if (!listedEntry(configuration.get('authn.mfa.steps'), 'webauthn') && !listedEntry(configuration.get('authn.strategies'), 'passkey')) {
      throw notFound('not_found', 'WebAuthn is off: neither the webauthn step nor the passkey strategy is listed');
    }
  }
}
```

`packages/authn-http/src/v3/index.ts:8` becomes:

```ts
export { RoleSourceRegistered, ImpersonationGuardRegistered, WebAuthnRoutesOn } from '../policies/v3/groups.js';
```

Create `packages/authn-http/src/v3/controllers/AuthnWebAuthnController.ts`:

```ts
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BadRequestResponse, BaseController, BasePath, Del, Get, NotFound, Ok, Param, Patch, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import type { Credentials } from '@spinajs/authn/contracts';
import { authnMessage } from '@spinajs/authn/messages';
import type { WebAuthnCredentialView, WebAuthnService } from '@spinajs/authn-webauthn';

import { authnFailed, errorBody, notFound, refused, unauthenticated } from '../../policies/v3/errors.js';
import { REAUTH_PASSWORD_FIELD, passwordCredentials } from '../../policies/v3/fresh-auth.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy, PendingMfaEnrolment, WebAuthnRoutesOn } from '../index.js';
import { NO_STORE } from '../responses.js';
import { bodyField, contextOf } from '../routes.js';
import type { Restored } from '../routes.js';

type Refusal = 'no_session' | 'not_fresh' | 'limit' | 'invalid_response' | 'duplicate' | 'not_discoverable' | 'invalid_name' | 'not_found' | 'last_factor' | 'last_credential';

const MESSAGE_OF = {
  limit: 'webauthn_limit',
  invalid_response: 'webauthn_invalid_response',
  duplicate: 'webauthn_duplicate',
  not_discoverable: 'webauthn_not_discoverable',
  invalid_name: 'webauthn_invalid_name',
  not_found: 'webauthn_not_found',
  last_factor: 'webauthn_last_factor',
  last_credential: 'webauthn_last_credential',
} as const;

const credentialBody = (c: WebAuthnCredentialView) => ({ Id: c.id, Name: c.name, Passkey: c.passkey, BackedUp: c.backedUp, Transports: [...c.transports], Created: c.createdAt.toISOString(), LastUsed: c.lastUsedAt ? c.lastUsedAt.toISOString() : null });

/**
 * The caller's WebAuthn credentials (security keys and passkeys), on WebAuthnService (design §22.11, `/user/mfa`).
 * Off (404) unless the step `webauthn` or the strategy `passkey` is listed. Options and registration also take a
 * pending session forced to enrol (PendingMfaEnrolment); options and removal need fresh auth, or the password in
 * `reauthPassword`. Nothing here loads @spinajs/authn-webauthn before a request reaches it.
 * @tags MFA
 */
@BasePath('user/mfa/webauthn')
@Policy(WebAuthnRoutesOn)
export class AuthnWebAuthnController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  /**
   * List own WebAuthn credentials
   * Oldest first.
   * @security cookieAuth
   */
  @Get('/')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async list(@Req() req: Request) {
    const r = await (await this.service()).list(this.session(req).handle);
    if (!r.ok) throw unauthenticated('this route needs a session');
    return new Ok(r.credentials.map(credentialBody), { Headers: [NO_STORE] });
  }

  /**
   * Registration options
   * Body `{ reauthPassword? }`. PublicKeyCredentialCreationOptions for navigator.credentials.create.
   * @security cookieAuth
   */
  @Post('options')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  @Policy(PendingMfaEnrolment)
  public async options(@Req() req: Request) {
    const session = this.session(req);
    const reauth = await this.reauth(req, session);
    const r = await (await this.service()).registrationOptions(session.handle, contextOf(req, 'reauth', session.handle), { passkey: false }, reauth ?? undefined);
    if (!r.ok) return this.refusal(r.code, reauth !== null);
    return new Ok({ Options: r.options }, { Headers: [NO_STORE] });
  }

  /**
   * Register a credential
   * Body `{ response, name? }`: the navigator.credentials.create answer as JSON over the last options.
   * @security cookieAuth
   */
  @Post('/')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  @Policy(PendingMfaEnrolment)
  public async register(@Req() req: Request) {
    const session = this.session(req);
    const r = await (await this.service()).register(session.handle, bodyField(req, 'response'), contextOf(req, 'login', session.handle), bodyField(req, 'name'));
    if (!r.ok) return this.refusal(r.code, false);
    return new Ok({ Credential: credentialBody(r.credential), messages: [authnMessage('webauthn_registered')] }, { Headers: [NO_STORE] });
  }

  /**
   * Rename a credential
   * Body `{ name }`; null clears it.
   * @security cookieAuth
   */
  @Patch(':id')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async rename(@Req() req: Request, @Param() id: string) {
    const r = await (await this.service()).rename(this.session(req).handle, id, bodyField(req, 'name'));
    if (!r.ok) return this.refusal(r.code, false);
    return new Ok({ messages: [authnMessage('webauthn_renamed')] }, { Headers: [NO_STORE] });
  }

  /**
   * Remove a credential
   * Body `{ reauthPassword? }`. 403 `webauthn_last_credential` or `webauthn_last_factor` when it is the last way in.
   * @security cookieAuth
   */
  @Del(':id')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async remove(@Req() req: Request, @Param() id: string) {
    const session = this.session(req);
    const reauth = await this.reauth(req, session);
    const r = await (await this.service()).remove(session.handle, id, contextOf(req, 'reauth', session.handle), reauth ?? undefined);
    if (!r.ok) return this.refusal(r.code, reauth !== null);
    return new Ok({ messages: [authnMessage('webauthn_removed')] }, { Headers: [NO_STORE] });
  }

  protected session(req: Request): Restored {
    const session = req.storage.AuthnSession;
    if (!session) throw unauthenticated('this route needs a session');
    return session;
  }

  /** The inline re-authentication of `reauthPassword` for an active session, or null without one. */
  protected async reauth(req: Request, session: Restored): Promise<Credentials | null> {
    const password = bodyField(req, REAUTH_PASSWORD_FIELD);
    if (typeof password !== 'string' || password === '' || session.handle.state !== 'active') return null;
    const credentials = await passwordCredentials(this.Container, session.identity, password);
    // A store defect looks like a wrong password, as on the FreshAuth routes.
    if (typeof credentials === 'string') throw authnFailed();
    return credentials;
  }

  protected refusal(code: Refusal, reauthenticated: boolean) {
    if (code === 'no_session') throw unauthenticated('this route needs a session');
    if (code === 'not_fresh') {
      if (reauthenticated) throw authnFailed();
      throw refused('fresh_auth_required', 'this route needs a recent login or the password');
    }
    const message = MESSAGE_OF[code];
    const text = authnMessage(message).text;
    if (code === 'not_found') return new NotFound(errorBody(message, text));
    if (code === 'last_factor' || code === 'last_credential') throw refused(message, text);
    return new BadRequestResponse(errorBody(message, text));
  }

  protected async service(): Promise<WebAuthnService> {
    // Loaded here: an app without WebAuthn never loads @simplewebauthn/server.
    const { WebAuthnService: Service } = await import('@spinajs/authn-webauthn');
    return this.Container.resolve(Service);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/authn-http && npx tsc -b tsconfig.mjs.json && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json`
Expected: PASS, including the five new cases and the route table.
Run: `npm test` in `packages/authn-http`. Expected: no new failures.

- [ ] **Step 5: Commit**

```bash
unix2dos packages/authn-http/src/v3/controllers/AuthnWebAuthnController.ts
git add packages/authn-http/src packages/authn-http/test/v3-app
git diff --cached --stat
git commit -m "feat(authn-http): /user/mfa/webauthn routes on WebAuthnService"
```

---

### Task 12: Documentation for phase 1

**Files:**
- Create: `packages/authn-webauthn/README.md`
- Modify: `docs/authn/README.md` (package table `:61-73`, MFA section after "The TOTP step" `:303-374`, config table `:629-642`, Testing `:683-696`)

**Interfaces:** none.

- [ ] **Step 1: Write the package README**

Create `packages/authn-webauthn/README.md`:

````markdown
# @spinajs/authn-webauthn

WebAuthn security keys as the MFA step `webauthn`, and passkeys as a first factor (strategy `passkey`), on
`@simplewebauthn/server` 14.0.3. Requires Node 20 or later.

## Turning WebAuthn on

1. Set `authn.webauthn`:

   ```ts
   authn: {
     webauthn: {
       rpId: 'example.com',                      // the site host or a registrable suffix; no scheme, no port
       rpName: 'Example',
       origins: ['https://app.example.com'],     // exact origins; https unless the env is development or test
       // timeoutSeconds: 120, maxCredentials: 10, mfa: { userVerification: 'preferred' }, passkey: { assurance: 'aal1' }
     },
     mfa: { steps: [{ name: 'webauthn', service: 'WebAuthnMfaStep' }] },
   }
   ```

2. Import `@spinajs/authn-webauthn/db` once. It registers `DbWebAuthnCredentialStore` over authn-orm's
   `authn_webauthn_credential` and `authn_webauthn_user`. The challenges use authn-orm's `SecretStore`.

## Routes (3.0 HTTP layer)

| Route | Who |
|---|---|
| `GET /user/mfa/webauthn` | own active session |
| `POST /user/mfa/webauthn/options`, `POST /user/mfa/webauthn` | active session with fresh auth, or a pending session forced to enrol |
| `PATCH /user/mfa/webauthn/:id` | own active session |
| `DELETE /user/mfa/webauthn/:id` | own active session with fresh auth |
| `POST /auth/mfa/challenge` `{ step: 'webauthn' }` (answers `{ Challenge }`), then `POST /auth/mfa/verify` `{ step: 'webauthn', response }` | a pending session that waits for `webauthn` |

Answers carry `messages` from the 1007xxx and 4007xxx range (`docs/authn/messages.md`).

## Rules

- Every challenge is single use, lives `timeoutSeconds`, and is bound to the identity and the ceremony.
- A signed counter that does not rise is refused and audited (`data.error: 'WebAuthnSignCountRegression'`); counters
  that stay 0 (synced passkeys) are fine.
- No recovery codes: register more than one key. `authn:webauthn-reset <login>` removes every credential of an account.
- A removal answers `webauthn_last_credential` for the last passkey of an identity with no password and no external
  link, and `webauthn_last_factor` for the last key under `authn.mfa.policy.force`.
- Only `none` attestation: the package keeps no trust anchors.
````

- [ ] **Step 2: Update `docs/authn/README.md`**

In the package table, after the `@spinajs/authn-totp` row, add:

```markdown
| `@spinajs/authn-webauthn` | WebAuthn security keys (MFA step `webauthn`) and passkeys (strategy `passkey`). |
```

After the TOTP step subsection (before `## Tokens`), add:

```markdown
### The WebAuthn step (`authn-webauthn`)

`WebAuthnMfaStep` (`name: 'webauthn'`) keeps public keys only, so it needs no `authn.mfa.encryptionKey`. List
`{ name: 'webauthn', service: 'WebAuthnMfaStep' }`, set `authn.webauthn` (`rpId`, `rpName`, `origins`) and import
`@spinajs/authn-webauthn/db`. A pending session asks `POST /auth/mfa/challenge` `{ step: 'webauthn' }`, which
answers `{ Challenge }` (the step's `MfaStep.challenge` returns its request options), and sends the answer to
`POST /auth/mfa/verify` as `{ step: 'webauthn', response }`. Challenges are single-use `SecretStore` secrets bound to the identity and the ceremony,
redeemed only after the signature holds. A signed counter that does not rise is refused and audited
(`WebAuthnSignCountRegression`). `WebAuthnService` is the owner's side, with the TOTP rules for fresh auth and pending
sessions; events `webauthn.register` and `webauthn.remove`. Full reference: `packages/authn-webauthn/README.md`.
```

In the config table, after the `authn.mfa.*` row, add:

```markdown
| `authn.webauthn.*` | `authn-webauthn` | Own schema (`WEBAUTHN_CONFIGURATION_SCHEMA`). `origins` must be https outside development and test and sit on `rpId`. `attestation` is `none` only. |
```

In Testing, after the fakes line, add:

```markdown
- `SoftAuthenticator`: a software WebAuthn authenticator (P-256, none attestation) for ceremony tests; rule A40 runs
  against any WebAuthn step through the `webauthn` port.
```

- [ ] **Step 3: Check and commit**

Run: `grep -n "authn-webauthn" docs/authn/README.md`
Expected: the four additions.

```bash
unix2dos packages/authn-webauthn/README.md
git add packages/authn-webauthn/README.md docs/authn/README.md
git diff --cached --stat
git commit -m "docs(authn-webauthn): WebAuthn as a second factor"
```

---

## Phase 2: Passkeys as a first factor

### Task 13: Core: `passkey` credentials and a strategy's assurance

**Files:**
- Modify: `packages/authn/src/contracts/credentials.ts:5-16` (`Credentials`), `:76-93` (`StrategyOutcome`)
- Modify: `packages/authn/src/service/default-authn-service.ts:101-111` (`checkOutcome`), `:418` (`accept`)
- Test: `packages/authn/test/contracts/credentials.test.ts:46`, `:196`; new `packages/authn/test/service/strategy-assurance.test.ts`

**Interfaces:**
- Consumes: `buildCore`, `useHarnessLog`, `CoreParts` (`packages/authn/test/behaviour/harness.ts`), `FakeStrategy`.
- Produces: `Credentials` member `{ readonly kind: 'passkey'; readonly response: unknown }`; `StrategyOutcome` (ok) member `readonly assurance?: 'aal1' | 'aal2'`, honoured for interactive strategies only; any other value is a broken contract (`strategy_contract`).

- [ ] **Step 1: Write the failing tests**

In `packages/authn/test/contracts/credentials.test.ts`, the `Credentials` pin (`:46`) gains `{ readonly kind: 'passkey'; readonly response: unknown }` just before the catch-all member (after any member another plan added, e.g. plan 08's `code`). Against the base of this plan it reads:

```ts
      same<Credentials, { readonly kind: 'password'; readonly login: string; readonly password: string } | { readonly kind: 'bearer'; readonly token: string } | { readonly kind: 'jws-assertion'; readonly jws: string } | { readonly kind: 'http-signature'; readonly request: SignedRequest } | { readonly kind: 'key-challenge'; readonly keyId: string; readonly challengeId: string; readonly signature: string } | { readonly kind: 'external'; readonly provider: string; readonly payload: Readonly<Record<string, unknown>> } | { readonly kind: 'passkey'; readonly response: unknown } | { readonly kind: string; readonly [k: string]: unknown }>(true);
```

and the `StrategyOutcome` pin (`:196`) becomes:

```ts
      same<StrategyOutcome, { readonly ok: true; readonly identity?: IdentityRef; readonly external?: ExternalSubject; readonly method: string; readonly ceiling?: Ceiling; readonly delegation?: Delegation; readonly attributes?: Attributes; readonly assurance?: 'aal1' | 'aal2' } | { readonly ok: false; readonly reason: AuthnFailure }>(true);
```

Create `packages/authn/test/service/strategy-assurance.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';
import { FakeStrategy } from '@spinajs/authn-testing';

import type { AuthenticationResult, AuthnContext, IdentityRef, StrategyOutcome } from '../../src/index.js';
import { buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

type Success = Extract<AuthenticationResult, { status: 'success' }>;

const ctx = (purpose: AuthnContext['purpose'] = 'login'): AuthnContext => ({ now: new Date(), ip: '192.0.2.10', purpose });

describe('DefaultAuthnService: the assurance a strategy claims', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;

  afterEach(async () => {
    await parts?.dispose();
    parts = undefined;
  });

  async function boot(interactive: boolean, claim: unknown): Promise<CoreParts> {
    let id: IdentityRef = { type: 'user', id: 'unset' };
    const s = new FakeStrategy({ name: 'passkey', kinds: ['passkey'], interactive, keys: () => [], verify: () => ({ ok: true, identity: id, method: 'passkey', assurance: claim }) as unknown as StrategyOutcome });
    parts = await buildCore({}, { strategies: [{ name: 'passkey', service: 'Svc_passkey', instance: s, listed: true }] });
    id = parts.identities.add({ login: 'pk@example.test' });
    return parts;
  }

  const login = (p: CoreParts, purpose: AuthnContext['purpose'] = 'login'): Promise<AuthenticationResult> => p.service.authenticate({ kind: 'passkey', response: {} }, ctx(purpose));

  it("an interactive strategy's aal2 gives an aal2 session with no MFA step passed", async () => {
    const p = await boot(true, 'aal2');
    const r = await login(p);
    assert.strictEqual(r.status, 'success', JSON.stringify(r));
    assert.strictEqual((r as Success).facts.assurance, 'aal2');
    const stored = await p.sessions.restore((r as Success).session!.id);
    assert.strictEqual(stored?.facts.assurance, 'aal2');
    assert.deepStrictEqual(stored?.facts.mfa, []);
  });

  it('without a claim the session is aal1', async () => {
    const r = await login(await boot(true, undefined));
    assert.strictEqual((r as Success).facts.assurance, 'aal1');
  });

  it('a per-request strategy cannot raise the assurance', async () => {
    const r = await login(await boot(false, 'aal2'), 'request');
    assert.strictEqual(r.status, 'success', JSON.stringify(r));
    assert.strictEqual((r as Success).facts.assurance, 'aal1');
  });

  it('any other value breaks the strategy contract: the one failure, audited as strategy_contract', async () => {
    const p = await boot(true, 'aal3');
    assert.deepStrictEqual(await login(p), { status: 'failure', reason: 'invalid_credentials' });
    assert.ok(p.events.all().some((e) => e.type === 'login' && e.reason === 'strategy_contract'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/credentials.test.ts test/service/strategy-assurance.test.ts`
Expected: FAIL: compile errors on both pins (the members are missing), and `expected 'aal1' to equal 'aal2'`.

- [ ] **Step 3: Implement**

`packages/authn/src/contracts/credentials.ts`: before the catch-all member of `Credentials` add:

```ts
  /** A WebAuthn assertion of a discoverable credential, as the client's JSON. */
  | { readonly kind: 'passkey'; readonly response: unknown }
```

and in the `ok: true` member of `StrategyOutcome`, after `attributes`, add:

```ts
      /**
       * An interactive strategy whose single proof is multi-factor (a user-verified passkey, NIST SP 800-63B) may claim
       * 'aal2'; the core ignores it for per-request strategies. Default 'aal1'.
       */
      readonly assurance?: 'aal1' | 'aal2';
```

`packages/authn/src/service/default-authn-service.ts`, in `checkOutcome` after the `ceiling`/`attributes` line (`:109`):

```ts
  if (o.assurance !== undefined && o.assurance !== 'aal1' && o.assurance !== 'aal2') return null;
```

and in `accept` the line `const facts = { method: r.method, strategy: s.name, assurance: 'aal1' as const, mfa: [] as string[] };` (`:418`) becomes:

```ts
    // A token or a key the client holds proves no user presence, so only a login method may vouch for more than one factor.
    const assurance: AuthnFacts['assurance'] = s.interactive && r.assurance === 'aal2' ? 'aal2' : 'aal1';
    const facts = { method: r.method, strategy: s.name, assurance, mfa: [] as string[] };
```

- [ ] **Step 4: Run tests, the suite, rebuild, dependants**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/credentials.test.ts test/service/strategy-assurance.test.ts`
Expected: PASS.
Run: `npm test`, then `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. Expected: no new failures, exit 0.
Run: `npm test` in `packages/authn-testing`, `packages/authn-http`, `packages/authn-webauthn`, one at a time. Expected: no new failures.

- [ ] **Step 5: Commit**

```bash
unix2dos packages/authn/test/service/strategy-assurance.test.ts
git add packages/authn/src/contracts/credentials.ts packages/authn/src/service/default-authn-service.ts packages/authn/test/contracts/credentials.test.ts packages/authn/test/service/strategy-assurance.test.ts
git diff --cached
git commit -m "feat(authn): passkey credentials, and an interactive strategy may claim aal2"
```

---

### Task 14: `PasskeyStrategy`

**Files:**
- Create: `packages/authn-webauthn/src/strategy/passkey-strategy.ts`, `src/strategy/index.ts`
- Modify: `packages/authn-webauthn/src/index.ts`
- Modify: `packages/authn-testing/src/harness/ports.ts` (`PasskeyPort`), `src/behaviour/types.ts` (`portNames`), `src/behaviour/A40-webauthn.spec.ts` (passkey cases)
- Test: `packages/authn-webauthn/test/passkey-strategy.test.ts`, `test/behaviour.test.ts`

**Interfaces:**
- Consumes: Task 13 `{ kind: 'passkey', response }` and `StrategyOutcome.assurance`; Task 7 `checkAssertion`, `counterRegressed`, `parseResponse`, `isSecretChallenge`, `WebAuthnSignCountRegression`; Task 4 `isCredentialId`; Task 3 options.
- Produces: `PASSKEY_CHALLENGE_IDENTITY: IdentityRef` (`webauthn:passkey-login`); `parsePasskeyChallenge(challenge: string): { rid: string; raw: string } | null`; `class PasskeyStrategy extends AuthenticationStrategy` (`name = 'passkey'`, `kinds = ['passkey']`, `interactive = true`, `@Injectable(AuthenticationStrategy)`), constructor `(deps: PasskeyStrategyDeps = {})` with `{ store?, secrets?, options? }`, `loginOptions(): Promise<PublicKeyCredentialRequestOptionsJSON>`; port `passkey: PasskeyPort { strategy: AuthenticationStrategy; options(): Promise<unknown>; enrol(id, opts?: { passkey?: boolean }): Promise<WebAuthnDevicePort> }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/authn-webauthn/test/passkey-strategy.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';
import { createHash } from 'node:crypto';
import type { AuthnContext, Credentials, IdentityRef } from '@spinajs/authn/contracts';
import { SoftAuthenticator } from '@spinajs/authn-testing';
import type { SoftAuthenticator as Device, SoftOverrides, SoftRequestOptions } from '@spinajs/authn-testing';

import { PasskeyStrategy } from '../src/index.js';
import type { WebAuthnOptions } from '../src/index.js';
import { OPTIONS, ORIGIN, RP_ID, enrolDevice, stepWorld } from './support/fixtures.js';

const ALICE: IdentityRef = { type: 'user', id: 'alice' };
const BOB: IdentityRef = { type: 'user', id: 'bob' };
const INVALID = { ok: false, reason: 'invalid_credentials' };
const ctx = (): AuthnContext => ({ now: new Date(), ip: '192.0.2.1', purpose: 'login' });
const creds = (device: Device, options: unknown, over: SoftOverrides = {}): Credentials => ({ kind: 'passkey', response: device.get(options as SoftRequestOptions, over) });

function world(options: WebAuthnOptions = OPTIONS) {
  const w = stepWorld(options);
  return { ...w, strategy: new PasskeyStrategy({ store: w.store, secrets: w.secrets, options }) };
}

describe('PasskeyStrategy', () => {
  it('a user-verified passkey over fresh login options logs in as its identity, once', async () => {
    const { step, strategy } = world();
    const device = await enrolDevice(step, ALICE, { passkey: true });
    const c = creds(device, await strategy.loginOptions());
    assert.deepStrictEqual(await strategy.verify(c, ctx()), { ok: true, identity: ALICE, method: 'passkey' });
    assert.deepStrictEqual(await strategy.verify(c, ctx()), INVALID);
  });

  it('login options list no credential, require user verification, and parallel ones do not void each other', async () => {
    const { step, strategy } = world();
    const device = await enrolDevice(step, ALICE, { passkey: true });
    const a = await strategy.loginOptions();
    const b = await strategy.loginOptions();
    assert.deepStrictEqual(a.allowCredentials, []);
    assert.strictEqual(a.userVerification, 'required');
    assert.strictEqual(a.rpId, RP_ID);
    assert.strictEqual((await strategy.verify(creds(device, a), ctx())).ok, true);
    assert.strictEqual((await strategy.verify(creds(device, b), ctx())).ok, true);
  });

  it("refuses no user verification, a second-factor key, an unknown key, another user handle and an MFA challenge, burning nothing", async () => {
    const { step, strategy } = world();
    const passkey = await enrolDevice(step, ALICE, { passkey: true });
    const mfaKey = await enrolDevice(step, BOB);
    const options = await strategy.loginOptions();
    assert.deepStrictEqual(await strategy.verify(creds(passkey, options, { uv: false }), ctx()), INVALID);
    assert.deepStrictEqual(await strategy.verify(creds(mfaKey, options), ctx()), INVALID);
    const stranger = new SoftAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    assert.deepStrictEqual(await strategy.verify(creds(stranger, options), ctx()), INVALID);
    assert.deepStrictEqual(await strategy.verify(creds(passkey, options, { userHandle: Buffer.alloc(32, 1).toString('base64url') }), ctx()), INVALID);
    assert.deepStrictEqual(await strategy.verify(creds(passkey, await step.assertionOptions(ALICE)), ctx()), INVALID);
    assert.strictEqual((await strategy.verify(creds(passkey, options), ctx())).ok, true);
  });

  it('a signed counter that does not rise rejects as a clone', async () => {
    const { step, strategy } = world();
    const device = await enrolDevice(step, ALICE, { passkey: true });
    assert.strictEqual((await strategy.verify(creds(device, await strategy.loginOptions()), ctx())).ok, true);
    await assert.rejects(strategy.verify(creds(device, await strategy.loginOptions(), { counter: 1 }), ctx()), (e: Error) => e.name === 'WebAuthnSignCountRegression');
  });

  it('claims aal2 when authn.webauthn.passkey.assurance says so', async () => {
    const { step, strategy } = world({ ...OPTIONS, passkey: { assurance: 'aal2' } });
    const device = await enrolDevice(step, ALICE, { passkey: true });
    assert.deepStrictEqual(await strategy.verify(creds(device, await strategy.loginOptions()), ctx()), { ok: true, identity: ALICE, method: 'passkey', assurance: 'aal2' });
  });

  it('keys the throttle by a hash of the credential id, and passes other kinds on', async () => {
    const { strategy } = world();
    assert.deepStrictEqual(strategy.throttleKeys({ kind: 'passkey', response: { id: 'abc' } }), [{ kind: 'account', value: `passkey:${createHash('sha256').update('abc', 'utf8').digest('base64url')}` }]);
    assert.deepStrictEqual(strategy.throttleKeys({ kind: 'passkey', response: 'nope' }), []);
    assert.deepStrictEqual(await strategy.verify({ kind: 'password', login: 'a', password: 'b' }, ctx()), { ok: false, reason: 'unsupported_credentials' });
  });
});
```

In `packages/authn-webauthn/test/behaviour.test.ts`, import `PasskeyStrategy` from `'../src/index.js'` and give the harness the `passkey` port (`webauthnHarness` becomes):

```ts
function webauthnHarness(): Harness {
  const { step, store, secrets } = stepWorld();
  const strategy = new PasskeyStrategy({ store, secrets, options: OPTIONS });
  const device = (soft: SoftAuthenticator) => ({ answer: (options: unknown, over?: { readonly counter?: number; readonly uv?: boolean }) => JSON.stringify(soft.get(options as SoftRequestOptions, over ?? {})) });
  return {
    webauthn: {
      step,
      options: (id) => step.challenge(id),
      enrol: async (id, opts) => {
        const soft = new SoftAuthenticator({ origin: ORIGIN, counter: opts?.counter ?? 'counting' });
        const { provisioning } = await step.beginEnrolment(id);
        await step.confirmEnrolment(id, JSON.stringify(soft.create(JSON.parse(provisioning))));
        return device(soft);
      },
    },
    passkey: {
      strategy,
      options: () => strategy.loginOptions(),
      enrol: async (id, opts) => {
        const soft = new SoftAuthenticator({ origin: ORIGIN });
        const r = await step.registrationOptions(id, { passkey: opts?.passkey !== false });
        if (!r.ok) throw new Error(r.code);
        const done = await step.register(id, soft.create(r.options));
        if (!done.ok) throw new Error(done.code);
        return device(soft);
      },
    },
  };
}
```

(and import `OPTIONS` from `./support/fixtures.js`).

Append these cases to `A40` in `packages/authn-testing/src/behaviour/A40-webauthn.spec.ts`:

```ts
  defineCase({
    name: 'A40 a user-verified passkey logs in as its identity, once',
    facet: 'A40/webauthn',
    needs: ['passkey'],
    async run(h, k) {
      const d = await h.passkey.enrol(A);
      const c = { kind: 'passkey', response: JSON.parse(d.answer(await h.passkey.options())) } as const;
      const out = await h.passkey.strategy.verify(c, k.ctx());
      assert.ok(out.ok, JSON.stringify(out));
      assert.deepStrictEqual([out.identity, out.method], [A, 'passkey']);
      assert.strictEqual((await h.passkey.strategy.verify(c, k.ctx())).ok, false);
    },
  }),
  defineCase({
    name: 'A40 a passkey answer without user verification fails',
    facet: 'A40/webauthn',
    needs: ['passkey'],
    async run(h, k) {
      const d = await h.passkey.enrol(A);
      const out = await h.passkey.strategy.verify({ kind: 'passkey', response: JSON.parse(d.answer(await h.passkey.options(), { uv: false })) }, k.ctx());
      assert.strictEqual(out.ok, false);
    },
  }),
  defineCase({
    name: 'A40 a second-factor credential does not log in alone',
    facet: 'A40/webauthn',
    needs: ['passkey'],
    async run(h, k) {
      const d = await h.passkey.enrol(B, { passkey: false });
      const out = await h.passkey.strategy.verify({ kind: 'passkey', response: JSON.parse(d.answer(await h.passkey.options())) }, k.ctx());
      assert.strictEqual(out.ok, false);
    },
  }),
```

In `packages/authn-testing/src/harness/ports.ts`, in `Harness` after `webauthn` add `readonly passkey?: PasskeyPort;`, and after `WebAuthnPort` add:

```ts
export interface PasskeyPort {
  readonly strategy: AuthenticationStrategy;
  /** What POST /auth/passkey/options answers. */
  options(): Promise<unknown>;
  /** Registers an authenticator for `id` in a passkey ceremony; `passkey: false` registers a second-factor key instead. */
  enrol(id: IdentityRef, opts?: { readonly passkey?: boolean }): Promise<WebAuthnDevicePort>;
}
```

In `packages/authn-testing/src/behaviour/types.ts`, `portNames` gains `passkey: 1,` after `webauthn: 1,`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/authn-webauthn && npx ts-mocha -p tsconfig.json test/passkey-strategy.test.ts`
Expected: FAIL at compile time: `has no exported member 'PasskeyStrategy'`.

- [ ] **Step 3: Implement**

Create `packages/authn-webauthn/src/strategy/passkey-strategy.ts`:

```ts
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { Config, Configuration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { AuthenticationStrategy, SecretStore } from '@spinajs/authn/contracts';
import type { Credentials, IdentityRef, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';
import { authnAppEnv } from '@spinajs/authn/env';

import { checkAssertion, counterRegressed } from '../assertion.js';
import { isSecretChallenge, parseResponse } from '../ceremony.js';
import { resolveWebAuthnOptions } from '../config/options.js';
import type { WebAuthnOptions } from '../config/options.js';
import { WebAuthnSignCountRegression } from '../step/errors.js';
import { isCredentialId } from '../store/memory.js';
import { WebAuthnCredentialStore } from '../store/store.js';
import { registered } from '../support/registered.js';

/** The SecretStore owner of passkey login challenges: no identity is known before the assertion. */
export const PASSKEY_CHALLENGE_IDENTITY: IdentityRef = Object.freeze({ type: 'webauthn', id: 'passkey-login' });

const RID = /^[A-Za-z0-9_-]{16}$/;
const passkeyPurpose = (rid: string): string => `passkey:${rid}`;
const INVALID: StrategyOutcome = { ok: false, reason: 'invalid_credentials' };

/**
 * A passkey login challenge is `<rid>.<secret>` as UTF-8: each login has its own SecretStore purpose, so parallel logins
 * never void each other, and clientDataJSON brings the rid back.
 */
export function parsePasskeyChallenge(challenge: string): { rid: string; raw: string } | null {
  const [rid, raw, extra] = Buffer.from(challenge, 'base64url').toString('utf8').split('.');
  return extra === undefined && RID.test(rid ?? '') && isSecretChallenge(raw ?? '') ? { rid, raw } : null;
}

// An answer for an unknown credential is verified against this key, so it costs what a known one costs (A02).
const DUMMY_PUBLIC_KEY = (() => {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  const coordinate = (v: string | undefined) => new Uint8Array(Buffer.from(v ?? '', 'base64url'));
  const cose = new Map<number, number | Uint8Array>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, coordinate(jwk.x)],
    [-3, coordinate(jwk.y)],
  ]);
  return Buffer.from(isoCBOR.encode(cose as unknown as Parameters<typeof isoCBOR.encode>[0])).toString('base64url');
})();

/** Left out, a dependency is resolved from DI on first use. */
export interface PasskeyStrategyDeps {
  readonly store?: WebAuthnCredentialStore;
  readonly secrets?: SecretStore;
  readonly options?: WebAuthnOptions;
}

interface Parts {
  readonly store: WebAuthnCredentialStore;
  readonly secrets: SecretStore;
  readonly options: WebAuthnOptions;
}

/**
 * Passkey login, credentials `{ kind: 'passkey', response }`: a user-verified assertion of a credential registered in a
 * passkey ceremony, over a challenge from `loginOptions`, whose userHandle is the identity's own. Method 'passkey';
 * assurance from authn.webauthn.passkey.assurance. The throttle account is a hash of the credential id, so a success
 * gives its attempt back to the ip key; the id travels only between the owner's client and this server.
 */
@Injectable(AuthenticationStrategy)
export class PasskeyStrategy extends AuthenticationStrategy {
  readonly name = 'passkey';
  readonly kinds = ['passkey'];
  readonly interactive = true;

  @Config('authn.webauthn')
  protected WebAuthnConfig: unknown;

  private resolved: Parts | null = null;

  constructor(private readonly deps: PasskeyStrategyDeps = {}) {
    super();
  }

  throttleKeys(c: Credentials): readonly ThrottleKey[] {
    const parsed = c.kind === 'passkey' ? parseResponse((c as { response?: unknown }).response) : null;
    return parsed && typeof parsed.id === 'string' ? [{ kind: 'account', value: `passkey:${createHash('sha256').update(parsed.id, 'utf8').digest('base64url')}` }] : [];
  }

  /** What POST /auth/passkey/options answers: no allowCredentials, so the browser offers the site's passkeys (conditional UI too). */
  async loginOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const { secrets, options } = await this.parts();
    const rid = randomBytes(12).toString('base64url');
    const raw = await secrets.issue(PASSKEY_CHALLENGE_IDENTITY, passkeyPurpose(rid), options.timeoutSeconds);
    return generateAuthenticationOptions({ rpID: options.rpId, challenge: new Uint8Array(Buffer.from(`${rid}.${raw}`, 'utf8')), timeout: options.timeoutSeconds * 1000, userVerification: 'required', allowCredentials: [] });
  }

  async verify(c: Credentials): Promise<StrategyOutcome> {
    if (c.kind !== 'passkey') return { ok: false, reason: 'unsupported_credentials' };
    const { store, secrets, options } = await this.parts();
    const parsed = parseResponse((c as { response?: unknown }).response);
    const found = parsed && isCredentialId(parsed.id) ? await store.find(parsed.id) : null;
    const record = found?.passkey === true ? found : null;
    const used = await checkAssertion(parsed ?? {}, record?.publicKey ?? DUMMY_PUBLIC_KEY, options, true, (challenge) => parsePasskeyChallenge(challenge) !== null);
    if (!record || !used) return INVALID;
    if (used.userHandle === null || used.userHandle !== (await store.userHandle(record.identity))) return INVALID;
    const challenge = parsePasskeyChallenge(used.challenge);
    if (!challenge || !(await secrets.redeem(PASSKEY_CHALLENGE_IDENTITY, passkeyPurpose(challenge.rid), challenge.raw))) return INVALID;
    if (counterRegressed(record.signCount, used.counter)) {
      throw new WebAuthnSignCountRegression(`PasskeyStrategy: counter ${used.counter} at or below the stored ${record.signCount}`);
    }
    if (!(await store.recordUse(record.credentialId, record.signCount, used.counter, used.backedUp, new Date()))) return INVALID;
    return { ok: true, identity: record.identity, method: 'passkey', ...(options.passkey.assurance === 'aal2' ? { assurance: 'aal2' as const } : {}) };
  }

  // Not `resolve`: AuthenticationStrategy is an AsyncService, whose resolve() DI calls.
  private async parts(): Promise<Parts> {
    if (this.resolved) return this.resolved;
    const store = this.deps.store ?? (registered(WebAuthnCredentialStore) ? await DI.resolve(WebAuthnCredentialStore) : null);
    if (!store) throw new InvalidOperation('PasskeyStrategy: no WebAuthnCredentialStore is registered; import "@spinajs/authn-webauthn/db" (DbWebAuthnCredentialStore) or register another');
    const secrets = this.deps.secrets ?? (registered(SecretStore) ? await DI.resolve(SecretStore) : null);
    if (!secrets) throw new InvalidOperation('PasskeyStrategy: no SecretStore is registered; import "@spinajs/authn-orm" (DbSecretStore) or register another');
    const options = this.deps.options ?? resolveWebAuthnOptions(this.WebAuthnConfig, authnAppEnv(await DI.resolve(Configuration)));
    this.resolved = { store, secrets, options };
    return this.resolved;
  }
}
```

Create `packages/authn-webauthn/src/strategy/index.ts`:

```ts
export * from './passkey-strategy.js';
```

Append to `packages/authn-webauthn/src/index.ts`:

```ts
export * from './strategy/index.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/authn-testing && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npm test`
Expected: exit 0, no new failures.
Run: `cd packages/authn-webauthn && npx ts-mocha -p tsconfig.json test/passkey-strategy.test.ts test/behaviour.test.ts`
Expected: PASS, 6 passing and 9 passing (A40 with its three passkey cases).
Run: `npm test`, then `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`. Expected: all passing, exit 0.

- [ ] **Step 5: Commit**

```bash
unix2dos packages/authn-webauthn/src/strategy/*.ts packages/authn-webauthn/test/passkey-strategy.test.ts
git add packages/authn-webauthn/src packages/authn-webauthn/test packages/authn-testing/src
git diff --cached --stat
git commit -m "feat(authn-webauthn): PasskeyStrategy with per-login challenges; A40 passkey cases"
```

---

### Task 15: HTTP: passkey options, `{ passkey }` login, passkey registration

**Files:**
- Modify: `packages/authn-http/src/policies/v3/groups.ts` (append `PasskeyStrategyListed`), `src/v3/index.ts:8`
- Create: `packages/authn-http/src/v3/controllers/AuthnWebAuthnLoginController.ts`
- Modify: `AuthnWebAuthnController.ts` (`options`), `AuthnLoginController.ts:43-49`, `src/v3/routes.ts`
- Test: `packages/authn-http/test/v3-app/suites/webauthn.ts`, `test/v3-app/suites/route-table.ts`

**Interfaces:**
- Consumes: Task 14 `PasskeyStrategy.loginOptions` (duck-typed through `AuthnService.strategies()`), Task 13 credentials, Task 10 `CEREMONY_RESPONSE_CAP`, `listedEntry`; plan 08's `loginCredentialsOf` when it has landed.
- Produces: `PasskeyStrategyListed`; `POST /auth/passkey/options` (`{ Options }`); `POST /auth/login` takes `{ passkey: <assertion object> }`; `POST /user/mfa/webauthn/options` takes `{ passkey: true }`; `loginCredentialsOf(req, passwordCap): Credentials | null` in routes.ts (plan 08's name and signature).

- [ ] **Step 1: Write the failing tests**

In `packages/authn-http/test/v3-app/suites/webauthn.ts`, add after `webauthnOff`:

```ts
const STRATEGIES_OFF = [
  { name: 'local', service: 'V3AppPasswordStrategy' },
  { name: 'token', service: 'V3AppTokenStrategy' },
];
const STRATEGIES_ON = [...STRATEGIES_OFF, { name: 'passkey', service: 'PasskeyStrategy' }];

/** The registry and the service read authn.strategies when they resolve. */
async function listStrategies(entries: readonly object[]): Promise<void> {
  config().set('authn.strategies', entries);
  const { DefaultAuthnService, StrategyRegistry } = await import('@spinajs/authn');
  DI.uncache(StrategyRegistry);
  DI.uncache(DefaultAuthnService);
}

async function addPasskey(c: Client): Promise<SoftAuthenticator> {
  const options = await c.post('/user/mfa/webauthn/options', { passkey: true });
  expect(options.status, JSON.stringify(options.body)).to.eq(200);
  expect(options.body.Options.authenticatorSelection).to.include({ residentKey: 'required', userVerification: 'required' });
  const device = new SoftAuthenticator({ origin: ORIGIN });
  const res = await c.post('/user/mfa/webauthn', { response: device.create(options.body.Options) });
  expect(res.body.Credential.Passkey).to.eq(true);
  return device;
}
```

and at the end of `webauthnSuite`:

```ts
  it('POST /auth/passkey/options answers 404 while the passkey strategy is not listed', async () => {
    expect((await new Client().post('/auth/passkey/options', {})).status).to.eq(404);
  });

  describe('with the passkey strategy listed', () => {
    before(async () => {
      await webauthnOn();
      await listStrategies(STRATEGIES_ON);
    });
    after(async () => {
      await listStrategies(STRATEGIES_OFF);
      await webauthnOff();
    });

    it('registers a passkey and logs in with it alone: aal1, a session, no MFA step', async () => {
      const u = await seedUser();
      const device = await addPasskey(await loggedIn(u));
      const c = new Client();
      const options = await c.post('/auth/passkey/options', {});
      expect(options.status).to.eq(200);
      expect(options.body.Options).to.include({ userVerification: 'required', rpId: 'example.test' });
      expect(options.body.Options.allowCredentials).to.deep.eq([]);
      const res = await c.post('/auth/login', { passkey: device.get(options.body.Options) });
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.body.Identity).to.deep.eq({ type: 'user', id: u.ref.id });
      expect(res.body.Authn).to.include({ method: 'passkey', strategy: 'passkey', assurance: 'aal1' });
      expect(c.cookie).to.not.eq(null);
    });

    it('an answer without user verification, or a replayed one, answers the one failure body', async () => {
      const device = await addPasskey(await loggedIn(await seedUser()));
      const c = new Client();
      const options = (await c.post('/auth/passkey/options', {})).body.Options;
      const noUv = await c.post('/auth/login', { passkey: device.get(options, { uv: false }) });
      expect(noUv.status).to.eq(401);
      expect(noUv.body).to.deep.eq(JSON.parse(JSON.stringify(AUTHN_FAILURE_BODY)));
      const answer = device.get(options);
      expect((await c.post('/auth/login', { passkey: answer })).status).to.eq(200);
      expect((await new Client().post('/auth/login', { passkey: answer })).status).to.eq(401);
    });
  });
```

In `packages/authn-http/test/v3-app/suites/route-table.ts`, append to `ACCOUNT_ROUTES_V3`:

```ts
  'POST /auth/passkey/options',
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json`
Expected: FAIL: `expected 404 to equal 200` on `/auth/passkey/options` once listed, `residentKey 'discouraged'` where `'required'` is expected (the options route ignores `passkey`), and the route table misses `POST /auth/passkey/options`.

- [ ] **Step 3: Implement**

Append to `packages/authn-http/src/policies/v3/groups.ts`:

```ts
/** 404 while authn.strategies lists no strategy named 'passkey': passkey login is off. */
export class PasskeyStrategyListed extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request, _action: IRoute, _instance: IController): Promise<void> {
    const configuration = await this.Container.resolve(Configuration);
    if (!listedEntry(configuration.get('authn.strategies'), 'passkey')) throw notFound('not_found', 'passkey login is off: authn.strategies lists no passkey strategy');
  }
}
```

`packages/authn-http/src/v3/index.ts:8` becomes:

```ts
export { RoleSourceRegistered, ImpersonationGuardRegistered, WebAuthnRoutesOn, PasskeyStrategyListed } from '../policies/v3/groups.js';
```

Create `packages/authn-http/src/v3/controllers/AuthnWebAuthnLoginController.ts`:

```ts
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Ok, Policy, Post } from '@spinajs/http';
import { AuthnService } from '@spinajs/authn/contracts';

import { notFound } from '../../policies/v3/errors.js';
import { PasskeyStrategyListed } from '../index.js';
import { NO_STORE } from '../responses.js';

/**
 * Passkey login options. The strategy comes from AuthnService.strategies(), so nothing here loads
 * @spinajs/authn-webauthn.
 * @tags Authentication
 */
@BasePath('auth')
export class AuthnWebAuthnLoginController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  /**
   * Passkey login options
   * No body. PublicKeyCredentialRequestOptions with an empty allowCredentials (conditional UI too); send the answer to
   * POST /auth/login as `{ passkey }`. Each call has its own single-use challenge, living authn.webauthn.timeoutSeconds.
   * @security []
   */
  @Post('passkey/options')
  @Policy(PasskeyStrategyListed)
  public async passkeyOptions() {
    const authn = await this.Container.resolve(AuthnService);
    const strategy = authn.strategies().find((s) => s.name === 'passkey') as { loginOptions?: () => Promise<unknown> } | undefined;
    if (typeof strategy?.loginOptions !== 'function') throw notFound('not_found', 'passkey login is off: the passkey strategy has no login options');
    return new Ok({ Options: await strategy.loginOptions() }, { Headers: [NO_STORE] });
  }
}
```

In `AuthnWebAuthnController.ts`, in `options`, `{ passkey: false }` becomes `{ passkey: bodyField(req, 'passkey') === true }`, and its doc line becomes `Body { passkey?, reauthPassword? }. passkey: true asks for a discoverable, user-verified credential (active session only).`

Login credentials, in `packages/authn-http/src/v3/routes.ts` (add `Credentials` to its `import type { … } from '@spinajs/authn/contracts'`):

- **If plan 08 has landed** (`grep -n "export function loginCredentialsOf" packages/authn-http/src/v3/routes.ts` prints a line): insert at the start of its body:

```ts
  const passkey = bodyField(req, 'passkey');
  if (typeof passkey === 'object' && passkey !== null && !Array.isArray(passkey)) {
    return JSON.stringify(passkey).length <= CEREMONY_RESPONSE_CAP ? { kind: 'passkey', response: passkey } : null;
  }
```

- **Otherwise** append (plan 08 later adds its code branch to the same function):

```ts
/** The credentials of POST /auth/login: a passkey answer, or a login and password; null when neither fits its cap. */
export function loginCredentialsOf(req: Request, passwordCap: number): Credentials | null {
  const passkey = bodyField(req, 'passkey');
  if (typeof passkey === 'object' && passkey !== null && !Array.isArray(passkey)) {
    return JSON.stringify(passkey).length <= CEREMONY_RESPONSE_CAP ? { kind: 'passkey', response: passkey } : null;
  }
  const login = boundedString(bodyField(req, 'login', 'Email'), passwordCap);
  const password = boundedString(bodyField(req, 'password', 'Password'), passwordCap);
  return login === null || password === null ? null : { kind: 'password', login, password };
}
```

  and in `AuthnLoginController.ts` the import (`:10`) becomes `import { answerFor, auditEnded, contextOf, loginCredentialsOf, pendingSteps, stampClient } from '../routes.js';` and lines 43-49 become:

```ts
    // Over-long values never verify (N3), so they reach no strategy, no throttle and no log.
    const credentials = loginCredentialsOf(req, PASSWORD_HARD_CAP);
    if (credentials === null) return authnFailureResponse(undefined, cleared);

    const authn = await this.Container.resolve(AuthnService);
    const result = await authn.authenticate(credentials, contextOf(req, 'login'));
```

The login doc (`:26-31`) gains: `` or `{ passkey }` with an answer over the options of POST /auth/passkey/options``.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/authn-http && npx tsc -b tsconfig.mjs.json && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json`
Expected: PASS, including the three new cases and the route table.
Run: `npm test` in `packages/authn-http`. Expected: no new failures (the login suite still passes with `{ login, password }`).

- [ ] **Step 5: Commit**

```bash
unix2dos packages/authn-http/src/v3/controllers/AuthnWebAuthnLoginController.ts
git add packages/authn-http/src packages/authn-http/test/v3-app
git diff --cached --stat
git commit -m "feat(authn-http): passkey login (POST /auth/passkey/options, { passkey } on /auth/login) and passkey registration"
```

---

### Task 16: Documentation for phase 2

**Files:**
- Modify: `packages/authn-webauthn/README.md`, `docs/authn/README.md` (strategy table `:153-161`, Strategies section, config table)

**Interfaces:** none.

- [ ] **Step 1: Update the package README**

Append to `packages/authn-webauthn/README.md`:

````markdown
## Passkeys

List the strategy and register passkeys with `POST /user/mfa/webauthn/options` `{ passkey: true }`:

```ts
authn: {
  strategies: [{ name: 'local', service: 'LocalPasswordStrategy' }, { name: 'passkey', service: 'PasskeyStrategy' }],
  webauthn: { /* as above */ passkey: { assurance: 'aal1' } },
}
```

Login: `POST /auth/passkey/options` (no body, empty `allowCredentials`, so conditional UI works), then
`POST /auth/login` with `{ passkey: <navigator.credentials.get answer> }`. User verification is always required.
The answer's `userHandle` must be the identity's own random handle (never the user uuid). A passkey also answers the
MFA step, so a password login of the same user can complete with it.

- Assurance: `aal1` by default. `passkey.assurance: 'aal2'` counts a user-verified passkey as multi-factor (NIST SP
  800-63B), so `MfaSatisfied` routes and impersonation accept it without a second step.
- Throttle: flow `login`, account `passkey:<sha256 of the credential id>` plus the ip. The options route counts nothing.
- A passkey also works as an inline re-authentication once the strategy is listed.
````

- [ ] **Step 2: Update `docs/authn/README.md`**

In the strategy table, after the `keys-challenge` row, add:

```markdown
| `passkey` (`PasskeyStrategy`) | `passkey` | yes | `authn-webauthn` |
```

At the end of `## Strategies` (before `## Sessions`), add:

```markdown
### Passkeys

See `packages/authn-webauthn/README.md`. `PasskeyStrategy` reports method `passkey`; `DefaultMfaPolicy` asks no step
after it. It is `aal1` unless `authn.webauthn.passkey.assurance` is `aal2`; `StrategyOutcome.assurance` lets an
interactive strategy claim `aal2`, and the core ignores the claim for per-request strategies.
```

- [ ] **Step 3: Check and commit**

Run: `grep -n "PasskeyStrategy" docs/authn/README.md packages/authn-webauthn/README.md`
Expected: the additions.

```bash
git add packages/authn-webauthn/README.md docs/authn/README.md
git diff --cached --stat
git commit -m "docs(authn-webauthn): passkeys as a first factor"
```

---

## Self-review

**Spec coverage.**

| Requirement | Task |
|---|---|
| New package mirroring authn-totp (deps, `/db` entry, schema, store, events, CLI) | 2, 3, 4, 5, 8 |
| `@simplewebauthn/server` API and version pin, Node engines | 2 (Decision 16) |
| `authn.webauthn.*`: rpId, rpName, origins with env leniency, UV per use, attestation none, timeout, max credentials | 3 |
| `authn_webauthn_credential` columns, migration package, memory store | 4, 5 (Decision 5) |
| MfaStep: beginEnrolment/confirmEnrolment/verify; per-attempt challenge | 6, 7, 10 (Decision 1: plan 08's `challenge?` widened, passed through) |
| Single-use challenge bound to the identity | 7 (Decision 2) |
| Sign-count regression, tolerance of zero counters | 7, 9, 14 (Decision 4) |
| Several credentials, rename, remove with fresh auth, last-factor rule | 8, 11 (Decision 12) |
| Passkeys: discoverable, UV required, empty allowCredentials, userHandle mapping | 7, 14, 15 (Decisions 6, 7) |
| Passkey assurance decision and option | 13, 14 (Decision 8) |
| Throttle, enumeration safety, audit events, message IDs | 6, 8, 14 (Decision 13, Security notes) |
| Tests with a software authenticator, helper shown in full | 1 |
| A-series row | 9, 14 (A40) |
| HTTP routes compatible with `/user/mfa/*` | 10, 11, 15 (Decision 14) |

**Placeholder scan.** No step defers code. Steps that depend on other plans branch with exact code for each case: Task 6 (plan 03 must have landed, else stop; plan 08's `challenge?` present or not), Task 10 (plan 08's challenge route present or not), Task 15 (plan 08's `loginCredentialsOf` present or not).

**Type consistency.** `WebAuthnMfaStep.registrationOptions(id, { passkey })`, `register(id, response, { name })`, `assertionOptions(id)`, `challenge(id)`, `credentialStore()` are used with these names in Tasks 8, 9, 10 and 14; `MfaStep.challenge?` has the one widened signature in Tasks 6, 7 and 10. `WebAuthnService` result codes in Task 8 match `Refusal` and `MESSAGE_OF` in Task 11; message codes in Task 11 match Task 6. `PasskeyStrategy.loginOptions()` (Task 14) is what Task 15 duck-types. Port names `webauthn`, `passkey` and the rule `A40` match across Tasks 9 and 14. `CEREMONY_RESPONSE_CAP` (Task 10) is reused in Task 15; `RESPONSE_CAP` (Task 7) is the same value on the step side.
