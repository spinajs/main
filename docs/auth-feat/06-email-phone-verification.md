# Email and Phone Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identities get verifiable addresses (email, and a phone in E.164) with a verified flag, a code-based verification flow over HTTP, an optional "verified email required for login" policy, and the one-time-code machinery that plans 07 and 08 reuse.

**Architecture:** `@spinajs/authn` owns the contracts (`OneTimeCodeStore`, `CodeSender`, `AddressStore`, `VerificationService`), an in-memory code store for tests, and `DefaultVerificationService`, which throttles (`verify` flow), issues HMAC-stored codes, sends them through `CodeSender` and marks addresses verified through `AddressStore`. `@spinajs/authn-orm` stores codes in `authn_code`; `@spinajs/users` implements `AddressStore` over `users.Email` plus a new `users_address` table; `@spinajs/email` renders code mails; `@spinajs/authn-http` mounts `POST /auth/verification` and `POST /auth/verification/confirm` and answers the login gate.

**Tech Stack:** TypeScript (ESM + CJS builds), mocha via `ts-mocha`, chai / `node:assert`, `@spinajs/di`, `@spinajs/configuration` (`@Config` + AJV schema), `@spinajs/orm` (sqlite, postgres in tests), `node:crypto` (HMAC-SHA256, `randomInt`, `timingSafeEqual`).

## Global Constraints

- Code comments, identifiers and commit messages are in English. Comment only what the code cannot say.
- Work on branch `authz-v3-refactor`, one commit per task, and run the package suites before each commit.
- Every test command runs from the package directory: `npx ts-mocha -p tsconfig.json <file>`. A package's full suite is `npm test`.
- A package that consumes a changed package reads it from `lib/`. Rebuild before testing dependents: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json` in the changed package.
- Working-copy files use CRLF. Keep them CRLF.
- A value check moves into the module's JSON schema. Code keeps only checks a schema cannot make (DI lookups, compiling a value, cross-domain merges).
- Defaults move into the schema (`default`, applied by `useDefaults`). Never add a schema default that changes an effective access/security value.
- Secrets are secret references, never inline values.
- Each new behaviour rule gets a row in `packages/authn-testing`, continuing the A-series (last existing: A32). This plan writes its rule as **A33**. Plans 02–05 also write A33 and land before this one, so at execution take the next free id and rename it in the four places Task 4 lists (file name, `defineRule`/case names, `RULE_IDS`, `ALL`, and the registry test).
- HTTP work targets the 3.0 layer (`packages/authn-http/src/v3`), never the 2.x controllers.
- Committing shared files: stage only your hunks; check `git diff --cached` before every commit (other agents have uncommitted work in `packages/authn*`).

---

## Current state

- `SecretStore` / `DbSecretStore` hold single-use secrets of 32 random bytes as plain SHA-256 (`packages/authn-orm/src/secrets/db-secret-store.ts:51-56`). That is fine for 256-bit secrets and wrong for a six-digit code: SHA-256 of 10^6 candidates is reversed offline at once. Codes need a keyed hash and an attempt counter, hence `OneTimeCodeStore`.
- No identity has a verified flag. `users` has `Email` (unique, varchar 64), `Login`, `IsActive`, `RegisteredAt` (`packages/users/src/models/User.ts:289-344`) and a free-form metadata key `user:phone` (`User.ts:164`). `RegisteredAt` says nothing about verification: rows older than `RBACRegisteredAt_2026_07_28_00_00_00` have null there on purpose, and `create()` stamps it for every new row (`packages/users/src/actions.ts:684`).
- The only "verified" signal today is `ExternalSubject.emailVerified` from OIDC (`packages/authn/src/contracts/credentials.ts:42-48`), used for linking by verified email (`packages/authn/src/service/default-authn-service.ts:501-515`).
- Every login failure answers one 401 body (A02, `packages/authn-http/src/v3/controllers/AuthnLoginController.ts:50`).
- `docs/auth-feat/README.md` fixes the contracts this plan owns: `OneTimeCodeStore`, `CodeMessage`, `CodeSender` (`packages/authn/src/contracts/codes.ts`) and `AddressChannel`, `VerifiableAddress`, `AddressStore` (`packages/authn/src/contracts/identity.ts`). This plan uses them unchanged.

## Decisions (confirm before Task 1)

1. **Storage of the verified flag: a `users_address` table, not columns on `users`.** A row `(user_id, Channel, Value, VerifiedAt)` records that this exact value was verified. The current email stays `users.Email`; it is verified when a row for its normalized value carries `VerifiedAt`. Reasons: (a) any path that changes `users.Email` (the admin `PATCH /users/:user` writes it directly, `packages/users-http/src/admin/controllers/Users/Users.ts:535-540`; 2.x actions; app code) leaves the new value unverified with no extra write, so a stale flag can never carry over; (b) the phone needs no new column on a model apps extend; (c) no `ALTER TABLE users` on every dialect. The phone of a user is its one `users_address` row of channel `sms` (the 2.x `user:phone` metadata stays a display field and is not read).
2. **Phone numbers** are normalized to E.164 by a small validator (`normalizeAddress('sms', raw)`): drop spaces, dots, dashes and parentheses, `00` → `+`, then `^\+[1-9]\d{1,14}$`. National formats are refused (no region is known). The repo has no libphonenumber and this plan adds none.
3. **Code subjects for verification are addresses** (`address:<channel>:<normalized>`), not identity keys: a code is bound to the value it was sent to, so a code sent before an email change cannot verify the new address. `codes.ts` stays as the README fixes it; the subject helper `addressSubject()` lives in `contracts/address.ts`.
4. **Codes are stored as HMAC-SHA256 hex** under `authn.codes.secret`: `subject` = HMAC(`subject|<subject>`) and `code_hmac` = HMAC(`code|<subject digest>|<purpose>|<code>`). Hex (not base64url) because MySQL/MSSQL default collations ignore case. Each attempt is counted with a compare-and-set before the code is compared, so at most `authn.codes.maxAttempts` (default 5) guesses are ever compared, also in parallel. `DbOneTimeCodeStore` fails closed when `authn.codes.secret` is unset (a per-process key would break multi-instance apps); `MemoryOneTimeCodeStore` uses random bytes then.
5. **`MemoryOneTimeCodeStore` is never registered in DI.** Only `DbOneTimeCodeStore` is `@Injectable(OneTimeCodeStore)`, so there is no "several registered" ambiguity like the throttle's (K6). Apps without `authn-orm` have no code store, and the verification routes are off.
6. **The HMAC helpers live in `packages/authn/src/codes/digest.ts`, exported through a new subpath `@spinajs/authn/codes`.** The contracts entry may import only `@spinajs/di` (`packages/authn/test/contracts/boundary.test.ts:17`), so no `node:crypto` there; `authn-orm` must not load the `@spinajs/authn` root (it registers services). Precedent: the `./env` subpath in `packages/authn/package.json`.
7. **`VerificationService` is a new contract** (`packages/authn/src/contracts/verification.ts`) with two public flows (`request`, `confirm`: throttled and audited) and two primitives (`send`, `redeem`: neither throttled nor audited) that plans 07 and 08 call.
8. **Request is enumeration-safe:** it validates the address shape, counts in the `verify` flow (keys `account` = `address:<channel>:<value>` and `ip`), answers `accepted`, and does the lookup, issue and send as deferred work (same technique as `LocalPasswordService.requestReset`). Confirm counts only the `ip` key (an account key would refuse a code redeemed right after its request, the reset-flow reasoning at `packages/authn/src/contracts/password.ts:75-76`), and answers one `invalid` for a wrong, expired, used or exhausted code and for an unknown address.
9. **Links carry the code in the URL fragment**: `<authn.verification.url>#channel=email&address=…&code=…`. Browsers send neither the fragment nor its parameters to a server, a proxy log or a `Referer`. The page reads the fragment and POSTs to `/auth/verification/confirm`; no GET ever redeems (mail scanners follow links).
10. **Login gate:** `authn.verification.requiredForLogin: false | 'email'` (default `false`). With `'email'`, `DefaultAuthnService.accept` refuses an interactive login of a `user` whose email is not verified, **after** the credential, the status and the login hooks passed. The result is a new failure reason `'unverified'` (added to `AuthnFailure`), which the 3.0 login route answers with 403 and message 4004003. Only the holder of the password learns it, so it reveals nothing to an enumerator. With `'email'` and no `AddressStore` registered, boot fails.
11. **OIDC:** `authn.verification.trustExternalEmail` (default `true`). An interactive external login whose subject has `emailVerified === true` marks that email verified when it is the identity's own current address. The default is safe because the claims layer already never sets `emailVerified` for presets that cannot be trusted (`entra`, `github`: `packages/authn-oidc/src/presets.ts:27,60`); a generic provider maps `email_verified` and is trusted, as the app configured it. Marking runs before the gate, so such a login passes it.
12. **2.x data:** the `users` migration marks the current email of every **active, not deleted** user as verified at migration time. `RegisteredAt` is not usable as a signal (see Current state). `users.addresses.trustExistingEmails: false` skips the backfill. Inactive and invite-pending accounts start unverified.
13. **Email change:** `users` gets `changeEmail()`: unique check, write `users.Email` (the new value is unverified by Decision 1), a `verify` code to the new address through `VerificationService.request`, and the `emailChanged` notice to the **previous** address (Kratos `notify_previous_addresses`) through `sendUserEmail` (queued; it carries no secret). The self-service HTTP route for it belongs to the 3.0 `/user/*` routes of N8b and is not added here; the admin route keeps writing `Email` directly, which leaves the new address unverified.
14. **Messages (plan 03 range 1004000–1004999 / 4004000–4004999):**

    | Code (wire `error`) | ID | Type | Text |
    |---|---|---|---|
    | `verification_sent` | 1004001 | info | If the address belongs to an account, a code is on its way. |
    | `address_verified` | 1004002 | info | The address is verified. |
    | `E_CODE_INVALID` | 4004001 | error | The code is invalid or has expired. |
    | `E_VERIFICATION_REQUIRED` | 4004002 | error | Verify your email address to log in. |
    | `E_INVALID_ADDRESS` | 4004003 | error | Enter a valid address. |

    They follow plan 03's "How a consumer plan adds messages": `VERIFICATION_MESSAGES` in `packages/authn/src/messages/verification.ts` (`as const satisfies Readonly<Record<string, AuthnMessageDefinition>>`, keys are the wire codes, so `messages[0].code === error`), added to `PARTS` and `DEFINITIONS` in `catalogue.ts`, pinned in `test/messages/catalogue.test.ts`, docs regenerated. A throttled request reuses plan 03's `throttled` (4000018, context `{ retryAfterSeconds }`), as plan 03 Decision 3 intends for the code requests of plans 06 and 08. Answers use plan 03's `errorBody(code, message, context?)` and `authnMessage(code)`. Plans 07 and 08 may reuse `E_CODE_INVALID` and `E_INVALID_ADDRESS`.
15. **CAPTCHA (plan 05):** `POST /auth/verification` calls plan 05's `captchaRefusal(this.Container, req, 'verify', address)` after its bounds checks and before the service runs ("Integration for plans 06, 07 and 08"). Without a registered `CaptchaGate` it is a no-op. `confirm` is not guarded: it is bounded by `maxAttempts` per code and the `verify` throttle per IP.
16. **Audit:** `verification.request` and `verification.verify` (README table). Events never carry the address or the code; `data` holds `{ channel }` (and `via: 'external'` for OIDC marking).

## Security notes

- Codes: 6 digits by default (`authn.codes.length` 6–10), TTL `authn.verification.ttlSeconds` (default 900 s), at most 5 compared guesses per code, keyed hash at rest, constant-time comparison, single use, one live code per subject and purpose. Per address and IP the `verify` throttle bounds how often new codes can be requested; guessing a 6-digit code within 5 tries succeeds with probability 5·10⁻⁶ per code.
- `CodeSender` renders and sends at once and never queues, persists or logs the code or link (SR-09), like `PasswordMailer`; `EmailCodeSender` marks both for redaction.
- No answer tells whether an address exists: request answers `accepted` before any lookup; confirm answers one `invalid`; the store spends the same statements for a missing code as for a wrong one.
- The gate answers `unverified` only after the password verified; the throttle has counted the attempt before verification as for every login.
- A verified mark is bound to the value: a code redeemed after the address changed is refused (`markVerified` answers false).

## File structure

| File | Change | Responsibility |
|---|---|---|
| `packages/authn/src/contracts/codes.ts` | create | README contract: `OneTimeCodeStore`, `CodeMessage`, `CodeSender` |
| `packages/authn/src/contracts/address.ts` | create | `normalizeAddress()`, `addressSubject()` (pure) |
| `packages/authn/src/contracts/identity.ts` | modify | README contract: `AddressChannel`, `VerifiableAddress`, `AddressStore` |
| `packages/authn/src/contracts/verification.ts` | create | `VerificationService` and its result types |
| `packages/authn/src/contracts/audit.ts`, `credentials.ts`, `throttle.ts`, `index.ts` | modify | event types, `'unverified'`, flow `verify`, exports |
| `packages/authn/src/schemas/authn.configuration.ts`, `src/config/authn.ts` | modify | `authn.codes`, `authn.verification`, `throttle.verify` |
| `packages/authn/src/messages/verification.ts` | create | message IDs 1004xxx/4004xxx |
| `packages/authn/src/codes/{digest,memory-code-store,index}.ts` | create | HMAC helpers (subpath `@spinajs/authn/codes`), test store |
| `packages/authn/src/registry/throttle.ts` | create | `selectThrottle()` moved out of `DefaultAuthnService` |
| `packages/authn/src/verification/{deferred,default-verification-service,index}.ts` | create | the flows |
| `packages/authn/src/service/default-authn-service.ts` | modify | login gate, OIDC marking |
| `packages/authn-testing/src/{fakes/addresses.ts,fakes/codes.ts,behaviour/A33-one-time-codes.spec.ts}` | create | fakes and rule A33 |
| `packages/authn-orm/src/codes/{db-code-store,index}.ts`, `src/migrations/AuthnCode_2026_10_06_00_00_00.ts` | create | `authn_code` |
| `packages/email/src/code-sender.ts` | create | `EmailCodeSender` |
| `packages/users/src/identity/address-store.ts`, `src/migrations/UsersAddress_2026_10_06_00_00_00.ts` | create | `UserAddressStore`, `users_address` |
| `packages/users/src/actions.ts`, `src/index.ts`, `src/config/users.ts`, `src/templates/user-email-changed-template.pug` | modify/create | `changeEmail`, `setPhone`, CodeSender registration, notice |
| `packages/authn-http/src/v3/controllers/AuthnVerificationController.ts`, `src/policies/v3/groups.ts`, `src/v3/responses.ts`, `src/v3/controllers/AuthnLoginController.ts` | create/modify | routes, group policy, answers |
| `docs/authn/README.md` | modify | verification section and config rows |

## Task order

```
1 contracts → 2 throttle flow → 3 schema + messages → 4 authn-testing → 5 memory store
→ 6 authn-orm store → 7 email sender → 8 users addresses → 9 verification service
→ 10 login gate → 11 HTTP → 12 users email change
```
Each task rebuilds the package it changed before the next one reads `lib/`.

## Facts verified (2026-10-06, working copy of `authz-v3-refactor`)

- `SecretStore`: `packages/authn/src/contracts/secrets.ts:3-9`. `DbSecretStore`: raw secret `randomBytes(32)` base64url, `sha256hex` (`packages/authn-orm/src/secrets/db-secret-store.ts:51-56`); purge every 64 calls, batches of 500 (`:17-18`, `:84-95`); `StoreConnection` (`packages/authn-orm/src/support/connection.ts:20-42`); SQL helpers `sqlTime`, `checkedMs`, `selectTime`, `columnText`, `textMs`, `rowsAffected`, `isDuplicate`, `checkedText` (`packages/authn-orm/src/support/sql.ts`).
- `IdentityStore`, `PasswordCredentialStore`: `packages/authn/src/contracts/identity.ts:12-33`. `packages/authn/test/contracts/identity.test.ts:144` pins the class list of `identity.ts` to `['IdentityStore', 'PasswordCredentialStore']`.
- `AuthnFailure`: `credentials.ts:74`, pinned in `packages/authn/test/contracts/credentials.test.ts:136`. `AuthnEventType`: `audit.ts:21`, pinned in `packages/authn/test/contracts/audit.test.ts:23` and `:155` (order matters).
- Throttle (working copy, uncommitted move by another agent): `ThrottleFlow` `packages/authn/src/contracts/throttle.ts:9`, `ThrottleParams` `:35-43`, `THROTTLE_FLOWS` `:45`, `DEFAULT_THROTTLE_PARAMS` `:50-57`. `packages/authn/test/contracts/throttle.test.ts:172-176` pins four flows; `packages/authn-orm/test/throttle-config.test.ts:22` (untracked) pins `THROTTLE_FLOWS`. `MemoryAuthnThrottle` builds one table per flow from a literal (`packages/authn/src/throttle/memory-throttle.ts:89`); `DbAuthnThrottle` checks flows against `THROTTLE_FLOWS` (`packages/authn-orm/src/throttle/db-throttle.ts:373-376`). If the move has not landed when you execute, the same members are in `packages/authn/src/throttle/params.ts`.
- Schema: throttle block with `propertyNames` enum `packages/authn/src/schemas/authn.configuration.ts:237-251`; the root has no `additionalProperties`. Shipped config `packages/authn/src/config/authn.ts:16-23`. Pins: `packages/authn/test/boot/config-defaults.test.ts:43,55-60,75`, `packages/authn/test/contracts/config-schema.test.ts:63-71,271`.
- Contracts boundary: only `@spinajs/di` may be imported (`packages/authn/test/contracts/boundary.test.ts:17-18`); `RUNTIME_EXPORTS` is checked with `include.members` (`:149`). Subpath precedent `./env` in `packages/authn/package.json` `exports` and `typesVersions`.
- `DefaultAuthnService` (`packages/authn/src/service/default-authn-service.ts`): `resolve()` `:182-202`, `accept()` `:395-443` (status refusal `:407`, login hooks `:410-413`, `throttle.succeed` `:416`), `linked()` `:501-515`, `refuse()` `:567-570`, `selectThrottle()` `:607-629`, `MEMORY_THROTTLE` `:41`. `@Config` reads work in `resolve()` (mechanism notes).
- Core test harness: `buildCore`, `bind`, `configuredChild`, `pinConfiguration` (`packages/authn/test/behaviour/harness.ts:115-213`); kit external strategy provider `kit-idp` takes `{ kind: 'external', provider: 'kit-idp', payload: { subject } }` (`packages/authn-testing/src/fakes/strategy.ts:96-116`); `fakeHash` (`packages/authn-testing/src/fakes/passwords.ts:8`).
- authn-testing: `RULE_IDS` `packages/authn-testing/src/behaviour/types.ts:8`, port registry `:15-55`, `Harness` `packages/authn-testing/src/harness/ports.ts:9-56`, rule list `packages/authn-testing/src/behaviour/index.ts:40`, wrappers `packages/authn-testing/src/conformance/stores.ts`, registry pins `packages/authn-testing/test/registry.test.ts:7,48-54`. `FakeClock.tick` (`packages/authn-testing/src/fakes/clock.ts:22-29`).
- authn-orm: migration naming `AuthnInitial_2026_10_02_00_00_00` (`packages/authn-orm/src/migrations/AuthnInitial_2026_10_02_00_00_00.ts`), barrel `src/migrations/index.ts`; test DB `bootDb`, `rawQuery`, `DB_KINDS` (`packages/authn-orm/test/support/db.ts:150-200`), store conformance pattern `packages/authn-orm/test/secret-store.test.ts:55-86`.
- email: `EmailPasswordMailer` (`packages/email/src/password-mailer.ts:54-114`) declares its mail shape locally; `@spinajs/email` has no runtime dependency on authn (`packages/email/package.json` `dependencies`); `EmailConfiguration.password` `packages/email/src/interfaces.ts:212`; `redactText(text, secrets)` `packages/email/src/redact.ts:22`. `users` registers the mailer in `RbacBootstrapper` (`packages/users/src/index.ts:80-83`).
- users: `usersMatchingLogin`, `sqlDateTime`, `rowsAffected`, `usersDriver`, `usersOrmUp` (`packages/users/src/identity/sql.ts`); `runAsSystem` (`packages/users/src/system.ts`); `sendUserEmail` sends to `u.Email` only (`packages/users/src/actions.ts:162-193`); `assertUserUnique` `:567-587`; migration pattern and test `packages/users/src/migrations/UsersPasswordSetAt_2026_10_04_00_00_00.ts`, `packages/users/test/password-age.test.ts:42-80`; test DB `bootUsersDb`, `seedUser`, `registerUsersTestHost` (`packages/users/test/support/users-db.ts`). `users.Email` is varchar(64) unique (`RBACInitial_2022_06_28_01_13_00.ts:10`).
- authn-http 3.0: helpers `bodyField`, `boundedString`, `contextOf` (`packages/authn-http/src/v3/routes.ts:25-43`); `NO_STORE`, `authnFailureResponse` (`src/v3/responses.ts:17-27`); group policy pattern (`src/policies/v3/groups.ts:13-38`); v3-app wiring (`test/v3-app/app.ts:128-145`), route table (`test/v3-app/suites/route-table.ts:26-40`), suite list (`test/v3-app/account.test.ts`). `@spinajs/http` has no 429 response class; every `Response` honours `options.StatusCode` (`packages/http/src/interfaces.ts:888`).
- Sibling plans this plan consumes (written, not landed): plan 03 `docs/auth-feat/03-message-ids.md` — `AuthnMessageDefinition`, `authnMessage`, `PARTS`/`DEFINITIONS` in `catalogue.ts`, `PINNED`, `errorBody` in `policies/v3/errors.ts`, `throttled` 4000018 for code requests (its Decision 3), "How a consumer plan adds messages"; plan 05 `docs/auth-feat/05-captcha.md` — `captchaRefusal(container, req, flow, account?, cookies?)` in `packages/authn-http/src/v3/captcha.ts`, flow `verify` for a verification-code request ("Integration for plans 06, 07 and 08").
- OIDC: only a boolean `true` claim sets `emailVerified` (`packages/authn-oidc/src/claims.ts:53`); `entra` and `github` presets map it to `null` (`presets.ts:27,60`).

---

### Task 1: Contracts for codes, addresses and verification

**Files:**
- Create: `packages/authn/src/contracts/codes.ts`
- Create: `packages/authn/src/contracts/address.ts`
- Create: `packages/authn/src/contracts/verification.ts`
- Modify: `packages/authn/src/contracts/identity.ts` (append after line 33)
- Modify: `packages/authn/src/contracts/audit.ts:21`
- Modify: `packages/authn/src/contracts/credentials.ts:73-74`
- Modify: `packages/authn/src/contracts/index.ts`
- Test: `packages/authn/test/contracts/codes.test.ts` (create), `packages/authn/test/contracts/identity.test.ts:144`, `packages/authn/test/contracts/audit.test.ts:23`, `packages/authn/test/contracts/credentials.test.ts:136`, `packages/authn/test/contracts/boundary.test.ts:18`

**Interfaces:**
- Consumes: `IdentityRef`, `AuthnContext` (`contracts/credentials.ts`).
- Produces (all from `@spinajs/authn/contracts`):
  - `CodePurpose`, `IssuedCode`, `CodeCheck`, `OneTimeCodeStore.issue(subject, purpose, { ttlSeconds, length? }): Promise<IssuedCode>`, `OneTimeCodeStore.verify(subject, purpose, code): Promise<CodeCheck>`, `CodeMessage`, `CodeSender.send(message): Promise<void>` — exactly the README block.
  - `AddressChannel`, `VerifiableAddress`, `AddressStore.addresses(id)`, `.findByAddress(channel, value)`, `.markVerified(id, channel, value, at): Promise<boolean>` — exactly the README block.
  - `normalizeAddress(channel: AddressChannel, raw: unknown): string | null`, `addressSubject(channel: AddressChannel, normalized: string): string`.
  - `AddressInput { channel; value }`, `VerificationTarget`, `VerificationRequestResult`, `VerificationConfirmResult`, `CodeRedeemResult`, `CodeSendOptions`, abstract `VerificationService` with `request`, `confirm`, `send`, `redeem`.
  - `AuthnEventType` gains `'verification.request' | 'verification.verify'`; `AuthnFailure` gains `'unverified'`.

- [ ] **Step 1: Write the failing tests**

Create `packages/authn/test/contracts/codes.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import * as index from '../../src/contracts/index.js';
import { CodeSender, OneTimeCodeStore } from '../../src/contracts/codes.js';
import type { CodeCheck, CodeMessage, CodePurpose, IssuedCode } from '../../src/contracts/codes.js';
import { addressSubject, normalizeAddress } from '../../src/contracts/address.js';
import { AddressStore } from '../../src/contracts/identity.js';
import type { AddressChannel, VerifiableAddress } from '../../src/contracts/identity.js';
import { VerificationService } from '../../src/contracts/verification.js';
import type { CodeRedeemResult, VerificationConfirmResult, VerificationRequestResult } from '../../src/contracts/verification.js';
import type { IdentityRef } from '../../src/contracts/credentials.js';
import { classMembers, same } from './source-shape.js';

const expect = chai.expect;

describe('code, address and verification contracts', () => {
  it('are exported from the contracts index', () => {
    for (const name of ['OneTimeCodeStore', 'CodeSender', 'AddressStore', 'VerificationService', 'normalizeAddress', 'addressSubject']) {
      expect(index, name).to.have.property(name);
    }
  });

  it('keep the README shapes', () => {
    same<CodeCheck, 'ok' | 'invalid' | 'expired' | 'exhausted'>(true);
    same<IssuedCode, { readonly code: string; readonly ttlSeconds: number }>(true);
    same<AddressChannel, 'email' | 'sms'>(true);
    same<VerifiableAddress, { readonly channel: AddressChannel; readonly value: string; readonly verifiedAt: Date | null }>(true);
    same<Parameters<OneTimeCodeStore['issue']>, [string, CodePurpose, { readonly ttlSeconds: number; readonly length?: number }]>(true);
    same<Parameters<CodeSender['send']>, [CodeMessage]>(true);
    same<Parameters<AddressStore['markVerified']>, [IdentityRef, AddressChannel, string, Date]>(true);
    same<ReturnType<AddressStore['markVerified']>, Promise<boolean>>(true);
  });

  it('declare the members in source', () => {
    expect(Object.keys(classMembers('codes.ts'))).to.deep.eq(['OneTimeCodeStore', 'CodeSender']);
    expect(Object.keys(classMembers('verification.ts'))).to.deep.eq(['VerificationService']);
    expect(classMembers('verification.ts').VerificationService.members.map((m) => m.name)).to.deep.eq(['request', 'confirm', 'send', 'redeem']);
  });

  it('VerificationService answers the documented results', () => {
    same<VerificationRequestResult, { readonly status: 'accepted' } | { readonly status: 'invalid_address' } | { readonly status: 'throttled'; readonly retryAfterSeconds: number }>(true);
    same<VerificationConfirmResult, { readonly status: 'verified'; readonly identity: IdentityRef } | { readonly status: 'invalid' } | { readonly status: 'throttled'; readonly retryAfterSeconds: number }>(true);
    same<CodeRedeemResult, { readonly status: 'verified'; readonly identity: IdentityRef } | { readonly status: 'invalid' }>(true);
    expect(VerificationService).to.be.a('function');
  });

  describe('normalizeAddress', () => {
    it('lower-cases and trims an email, NFKC first', () => {
      expect(normalizeAddress('email', '  Alice.Smith@Example.COM ')).to.eq('alice.smith@example.com');
      expect(normalizeAddress('email', 'Kate@example.com')).to.eq('kate@example.com');
    });

    it('refuses what is not one email address', () => {
      for (const bad of ['', 'alice', '@example.com', 'alice@', 'a@b@c', 'a b@c.d', `${'a'.repeat(250)}@b.cd`, 42, null]) {
        expect(normalizeAddress('email', bad), String(bad)).to.eq(null);
      }
    });

    it('turns a phone into E.164, dropping separators and reading 00 as +', () => {
      expect(normalizeAddress('sms', '+48 (12) 345-67.89')).to.eq('+48123456789');
      expect(normalizeAddress('sms', '0048123456789')).to.eq('+48123456789');
    });

    it('refuses a phone without a country code or longer than 15 digits', () => {
      for (const bad of ['123456789', '+0123456', '+1234567890123456', '+48 12a', '']) {
        expect(normalizeAddress('sms', bad), bad).to.eq(null);
      }
    });

    it('builds the code subject of an address', () => {
      expect(addressSubject('email', 'alice@example.com')).to.eq('address:email:alice@example.com');
    });
  });
});
```

In `packages/authn/test/contracts/identity.test.ts` replace line 144 with:

```ts
      expect(Object.keys(c)).to.deep.eq(['IdentityStore', 'PasswordCredentialStore', 'AddressStore']);
      expect(c.AddressStore.base).to.eq(null);
      expect(shape(c.AddressStore.members)).to.deep.eq([
        { name: 'addresses', modifiers: ['abstract'], optional: false, params: ['id'] },
        { name: 'findByAddress', modifiers: ['abstract'], optional: false, params: ['channel', 'value'] },
        { name: 'markVerified', modifiers: ['abstract'], optional: false, params: ['id', 'channel', 'value', 'at'] },
      ]);
```

In `packages/authn/test/contracts/audit.test.ts` line 23, append `'verification.request', 'verification.verify'` after `'throttle.block'` in `EVENT_TYPES`.

In `packages/authn/test/contracts/credentials.test.ts` line 136, replace the union with:

```ts
      same<AuthnFailure, 'invalid_credentials' | 'throttled' | 'unsupported_credentials' | 'expired' | 'revoked' | 'not_linked' | 'unverified'>(true);
```

In `packages/authn/test/contracts/boundary.test.ts` line 18, append `'OneTimeCodeStore', 'CodeSender', 'AddressStore', 'VerificationService', 'normalizeAddress', 'addressSubject'` to `RUNTIME_EXPORTS`.

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/codes.test.ts test/contracts/identity.test.ts test/contracts/audit.test.ts test/contracts/credentials.test.ts`
Expected: FAIL at compile time: `Cannot find module '../../src/contracts/codes.js'` (and `address.js`, `verification.js`), `Module '"../../src/contracts/identity.js"' has no exported member 'AddressStore'`.

- [ ] **Step 3: Implement**

Create `packages/authn/src/contracts/codes.ts` (the README block, verbatim):

```ts
import type { IdentityRef } from './credentials.js';

export type CodePurpose = 'verify' | 'login' | 'register' | (string & {});

export interface IssuedCode {
  /** Digits only; shown to the user once. */
  readonly code: string;
  readonly ttlSeconds: number;
}

export type CodeCheck = 'ok' | 'invalid' | 'expired' | 'exhausted';

/**
 * Short numeric codes, stored as HMAC-SHA256 under `authn.codes.secret` (a six-digit code hashed with plain SHA-256 is
 * reversed offline in milliseconds). A subject has at most one live code per purpose; issue replaces it.
 * After `authn.codes.maxAttempts` (default 5) wrong answers the code is void ('exhausted').
 */
export abstract class OneTimeCodeStore {
  /** `subject` is `identityKey(ref)`, or `address:<channel>:<normalized value>` before an identity exists. */
  abstract issue(subject: string, purpose: CodePurpose, opts: { readonly ttlSeconds: number; readonly length?: number }): Promise<IssuedCode>;
  abstract verify(subject: string, purpose: CodePurpose, code: string): Promise<CodeCheck>;
}

export interface CodeMessage {
  readonly channel: 'email' | 'sms';
  readonly to: string;
  readonly purpose: CodePurpose;
  readonly code: string;
  /** A link that carries the code, when the flow offers one. */
  readonly link?: string;
  readonly ttlSeconds: number;
  readonly locale?: string;
  readonly identity?: IdentityRef;
}

/** Renders and sends at once; never queues, persists or logs `code` or `link` (same rule as PasswordMailer, SR-09). */
export abstract class CodeSender {
  abstract send(message: CodeMessage): Promise<void>;
}
```

Append to `packages/authn/src/contracts/identity.ts`:

```ts

export type AddressChannel = 'email' | 'sms';

export interface VerifiableAddress {
  readonly channel: AddressChannel;
  /** Normalized: email lower-cased; phone E.164. */
  readonly value: string;
  readonly verifiedAt: Date | null;
}

export abstract class AddressStore {
  abstract addresses(id: IdentityRef): Promise<readonly VerifiableAddress[]>;
  abstract findByAddress(channel: AddressChannel, value: string): Promise<IdentityRef | null>;
  /** False when `value` is no longer an address of `id` (changed since the code was sent). */
  abstract markVerified(id: IdentityRef, channel: AddressChannel, value: string, at: Date): Promise<boolean>;
}
```

Create `packages/authn/src/contracts/address.ts`:

```ts
import type { AddressChannel } from './identity.js';

const EMAIL_MAX = 254;
// E.164: a plus, a country code that does not start with 0, at most 15 digits in all.
const E164 = /^\+[1-9]\d{1,14}$/;
const PHONE_SEPARATORS = /[\s().-]/g;

/**
 * The stored form of an address, or null when `raw` is none. Email: NFKC, trimmed, lower-cased, exactly one `@` with text
 * on both sides, no whitespace. Phone: E.164 after dropping spaces, dots, dashes and parentheses, a leading `00` read as
 * `+`. A national number is refused: no region is known here.
 */
export function normalizeAddress(channel: AddressChannel, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (channel === 'email') {
    const v = raw.normalize('NFKC').trim().toLowerCase();
    if (v.length > EMAIL_MAX || /\s/.test(v)) return null;
    const at = v.indexOf('@');
    return at > 0 && at === v.lastIndexOf('@') && at < v.length - 1 ? v : null;
  }
  if (channel === 'sms') {
    let v = raw.trim().replace(PHONE_SEPARATORS, '');
    if (v.startsWith('00')) v = `+${v.slice(2)}`;
    return E164.test(v) ? v : null;
  }
  return null;
}

/** The OneTimeCodeStore subject of an address, which may not belong to any identity yet. */
export const addressSubject = (channel: AddressChannel, normalized: string): string => `address:${channel}:${normalized}`;
```

Create `packages/authn/src/contracts/verification.ts`:

```ts
import type { CodePurpose } from './codes.js';
import type { AuthnContext, IdentityRef } from './credentials.js';
import type { AddressChannel } from './identity.js';

/** An address as typed; the service normalizes it. */
export interface AddressInput {
  readonly channel: AddressChannel;
  readonly value: string;
}

/** The owner of a session asks for its own address of a channel; anyone may ask for an address they type. */
export type VerificationTarget = { readonly identity: IdentityRef; readonly channel: AddressChannel } | { readonly address: AddressInput };

export type VerificationRequestResult = { readonly status: 'accepted' } | { readonly status: 'invalid_address' } | { readonly status: 'throttled'; readonly retryAfterSeconds: number };

/** 'invalid' is the one answer for a wrong, expired, used or exhausted code and for an address no identity holds. */
export type VerificationConfirmResult = { readonly status: 'verified'; readonly identity: IdentityRef } | { readonly status: 'invalid' } | { readonly status: 'throttled'; readonly retryAfterSeconds: number };

export type CodeRedeemResult = { readonly status: 'verified'; readonly identity: IdentityRef } | { readonly status: 'invalid' };

export interface CodeSendOptions {
  /** The app page the link opens; the code travels in its fragment. Absent: the message carries no link. */
  readonly linkBase?: string;
  /** Default `authn.verification.ttlSeconds`. */
  readonly ttlSeconds?: number;
  readonly locale?: string;
}

/** DefaultVerificationService in @spinajs/authn. Codes go through OneTimeCodeStore and CodeSender, marks through AddressStore. */
export abstract class VerificationService {
  /**
   * POST /auth/verification. Counts in the 'verify' flow (the address and the ip) and answers 'accepted' before any lookup,
   * so the answer is the same whether or not the address belongs to an identity; the code is issued and sent afterwards.
   */
  abstract request(target: VerificationTarget, ctx: AuthnContext): Promise<VerificationRequestResult>;
  /** POST /auth/verification/confirm. Counts the ip in the 'verify' flow, then redeems a code of purpose 'verify'. */
  abstract confirm(address: AddressInput, code: string, ctx: AuthnContext): Promise<VerificationConfirmResult>;
  /** Issues a code of `purpose` for `address` and sends it now. Neither throttled nor audited: the calling flow does both. */
  abstract send(identity: IdentityRef, address: AddressInput, purpose: CodePurpose, opts?: CodeSendOptions): Promise<void>;
  /** Checks a code of `purpose` and marks `address` verified for the identity holding it. Neither throttled nor audited. */
  abstract redeem(address: AddressInput, code: string, purpose: CodePurpose, ctx: AuthnContext): Promise<CodeRedeemResult>;
}
```

In `packages/authn/src/contracts/audit.ts` line 21 append the two members at the end of the union:

```ts
export type AuthnEventType = 'login' | 'logout' | 'mfa.challenge' | 'mfa.verify' | 'mfa.enrol' | 'mfa.disable' | 'reauth' | 'session.issue' | 'session.rotate' | 'session.revoke' | 'session.expire' | 'password.change' | 'password.reset.request' | 'password.reset' | 'invite.redeem' | 'token.create' | 'token.use' | 'token.revoke' | 'key.register' | 'key.use' | 'key.revoke' | 'identity.link' | 'identity.unlink' | 'impersonation.start' | 'impersonation.end' | 'impersonation.expire' | 'throttle.block' | 'verification.request' | 'verification.verify';
```

In `packages/authn/src/contracts/credentials.ts` replace lines 73-74 with:

```ts
/**
 * Goes to audit only; HTTP answers one shape for all of them (A02). The exception is 'unverified': it follows a verified
 * credential only (authn.verification.requiredForLogin), so the 3.0 login route tells the user to verify the address.
 */
export type AuthnFailure = 'invalid_credentials' | 'throttled' | 'unsupported_credentials' | 'expired' | 'revoked' | 'not_linked' | 'unverified';
```

Append to `packages/authn/src/contracts/index.ts`:

```ts
export * from './codes.js';
export * from './address.js';
export * from './verification.js';
```

Functions deleted: none.

- [ ] **Step 4: GREEN + package suite + rebuild**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/codes.test.ts test/contracts/identity.test.ts test/contracts/audit.test.ts test/contracts/credentials.test.ts` — all passing.
2. `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`, then `npx ts-mocha -p tsconfig.json test/contracts/boundary.test.ts` (it reads `lib/`) — passing.
3. `npm test` in `packages/authn` — passing. `DefaultAuthnService` keeps `STRATEGY_FAILURES` without `'unverified'` (`default-authn-service.ts:74`), so a strategy that answers it still breaks the contract.

- [ ] **Step 5: Commit**

```bash
git add packages/authn/src/contracts/codes.ts packages/authn/src/contracts/address.ts packages/authn/src/contracts/verification.ts packages/authn/src/contracts/identity.ts packages/authn/src/contracts/audit.ts packages/authn/src/contracts/credentials.ts packages/authn/src/contracts/index.ts packages/authn/test/contracts/codes.test.ts packages/authn/test/contracts/identity.test.ts packages/authn/test/contracts/audit.test.ts packages/authn/test/contracts/credentials.test.ts packages/authn/test/contracts/boundary.test.ts
git commit -m "feat(authn): contracts for one-time codes, verifiable addresses and verification"
```

---

### Task 2: Throttle flow `verify`

**Files:**
- Modify: `packages/authn/src/contracts/throttle.ts:9` (`ThrottleFlow`), `:35-43` (`ThrottleParams`), `:45` (`THROTTLE_FLOWS`), `:50-57` (`DEFAULT_THROTTLE_PARAMS`)
- Modify: `packages/authn/src/throttle/memory-throttle.ts:89` (tables literal)
- Modify: `packages/authn/src/schemas/authn.configuration.ts:240-246` (throttle `propertyNames` and a `verify` flow)
- Modify: `packages/authn/src/config/authn.ts:16-23`
- Test: `packages/authn/test/contracts/throttle.test.ts:172-176`, `packages/authn/test/contracts/config-schema.test.ts:63-71`, `packages/authn-orm/test/throttle-config.test.ts:22`

**Interfaces:**
- Produces: `ThrottleFlow` = `'login' | 'mfa' | 'reset' | 'reauth' | 'verify'`; `ThrottleParams.verify: ThrottleFlowParams`; `DEFAULT_THROTTLE_PARAMS.verify = { account: { free: 3, baseDelayMs: 60000, maxDelayMs: 3600000 }, ip: { free: 10, baseDelayMs: 10000, maxDelayMs: 900000 } }`. `succeed` is never called for `verify` (only time clears it), so neither throttle's `succeed` changes.

- [ ] **Step 1: Schema additions**

In the throttle block, `propertyNames` becomes:

```ts
      propertyNames: { enum: ['service', 'login', 'mfa', 'reset', 'reauth', 'verify', 'resetAfterSeconds', 'global', 'maxRows'] },
```

and after the `reauth` line add:

```ts
        verify: flow({ free: 3, baseDelayMs: 60000, maxDelayMs: 3600000 }, { free: 10, baseDelayMs: 10000, maxDelayMs: 900000 }),
```

- [ ] **Step 2: Write the failing tests**

`packages/authn/test/contracts/throttle.test.ts`, replace the test at lines 172-176:

```ts
    it('ThrottleFlow is exactly the five flows', () => {
      same<ThrottleFlow, 'login' | 'mfa' | 'reset' | 'reauth' | 'verify'>(true);
      // @ts-expect-error no signup flow
      const f: ThrottleFlow = 'signup';
      void f;
    });
```

`packages/authn/test/contracts/config-schema.test.ts`, in `THROTTLE_DEFAULTS` (lines 63-71) add after `reauth`:

```ts
  verify: { account: { free: 3, baseDelayMs: 60000, maxDelayMs: 3600000 }, ip: { free: 10, baseDelayMs: 10000, maxDelayMs: 900000 } },
```

`packages/authn-orm/test/throttle-config.test.ts` line 22:

```ts
    expect(THROTTLE_FLOWS).to.deep.eq(['login', 'mfa', 'reset', 'reauth', 'verify']);
```

Add to `packages/authn/test/throttle/memory-throttle.test.ts` (inside its top-level `describe`, next to the other flow tests):

```ts
  it('keeps the verify flow in its own table and backs off per address', async () => {
    const t = new MemoryAuthnThrottle(DEFAULT_THROTTLE_PARAMS);
    const keys = [{ kind: 'account', value: 'address:email:a@b.c' }];
    const ctx = { now: new Date('2026-10-06T10:00:00Z'), purpose: 'request' as const };
    for (let i = 0; i < 3; i++) expect((await t.attempt(keys, 'verify', ctx)).allowed, `attempt ${i + 1}`).to.eq(true);
    expect(await t.attempt(keys, 'verify', ctx)).to.deep.eq({ allowed: false, retryAfterSeconds: 60 });
    expect((await t.attempt(keys, 'login', ctx)).allowed).to.eq(true);
  });
```

(add `DEFAULT_THROTTLE_PARAMS` to that file's `../../src/index.js` import if it is not there.)

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/throttle.test.ts test/contracts/config-schema.test.ts test/throttle/memory-throttle.test.ts test/boot/config-defaults.test.ts`
Expected: FAIL: `throttle.test.ts` at compile time (`Type '"verify"' is not assignable`), `config-schema` deep-equal mismatch on `throttle.verify`, the memory test with `MemoryAuthnThrottle: unknown flow "verify"`.

- [ ] **Step 4: Implement**

`packages/authn/src/contracts/throttle.ts`:

```ts
export type ThrottleFlow = 'login' | 'mfa' | 'reset' | 'reauth' | 'verify';
```

In `ThrottleParams` add after `reauth`:

```ts
  readonly verify: ThrottleFlowParams;
```

```ts
export const THROTTLE_FLOWS: readonly ThrottleFlow[] = Object.freeze(['login', 'mfa', 'reset', 'reauth', 'verify']);
```

In `DEFAULT_THROTTLE_PARAMS` add after `reauth`:

```ts
  verify: Object.freeze({ account: backoff(3, 60000, 3600000), ip: backoff(10, 10000, 900000) }),
```

`packages/authn/src/throttle/memory-throttle.ts:89`:

```ts
    this.tables = Object.freeze({ login: table(), mfa: table(), reset: table(), reauth: table(), verify: table() });
```

`packages/authn/src/config/authn.ts`, in `throttle` after `reauth`:

```ts
      verify: { account: { free: 3, baseDelayMs: 60000, maxDelayMs: 3600000 }, ip: { free: 10, baseDelayMs: 10000, maxDelayMs: 900000 } },
```

- [ ] **Step 5: GREEN + package suite + dependants**

1. The four test files above pass (`config-defaults.test.ts` compares the shipped block, the schema defaults and `DEFAULT_THROTTLE_PARAMS`, so all three must agree).
2. `npm test` in `packages/authn`.
3. Rebuild authn (`npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`), then `cd ../authn-orm && npm test` (`DbAuthnThrottle` takes the new flow through `THROTTLE_FLOWS`), then `cd ../authn-testing && npm test`.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/contracts/throttle.ts packages/authn/src/throttle/memory-throttle.ts packages/authn/src/schemas/authn.configuration.ts packages/authn/src/config/authn.ts packages/authn/test/contracts/throttle.test.ts packages/authn/test/contracts/config-schema.test.ts packages/authn/test/throttle/memory-throttle.test.ts packages/authn-orm/test/throttle-config.test.ts
git commit -m "feat(authn): throttle flow verify for address verification"
```

---

### Task 3: Schema `authn.codes` and `authn.verification`, message IDs

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts` (two blocks after `freshAuth`, line 258)
- Create: `packages/authn/src/messages/verification.ts`
- Modify: `packages/authn/src/messages/catalogue.ts` (plan 03: `PARTS` and the `DEFINITIONS` spread)
- Modify: `docs/authn/messages.md` (regenerated by plan 03's golden test)
- Test: `packages/authn/test/contracts/config-schema.test.ts:271`, `packages/authn/test/boot/config-defaults.test.ts:75`, `packages/authn/test/messages/catalogue.test.ts` (plan 03's `PINNED` and range test)

**Interfaces:**
- Consumes: plan 03's `AuthnMessageDefinition` (`packages/authn/src/messages/types.ts`), `PARTS`/`DEFINITIONS`/`assertDistinctMessages` (`catalogue.ts`), `authnMessage` (`factory.ts`).
- Produces: config `authn.codes.{ secret: string | null (default null), maxAttempts: 1-10 (5), length: 6-10 (6) }`, `authn.verification.{ requiredForLogin: false | 'email' (false), ttlSeconds: 60-86400 (900), url: string (''), trustExternalEmail: boolean (true) }`; `VERIFICATION_MESSAGES` with the codes `verification_sent` (1004001), `address_verified` (1004002), `E_CODE_INVALID` (4004001), `E_VERIFICATION_REQUIRED` (4004002), `E_INVALID_ADDRESS` (4004003), all valid `AuthnMessageCode`s (and the three errors valid `AuthnErrorCode`s) for `authnMessage` and `errorBody`.

- [ ] **Step 1: Schema additions**

After the `freshAuth` block:

```ts
    codes: {
      type: 'object',
      default: {},
      propertyNames: { enum: ['secret', 'maxAttempts', 'length'] },
      properties: {
        secret: { type: ['string', 'null'], minLength: 32, default: null, description: 'HMAC key of stored one-time codes; a secret reference, never an inline value. DbOneTimeCodeStore refuses to work without it.' },
        maxAttempts: { type: 'integer', minimum: 1, maximum: 10, default: 5, description: 'Wrong answers after which a code is void.' },
        length: { type: 'integer', minimum: 6, maximum: 10, default: 6, description: 'Digits of an issued code.' },
      },
    },
    verification: {
      type: 'object',
      default: {},
      propertyNames: { enum: ['requiredForLogin', 'ttlSeconds', 'url', 'trustExternalEmail'] },
      properties: {
        // No `type`: with coerceTypes the string 'false' must not become false silently, nor false a string.
        requiredForLogin: { enum: [false, 'email'], default: false, description: "'email': an interactive login needs a verified email (answered after the credential verified)." },
        ttlSeconds: { type: 'integer', minimum: 60, maximum: 86400, default: 900 },
        url: { type: 'string', default: '', description: 'App page a verification link opens; the code travels in its fragment. Empty: mails carry the code only.' },
        trustExternalEmail: { type: 'boolean', default: true, description: 'An external login whose provider vouches for the email (emailVerified true) marks it verified.' },
      },
    },
```

- [ ] **Step 2: Write the failing tests**

`packages/authn/test/contracts/config-schema.test.ts` line 271: in the expected object add after `freshAuth: { maxAgeSeconds: 300 },`:

```ts
codes: { secret: null, maxAttempts: 5, length: 6 }, verification: { requiredForLogin: false, ttlSeconds: 900, url: '', trustExternalEmail: true },
```

and add a test in the same `describe`:

```ts
    it('takes authn.codes and authn.verification within their bounds', () => {
      expect(check({ codes: { secret: 'k'.repeat(32), maxAttempts: 3, length: 8 }, verification: { requiredForLogin: 'email', ttlSeconds: 600, url: 'https://app.test/verify' } }).ok).to.eq(true);
      expect(check({ codes: { length: 5 } }).paths).to.include('/codes/length');
      expect(check({ codes: { maxAttempts: 0 } }).paths).to.include('/codes/maxAttempts');
      expect(check({ codes: { secret: 'short' } }).paths).to.include('/codes/secret');
      expect(check({ verification: { requiredForLogin: 'phone' } }).paths).to.include('/verification/requiredForLogin');
      expect(check({ verification: { ttlSeconds: 30 } }).paths).to.include('/verification/ttlSeconds');
      expect(check({ verification: { typo: 1 } }).ok).to.eq(false);
    });
```

`packages/authn/test/boot/config-defaults.test.ts` line 75: in the expected config add `codes: check({}).config.codes, verification: check({}).config.verification` next to `token: check({}).config.token`.

In plan 03's `packages/authn/test/messages/catalogue.test.ts`, append to `PINNED` (keep the list sorted by id):

```ts
  [1004001, 'verification_sent', 'info'],
  [1004002, 'address_verified', 'info'],
  [4004001, 'E_CODE_INVALID', 'error'],
  [4004002, 'E_VERIFICATION_REQUIRED', 'error'],
  [4004003, 'E_INVALID_ADDRESS', 'error'],
```

and in its test `each part stays in its README range` add (with `import { VERIFICATION_MESSAGES } from '../../src/messages/verification.js';` at the top):

```ts
    for (const [code, d] of Object.entries(VERIFICATION_MESSAGES) as [string, AuthnMessageDefinition][]) {
      expect(within(d.id, 1004000, 1004999) || within(d.id, 4004000, 4004999), code).to.eq(true);
    }
```

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/config-schema.test.ts test/boot/config-defaults.test.ts test/messages/catalogue.test.ts`
Expected: FAIL: schema deep-equal mismatch (no `codes`/`verification` defaults); `catalogue.test.ts` fails at compile time with `Cannot find module '../../src/messages/verification.js'`.

- [ ] **Step 4: Implement**

Create `packages/authn/src/messages/verification.ts`:

```ts
import type { AuthnMessageDefinition } from './types.js';

/** Plan 06 range: 1004000–1004999 (info) and 4004000–4004999 (user error). Keys are the wire `error` codes. */
export const VERIFICATION_MESSAGES = {
  verification_sent: { id: 1004001, type: 'info', text: 'If the address belongs to an account, a code is on its way.' },
  address_verified: { id: 1004002, type: 'info', text: 'The address is verified.' },
  E_CODE_INVALID: { id: 4004001, type: 'error', text: 'The code is invalid or has expired.' },
  E_VERIFICATION_REQUIRED: { id: 4004002, type: 'error', text: 'Verify your email address to log in.' },
  E_INVALID_ADDRESS: { id: 4004003, type: 'error', text: 'Enter a valid address.' },
} as const satisfies Readonly<Record<string, AuthnMessageDefinition>>;
```

In plan 03's `packages/authn/src/messages/catalogue.ts`, import it and add it to both lists:

```ts
import { VERIFICATION_MESSAGES } from './verification.js';
```

```ts
const PARTS = [CORE_MESSAGES, PASSWORD_MESSAGES, VERIFICATION_MESSAGES] as const;
```

```ts
const DEFINITIONS = { ...CORE_MESSAGES, ...PASSWORD_MESSAGES, ...VERIFICATION_MESSAGES };
```

(Keep whatever parts other plans added before you; append this one.) Then regenerate the docs: `UPDATE_GOLDEN=1 npx ts-mocha -p tsconfig.json test/messages/doc.test.ts`.

- [ ] **Step 5: GREEN + package suite**

1. The three files pass, and `npx ts-mocha -p tsconfig.json test/messages/doc.test.ts` passes without `UPDATE_GOLDEN`.
2. `npm test` in `packages/authn`. Rebuild (`npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`) because Task 4 reads `lib/`.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn/src/messages/verification.ts packages/authn/src/messages/catalogue.ts packages/authn/test/contracts/config-schema.test.ts packages/authn/test/boot/config-defaults.test.ts packages/authn/test/messages/catalogue.test.ts docs/authn/messages.md
git commit -m "feat(authn): authn.codes and authn.verification in the schema, verification message ids"
```

---

### Task 4: authn-testing — address and code fakes, rule A33, code store conformance

**Files:**
- Create: `packages/authn-testing/src/fakes/addresses.ts`, `packages/authn-testing/src/fakes/codes.ts`
- Modify: `packages/authn-testing/src/fakes/index.ts`
- Create: `packages/authn-testing/src/behaviour/A33-one-time-codes.spec.ts`
- Modify: `packages/authn-testing/src/behaviour/types.ts:8` (`RULE_IDS`), `:15-55` (`portNames`)
- Modify: `packages/authn-testing/src/harness/ports.ts:9-56` (`Harness`) and add `CodeStoragePort`
- Modify: `packages/authn-testing/src/behaviour/index.ts:1-40`
- Modify: `packages/authn-testing/src/conformance/stores.ts`
- Test: `packages/authn-testing/test/registry.test.ts:7,48-54`, create `packages/authn-testing/test/verification-fakes.test.ts`

The rule id appears in four places: `types.ts` `RULE_IDS`, the spec file (name and `defineRule`), `behaviour/index.ts` `ALL`, and `registry.test.ts`.

**Interfaces:**
- Consumes: Task 1 contracts.
- Produces (from `@spinajs/authn-testing`):
  - `MemoryAddressStore extends AddressStore` with `set(identity, channel, raw, verifiedAt?: Date | null): string` (replaces the identity's address of that channel, returns the normalized value) and `marked: { identity; channel; value; at }[]`.
  - `RecordingCodeSender extends CodeSender` with `sent: CodeMessage[]`, `fail: Error | null`, `codeFor(to: string, purpose: CodePurpose): string | null`, `clear(): void`.
  - Ports `codes?: OneTimeCodeStore`, `codeStorage?: CodeStoragePort` where `CodeStoragePort.rows(): Promise<readonly CodeRowView[]>`, `CodeRowView = { subject: string; purpose: string; codeHash: string; attempts: number; expiresAt: Date; usedAt: Date | null }`.
  - Rule `A33` (facet `A33/store`), wrapper `runOneTimeCodeStoreConformance(factory, opts?)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/authn-testing/test/verification-fakes.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';

import { MemoryAddressStore, RecordingCodeSender } from '../src/fakes/index.js';

const ALICE = { type: 'user', id: 'alice' };
const BOB = { type: 'user', id: 'bob' };

describe('verification fakes', () => {
  it('MemoryAddressStore normalizes, finds a single holder and binds a mark to the current value', async () => {
    const s = new MemoryAddressStore();
    assert.strictEqual(s.set(ALICE, 'email', ' Alice@Example.test '), 'alice@example.test');
    assert.deepStrictEqual(await s.findByAddress('email', 'alice@example.test'), ALICE);
    assert.strictEqual(await s.markVerified(ALICE, 'email', 'old@example.test', new Date(1)), false);
    assert.strictEqual(await s.markVerified(ALICE, 'email', 'alice@example.test', new Date(1)), true);
    assert.deepStrictEqual(await s.addresses(ALICE), [{ channel: 'email', value: 'alice@example.test', verifiedAt: new Date(1) }]);
    s.set(ALICE, 'email', 'new@example.test');
    assert.deepStrictEqual(await s.addresses(ALICE), [{ channel: 'email', value: 'new@example.test', verifiedAt: null }]);
    s.set(BOB, 'sms', '+48 123 456 789');
    s.set(ALICE, 'sms', '0048123456789');
    assert.strictEqual(await s.findByAddress('sms', '+48123456789'), null, 'two holders: none');
  });

  it('RecordingCodeSender records messages and hands out the newest code', async () => {
    const r = new RecordingCodeSender();
    await r.send({ channel: 'email', to: 'a@b.c', purpose: 'verify', code: '111111', ttlSeconds: 60 });
    await r.send({ channel: 'email', to: 'a@b.c', purpose: 'verify', code: '222222', ttlSeconds: 60 });
    assert.strictEqual(r.codeFor('a@b.c', 'verify'), '222222');
    assert.strictEqual(r.codeFor('a@b.c', 'login'), null);
    r.fail = new Error('down');
    await assert.rejects(r.send({ channel: 'email', to: 'a@b.c', purpose: 'verify', code: '3', ttlSeconds: 60 }), /down/);
  });
});
```

`packages/authn-testing/test/registry.test.ts`: in `FACET_MAP` (line 7) append `'A33/store'`; replace the first test (lines 48-54):

```ts
  it('RULE_IDS are A01–A27, A30–A32 and A33 in order', () => {
    const expected = [...Array.from({ length: 27 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`), 'A30', 'A31', 'A32', 'A33'];
    assert.deepStrictEqual([...RULE_IDS], expected);
    assert.deepStrictEqual([...AUTHN_RULES.keys()], expected);
    assert.strictEqual(AUTHN_RULES.has('A28' as RuleId), false);
    assert.strictEqual(AUTHN_RULES.has('A29' as RuleId), false);
  });
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn-testing && npx ts-mocha -p tsconfig.json test/verification-fakes.test.ts test/registry.test.ts`
Expected: FAIL: `Module '"../src/fakes/index.js"' has no exported member 'MemoryAddressStore'`; the registry test lists 30 ids, not 31.

- [ ] **Step 3: Implement**

Create `packages/authn-testing/src/fakes/addresses.ts`:

```ts
import { AddressStore, normalizeAddress } from '@spinajs/authn/contracts';
import type { AddressChannel, IdentityRef, VerifiableAddress } from '@spinajs/authn/contracts';

interface Entry {
  readonly identity: IdentityRef;
  readonly channel: AddressChannel;
  readonly value: string;
  verifiedAt: Date | null;
}

const sameRef = (a: IdentityRef, b: IdentityRef) => a.type === b.type && a.id === b.id;

/** One address per identity and channel. `set` replaces it unverified, as a change of address does. */
export class MemoryAddressStore extends AddressStore {
  readonly marked: { identity: IdentityRef; channel: AddressChannel; value: string; at: Date }[] = [];
  private entries: Entry[] = [];

  set(identity: IdentityRef, channel: AddressChannel, raw: string, verifiedAt: Date | null = null): string {
    const value = normalizeAddress(channel, raw);
    if (value === null) throw new RangeError(`not an ${channel} address: ${raw}`);
    this.entries = this.entries.filter((e) => !(sameRef(e.identity, identity) && e.channel === channel));
    this.entries.push({ identity, channel, value, verifiedAt });
    return value;
  }

  async addresses(id: IdentityRef): Promise<readonly VerifiableAddress[]> {
    return this.entries.filter((e) => sameRef(e.identity, id)).map((e) => ({ channel: e.channel, value: e.value, verifiedAt: e.verifiedAt }));
  }

  async findByAddress(channel: AddressChannel, value: string): Promise<IdentityRef | null> {
    const hits = this.entries.filter((e) => e.channel === channel && e.value === value);
    return hits.length === 1 ? hits[0].identity : null;
  }

  async markVerified(id: IdentityRef, channel: AddressChannel, value: string, at: Date): Promise<boolean> {
    const e = this.entries.find((x) => sameRef(x.identity, id) && x.channel === channel && x.value === value);
    if (!e) return false;
    e.verifiedAt = at;
    this.marked.push({ identity: id, channel, value, at });
    return true;
  }
}
```

Create `packages/authn-testing/src/fakes/codes.ts`:

```ts
import { CodeSender } from '@spinajs/authn/contracts';
import type { CodeMessage, CodePurpose } from '@spinajs/authn/contracts';

export class RecordingCodeSender extends CodeSender {
  readonly sent: CodeMessage[] = [];
  /** Set to make every send throw it. */
  fail: Error | null = null;

  async send(message: CodeMessage): Promise<void> {
    if (this.fail) throw this.fail;
    this.sent.push(message);
  }

  /** The code of the newest message of `purpose` to `to`, or null. */
  codeFor(to: string, purpose: CodePurpose): string | null {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].to === to && this.sent[i].purpose === purpose) return this.sent[i].code;
    }
    return null;
  }

  clear(): void {
    this.sent.length = 0;
  }
}
```

Append to `packages/authn-testing/src/fakes/index.ts`:

```ts
export * from './addresses.js';
export * from './codes.js';
```

In `packages/authn-testing/src/harness/ports.ts`: add `OneTimeCodeStore` to the `@spinajs/authn/contracts` type import (line 2), add to `Harness` after `secretStorage`:

```ts
  readonly codes?: OneTimeCodeStore;
  readonly codeStorage?: CodeStoragePort;
```

and after `SecretStoragePort`:

```ts
export interface CodeRowView {
  /** As stored: a keyed digest, never the subject itself. */
  readonly subject: string;
  readonly purpose: string;
  readonly codeHash: string;
  readonly attempts: number;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

export interface CodeStoragePort {
  rows(): Promise<readonly CodeRowView[]>;
}
```

`packages/authn-testing/src/behaviour/types.ts`: append `'A33'` to `RULE_IDS`, and add `codes: 1, codeStorage: 1,` to `portNames` after `secretStorage: 1,`.

Create `packages/authn-testing/src/behaviour/A33-one-time-codes.spec.ts`:

```ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { defineCase, defineRule } from './types.js';
import type { AuthnRule } from './types.js';

const SECOND = 1000;
const ALICE = 'address:email:alice@example.test';
const BOB = 'address:email:bob@example.test';
const TTL = { ttlSeconds: 600 } as const;
/** Lanes run A33 with authn.codes.maxAttempts at its default. */
const MAX_ATTEMPTS = 5;

/** A code of the same length that is not `code`. */
const wrong = (code: string, i = 0): string => String((Number(code) + 1 + i) % 10 ** code.length).padStart(code.length, '0');

export const A33: AuthnRule = defineRule('A33', 'one-time codes are keyed-hashed, bound, short-lived and bounded', [
  defineCase({
    name: 'A33 a code is decimal digits of the asked length, 6 by default',
    facet: 'A33/store',
    needs: ['codes'],
    async run(h) {
      const six = await h.codes.issue(ALICE, 'verify', TTL);
      assert.match(six.code, /^\d{6}$/);
      assert.strictEqual(six.ttlSeconds, 600);
      assert.match((await h.codes.issue(BOB, 'verify', { ttlSeconds: 600, length: 8 })).code, /^\d{8}$/);
    },
  }),
  defineCase({
    name: 'A33 the store keeps neither the code, its plain SHA-256, nor the subject',
    facet: 'A33/store',
    needs: ['codes', 'codeStorage'],
    async run(h) {
      const { code } = await h.codes.issue(ALICE, 'verify', TTL);
      const rows = await h.codeStorage.rows();
      assert.strictEqual(rows.length, 1);
      const dump = JSON.stringify(rows);
      const sha = createHash('sha256').update(code).digest();
      for (const leak of [code, ALICE, 'alice@example.test', sha.toString('hex'), sha.toString('base64url')]) {
        assert.ok(!dump.includes(leak), `a row holds ${leak}`);
      }
    },
  }),
  defineCase({
    name: 'A33 a code verifies once',
    facet: 'A33/store',
    needs: ['codes'],
    async run(h) {
      const { code } = await h.codes.issue(ALICE, 'verify', TTL);
      assert.strictEqual(await h.codes.verify(ALICE, 'verify', code), 'ok');
      assert.strictEqual(await h.codes.verify(ALICE, 'verify', code), 'invalid', 'a second verify');
    },
  }),
  defineCase({
    name: 'A33 a code is bound to its subject and its purpose',
    facet: 'A33/store',
    needs: ['codes'],
    async run(h) {
      const { code } = await h.codes.issue(ALICE, 'verify', TTL);
      assert.strictEqual(await h.codes.verify(BOB, 'verify', code), 'invalid', 'other subject');
      assert.strictEqual(await h.codes.verify(ALICE, 'login', code), 'invalid', 'other purpose');
      assert.strictEqual(await h.codes.verify(ALICE, 'verify', code), 'ok');
    },
  }),
  defineCase({
    name: 'A33 a new code replaces the live one of that subject and purpose only',
    facet: 'A33/store',
    needs: ['codes'],
    async run(h) {
      const first = await h.codes.issue(ALICE, 'verify', TTL);
      const second = await h.codes.issue(ALICE, 'verify', TTL);
      const login = await h.codes.issue(ALICE, 'login', TTL);
      if (first.code !== second.code) assert.strictEqual(await h.codes.verify(ALICE, 'verify', first.code), 'invalid', 'the replaced code');
      assert.strictEqual(await h.codes.verify(ALICE, 'verify', second.code), 'ok');
      assert.strictEqual(await h.codes.verify(ALICE, 'login', login.code), 'ok', 'another purpose is untouched');
    },
  }),
  defineCase({
    name: 'A33 a code expires',
    facet: 'A33/store',
    needs: ['codes', 'fakeDate'],
    async run(h, k) {
      const a = await h.codes.issue(ALICE, 'verify', { ttlSeconds: 60 });
      const b = await h.codes.issue(BOB, 'verify', { ttlSeconds: 60 });
      k.clock.tick(59 * SECOND);
      assert.strictEqual(await h.codes.verify(ALICE, 'verify', a.code), 'ok', 'live at +59 s');
      k.clock.tick(2 * SECOND);
      assert.strictEqual(await h.codes.verify(BOB, 'verify', b.code), 'expired', 'expired at +61 s');
    },
  }),
  defineCase({
    name: 'A33 the right code within maxAttempts verifies',
    facet: 'A33/store',
    needs: ['codes'],
    async run(h) {
      const { code } = await h.codes.issue(ALICE, 'verify', TTL);
      for (let i = 0; i < MAX_ATTEMPTS - 1; i++) assert.strictEqual(await h.codes.verify(ALICE, 'verify', wrong(code, i)), 'invalid');
      assert.strictEqual(await h.codes.verify(ALICE, 'verify', code), 'ok');
    },
  }),
  defineCase({
    name: 'A33 after maxAttempts wrong answers even the right code is refused',
    facet: 'A33/store',
    needs: ['codes'],
    async run(h) {
      const { code } = await h.codes.issue(ALICE, 'verify', TTL);
      for (let i = 0; i < MAX_ATTEMPTS; i++) assert.strictEqual(await h.codes.verify(ALICE, 'verify', wrong(code, i)), 'invalid');
      assert.strictEqual(await h.codes.verify(ALICE, 'verify', code), 'exhausted');
    },
  }),
  defineCase({
    name: 'A33 parallel wrong guesses are counted one by one',
    facet: 'A33/store',
    needs: ['codes'],
    async run(h) {
      const { code } = await h.codes.issue(ALICE, 'verify', TTL);
      const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => h.codes.verify(ALICE, 'verify', wrong(code, i))));
      const invalid = answers.filter((a) => a === 'invalid').length;
      assert.ok(answers.every((a) => a === 'invalid' || a === 'exhausted'), answers.join(','));
      assert.ok(invalid >= 1 && invalid <= MAX_ATTEMPTS, `${invalid} guesses were compared`);
      assert.strictEqual(await h.codes.verify(ALICE, 'verify', code), 'exhausted');
    },
  }),
  defineCase({
    name: 'A33 an unknown subject and a malformed code answer invalid; spaces in a code do not matter',
    facet: 'A33/store',
    needs: ['codes'],
    async run(h) {
      assert.strictEqual(await h.codes.verify(BOB, 'verify', '123456'), 'invalid', 'no code issued');
      const { code } = await h.codes.issue(ALICE, 'verify', TTL);
      assert.strictEqual(await h.codes.verify(ALICE, 'verify', 'abcdef'), 'invalid');
      assert.strictEqual(await h.codes.verify(ALICE, 'verify', `${code.slice(0, 3)} ${code.slice(3)}`), 'ok');
    },
  }),
]);
```

`packages/authn-testing/src/behaviour/index.ts`: add `import { A33 } from './A33-one-time-codes.spec.js';` after the A32 import and append `A33` to `ALL`.

Append to `packages/authn-testing/src/conformance/stores.ts`:

```ts

/** A33 store facet, claimed: ports `codes`, `codeStorage`; the store runs with authn.codes.maxAttempts 5. */
export function runOneTimeCodeStoreConformance(factory: HarnessFactory, opts: StoreConformanceOptions = {}): void {
  runStoreFacets(['A33'], ['A33/store'], 'one-time code store conformance', factory, opts);
}
```

- [ ] **Step 4: GREEN + package suite + rebuild**

1. `cd packages/authn-testing && npx ts-mocha -p tsconfig.json test/verification-fakes.test.ts test/registry.test.ts` — passing (the registry checks that every A33 case uses a known facet and known needs).
2. `npm test` in `packages/authn-testing`.
3. Rebuild: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-testing/src/fakes/addresses.ts packages/authn-testing/src/fakes/codes.ts packages/authn-testing/src/fakes/index.ts packages/authn-testing/src/behaviour/A33-one-time-codes.spec.ts packages/authn-testing/src/behaviour/types.ts packages/authn-testing/src/behaviour/index.ts packages/authn-testing/src/harness/ports.ts packages/authn-testing/src/conformance/stores.ts packages/authn-testing/test/verification-fakes.test.ts packages/authn-testing/test/registry.test.ts
git commit -m "test(authn-testing): rule A33 for one-time codes, address and code sender fakes"
```

---

### Task 5: Code digests (`@spinajs/authn/codes`) and `MemoryOneTimeCodeStore`

**Files:**
- Create: `packages/authn/src/codes/digest.ts`, `packages/authn/src/codes/memory-code-store.ts`, `packages/authn/src/codes/index.ts`
- Modify: `packages/authn/src/index.ts` (one export line), `packages/authn/package.json` (`exports`, `typesVersions`)
- Test: create `packages/authn/test/codes/memory-code-store.test.ts`

**Interfaces:**
- Consumes: `OneTimeCodeStore` (Task 1), `runOneTimeCodeStoreConformance` (Task 4).
- Produces:
  - `@spinajs/authn/codes`: `DEFAULT_CODE_LENGTH = 6`, `DEFAULT_MAX_ATTEMPTS = 5`, `newCode(length?: number): string`, `checkedPurpose(p: unknown): string`, `checkedTtl(s: unknown): number`, `codeKey(secret: string | null | undefined): Buffer | null`, `subjectDigest(key: Buffer, subject: string): string`, `codeDigest(key: Buffer, subjectKey: string, purpose: string, code: string): string`, `sameDigest(a: string, b: string): boolean`, `enteredCode(code: unknown): string | null`.
  - `@spinajs/authn`: `MemoryOneTimeCodeStore(options?: { secret?: string; maxAttempts?: number })` with `rows(): CodeRowView`-shaped array (`{ subject, purpose, codeHash, attempts, expiresAt, usedAt }`).

- [ ] **Step 1: Write the failing test**

Create `packages/authn/test/codes/memory-code-store.test.ts`:

```ts
import assert from 'node:assert/strict';
import { expect } from 'chai';
import 'mocha';
import { runOneTimeCodeStoreConformance } from '@spinajs/authn-testing';

import { MemoryOneTimeCodeStore } from '../../src/index.js';
import { codeDigest, codeKey, enteredCode, newCode, subjectDigest } from '../../src/codes/digest.js';

describe('MemoryOneTimeCodeStore', () => {
  runOneTimeCodeStoreConformance(
    () => {
      const store = new MemoryOneTimeCodeStore({ maxAttempts: 5 });
      return { codes: store, codeStorage: { rows: async () => store.rows() } };
    },
    { title: 'one-time code store conformance (memory)' },
  );

  it('refuses a length outside 6 to 10 digits and a ttl that is not positive', async () => {
    const store = new MemoryOneTimeCodeStore();
    await assert.rejects(store.issue('s', 'verify', { ttlSeconds: 60, length: 5 }), /6 to 10 digits/);
    await assert.rejects(store.issue('s', 'verify', { ttlSeconds: 0 }), /ttlSeconds/);
  });

  it('keys digests with the secret: equal secrets agree, other secrets do not', () => {
    const a = codeKey('a'.repeat(32))!;
    const b = codeKey('b'.repeat(32))!;
    expect(subjectDigest(a, 's')).to.eq(subjectDigest(codeKey('a'.repeat(32))!, 's'));
    expect(subjectDigest(a, 's')).to.not.eq(subjectDigest(b, 's'));
    expect(codeDigest(a, 'k', 'verify', '123456')).to.match(/^[0-9a-f]{64}$/);
    expect(codeKey('')).to.eq(null);
  });

  it('generates uniform digit strings and reads entered codes leniently', () => {
    expect(new Set(Array.from({ length: 200 }, () => newCode())).size).to.be.greaterThan(190);
    expect(enteredCode(' 123 456 ')).to.eq('123456');
    expect(enteredCode('12a456')).to.eq(null);
    expect(enteredCode('9'.repeat(65))).to.eq(null);
  });
});
```


- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/codes/memory-code-store.test.ts`
Expected: FAIL at compile time: `Module '"../../src/index.js"' has no exported member 'MemoryOneTimeCodeStore'`, `Cannot find module '../../src/codes/digest.js'`.

- [ ] **Step 3: Implement**

Create `packages/authn/src/codes/digest.ts`:

```ts
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { InvalidArgument } from '@spinajs/exceptions';

// Loaded alone through @spinajs/authn/codes by authn-orm: no import here may register a service.

export const DEFAULT_CODE_LENGTH = 6;
export const DEFAULT_MAX_ATTEMPTS = 5;
const MIN_LENGTH = 6;
const MAX_LENGTH = 10;
const PURPOSE_MAX = 32;
/** No code is longer; longer input is refused before any hashing. */
const INPUT_MAX = 64;

/** `length` decimal digits, uniform. */
export function newCode(length: number = DEFAULT_CODE_LENGTH): string {
  if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) throw new InvalidArgument(`a code has ${MIN_LENGTH} to ${MAX_LENGTH} digits`);
  return String(randomInt(0, 10 ** length)).padStart(length, '0');
}

export function checkedPurpose(purpose: unknown): string {
  if (typeof purpose !== 'string' || purpose === '' || purpose.length > PURPOSE_MAX) throw new InvalidArgument(`a code purpose is 1 to ${PURPOSE_MAX} characters`);
  return purpose;
}

export function checkedTtl(ttlSeconds: unknown): number {
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new InvalidArgument('ttlSeconds must be a positive number');
  return ttlSeconds;
}

/** The HMAC key of a configured secret; null when none is set. */
export function codeKey(secret: string | null | undefined): Buffer | null {
  return typeof secret === 'string' && secret.length > 0 ? Buffer.from(secret, 'utf8') : null;
}

/** Hex, so stores with case-insensitive collations still tell two digests apart. */
export function subjectDigest(key: Buffer, subject: string): string {
  if (typeof subject !== 'string' || subject === '') throw new InvalidArgument('a code subject must be a non-empty string');
  return createHmac('sha256', key).update(`subject|${subject}`, 'utf8').digest('hex');
}

/** Bound to the subject and the purpose, so a digest is worthless for any other row. */
export function codeDigest(key: Buffer, subjectKey: string, purpose: string, code: string): string {
  return createHmac('sha256', key).update(`code|${subjectKey}|${purpose}|${code}`, 'utf8').digest('hex');
}

export function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Digits with any whitespace removed; null for anything else. */
export function enteredCode(code: unknown): string | null {
  if (typeof code !== 'string' || code.length > INPUT_MAX) return null;
  const digits = code.replace(/\s/g, '');
  return /^\d+$/.test(digits) ? digits : null;
}
```

Create `packages/authn/src/codes/memory-code-store.ts`:

```ts
import { randomBytes } from 'node:crypto';

import { OneTimeCodeStore } from '../contracts/codes.js';
import type { CodeCheck, CodePurpose, IssuedCode } from '../contracts/codes.js';
import { DEFAULT_CODE_LENGTH, DEFAULT_MAX_ATTEMPTS, checkedPurpose, checkedTtl, codeDigest, codeKey, enteredCode, newCode, sameDigest, subjectDigest } from './digest.js';

interface Row {
  readonly subject: string;
  readonly purpose: string;
  readonly codeHash: string;
  attempts: number;
  readonly expiresMs: number;
  usedMs: number | null;
}

export interface MemoryCodeStoreOptions {
  /** Default: random bytes of this instance. */
  readonly secret?: string;
  /** Default 5. */
  readonly maxAttempts?: number;
}

/**
 * The OneTimeCodeStore of one process, for tests. Never registered in DI: an app registers DbOneTimeCodeStore, and two
 * registered stores would make the choice depend on import order. Reads the clock (`Date`) at call time.
 */
export class MemoryOneTimeCodeStore extends OneTimeCodeStore {
  private readonly key: Buffer;
  private readonly maxAttempts: number;
  private readonly live = new Map<string, Row>();

  constructor(options: MemoryCodeStoreOptions = {}) {
    super();
    this.key = codeKey(options.secret) ?? randomBytes(32);
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  public async issue(subject: string, purpose: CodePurpose, opts: { readonly ttlSeconds: number; readonly length?: number }): Promise<IssuedCode> {
    const p = checkedPurpose(purpose);
    const ttlSeconds = checkedTtl(opts?.ttlSeconds);
    const code = newCode(opts.length ?? DEFAULT_CODE_LENGTH);
    const subjectKey = subjectDigest(this.key, subject);
    this.live.set(`${subjectKey}|${p}`, { subject: subjectKey, purpose: p, codeHash: codeDigest(this.key, subjectKey, p, code), attempts: 0, expiresMs: Date.now() + ttlSeconds * 1000, usedMs: null });
    return { code, ttlSeconds };
  }

  /** Counts the attempt before comparing, so no more than maxAttempts guesses are ever compared. */
  public async verify(subject: string, purpose: CodePurpose, code: string): Promise<CodeCheck> {
    const p = checkedPurpose(purpose);
    const subjectKey = subjectDigest(this.key, subject);
    const row = this.live.get(`${subjectKey}|${p}`);
    if (!row || row.usedMs !== null) return 'invalid';
    const now = Date.now();
    if (now >= row.expiresMs) return 'expired';
    if (row.attempts >= this.maxAttempts) return 'exhausted';
    row.attempts++;
    const entered = enteredCode(code);
    if (entered === null || !sameDigest(codeDigest(this.key, subjectKey, p, entered), row.codeHash)) return 'invalid';
    row.usedMs = now;
    return 'ok';
  }

  public rows(): { subject: string; purpose: string; codeHash: string; attempts: number; expiresAt: Date; usedAt: Date | null }[] {
    return [...this.live.values()].map((r) => ({ subject: r.subject, purpose: r.purpose, codeHash: r.codeHash, attempts: r.attempts, expiresAt: new Date(r.expiresMs), usedAt: r.usedMs === null ? null : new Date(r.usedMs) }));
  }
}
```

Create `packages/authn/src/codes/index.ts`:

```ts
export * from './digest.js';
export * from './memory-code-store.js';
```

Append to `packages/authn/src/index.ts`:

```ts
export * from './codes/index.js';
```

In `packages/authn/package.json` add next to `./env` in `exports`:

```json
    "./codes": {
      "types": "./lib/mjs/codes/digest.d.ts",
      "import": "./lib/mjs/codes/digest.js",
      "require": "./lib/cjs/codes/digest.js"
    }
```

and in `typesVersions["*"]`:

```json
      "codes": [
        "lib/cjs/codes/digest.d.ts"
      ]
```

- [ ] **Step 4: GREEN + package suite + rebuild**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/codes/memory-code-store.test.ts` — 10 conformance cases and 3 unit tests pass.
2. `npm test` in `packages/authn`.
3. Rebuild (`npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`) and check the subpath loads alone: `node --input-type=module -e "const c = await import('@spinajs/authn/codes'); console.log(typeof c.codeDigest)"` prints `function`.

- [ ] **Step 5: Commit**

```bash
git add packages/authn/src/codes packages/authn/src/index.ts packages/authn/package.json packages/authn/test/codes/memory-code-store.test.ts
git commit -m "feat(authn): HMAC code digests under @spinajs/authn/codes and MemoryOneTimeCodeStore"
```

---

### Task 6: `DbOneTimeCodeStore` and table `authn_code`

**Files:**
- Create: `packages/authn-orm/src/migrations/AuthnCode_2026_10_06_00_00_00.ts`
- Modify: `packages/authn-orm/src/migrations/index.ts`
- Create: `packages/authn-orm/src/codes/db-code-store.ts`, `packages/authn-orm/src/codes/index.ts`
- Modify: `packages/authn-orm/src/index.ts`
- Test: create `packages/authn-orm/test/code-store.test.ts`

**Interfaces:**
- Consumes: `@spinajs/authn/codes` (Task 5), `OneTimeCodeStore` (Task 1), `runOneTimeCodeStoreConformance` (Task 4), `authn.codes.secret`/`maxAttempts` (Task 3).
- Produces: `@Singleton() @Injectable(OneTimeCodeStore) DbOneTimeCodeStore(driver?: OrmDriver, options?: { secret?: string; maxAttempts?: number; container?: IContainer })` with `purge(now?: Date): Promise<number>`; migration `AuthnCode_2026_10_06_00_00_00` (table `authn_code`: `id` varchar(36) PK, `subject` varchar(64), `purpose` varchar(32), `code_hmac` varchar(64), `attempts` int default 0, `expires_at`, `used_at` null, `created_at`; unique index `authn_code_subject (subject, purpose)`).

- [ ] **Step 1: Write the failing test**

Create `packages/authn-orm/test/code-store.test.ts`:

```ts
import { FakeClock, runOneTimeCodeStoreConformance } from '@spinajs/authn-testing';
import { QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { AuthnCode_2026_10_06_00_00_00, DbOneTimeCodeStore, fromUtcColumn } from '../src/index.js';
import { DB_KINDS, TestDb, bootDb, rawQuery } from './support/db.js';

const SECRET = 'code-store-test-secret-0123456789abcdef';
const T0 = new Date('2026-10-06T10:00:00.000Z');

interface CodeRowText {
  subject: string;
  purpose: string;
  code_hmac: string;
  attempts: number;
  expires_text: string;
  used_text: string | null;
}

const codeRows = async (db: TestDb): Promise<CodeRowText[]> =>
  (await rawQuery(db.driver, 'SELECT subject, purpose, code_hmac, attempts, CAST(expires_at AS TEXT) AS expires_text, CAST(used_at AS TEXT) AS used_text FROM authn_code ORDER BY id')) as CodeRowText[];

for (const kind of DB_KINDS) {
  describe(`DbOneTimeCodeStore (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;

    before(async function () {
      db = await bootDb(this, kind, 'code_store');
    });

    after(async () => {
      await db?.dispose();
    });

    it('the migration creates authn_code with its unique (subject, purpose) index, and down drops it', async () => {
      expect(await db.driver.schema().tableExists('authn_code')).to.eq(true);
      await rawQuery(db.driver, 'DELETE FROM authn_code', [], QueryContext.Delete);
      const row = { subject: 'a'.repeat(64), purpose: 'verify', code_hmac: 'b'.repeat(64), attempts: 0, expires_at: '2026-10-06 10:00:00.000', used_at: null, created_at: '2026-10-06 10:00:00.000' };
      await db.driver.insert().into('authn_code').values({ id: 'c1', ...row });
      await expect(db.driver.insert().into('authn_code').values({ id: 'c2', ...row })).to.be.rejected;
      const migration = new AuthnCode_2026_10_06_00_00_00();
      await migration.down(db.driver);
      expect(await db.driver.schema().tableExists('authn_code')).to.eq(false);
      await migration.up(db.driver);
      expect(await db.driver.schema().tableExists('authn_code')).to.eq(true);
    });

    runOneTimeCodeStoreConformance(
      async () => {
        await rawQuery(db.driver, 'DELETE FROM authn_code', [], QueryContext.Delete);
        return {
          codes: new DbOneTimeCodeStore(db.driver, { secret: SECRET, maxAttempts: 5 }),
          codeStorage: {
            rows: async () =>
              (await codeRows(db)).map((r) => ({
                subject: r.subject,
                purpose: r.purpose,
                codeHash: r.code_hmac,
                attempts: Number(r.attempts),
                expiresAt: fromUtcColumn(r.expires_text)!,
                usedAt: fromUtcColumn(r.used_text) ?? null,
              })),
          },
        };
      },
      { title: `one-time code store conformance (${kind})`, timeoutMs: 30000 },
    );

    describe('store details', () => {
      let clock: FakeClock;

      beforeEach(async () => {
        await rawQuery(db.driver, 'DELETE FROM authn_code', [], QueryContext.Delete);
        clock = new FakeClock(T0);
        clock.install();
      });

      afterEach(() => clock.uninstall());

      it('fails closed without authn.codes.secret', async () => {
        const store = new DbOneTimeCodeStore(db.driver, { container: db.container });
        await expect(store.issue('address:email:a@b.c', 'verify', { ttlSeconds: 60 })).to.be.rejectedWith(/authn\.codes\.secret is not set/);
      });

      it('reads authn.codes.secret and maxAttempts from the configuration', async () => {
        const child = await bootDb(this as unknown as Mocha.Context, kind, 'code_store_cfg', { config: { authn: { codes: { secret: SECRET, maxAttempts: 2 } } } });
        try {
          const store = new DbOneTimeCodeStore(child.driver, { container: child.container });
          const { code } = await store.issue('address:email:a@b.c', 'verify', { ttlSeconds: 60 });
          const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');
          expect(await store.verify('address:email:a@b.c', 'verify', wrong)).to.eq('invalid');
          expect(await store.verify('address:email:a@b.c', 'verify', wrong)).to.eq('invalid');
          expect(await store.verify('address:email:a@b.c', 'verify', code)).to.eq('exhausted');
        } finally {
          await child.dispose();
        }
      });

      it('purges used and expired rows, and only those', async () => {
        const store = new DbOneTimeCodeStore(db.driver, { secret: SECRET });
        const used = await store.issue('s-used', 'verify', { ttlSeconds: 600 });
        await store.verify('s-used', 'verify', used.code);
        await store.issue('s-expired', 'verify', { ttlSeconds: 60 });
        await store.issue('s-live', 'verify', { ttlSeconds: 600 });
        clock.tick(120_000);
        expect(await store.purge()).to.eq(2);
        expect(await codeRows(db)).to.have.length(1);
      });
    });
  });
}
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn-orm && npx ts-mocha -p tsconfig.json test/code-store.test.ts`
Expected: FAIL at compile time: `Module '"../src/index.js"' has no exported member 'DbOneTimeCodeStore'` (and `AuthnCode_2026_10_06_00_00_00`).

- [ ] **Step 3: Implement**

Create `packages/authn-orm/src/migrations/AuthnCode_2026_10_06_00_00_00.ts`:

```ts
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/** `authn_code`: one-time codes as keyed digests (DbOneTimeCodeStore); one live row per (subject, purpose). */
@Migration('default')
export class AuthnCode_2026_10_06_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('authn_code', (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.string('subject', 64).notNull();
      table.string('purpose', 32).notNull();
      table.string('code_hmac', 64).notNull();
      table.int('attempts').notNull().default().value(0);
      table.dateTime('expires_at').notNull();
      table.dateTime('used_at');
      table.dateTime('created_at').notNull();
    });
    await connection.index().unique().table('authn_code').name('authn_code_subject').columns(['subject', 'purpose']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('authn_code');
  }
}
```

Append to `packages/authn-orm/src/migrations/index.ts`:

```ts
export * from './AuthnCode_2026_10_06_00_00_00.js';
```

Create `packages/authn-orm/src/codes/db-code-store.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { OneTimeCodeStore } from '@spinajs/authn/contracts';
import type { CodeCheck, CodePurpose, IssuedCode } from '@spinajs/authn/contracts';
import { DEFAULT_CODE_LENGTH, DEFAULT_MAX_ATTEMPTS, checkedPurpose, checkedTtl, codeDigest, codeKey, enteredCode, newCode, sameDigest, subjectDigest } from '@spinajs/authn/codes';
import { CONFIGURATION_CONTAINER_KEY, Config } from '@spinajs/configuration';
import { Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { OrmDriver } from '@spinajs/orm';
import type { WhereBuilder } from '@spinajs/orm';

import { StoreConnection } from '../support/connection.js';
import { checkedMs, columnText, isDuplicate, rowsAffected, selectTime, sqlTime, textMs } from '../support/sql.js';
import type { Dialect } from '../support/sql.js';

const TABLE = 'authn_code';
const PURGE_EVERY = 64;
const PURGE_BATCH = 500;
/** Each lost compare-and-set means a parallel guess took a slot; past this many the burst is far beyond maxAttempts. */
const MAX_TRIES = 16;

export interface DbCodeStoreOptions {
  /** Overrides `authn.codes.secret`. */
  readonly secret?: string;
  /** Overrides `authn.codes.maxAttempts`. */
  readonly maxAttempts?: number;
  /** Where the Orm and the Configuration come from; default the root container. */
  readonly container?: IContainer;
}

interface Stored {
  readonly id: string;
  readonly codeHmac: string;
  readonly attempts: number;
  readonly used: boolean;
  readonly expiresText: string | null;
}

/**
 * `authn_code`: one-time codes as HMAC-SHA256 digests under `authn.codes.secret` (subject and code alike), never the code.
 * Every guess claims an attempt with a compare-and-set before the comparison, so at most maxAttempts guesses are compared,
 * in parallel too. A missing code costs the same two statements as a wrong one. Times are UTC text taken in Node (F7).
 */
@Singleton()
@Injectable(OneTimeCodeStore)
export class DbOneTimeCodeStore extends OneTimeCodeStore {
  @Config('authn.codes.secret')
  protected ConfiguredSecret: string | null | undefined;

  @Config('authn.codes.maxAttempts')
  protected ConfiguredMaxAttempts: number | undefined;

  private readonly connection: StoreConnection;
  private calls = 0;

  /** DI passes nothing: the Orm's `'default'` connection and `authn.codes` are read on first use. */
  constructor(driver?: OrmDriver, private readonly options: DbCodeStoreOptions = {}) {
    super();
    this.connection = new StoreConnection('DbOneTimeCodeStore', driver, options.container);
    if (options.container) {
      // An instance built with `new` has no injected container, so @Config would read the root Configuration.
      Object.defineProperty(this, CONFIGURATION_CONTAINER_KEY, { value: options.container, configurable: true, writable: true });
    }
  }

  public async issue(subject: string, purpose: CodePurpose, opts: { readonly ttlSeconds: number; readonly length?: number }): Promise<IssuedCode> {
    const p = checkedPurpose(purpose);
    const ttlSeconds = checkedTtl(opts?.ttlSeconds);
    const key = this.key();
    const subjectKey = subjectDigest(key, subject);
    const code = newCode(opts.length ?? DEFAULT_CODE_LENGTH);
    const nowMs = checkedMs(new Date(), 'DbOneTimeCodeStore.issue: the clock');
    const { driver } = await this.connection.get();
    await this.purgeNowAndThen(nowMs);

    const row = { subject: subjectKey, purpose: p, code_hmac: codeDigest(key, subjectKey, p, code), attempts: 0, expires_at: sqlTime(nowMs + ttlSeconds * 1000), used_at: null, created_at: sqlTime(nowMs) };
    for (let tries = 0; ; tries++) {
      await driver.del().from(TABLE).where('subject', subjectKey).where('purpose', p);
      try {
        await driver.insert().into(TABLE).values({ id: randomUUID(), ...row });
        return { code, ttlSeconds };
      } catch (err) {
        // A parallel issue inserted between our delete and insert: replace its row in turn.
        if (!isDuplicate(err) || tries >= 2) throw err;
      }
    }
  }

  public async verify(subject: string, purpose: CodePurpose, code: string): Promise<CodeCheck> {
    const p = checkedPurpose(purpose);
    const key = this.key();
    const subjectKey = subjectDigest(key, subject);
    const entered = enteredCode(code);
    const nowMs = checkedMs(new Date(), 'DbOneTimeCodeStore.verify: the clock');
    const now = sqlTime(nowMs);
    const max = this.options.maxAttempts ?? this.ConfiguredMaxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const { driver, dialect } = await this.connection.get();
    await this.purgeNowAndThen(nowMs);

    for (let tries = 0; tries < MAX_TRIES; tries++) {
      const row = await this.read(driver, dialect, subjectKey, p);
      if (!row) {
        await this.claimAttempt(driver, randomUUID(), 0, now);
        return 'invalid';
      }
      if (row.used) return 'invalid';
      const expiresMs = row.expiresText === null ? NaN : textMs(row.expiresText);
      if (Number.isFinite(expiresMs) && expiresMs <= nowMs) return 'expired';
      if (row.attempts >= max) return 'exhausted';
      if (!(await this.claimAttempt(driver, row.id, row.attempts, now))) continue;
      if (entered === null || !sameDigest(codeDigest(key, subjectKey, p, entered), row.codeHmac)) return 'invalid';
      const claimed = await driver.update().in(TABLE).update({ used_at: now }).where('id', row.id).whereNull('used_at');
      return rowsAffected(claimed) === 1 ? 'ok' : 'invalid';
    }
    return 'exhausted';
  }

  /** Deletes up to one batch of used and expired rows; returns how many went. */
  public async purge(now: Date = new Date()): Promise<number> {
    const t = sqlTime(checkedMs(now, 'DbOneTimeCodeStore.purge: now'));
    const { driver } = await this.connection.get();
    const done = function (this: WhereBuilder<unknown>) {
      this.whereNotNull('used_at');
      this.orWhere('expires_at', '<=', t);
    };
    // MSSQL pages with OFFSET … FETCH, which needs an ORDER BY.
    const ids = ((await driver.select().from(TABLE).select('id').where(done).orderBy('id').take(PURGE_BATCH)) as { id: string }[]).map((r) => r.id);
    if (ids.length === 0) return 0;
    return rowsAffected(await driver.del().from(TABLE).whereIn('id', ids).where(done));
  }

  private key(): Buffer {
    const key = codeKey(this.options.secret ?? this.ConfiguredSecret);
    if (!key) throw new InvalidOperation('DbOneTimeCodeStore: authn.codes.secret is not set; codes need a key that every app instance shares');
    return key;
  }

  /** Raises attempts from `seen` by one while the code is live and unused; false when another guess got there first. */
  private async claimAttempt(driver: OrmDriver, id: string, seen: number, now: string): Promise<boolean> {
    const r = await driver.update().in(TABLE).update({ attempts: seen + 1 }).where('id', id).where('attempts', seen).whereNull('used_at').where('expires_at', '>', now);
    return rowsAffected(r) === 1;
  }

  private async read(driver: OrmDriver, dialect: Dialect, subjectKey: string, purpose: string): Promise<Stored | null> {
    const q = driver.select().from(TABLE).select('id').select('subject').select('purpose').select('code_hmac').select('attempts').select('used_at');
    const rows = (await selectTime(dialect, q, 'expires_at', 'expires_text').where('subject', subjectKey).where('purpose', purpose)) as Record<string, unknown>[];
    const r = rows.find((x) => x.subject === subjectKey && x.purpose === purpose);
    if (!r) return null;
    return { id: String(r.id), codeHmac: String(r.code_hmac), attempts: Number(r.attempts), used: r.used_at !== null && r.used_at !== undefined, expiresText: columnText(dialect, r, 'expires_at', 'expires_text') };
  }

  private async purgeNowAndThen(nowMs: number): Promise<void> {
    if (++this.calls % PURGE_EVERY === 0) await this.purge(new Date(nowMs));
  }
}
```

Create `packages/authn-orm/src/codes/index.ts`:

```ts
export { DbOneTimeCodeStore } from './db-code-store.js';
export type { DbCodeStoreOptions } from './db-code-store.js';
```

Append to `packages/authn-orm/src/index.ts`:

```ts
export * from './codes/index.js';
```

- [ ] **Step 4: GREEN + package suite + rebuild**

1. `cd packages/authn-orm && npx ts-mocha -p tsconfig.json test/code-store.test.ts` — sqlite cases pass; postgres cases pass or skip (no server).
2. `npm test` in `packages/authn-orm`. `migration.test.ts` only lists the `AuthnInitial` tables and stays green.
3. Rebuild (`npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`).

- [ ] **Step 5: Commit**

```bash
git add packages/authn-orm/src/migrations/AuthnCode_2026_10_06_00_00_00.ts packages/authn-orm/src/migrations/index.ts packages/authn-orm/src/codes packages/authn-orm/src/index.ts packages/authn-orm/test/code-store.test.ts
git commit -m "feat(authn-orm): DbOneTimeCodeStore over authn_code with keyed digests and counted attempts"
```

---

### Task 7: `EmailCodeSender`, registered by `users`

**Files:**
- Create: `packages/email/src/code-sender.ts`
- Modify: `packages/email/src/interfaces.ts:195-213` (`EmailConfiguration.codes`, `CodeMailConfiguration`)
- Modify: `packages/email/src/index.ts:23`
- Modify: `packages/users/src/index.ts:8-9,80-83`
- Test: create `packages/email/test/code-sender.test.ts`, create `packages/users/test/code-sender.test.ts`

**Interfaces:**
- Consumes: `CodeMessage`/`CodeSender` (Task 1) — `email` declares the shape locally (`ICodeMessage`) and never imports authn.
- Produces: `EmailCodeSender(deps?: { email: EmailService; options?: CodeMailConfiguration; defaultConnection?: string })` with `send(message: ICodeMessage): Promise<void>`; config `email.codes.{ connection?, from?, lang?, purposes?: Record<string, { subject?; template? }> }`. `RbacBootstrapper` registers `EmailCodeSender` as `CodeSender` when none is registered.

- [ ] **Step 1: Write the failing tests**

Create `packages/email/test/code-sender.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { EmailCodeSender, EmailSend, EmailSent } from '../src/index.js';
import type { ICodeMessage } from '../src/index.js';
import { capturingEmailService, dump, holds, recordPerf } from './capture.js';

const CODE = '482913';
const LINK = 'https://app.example.com/verify#channel=email&address=alice%40example.com&code=482913';

const aMessage = (over: Partial<ICodeMessage> = {}): ICodeMessage => ({ channel: 'email', to: 'alice@example.com', purpose: 'verify', code: CODE, link: LINK, ttlSeconds: 900, ...over });

// `transport` is the capturing EmailSender of capture.ts; `codes` the subject.
function senderWith(options: Record<string, unknown> = { connection: 'test' }) {
  const { service, sender: transport, emitted } = capturingEmailService();
  return { transport, emitted, codes: new EmailCodeSender({ email: service, options }) };
}

describe('EmailCodeSender', () => {
  recordPerf();

  it('sends at once with the code, the link, a purpose tag and both marked for redaction', async () => {
    const { codes, transport, emitted } = senderWith();
    await codes.send(aMessage());
    const m = transport.Captured[0];
    expect(m.to).to.deep.eq(['alice@example.com']);
    expect(m.subject).to.eq('Verify your email address');
    expect(m.tag).to.eq('authn-code-verify');
    expect(m.model).to.deep.eq({ Code: CODE, Link: LINK, ExpiresInMinutes: 15, Email: 'alice@example.com', Purpose: 'verify' });
    expect(m.redact).to.deep.eq([CODE, LINK]);
    expect(m.text).to.contain(CODE).and.contain(LINK).and.contain('15 minutes');
    expect(emitted.some((e) => e instanceof EmailSend)).to.eq(false);
    expect(emitted.every((e) => e instanceof EmailSent)).to.eq(true);
    expect(holds(dump(emitted), CODE)).to.eq(false);
  });

  it('takes the subject and template of the purpose from email.codes.purposes', async () => {
    const { codes, transport } = senderWith({ connection: 'test', purposes: { register: { subject: 'Welcome', template: './code.pug' } } });
    await codes.send(aMessage({ purpose: 'register', link: undefined }));
    const m = transport.Captured[0];
    expect(m.subject).to.eq('Welcome');
    expect(m.template).to.eq('./code.pug');
    expect(m.redact).to.deep.eq([CODE]);
  });

  it('refuses an sms message without leaking the code', async () => {
    const { codes, transport } = senderWith();
    const err = await codes.send(aMessage({ channel: 'sms', to: '+48123456789' })).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).to.match(/email only/).and.not.contain(CODE);
    expect(transport.Captured).to.have.length(0);
  });

  it('redacts the code from a transport error', async () => {
    const { codes, transport } = senderWith();
    transport.fail = (email) => new Error(`smtp refused ${JSON.stringify(email.model)}`);
    const err = await codes.send(aMessage()).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).to.contain('verify code mail was not sent').and.not.contain(CODE);
  });
});
```

`capturingEmailService()` returns `{ service, sender, logged, emitted, perf }` (`packages/email/test/capture.ts:77`).

Create `packages/users/test/code-sender.test.ts`:

```ts
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { expect } from 'chai';
import { CodeSender } from '@spinajs/authn/contracts';
import { EmailCodeSender } from '@spinajs/email';

import './migration/rbac.migration.js';
import { bootUsersDb, registerUsersTestHost } from './support/users-db.js';

describe('code sender registration', function () {
  this.timeout(60000);

  before(() => registerUsersTestHost());

  beforeEach(async () => {
    await bootUsersDb((config: Configuration) => config.set('email.defaultConnection', 'rbac-email-connection'));
  });

  afterEach(() => DI.clearCache());

  it("users' bootstrapper registers EmailCodeSender as the CodeSender", async () => {
    expect(DI.RootContainer.hasRegistered(CodeSender)).to.eq(true);
    expect(await DI.resolve(CodeSender)).to.be.instanceOf(EmailCodeSender);
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/email && npx ts-mocha -p tsconfig.json test/code-sender.test.ts`
Expected: FAIL at compile time: `Module '"../src/index.js"' has no exported member 'EmailCodeSender'`.

- [ ] **Step 3: Implement**

In `packages/email/src/interfaces.ts`, add to `EmailConfiguration` after `password?: PasswordMailConfiguration;`:

```ts
  codes?: CodeMailConfiguration;
```

and after `PasswordMailConfiguration`:

```ts
export interface CodeMailConfiguration {
  /**
   * Defaults to `email.defaultConnection`.
   */
  connection?: string;
  from?: string;
  lang?: string;
  /** Per code purpose (`verify`, `register`, `login`, or an app's own). */
  purposes?: Record<string, PasswordMailPurposeConfiguration>;
}
```

Create `packages/email/src/code-sender.ts`:

```ts
import { DI } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation, IOFail } from '@spinajs/exceptions';
import { CodeMailConfiguration, EmailService, IEmail } from './interfaces.js';
import { redactText } from './redact.js';

/** The fields of `CodeMessage` from `@spinajs/authn/contracts`, declared here so this package never imports it. */
export interface ICodeMessage {
  readonly channel: 'email' | 'sms';
  readonly to: string;
  readonly purpose: string;
  readonly code: string;
  readonly link?: string;
  readonly ttlSeconds: number;
  readonly locale?: string;
  readonly identity?: { readonly type: string; readonly id: string };
}

export interface EmailCodeSenderDeps {
  readonly email: EmailService;
  /** `email.codes` */
  readonly options?: CodeMailConfiguration;
  /** `email.defaultConnection` */
  readonly defaultConnection?: string;
}

const DEFAULT_SUBJECTS: Readonly<Record<string, string>> = { verify: 'Verify your email address', register: 'Finish signing up', login: 'Your sign-in code' };
const FALLBACK_SUBJECT = 'Your code';

function plainText(code: string, link: string | undefined, minutes: number): string {
  const action = link ? `Your code is ${code}. You can also open this link:\n${link}` : `Your code is ${code}.`;
  return [action, `It expires in ${minutes} minutes. If you did not ask for it, ignore this mail.`].join('\n\n');
}

/**
 * The `CodeSender` of `@spinajs/authn` for email over `EmailService.send`: it renders and sends at once, never queues, and
 * marks the code and the link for redaction, so neither reaches a queued payload, the `EmailSent` event, a log or an error
 * (SR-09). SMS is the app's own CodeSender.
 *
 * Not registered here: `@spinajs/users` registers it as the CodeSender when no other is registered.
 */
export class EmailCodeSender {
  @Config('email.codes', { defaultValue: {} })
  protected Options: CodeMailConfiguration;

  @Config('email.defaultConnection')
  protected DefaultConnection: string;

  /** With `deps`, neither the configuration nor the container is used. */
  constructor(protected readonly Deps?: EmailCodeSenderDeps) {}

  public async send(message: ICodeMessage): Promise<void> {
    const secrets = [message.code, ...(message.link ? [message.link] : [])].filter((s) => s !== '');
    try {
      if (message.channel !== 'email') throw new InvalidArgument('EmailCodeSender sends email only; register a CodeSender that handles sms');
      if (!message.to) throw new InvalidArgument('the message has no recipient');
      const email = this.compose(message, secrets);
      const service = this.Deps ? this.Deps.email : await DI.resolve(EmailService);
      await service.send(email);
    } catch (err) {
      // No cause: anything hanging off the original error may hold the code.
      throw new IOFail(`The ${message.purpose} code mail was not sent: ${redactText(err instanceof Error ? err.message : String(err), secrets)}`);
    }
  }

  protected compose(message: ICodeMessage, secrets: readonly string[]): IEmail {
    const options = (this.Deps ? this.Deps.options : this.Options) ?? {};
    const connection = options.connection || (this.Deps ? this.Deps.defaultConnection : this.DefaultConnection);
    if (!connection) throw new InvalidOperation('set email.codes.connection or email.defaultConnection');
    const purpose = options.purposes?.[message.purpose] ?? {};
    const minutes = Math.max(1, Math.round(message.ttlSeconds / 60));
    const lang = message.locale || options.lang;

    return {
      to: [message.to],
      connection,
      subject: purpose.subject || DEFAULT_SUBJECTS[message.purpose] || FALLBACK_SUBJECT,
      tag: `authn-code-${message.purpose}`,
      model: { Code: message.code, Link: message.link ?? '', ExpiresInMinutes: minutes, Email: message.to, Purpose: message.purpose },
      redact: [...secrets],
      ...(options.from ? { from: options.from } : {}),
      ...(lang ? { lang } : {}),
      ...(purpose.template ? { template: purpose.template } : { text: plainText(message.code, message.link, minutes) }),
    };
  }
}
```

In `packages/email/src/index.ts` after line 23 add:

```ts
export * from './code-sender.js';
```

In `packages/users/src/index.ts`: extend the imports (lines 8-9):

```ts
import { EmailCodeSender, EmailPasswordMailer } from '@spinajs/email';
import { PasswordMailer } from '@spinajs/authn-local';
import { CodeSender } from '@spinajs/authn/contracts';
```

and after the `PasswordMailer` registration (line 83):

```ts
    // Same rule for one-time codes: authn registers no CodeSender, and an app's own (SMS, say) registered earlier wins.
    if (!DI.RootContainer.hasRegistered(CodeSender)) {
      DI.register(EmailCodeSender).as(CodeSender);
    }
```

- [ ] **Step 4: GREEN + package suites + rebuild**

1. `cd packages/email && npx ts-mocha -p tsconfig.json test/code-sender.test.ts` — 4 passing; `npm test` in `packages/email`.
2. Rebuild email (`npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`).
3. `cd ../users && npx ts-mocha -p tsconfig.json test/code-sender.test.ts test/password-mailer.test.ts` — passing; `npm test` in `packages/users`.

- [ ] **Step 5: Commit**

```bash
git add packages/email/src/code-sender.ts packages/email/src/interfaces.ts packages/email/src/index.ts packages/email/test/code-sender.test.ts packages/users/src/index.ts packages/users/test/code-sender.test.ts
git commit -m "feat(email,users): EmailCodeSender renders and sends code mails at once; users registers it as the CodeSender"
```

---

### Task 8: `users_address` and `UserAddressStore`

**Files:**
- Modify: `packages/users/src/identity/sql.ts` (one constant after line 8)
- Create: `packages/users/src/migrations/UsersAddress_2026_10_06_00_00_00.ts`
- Create: `packages/users/src/identity/address-store.ts`
- Modify: `packages/users/src/identity/index.ts`, `packages/users/src/index.ts:32-34`
- Test: create `packages/users/test/address-store.test.ts`

**Interfaces:**
- Consumes: `AddressStore`, `normalizeAddress` (Task 1).
- Produces: `USERS_ADDRESS_TABLE = 'users_address'`; `TRUST_EXISTING_EMAILS_KEY = 'users.addresses.trustExistingEmails'`; migration `UsersAddress_2026_10_06_00_00_00`; `@Injectable(AddressStore) UserAddressStore` with the three contract methods plus `setPhone(id: IdentityRef, e164: string): Promise<boolean>` (true when the phone changed) and `removePhone(id: IdentityRef): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `packages/users/test/address-store.test.ts`:

```ts
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { AddressStore } from '@spinajs/authn/contracts';

import { User, UserAddressStore, UsersAddress_2026_10_06_00_00_00 } from '../src/index.js';
import { bootUsersDb, registerUsersTestHost, seedUser, setIdentityFlags } from './support/users-db.js';

const AT = new Date('2026-10-06T10:00:00.000Z');

const addressRows = async () => (await User.query().Driver.select().from('users_address').columns(['user_id', 'Channel', 'Value', 'VerifiedAt'])) as { user_id: number; Channel: string; Value: string; VerifiedAt: unknown }[];

describe('UserAddressStore and users_address', function () {
  this.timeout(30000);

  let store: UserAddressStore;

  before(() => registerUsersTestHost());

  beforeEach(async () => {
    await bootUsersDb();
    store = new UserAddressStore();
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  it('is the registered AddressStore', async () => {
    expect(await DI.resolve(AddressStore)).to.be.instanceOf(UserAddressStore);
  });

  it('lists the email as normalized and unverified until marked', async () => {
    const { ref } = await seedUser({ login: 'addr-a', email: 'Addr.A@Example.test' });
    expect(await store.addresses(ref)).to.deep.eq([{ channel: 'email', value: 'addr.a@example.test', verifiedAt: null }]);
    expect(await store.markVerified(ref, 'email', 'addr.a@example.test', AT)).to.eq(true);
    expect((await store.addresses(ref))[0].verifiedAt?.getTime()).to.eq(AT.getTime());
  });

  it('refuses a mark for a value that is not the current email, and a changed email is unverified', async () => {
    const { user, ref } = await seedUser({ login: 'addr-b', email: 'b-old@example.test' });
    await store.markVerified(ref, 'email', 'b-old@example.test', AT);
    expect(await store.markVerified(ref, 'email', 'someone@example.test', AT)).to.eq(false);
    await User.query().Driver.update().in('users').update({ Email: 'b-new@example.test' }).where('Id', user.Id);
    expect(await store.addresses(ref)).to.deep.eq([{ channel: 'email', value: 'b-new@example.test', verifiedAt: null }]);
  });

  it('finds an identity by its email, never by login, and not a deleted one', async () => {
    const { ref } = await seedUser({ login: 'addr-c', email: 'c@example.test' });
    const { ref: gone } = await seedUser({ login: 'addr-d', email: 'd@example.test' });
    await setIdentityFlags(gone, { deleted: true });
    expect(await store.findByAddress('email', 'C@Example.test')).to.deep.eq(ref);
    expect(await store.findByAddress('email', 'addr-c')).to.eq(null);
    expect(await store.findByAddress('email', 'd@example.test')).to.eq(null);
  });

  it('keeps one phone per user in E.164, unverified after each change', async () => {
    const { ref } = await seedUser({ login: 'addr-e' });
    expect(await store.setPhone(ref, '+48123456789')).to.eq(true);
    expect(await store.setPhone(ref, '+48123456789')).to.eq(false, 'same number again');
    expect(await store.markVerified(ref, 'sms', '+48123456789', AT)).to.eq(true);
    expect(await store.findByAddress('sms', '+48 123 456 789')).to.deep.eq(ref);
    expect(await store.setPhone(ref, '+48987654321')).to.eq(true);
    const phones = (await store.addresses(ref)).filter((a) => a.channel === 'sms');
    expect(phones).to.deep.eq([{ channel: 'sms', value: '+48987654321', verifiedAt: null }]);
    await store.removePhone(ref);
    expect((await store.addresses(ref)).filter((a) => a.channel === 'sms')).to.deep.eq([]);
  });

  describe('migration UsersAddress_2026_10_06_00_00_00', () => {
    it('marks the email of active, not deleted users verified, once, and leaves the others', async () => {
      const { user: active } = await seedUser({ login: 'mig-active', email: 'Mig.Active@Example.test' });
      const { user: inactive } = await seedUser({ login: 'mig-inactive', email: 'mig-inactive@example.test', active: false });
      const { user: deleted, ref: deletedRef } = await seedUser({ login: 'mig-deleted', email: 'mig-deleted@example.test' });
      await setIdentityFlags(deletedRef, { deleted: true });

      await new UsersAddress_2026_10_06_00_00_00().up(User.query().Driver);
      await new UsersAddress_2026_10_06_00_00_00().up(User.query().Driver);

      const rows = await addressRows();
      expect(rows.filter((r) => r.user_id === active.Id)).to.have.length(1);
      expect(rows.find((r) => r.user_id === active.Id)).to.include({ Channel: 'email', Value: 'mig.active@example.test' });
      expect(rows.some((r) => r.user_id === inactive.Id || r.user_id === deleted.Id)).to.eq(false);
    });

    it('marks nothing with users.addresses.trustExistingEmails false', async () => {
      const { user } = await seedUser({ login: 'mig-untrusted', email: 'mig-untrusted@example.test' });
      DI.get(Configuration)!.set('users.addresses.trustExistingEmails', false);
      await new UsersAddress_2026_10_06_00_00_00().up(User.query().Driver);
      expect((await addressRows()).some((r) => r.user_id === user.Id)).to.eq(false);
    });

    it('drops the table on down and creates it again on up', async () => {
      const migration = new UsersAddress_2026_10_06_00_00_00();
      await migration.down(User.query().Driver);
      expect(await User.query().Driver.schema().tableExists('users_address')).to.eq(false);
      await migration.up(User.query().Driver);
      expect(await User.query().Driver.schema().tableExists('users_address')).to.eq(true);
    });
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/users && npx ts-mocha -p tsconfig.json test/address-store.test.ts`
Expected: FAIL at compile time: `Module '"../src/index.js"' has no exported member 'UserAddressStore'` (and `UsersAddress_2026_10_06_00_00_00`).

- [ ] **Step 3: Implement**

In `packages/users/src/identity/sql.ts` after `USERS_TABLE` (line 8):

```ts
/** @internal */
export const USERS_ADDRESS_TABLE = 'users_address';
```

Create `packages/users/src/migrations/UsersAddress_2026_10_06_00_00_00.ts`:

```ts
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';
import { normalizeAddress } from '@spinajs/authn/contracts';

import { USERS_ADDRESS_TABLE, USERS_TABLE, sqlDateTime } from '../identity/sql.js';

export const TRUST_EXISTING_EMAILS_KEY = 'users.addresses.trustExistingEmails';

const BATCH = 500;

/**
 * `users_address`: when each value of an address was verified (the email by value, so an email changed by any path is
 * unverified) and the user's phone. The current email of each active, not deleted user gets a row verified at migration
 * time: 2.x had no verification, and turning `authn.verification.requiredForLogin` on must not lock them all out.
 * `users.addresses.trustExistingEmails: false` skips that. Running `up` again marks only users without an email row.
 */
@Migration('default')
export class UsersAddress_2026_10_06_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    if (!(await connection.schema().tableExists(USERS_ADDRESS_TABLE))) {
      await connection.schema().createTable(USERS_ADDRESS_TABLE, (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.int('user_id').notNull();
        table.string('Channel', 8).notNull();
        table.string('Value', 254).notNull();
        table.dateTime('VerifiedAt');
        table.dateTime('CreatedAt').notNull();
        table.foreignKey('user_id').references(USERS_TABLE, 'Id').cascade();
      });
      await connection.index().unique().table(USERS_ADDRESS_TABLE).name('users_address_owner_idx').columns(['user_id', 'Channel', 'Value']);
      await connection.index().table(USERS_ADDRESS_TABLE).name('users_address_value_idx').columns(['Channel', 'Value']);
    }

    if (DI.get(Configuration)?.get(TRUST_EXISTING_EMAILS_KEY, true) === false) return;

    const at = sqlDateTime(new Date());
    // Normalized in Node, not with SQL LOWER, so the rows match what UserAddressStore computes for non-ASCII emails too.
    for (let after = 0; ; ) {
      const users = (await connection.select().from(USERS_TABLE).columns(['Id', 'Email']).where('IsActive', true).whereNull('DeletedAt').where('Id', '>', after).orderBy('Id').take(BATCH)) as { Id: number; Email: string | null }[];
      if (users.length === 0) return;
      after = Number(users[users.length - 1].Id);
      const done = new Set(((await connection.select().from(USERS_ADDRESS_TABLE).columns(['user_id']).where('Channel', 'email').whereIn('user_id', users.map((u) => u.Id))) as { user_id: number }[]).map((r) => Number(r.user_id)));
      for (const u of users) {
        const value = normalizeAddress('email', u.Email);
        if (value === null || done.has(Number(u.Id))) continue;
        await connection.insert().into(USERS_ADDRESS_TABLE).values({ user_id: u.Id, Channel: 'email', Value: value, VerifiedAt: at, CreatedAt: at });
      }
    }
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable(USERS_ADDRESS_TABLE);
  }
}
```

Create `packages/users/src/identity/address-store.ts`:

```ts
import { Injectable } from '@spinajs/di';
import { AddressStore, normalizeAddress } from '@spinajs/authn/contracts';
import type { AddressChannel, IdentityRef, VerifiableAddress } from '@spinajs/authn/contracts';

import { User } from '../models/User.js';
import { runAsSystem } from '../system.js';
import { USERS_ADDRESS_TABLE, rowsAffected, sqlDateTime, usersDriver, usersMatchingLogin, usersOrmUp } from './sql.js';

interface AddressRow {
  readonly channel: AddressChannel;
  readonly value: string;
  readonly verifiedAt: Date | null;
}

const isUser = (id: IdentityRef | undefined): id is IdentityRef => id?.type === 'user' && typeof id.id === 'string';

const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T'));
  return Number.isFinite(d.getTime()) ? d : null;
};

/**
 * Users' verifiable addresses. The email is `users.Email`; a `users_address` row of channel `email` records that one exact
 * value was verified, so a changed `users.Email` reads unverified without any write here. A phone is the user's one row of
 * channel `sms`. Statements run as SYSTEM: callers are anonymous during verification.
 */
@Injectable(AddressStore)
export class UserAddressStore extends AddressStore {
  public async addresses(id: IdentityRef): Promise<readonly VerifiableAddress[]> {
    const u = await this.user(id);
    if (!u) return [];
    const rows = await this.rowsOf(u.Id);
    const out: VerifiableAddress[] = [];
    const email = normalizeAddress('email', u.Email);
    if (email !== null) out.push({ channel: 'email', value: email, verifiedAt: rows.find((r) => r.channel === 'email' && r.value === email)?.verifiedAt ?? null });
    for (const r of rows) if (r.channel === 'sms') out.push({ channel: 'sms', value: r.value, verifiedAt: r.verifiedAt });
    return out;
  }

  public async findByAddress(channel: AddressChannel, value: string): Promise<IdentityRef | null> {
    const v = normalizeAddress(channel, value);
    if (v === null) return null;
    await usersOrmUp();
    if (channel === 'email') {
      // usersMatchingLogin also matches logins; only the stored email may decide.
      const hits = (await runAsSystem('address-store', () => usersMatchingLogin(v))).filter((u) => !u.DeletedAt && normalizeAddress('email', u.Email) === v);
      return hits.length === 1 ? { type: 'user', id: hits[0].Uuid } : null;
    }
    return runAsSystem('address-store', async () => {
      const rows = (await usersDriver().select().from(USERS_ADDRESS_TABLE).columns(['user_id']).where('Channel', channel).where('Value', v)) as { user_id: number }[];
      const ids = [...new Set(rows.map((r) => Number(r.user_id)))];
      if (ids.length !== 1) return null;
      const u = await User.query().where('Id', ids[0]).first();
      return u ? { type: 'user', id: u.Uuid } : null;
    });
  }

  public async markVerified(id: IdentityRef, channel: AddressChannel, value: string, at: Date): Promise<boolean> {
    const u = await this.user(id);
    if (!u) return false;
    const when = sqlDateTime(at);
    return runAsSystem('address-store', async () => {
      const driver = usersDriver();
      const mark = async () => rowsAffected(await driver.update().in(USERS_ADDRESS_TABLE).update({ VerifiedAt: when }).where('user_id', u.Id).where('Channel', channel).where('Value', value));
      if (channel === 'sms') return (await mark()) === 1;
      if (normalizeAddress('email', u.Email) !== value) return false;
      if ((await mark()) > 0) return true;
      try {
        await driver.insert().into(USERS_ADDRESS_TABLE).values({ user_id: u.Id, Channel: 'email', Value: value, VerifiedAt: when, CreatedAt: when });
      } catch {
        // A parallel mark inserted the row first (unique owner index); set its time instead.
        await mark();
      }
      return true;
    });
  }

  /** Replaces the user's phone by `e164` (already normalized), unverified; false when it is the phone already. */
  public async setPhone(id: IdentityRef, e164: string): Promise<boolean> {
    const u = await this.user(id);
    if (!u) return false;
    return runAsSystem('address-store', async () => {
      const driver = usersDriver();
      const current = (await this.rowsOf(u.Id)).filter((r) => r.channel === 'sms');
      if (current.length === 1 && current[0].value === e164) return false;
      await driver.del().from(USERS_ADDRESS_TABLE).where('user_id', u.Id).where('Channel', 'sms');
      await driver.insert().into(USERS_ADDRESS_TABLE).values({ user_id: u.Id, Channel: 'sms', Value: e164, VerifiedAt: null, CreatedAt: sqlDateTime(new Date()) });
      return true;
    });
  }

  public async removePhone(id: IdentityRef): Promise<void> {
    const u = await this.user(id);
    if (!u) return;
    await runAsSystem('address-store', async () => {
      await usersDriver().del().from(USERS_ADDRESS_TABLE).where('user_id', u.Id).where('Channel', 'sms');
    });
  }

  protected async user(id: IdentityRef): Promise<User | undefined> {
    if (!isUser(id)) return undefined;
    await usersOrmUp();
    return runAsSystem('address-store', async () => (await User.query().where('Uuid', id.id).first()) ?? undefined);
  }

  private async rowsOf(userId: number): Promise<AddressRow[]> {
    const rows = (await runAsSystem('address-store', async () => usersDriver().select().from(USERS_ADDRESS_TABLE).columns(['Channel', 'Value', 'VerifiedAt']).where('user_id', userId))) as { Channel: string; Value: string; VerifiedAt: unknown }[];
    return rows.map((r) => ({ channel: r.Channel as AddressChannel, value: String(r.Value), verifiedAt: toDate(r.VerifiedAt) }));
  }
}
```

`toDate` reads the text `sqlDateTime` writes (local wall-clock, as `UsersPasswordSetAt` does) and a driver's `Date`. If the address-store test shows an hour offset on a dialect, read the column through the `User` model's converter instead and say so in the commit body.

Append to `packages/users/src/identity/index.ts`:

```ts
export * from './address-store.js';
```

In `packages/users/src/index.ts` after line 34:

```ts
export * from './migrations/UsersAddress_2026_10_06_00_00_00.js';
```

- [ ] **Step 4: GREEN + package suite + rebuild**

1. `cd packages/users && npx ts-mocha -p tsconfig.json test/address-store.test.ts` — passing.
2. `npm test` in `packages/users`.
3. Rebuild (`npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`).

- [ ] **Step 5: Commit**

```bash
git add packages/users/src/identity/sql.ts packages/users/src/migrations/UsersAddress_2026_10_06_00_00_00.ts packages/users/src/identity/address-store.ts packages/users/src/identity/index.ts packages/users/src/index.ts packages/users/test/address-store.test.ts
git commit -m "feat(users): users_address and UserAddressStore; existing active users' emails count as verified"
```

---

### Task 9: `DefaultVerificationService`

**Files:**
- Create: `packages/authn/src/registry/throttle.ts`
- Modify: `packages/authn/src/registry/index.ts`, `packages/authn/src/service/default-authn-service.ts:41` (`MEMORY_THROTTLE`), `:198` (call), `:607-629` (method removed)
- Create: `packages/authn/src/verification/deferred.ts`, `packages/authn/src/verification/default-verification-service.ts`, `packages/authn/src/verification/index.ts`
- Modify: `packages/authn/src/index.ts`
- Test: create `packages/authn/test/verification/verification-service.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5 (`VerificationService`, `AddressStore`, `OneTimeCodeStore`, `CodeSender`, `normalizeAddress`, `addressSubject`, flow `verify`, `authn.verification`, `authn.codes.length`); fakes `MemoryAddressStore`, `RecordingCodeSender` and `MemoryOneTimeCodeStore`.
- Produces: `selectThrottle(container: IContainer, name: string | undefined): Promise<AuthnThrottle>` (same rules and messages as before); `@PerChildInstance() @Injectable(VerificationService) DefaultVerificationService` with `drain(): Promise<void>` and type `VerificationConfig`.

- [ ] **Step 1: Write the failing test**

Create `packages/authn/test/verification/verification-service.test.ts`:

```ts
import assert from 'node:assert/strict';
import { expect } from 'chai';
import 'mocha';
import type { IContainer } from '@spinajs/di';
import { MemoryAddressStore, RecordingCodeSender, RecordingEventSink } from '@spinajs/authn-testing';

import { AddressStore, AuthnEventSink, AuthnThrottle, CodeSender, DefaultVerificationService, MemoryAuthnThrottle, MemoryOneTimeCodeStore, OneTimeCodeStore, VerificationService } from '../../src/index.js';
import type { AuthnContext } from '../../src/index.js';
import { bind, configuredChild, pinConfiguration, useHarnessLog } from '../behaviour/harness.js';

const ALICE = { type: 'user', id: 'alice' };
const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: new Date(), ip: '192.0.2.10', purpose: 'request', ...over });

interface Kit {
  child: IContainer;
  service: DefaultVerificationService;
  addresses: MemoryAddressStore;
  sender: RecordingCodeSender;
  events: RecordingEventSink;
}

async function kit(authn: Record<string, unknown> = {}): Promise<Kit> {
  const child = await configuredChild({ authn: { verification: { url: 'https://app.test/verify' }, ...authn } }, 'test');
  const addresses = new MemoryAddressStore();
  const sender = new RecordingCodeSender();
  const events = new RecordingEventSink();
  bind(child, AddressStore, 'KitAddressStore', addresses);
  bind(child, CodeSender, 'KitCodeSender', sender);
  bind(child, OneTimeCodeStore, 'KitCodeStore', new MemoryOneTimeCodeStore({ maxAttempts: 5 }));
  bind(child, AuthnThrottle, 'MemoryAuthnThrottle', pinConfiguration(new MemoryAuthnThrottle(), child));
  bind(child, AuthnEventSink, 'KitEvents', events);
  const service = (await child.resolve(VerificationService)) as DefaultVerificationService;
  return { child, service, addresses, sender, events };
}

describe('DefaultVerificationService', function () {
  this.timeout(30000);
  useHarnessLog();

  let k: Kit;
  afterEach(async () => k?.child.dispose());

  it('is the registered VerificationService', async () => {
    k = await kit();
    expect(k.service).to.be.instanceOf(DefaultVerificationService);
  });

  it('request by address: accepted, then a verify code with a fragment link goes to a known, unverified address', async () => {
    k = await kit();
    k.addresses.set(ALICE, 'email', 'Alice@Example.test');
    expect(await k.service.request({ address: { channel: 'email', value: ' ALICE@example.test' } }, ctx())).to.deep.eq({ status: 'accepted' });
    await k.service.drain();
    expect(k.sender.sent).to.have.length(1);
    const m = k.sender.sent[0];
    expect(m).to.include({ channel: 'email', to: 'alice@example.test', purpose: 'verify', ttlSeconds: 900 });
    expect(m.link).to.eq(`https://app.test/verify#channel=email&address=alice%40example.test&code=${m.code}`);
    expect(k.events.ofType('verification.request').map((e) => e.outcome)).to.deep.eq(['success']);
    expect(JSON.stringify(k.events.all())).to.not.contain('alice@example.test').and.not.contain(m.code);
  });

  it('request for an unknown or already verified address answers the same and sends nothing', async () => {
    k = await kit();
    k.addresses.set(ALICE, 'email', 'alice@example.test', new Date(1));
    expect(await k.service.request({ address: { channel: 'email', value: 'nobody@example.test' } }, ctx())).to.deep.eq({ status: 'accepted' });
    expect(await k.service.request({ address: { channel: 'email', value: 'alice@example.test' } }, ctx({ ip: '192.0.2.11' }))).to.deep.eq({ status: 'accepted' });
    await k.service.drain();
    expect(k.sender.sent).to.deep.eq([]);
    expect(k.events.ofType('verification.request').map((e) => e.reason)).to.deep.eq(['unknown_address', 'already_verified']);
  });

  it('request refuses a malformed address and counts in the verify flow per address', async () => {
    k = await kit();
    expect(await k.service.request({ address: { channel: 'sms', value: '123' } }, ctx())).to.deep.eq({ status: 'invalid_address' });
    for (let i = 0; i < 3; i++) expect((await k.service.request({ address: { channel: 'email', value: 'x@example.test' } }, ctx())).status).to.eq('accepted');
    expect(await k.service.request({ address: { channel: 'email', value: 'x@example.test' } }, ctx())).to.deep.eq({ status: 'throttled', retryAfterSeconds: 60 });
  });

  it('request by identity sends to its own address of that channel', async () => {
    k = await kit();
    k.addresses.set(ALICE, 'sms', '+48123456789');
    expect(await k.service.request({ identity: ALICE, channel: 'sms' }, ctx())).to.deep.eq({ status: 'accepted' });
    expect(await k.service.request({ identity: ALICE, channel: 'email' }, ctx())).to.deep.eq({ status: 'invalid_address' });
    await k.service.drain();
    expect(k.sender.sent.map((m) => [m.channel, m.to])).to.deep.eq([['sms', '+48123456789']]);
  });

  it('confirm marks the address verified once; a wrong, used or foreign code answers invalid', async () => {
    k = await kit();
    k.addresses.set(ALICE, 'email', 'alice@example.test');
    await k.service.request({ address: { channel: 'email', value: 'alice@example.test' } }, ctx());
    await k.service.drain();
    const code = k.sender.codeFor('alice@example.test', 'verify')!;
    const addr = { channel: 'email', value: 'Alice@Example.test' } as const;
    expect(await k.service.confirm(addr, '000000' === code ? '111111' : '000000', ctx())).to.deep.eq({ status: 'invalid' });
    expect(await k.service.confirm(addr, code, ctx())).to.deep.eq({ status: 'verified', identity: ALICE });
    expect(await k.service.confirm(addr, code, ctx())).to.deep.eq({ status: 'invalid' });
    expect(k.addresses.marked).to.have.length(1);
    expect(k.events.ofType('verification.verify').map((e) => e.outcome)).to.deep.eq(['failure', 'success', 'failure']);
  });

  it('confirm refuses a code sent before the address changed', async () => {
    k = await kit();
    k.addresses.set(ALICE, 'email', 'old@example.test');
    await k.service.request({ address: { channel: 'email', value: 'old@example.test' } }, ctx());
    await k.service.drain();
    const code = k.sender.codeFor('old@example.test', 'verify')!;
    k.addresses.set(ALICE, 'email', 'new@example.test');
    expect(await k.service.confirm({ channel: 'email', value: 'old@example.test' }, code, ctx())).to.deep.eq({ status: 'invalid' });
  });

  it('send and redeem work for any purpose, unthrottled and unaudited', async () => {
    k = await kit();
    k.addresses.set(ALICE, 'email', 'alice@example.test');
    await k.service.send(ALICE, { channel: 'email', value: 'alice@example.test' }, 'register', { ttlSeconds: 120 });
    const m = k.sender.sent[0];
    expect(m).to.include({ purpose: 'register', ttlSeconds: 120 });
    expect(m.link).to.eq(undefined);
    expect(await k.service.redeem({ channel: 'email', value: 'alice@example.test' }, m.code, 'verify', ctx())).to.deep.eq({ status: 'invalid' });
    expect(await k.service.redeem({ channel: 'email', value: 'alice@example.test' }, m.code, 'register', ctx())).to.deep.eq({ status: 'verified', identity: ALICE });
    expect(k.events.all()).to.deep.eq([]);
  });

  it('fails when a neighbour is missing, naming it', async () => {
    const child = await configuredChild({}, 'test');
    try {
      const service = (await child.resolve(VerificationService)) as DefaultVerificationService;
      await assert.rejects(service.request({ address: { channel: 'email', value: 'a@b.c' } }, ctx()), /no AddressStore is registered/);
    } finally {
      await child.dispose();
    }
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/verification/verification-service.test.ts`
Expected: FAIL at compile time: `Module '"../../src/index.js"' has no exported member 'DefaultVerificationService'`.

- [ ] **Step 3: Implement**

Create `packages/authn/src/registry/throttle.ts` (the body of `DefaultAuthnService.selectThrottle`, moved):

```ts
import type { IContainer } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';

import { AuthnThrottle } from '../contracts/throttle.js';
import { instantiate, nearestRegistration, q, registeredNames } from './named.js';

const MEMORY_THROTTLE = 'MemoryAuthnThrottle';

/**
 * `authn.throttle.service` (`name`); when that is unset, the only registered throttle, or the only one besides
 * `MemoryAuthnThrottle` (an app that imports authn-orm gets `DbAuthnThrottle`). Fails rather than falling back to memory,
 * which would throttle each instance of a multi-instance app apart.
 */
export async function selectThrottle(container: IContainer, name: string | undefined): Promise<AuthnThrottle> {
  const names = registeredNames(container, AuthnThrottle);
  const listed = names.map(q).join(', ') || 'none';
  let chosen = name;
  if (chosen === undefined) {
    // The core always registers the memory throttle; one more registered throttle is the one the app imported (K6).
    const others = names.filter((n) => n !== MEMORY_THROTTLE);
    const only = names.length === 1 ? names : others.length === 1 ? others : [];
    if (only.length !== 1) {
      throw new InvalidOption(`authn.throttle.service is not set and ${names.length === 0 ? 'no AuthnThrottle is' : 'several are'} registered (${listed}); name one`);
    }
    chosen = only[0];
  }
  const type = nearestRegistration(container, AuthnThrottle, chosen);
  if (!type) {
    throw new InvalidOption(`authn.throttle.service ${q(chosen)}: no AuthnThrottle is registered under that name (registered: ${listed}). Install the package that provides it (DbAuthnThrottle: @spinajs/authn-orm); MemoryAuthnThrottle suits a single instance only`);
  }
  const throttle: unknown = await instantiate(container, type);
  const t = throttle as Partial<AuthnThrottle> | null;
  if (t === null || typeof t !== 'object' || typeof t.attempt !== 'function' || typeof t.succeed !== 'function') {
    throw new InvalidOption(`authn.throttle.service ${q(chosen)} is not an AuthnThrottle`);
  }
  return throttle as AuthnThrottle;
}
```

Append to `packages/authn/src/registry/index.ts`:

```ts
export * from './throttle.js';
```

In `packages/authn/src/service/default-authn-service.ts`: delete `const MEMORY_THROTTLE = 'MemoryAuthnThrottle';` (line 41) and the whole `selectThrottle()` method (lines 607-629); add `import { selectThrottle } from '../registry/throttle.js';` to the imports; replace line 198 with:

```ts
    this.throttle = await selectThrottle(this.container, this.ThrottleService);
```

Keep the `instantiate`, `nearestRegistration`, `registeredNames` import: `selectPolicy()` still uses them.

Create `packages/authn/src/verification/deferred.ts`:

```ts
/**
 * Work that runs after the caller has its answer, so the answer and its timing say nothing about the address. Errors go
 * to `onError` by class only and never reach the caller; `drain()` waits for everything scheduled so far.
 */
export class DeferredWork {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly onError: (message: string) => void) {}

  public defer(work: () => Promise<void>): void {
    const p = new Promise<void>((resolve) => setImmediate(resolve))
      .then(work)
      .catch((err: unknown) => this.onError(`Deferred verification work failed: ${(err as Error)?.name ?? typeof err}`))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  public async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
```

Create `packages/authn/src/verification/default-verification-service.ts`:

```ts
import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';

import { addressSubject, normalizeAddress } from '../contracts/address.js';
import type { AuthnEvent } from '../contracts/audit.js';
import { CodeSender, OneTimeCodeStore } from '../contracts/codes.js';
import type { CodePurpose } from '../contracts/codes.js';
import type { AuthnContext, IdentityRef } from '../contracts/credentials.js';
import { AddressStore } from '../contracts/identity.js';
import type { AddressChannel } from '../contracts/identity.js';
import { AuthnThrottle } from '../contracts/throttle.js';
import type { ThrottleKey } from '../contracts/throttle.js';
import { VerificationService } from '../contracts/verification.js';
import type { AddressInput, CodeRedeemResult, CodeSendOptions, VerificationConfirmResult, VerificationRequestResult, VerificationTarget } from '../contracts/verification.js';
import { AuthnAudit } from '../audit/authn-audit.js';
import { auditLog } from '../audit/log.js';
import { selectThrottle } from '../registry/throttle.js';
import { DeferredWork } from './deferred.js';

export interface VerificationConfig {
  readonly requiredForLogin: false | 'email';
  readonly ttlSeconds: number;
  readonly url: string;
  readonly trustExternalEmail: boolean;
}

interface Parts {
  readonly addresses: AddressStore;
  readonly codes: OneTimeCodeStore;
  readonly sender: CodeSender;
}

type Redeemed = CodeRedeemResult | { readonly status: 'invalid'; readonly reason: string };

const log = auditLog('authn-verification');

const ipKey = (ctx: AuthnContext): ThrottleKey => ({ kind: 'ip', value: ctx.ip ?? 'unknown' });

/** The code travels in the fragment: browsers send neither it nor its parameters to a server, a log or a Referer. */
function linkOf(base: string | undefined, channel: AddressChannel, value: string, code: string): string | undefined {
  if (!base) return undefined;
  const url = new URL(base);
  url.hash = new URLSearchParams({ channel, address: value, code }).toString();
  return url.toString();
}

/**
 * Address verification (plan 06). `request` and `confirm` are the public flows: throttled in the 'verify' flow and audited,
 * and answering the same whether or not an address belongs to an identity. `send` and `redeem` are the primitives other
 * flows (registration, code login) throttle and audit themselves. The neighbours are looked up per call, so the service
 * resolves in apps that have not registered them; the 3.0 routes stay off there.
 */
@PerChildInstance()
@Injectable(VerificationService)
@Inject(Container)
export class DefaultVerificationService extends VerificationService {
  @Config('authn.verification')
  protected Settings: VerificationConfig;

  @Config('authn.codes.length')
  protected CodeLength: number;

  @Config('authn.throttle.service')
  protected ThrottleService: string | undefined;

  private throttle: AuthnThrottle | undefined;
  private auditor: AuthnAudit | undefined;
  private readonly work = new DeferredWork((m) => log.warn(m));

  constructor(private readonly container: IContainer) {
    super();
  }

  /** Resolves once every deferred send scheduled so far has finished (tests, shutdown). */
  public drain(): Promise<void> {
    return this.work.drain();
  }

  public async request(target: VerificationTarget, ctx: AuthnContext): Promise<VerificationRequestResult> {
    const parts = await this.parts();
    const known = 'identity' in target ? target.identity : undefined;
    const channel = 'identity' in target ? target.channel : target.address.channel;
    const value = known ? ((await parts.addresses.addresses(known)).find((a) => a.channel === channel)?.value ?? null) : normalizeAddress(channel, (target as { address: AddressInput }).address.value);
    if (value === null) return { status: 'invalid_address' };

    const gate = await (await this.throttleOf()).attempt([{ kind: 'account', value: addressSubject(channel, value) }, ipKey(ctx)], 'verify', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', reason: 'throttled', data: { flow: 'verify' } });
      return { status: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }
    this.work.defer(() => this.sendVerification(parts, channel, value, known, ctx));
    return { status: 'accepted' };
  }

  public async confirm(address: AddressInput, code: string, ctx: AuthnContext): Promise<VerificationConfirmResult> {
    const gate = await (await this.throttleOf()).attempt([ipKey(ctx)], 'verify', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', reason: 'throttled', data: { flow: 'verify' } });
      return { status: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }
    const r = await this.redeemWith(await this.parts(), address, code, 'verify', ctx);
    if (r.status === 'verified') {
      await this.audit(ctx, { type: 'verification.verify', outcome: 'success', identity: r.identity, data: { channel: address?.channel } });
      return r;
    }
    await this.audit(ctx, { type: 'verification.verify', outcome: 'failure', reason: 'reason' in r ? r.reason : 'invalid', data: { channel: address?.channel } });
    return { status: 'invalid' };
  }

  public async send(identity: IdentityRef, address: AddressInput, purpose: CodePurpose, opts: CodeSendOptions = {}): Promise<void> {
    const value = normalizeAddress(address.channel, address.value);
    if (value === null) throw new InvalidArgument('VerificationService.send: not a valid address');
    await this.sendWith(await this.parts(), identity, address.channel, value, purpose, opts);
  }

  public async redeem(address: AddressInput, code: string, purpose: CodePurpose, ctx: AuthnContext): Promise<CodeRedeemResult> {
    const r = await this.redeemWith(await this.parts(), address, code, purpose, ctx);
    return r.status === 'verified' ? r : { status: 'invalid' };
  }

  private async sendVerification(parts: Parts, channel: AddressChannel, value: string, known: IdentityRef | undefined, ctx: AuthnContext): Promise<void> {
    const identity = known ?? (await parts.addresses.findByAddress(channel, value));
    if (!identity) {
      await this.audit(ctx, { type: 'verification.request', outcome: 'failure', reason: 'unknown_address', data: { channel } });
      return;
    }
    const current = (await parts.addresses.addresses(identity)).find((a) => a.channel === channel && a.value === value);
    if (!current || current.verifiedAt !== null) {
      await this.audit(ctx, { type: 'verification.request', outcome: 'failure', reason: current ? 'already_verified' : 'not_an_address', identity, data: { channel } });
      return;
    }
    await this.sendWith(parts, identity, channel, value, 'verify', { linkBase: this.Settings.url || undefined });
    await this.audit(ctx, { type: 'verification.request', outcome: 'success', identity, data: { channel } });
  }

  private async sendWith(parts: Parts, identity: IdentityRef, channel: AddressChannel, value: string, purpose: CodePurpose, opts: CodeSendOptions): Promise<void> {
    const issued = await parts.codes.issue(addressSubject(channel, value), purpose, { ttlSeconds: opts.ttlSeconds ?? this.Settings.ttlSeconds, length: this.CodeLength });
    const link = linkOf(opts.linkBase, channel, value, issued.code);
    await parts.sender.send({ channel, to: value, purpose, code: issued.code, ttlSeconds: issued.ttlSeconds, identity, ...(link ? { link } : {}), ...(opts.locale ? { locale: opts.locale } : {}) });
  }

  private async redeemWith(parts: Parts, address: AddressInput, code: string, purpose: CodePurpose, ctx: AuthnContext): Promise<Redeemed> {
    const value = address ? normalizeAddress(address.channel, address.value) : null;
    if (value === null || typeof code !== 'string') return { status: 'invalid', reason: 'malformed' };
    const check = await parts.codes.verify(addressSubject(address.channel, value), purpose, code);
    if (check !== 'ok') return { status: 'invalid', reason: check };
    const identity = await parts.addresses.findByAddress(address.channel, value);
    if (!identity) return { status: 'invalid', reason: 'unknown_address' };
    return (await parts.addresses.markVerified(identity, address.channel, value, ctx.now)) ? { status: 'verified', identity } : { status: 'invalid', reason: 'address_changed' };
  }

  private async parts(): Promise<Parts> {
    return {
      addresses: await this.neighbour(AddressStore, 'AddressStore'),
      codes: await this.neighbour(OneTimeCodeStore, 'OneTimeCodeStore'),
      sender: await this.neighbour(CodeSender, 'CodeSender'),
    };
  }

  private async neighbour<T>(type: abstract new (...args: never[]) => T, name: string): Promise<T> {
    if (!this.container.hasRegistered(type as unknown as Class<T>)) throw new InvalidOperation(`DefaultVerificationService: no ${name} is registered`);
    return (await this.container.resolve(type as unknown as Class<T>)) as T;
  }

  private async throttleOf(): Promise<AuthnThrottle> {
    this.throttle ??= await selectThrottle(this.container, this.ThrottleService);
    return this.throttle;
  }

  private async audit(ctx: AuthnContext, e: Omit<AuthnEvent, 'at' | 'ip' | 'userAgent'>): Promise<void> {
    this.auditor ??= await this.container.resolve(AuthnAudit);
    await this.auditor.publish({ ...e, at: ctx.now, ...(ctx.ip ? { ip: ctx.ip } : {}), ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}) });
  }
}
```

Create `packages/authn/src/verification/index.ts`:

```ts
export * from './default-verification-service.js';
```

Append to `packages/authn/src/index.ts`:

```ts
export * from './verification/index.js';
```

- [ ] **Step 4: GREEN + package suite + dependants**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/verification/verification-service.test.ts` — 9 passing.
2. `npm test` in `packages/authn` (the throttle selection tests of `default-authn-service.test.ts` cover the moved function; messages are unchanged).
3. Rebuild, then `cd ../authn-http && npm test` and `cd ../authn-oidc && npm test` (they resolve `DefaultAuthnService`).

- [ ] **Step 5: Commit**

```bash
git add packages/authn/src/registry/throttle.ts packages/authn/src/registry/index.ts packages/authn/src/service/default-authn-service.ts packages/authn/src/verification packages/authn/src/index.ts packages/authn/test/verification/verification-service.test.ts
git commit -m "feat(authn): DefaultVerificationService: throttled, enumeration-safe address verification"
```

---

### Task 10: Login gate and OIDC marking in `DefaultAuthnService`

**Files:**
- Modify: `packages/authn/src/service/default-authn-service.ts` (imports; fields after line 172; `resolve()` after line 192; `accept()` after line 413 and after line 416; one new private method)
- Test: create `packages/authn/test/service/verification-gate.test.ts`

**Interfaces:**
- Consumes: `AddressStore`, `normalizeAddress`, `'unverified'` (Task 1), `authn.verification` (Task 3), `MemoryAddressStore` (Task 4).
- Produces: `AuthenticationResult` `{ status: 'failure', reason: 'unverified' }` for an interactive `user` login without a verified email while `requiredForLogin` is `'email'`; audit `login` failure with reason `unverified`; audit `verification.verify` success `{ channel: 'email', via: 'external' }` when an external login marks the email.

- [ ] **Step 1: Write the failing test**

Create `packages/authn/test/service/verification-gate.test.ts`:

```ts
import assert from 'node:assert/strict';
import { expect } from 'chai';
import 'mocha';
import { MemoryAddressStore, fakeHash } from '@spinajs/authn-testing';

import { AddressStore } from '../../src/index.js';
import type { AuthnContext, ExternalSubject } from '../../src/index.js';
import { bind, buildCore, useHarnessLog, violationPaths } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

const ctx = (): AuthnContext => ({ now: new Date(), ip: '192.0.2.20', purpose: 'login' });
const PASSWORD = 'Gate-Pass-1';

async function core(verification: Record<string, unknown>, addresses = new MemoryAddressStore()): Promise<CoreParts & { addresses: MemoryAddressStore }> {
  const parts = await buildCore({}, { raw: { authn: { verification } }, register: (child) => bind(child, AddressStore, 'KitAddressStore', addresses) });
  return { ...parts, addresses };
}

async function alice(p: CoreParts & { addresses: MemoryAddressStore }, verifiedAt: Date | null) {
  const ref = p.identities.add({ login: 'alice@example.test', email: 'alice@example.test' });
  await p.passwords.set(ref, fakeHash(PASSWORD));
  p.addresses.set(ref, 'email', 'alice@example.test', verifiedAt);
  return ref;
}

describe('DefaultAuthnService: verified email for login (authn.verification)', function () {
  this.timeout(30000);
  useHarnessLog();

  let p: (CoreParts & { addresses: MemoryAddressStore }) | undefined;
  afterEach(async () => p?.dispose());

  it('requiredForLogin email: a right password with an unverified email answers unverified and issues no session', async () => {
    p = await core({ requiredForLogin: 'email' });
    const ref = await alice(p, null);
    const r = await p.service.authenticate({ kind: 'password', login: 'alice@example.test', password: PASSWORD }, ctx());
    expect(r).to.deep.eq({ status: 'failure', reason: 'unverified' });
    expect(await p.sessions.list(ref)).to.have.length(0);
    expect(p.events.ofType('login').map((e) => e.reason)).to.deep.eq(['unverified']);
  });

  it('a wrong password still answers invalid_credentials: the gate tells nothing before the credential verified', async () => {
    p = await core({ requiredForLogin: 'email' });
    await alice(p, null);
    expect(await p.service.authenticate({ kind: 'password', login: 'alice@example.test', password: 'wrong-pass-1' }, ctx())).to.deep.eq({ status: 'failure', reason: 'invalid_credentials' });
  });

  it('a verified email logs in; the gate is off by default', async () => {
    p = await core({ requiredForLogin: 'email' });
    await alice(p, new Date(1));
    expect((await p.service.authenticate({ kind: 'password', login: 'alice@example.test', password: PASSWORD }, ctx())).status).to.eq('success');
    await p.dispose();
    p = await core({});
    await alice(p, null);
    expect((await p.service.authenticate({ kind: 'password', login: 'alice@example.test', password: PASSWORD }, ctx())).status).to.eq('success');
  });

  it('boot fails with requiredForLogin email and no AddressStore', async () => {
    const boot = buildCore({}, { raw: { authn: { verification: { requiredForLogin: 'email' } } } });
    await assert.rejects(boot, /no AddressStore is registered/);
  });

  it('refuses requiredForLogin values other than false and email at boot', async () => {
    expect(await violationPaths(buildCore({}, { raw: { authn: { verification: { requiredForLogin: 'sms' } } } }))).to.include('authn.verification.requiredForLogin');
  });

  describe('external login with a provider-verified email', () => {
    const subject = (emailVerified: boolean): ExternalSubject => ({ provider: 'kit-idp', subject: 'g-1', email: 'Alice@Example.test', emailVerified });
    const login = (q: CoreParts) => q.service.authenticate({ kind: 'external', provider: 'kit-idp', payload: { subject: 'g-1' } }, ctx());

    it('marks the identity own email verified, then passes the gate', async () => {
      p = await core({ requiredForLogin: 'email' });
      const ref = await alice(p, null);
      p.externalSubjects.set('g-1', subject(true));
      await p.links.link(ref, subject(true));
      expect((await login(p)).status).to.eq('success');
      expect(p.addresses.marked.map((m) => m.value)).to.deep.eq(['alice@example.test']);
      expect(p.events.ofType('verification.verify').map((e) => e.data)).to.deep.eq([{ channel: 'email', via: 'external' }]);
    });

    it('marks nothing when the provider does not vouch, or with trustExternalEmail false', async () => {
      p = await core({ requiredForLogin: 'email' });
      const ref = await alice(p, null);
      p.externalSubjects.set('g-1', subject(false));
      await p.links.link(ref, subject(false));
      expect(await login(p)).to.deep.eq({ status: 'failure', reason: 'unverified' });
      await p.dispose();

      p = await core({ trustExternalEmail: false });
      const ref2 = await alice(p, null);
      p.externalSubjects.set('g-1', subject(true));
      await p.links.link(ref2, subject(true));
      expect((await login(p)).status).to.eq('success');
      expect(p.addresses.marked).to.deep.eq([]);
    });
  });
});
```

If `MemorySessionIssuer` has no `list(ref)` that answers sessions for a subject, replace that assertion with `expect(p.sessions.storage.rows ...)` the way `default-authn-service.test.ts` counts issued sessions.

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/service/verification-gate.test.ts`
Expected: FAIL: the first test gets `status: 'success'`; the boot test resolves instead of rejecting; the external test finds `marked` empty.

- [ ] **Step 3: Implement**

In `packages/authn/src/service/default-authn-service.ts`:

Imports — extend the identity import and add the address helper:

```ts
import { AddressStore, IdentityStore } from '../contracts/identity.js';
import { normalizeAddress } from '../contracts/address.js';
```

Fields, after `protected ThrottleService` (line 172):

```ts
  @Config('authn.verification')
  protected Verification: { readonly requiredForLogin: false | 'email'; readonly trustExternalEmail: boolean } | undefined;

  private addresses: AddressStore | undefined;
```

`resolve()`, after `this.links = …` (line 192):

```ts
    this.addresses = await this.neighbour(AddressStore, 'AddressStore', this.Verification?.requiredForLogin === 'email');
```

`accept()`, replace lines 409-416 (from the hooks comment through `throttle.succeed`) with:

```ts
    // Before the link by verified email, so a login a hook refuses leaves neither a session nor a new email link.
    if (s.interactive && r.external) {
      const hookError = await this.runLoginHooks(id, r.external);
      if (hookError !== null) return this.refuse(ctx, s, 'hook_error', 'invalid_credentials', { identity: id, data: { error: hookError } });
      await this.markExternalEmail(ctx, s, id, r.external);
    }

    if (found.link && !found.provisioned) await this.link(ctx, s, id, found.link);
    await this.throttle.succeed(keys, 'login');
    // After the credential and the status: only the holder of the credential learns that the address is unverified.
    if (s.interactive && id.type === 'user' && this.Verification?.requiredForLogin === 'email' && !(await this.emailVerified(id))) {
      return this.refuse(ctx, s, 'unverified', 'unverified', { identity: id });
    }
```

New private methods, after `runLoginHooks`:

```ts
  private async emailVerified(id: IdentityRef): Promise<boolean> {
    return (await this.addresses!.addresses(id)).some((a) => a.channel === 'email' && a.verifiedAt !== null);
  }

  /** A provider that vouches for the email (emailVerified true) verifies it, when it is the identity's own current one. */
  private async markExternalEmail(ctx: AuthnContext, s: AuthenticationStrategy, id: IdentityRef, external: ExternalSubject): Promise<void> {
    if (!this.addresses || this.Verification?.trustExternalEmail !== true || external.emailVerified !== true) return;
    const value = normalizeAddress('email', external.email);
    if (value === null) return;
    const about = { strategy: s.name, identity: id };
    try {
      const own = (await this.addresses.addresses(id)).find((a) => a.channel === 'email' && a.value === value);
      if (!own || own.verifiedAt !== null) return;
      if (await this.addresses.markVerified(id, 'email', value, ctx.now)) {
        await this.audit(ctx, { type: 'verification.verify', outcome: 'success', ...about, data: { channel: 'email', via: 'external' } });
      }
    } catch (err) {
      await this.audit(ctx, { type: 'verification.verify', outcome: 'failure', reason: 'store_error', ...about, data: { channel: 'email', via: 'external', error: errorClass(err) } });
    }
  }
```

- [ ] **Step 4: GREEN + package suite + dependants**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/service/verification-gate.test.ts` — 7 passing.
2. `npm test` in `packages/authn` (with no `AddressStore` and the default `false`, nothing changes for the existing suites).
3. Rebuild, then one after another: `cd ../authn-http && npm test`, `cd ../authn-oidc && npm test`, `cd ../authn-local && npm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/authn/src/service/default-authn-service.ts packages/authn/test/service/verification-gate.test.ts
git commit -m "feat(authn): authn.verification.requiredForLogin gate and provider-verified emails"
```

---

### Task 11: 3.0 HTTP routes and the login answer

**Files:**
- Modify: `packages/authn-http/src/v3/responses.ts` (append helpers)
- Modify: `packages/authn-http/src/policies/v3/groups.ts` (append `VerificationRegistered`)
- Modify: `packages/authn-http/src/v3/index.ts:8` (export the policy)
- Create: `packages/authn-http/src/v3/controllers/AuthnVerificationController.ts`
- Modify: `packages/authn-http/src/v3/controllers/AuthnLoginController.ts:50`
- Modify: `packages/authn-http/test/v3-app/app.ts:13,128-145` (fakes), `test/v3-app/suites/route-table.ts:26-40`, `test/v3-app/account.test.ts`
- Create: `packages/authn-http/test/v3-app/suites/verification.ts`
- Modify: `docs/authn/README.md` (new section "Verification" after "Throttling", rows in the config table)

**Interfaces:**
- Consumes: `VerificationService`, `AddressStore`, `CodeSender`, `OneTimeCodeStore`, `'unverified'` (Task 1); `VERIFICATION_MESSAGES` codes (Task 3); plan 03's `authnMessage`, `AuthnMessageCode`, `AuthnErrorCode`, `AuthnMessageContextValue` (`@spinajs/authn/messages`) and `errorBody(code, message, context?)` (`packages/authn-http/src/policies/v3/errors.ts`); plan 05's `captchaRefusal(container, req, flow, account?, cookies?)` (`packages/authn-http/src/v3/captcha.ts`).
- Produces: routes
  - `POST /auth/verification` body `{ channel?: 'email' | 'sms', address?: string }`. With an active session and no `address`: the session's own address of `channel` (default `email`). 200 `{ messages: [1004001] }`; 400 `errorBody('E_INVALID_ADDRESS')` (4004003); 429 + `Retry-After` `errorBody('throttled', …, { retryAfterSeconds })` (4000018); plan 05's CAPTCHA 400 for flow `verify`.
  - `POST /auth/verification/confirm` body `{ channel?, address, code }`. 200 `{ messages: [1004002] }`; 400 `errorBody('E_CODE_INVALID')` (4004001); 429 as above.
  - Both 404 while `AddressStore`, `OneTimeCodeStore` or `CodeSender` is not registered (`VerificationRegistered`).
  - `POST /auth/login` with result reason `unverified`: 403 `errorBody('E_VERIFICATION_REQUIRED')` (4004002), no session cookie.
  - Helpers in `responses.ts`: `infoResponse(code: AuthnMessageCode): Ok`, `refusalResponse(status: number, code: AuthnErrorCode, message: string, context?, headers?, cookies?): BadRequestResponse`.

- [ ] **Step 1: Write the failing tests**

Create `packages/authn-http/test/v3-app/suites/verification.ts`:

```ts
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { VerificationService } from '@spinajs/authn/contracts';

import { Client, addresses, codeSender, config, loggedIn, resetRecorders, seedUser, throttle } from '../app.js';

const idOf = (body: { messages?: { id: number }[] }): number | undefined => body.messages?.[0]?.id;

const drain = async () => ((await DI.resolve(VerificationService)) as unknown as { drain(): Promise<void> }).drain();

export function verificationSuite(): void {
  beforeEach(() => {
    resetRecorders();
    codeSender.clear();
  });

  it('POST /auth/verification answers 1004001 for a known and an unknown address alike, and mails the known one', async () => {
    const u = await seedUser();
    addresses.set(u.ref, 'email', u.login);
    const known = await new Client().post('/auth/verification', { address: u.login });
    const unknown = await new Client().post('/auth/verification', { address: 'nobody@example.test' });
    expect(known.status).to.eq(200);
    expect(known.body).to.deep.eq(unknown.body);
    expect(idOf(known.body)).to.eq(1004001);
    await drain();
    expect(codeSender.sent.map((m) => m.to)).to.deep.eq([u.login.toLowerCase()]);
    expect(throttle.attempts.filter((a) => a.flow === 'verify')).to.have.length(2);
  });

  it('POST /auth/verification with a session and no address uses the own email', async () => {
    const u = await seedUser();
    addresses.set(u.ref, 'email', u.login);
    const c = await loggedIn(u);
    expect((await c.post('/auth/verification', {})).status).to.eq(200);
    await drain();
    expect(codeSender.sent).to.have.length(1);
  });

  it('POST /auth/verification refuses a malformed address with 4004003 and a throttled one with 429, Retry-After and 4000018', async () => {
    const bad = await new Client().post('/auth/verification', { channel: 'sms', address: '12' });
    expect(bad.status).to.eq(400);
    expect(bad.body.error).to.eq('E_INVALID_ADDRESS');
    expect(idOf(bad.body)).to.eq(4004003);
    throttle.refuse(30);
    const limited = await new Client().post('/auth/verification', { address: 'x@example.test' });
    expect(limited.status).to.eq(429);
    expect(limited.headers['retry-after']).to.eq('30');
    expect(limited.body.messages[0]).to.deep.include({ id: 4000018, context: { retryAfterSeconds: 30 } });
  });

  it('POST /auth/verification/confirm verifies with the mailed code once; anything else is one 4004001', async () => {
    const u = await seedUser();
    addresses.set(u.ref, 'email', u.login);
    await new Client().post('/auth/verification', { address: u.login });
    await drain();
    const code = codeSender.codeFor(u.login.toLowerCase(), 'verify')!;
    const ok = await new Client().post('/auth/verification/confirm', { address: u.login, code });
    expect(ok.status).to.eq(200);
    expect(idOf(ok.body)).to.eq(1004002);
    for (const body of [{ address: u.login, code }, { address: 'nobody@example.test', code }, { address: u.login }]) {
      const r = await new Client().post('/auth/verification/confirm', body);
      expect(r.status, JSON.stringify(body)).to.eq(400);
      expect(r.body.error).to.eq('E_CODE_INVALID');
      expect(idOf(r.body)).to.eq(4004001);
    }
  });

  it('GET is no route: a link never redeems', async () => {
    expect((await new Client().get('/auth/verification/confirm')).status).to.eq(404);
  });

  it('POST /auth/login answers 403 4004002 without a cookie when the email must be verified first', async () => {
    const u = await seedUser();
    addresses.set(u.ref, 'email', u.login);
    config().set('authn.verification.requiredForLogin', 'email');
    try {
      const c = new Client();
      const r = await c.post('/auth/login', { login: u.login, password: u.password });
      expect(r.status).to.eq(403);
      expect(r.body.error).to.eq('E_VERIFICATION_REQUIRED');
      expect(idOf(r.body)).to.eq(4004002);
      expect(c.cookie).to.eq(null);
    } finally {
      config().set('authn.verification.requiredForLogin', false);
    }
  });
}
```

(`requiredForLogin` is read through `@Config` on every login, so `config().set` switches it; `DefaultAuthnService` resolved `AddressStore` already because the app registers one.)

In `packages/authn-http/test/v3-app/app.ts`:
- line 13: add `AddressStore, CodeSender, OneTimeCodeStore` to the `@spinajs/authn/contracts` import; line 17: add `MemoryAddressStore, RecordingCodeSender` to the `@spinajs/authn-testing` import.
- after `export const events = new RecordingEventSink();` (line 93):

```ts
export const addresses = new MemoryAddressStore();
export const codeSender = new RecordingCodeSender();
```

- in `wire()` before `await registerAuthnHttpV3();`:

```ts
  bind(AddressStore, 'V3AppAddressStore', () => addresses);
  bind(CodeSender, 'V3AppCodeSender', () => codeSender);
  const { MemoryOneTimeCodeStore } = await import('@spinajs/authn');
  const codes = new MemoryOneTimeCodeStore({ maxAttempts: 5 });
  bind(OneTimeCodeStore, 'V3AppCodeStore', () => codes);
```

`packages/authn-http/test/v3-app/suites/route-table.ts`: append to `ACCOUNT_ROUTES_V3`:

```ts
  'POST /auth/verification',
  'POST /auth/verification/confirm',
```

`packages/authn-http/test/v3-app/account.test.ts`: import `{ verificationSuite } from './suites/verification.js'` and add `describe('address verification', verificationSuite);` before `describe('route table', routeTableSuite);`.

Add to `packages/authn-http/test/v3-app/suites/groups-off.ts` a case for the policy (it asks the container, like the existing one):

```ts
  it('VerificationRegistered needs an AddressStore, a OneTimeCodeStore and a CodeSender', async () => {
    const { VerificationRegistered } = await import('../../../src/v3/index.js');
    const { AddressStore, CodeSender, OneTimeCodeStore } = await import('@spinajs/authn/contracts');
    const empty = new Container();
    const p = new VerificationRegistered();
    (p as unknown as { Container: unknown }).Container = empty;
    const req = { storage: {} } as unknown as Request;
    await p.execute(req, {} as IRoute, {} as IController).then(
      () => expect.fail('passed without the neighbours'),
      (e: { constructor: { name: string } }) => expect(e.constructor.name).to.eq('ResourceNotFound'),
    );
    const child = empty.child();
    for (const base of [AddressStore, CodeSender, OneTimeCodeStore]) child.register({ [`Stub${base.name}`]: () => ({}) }[`Stub${base.name}`]).as(base as never);
    (p as unknown as { Container: unknown }).Container = child;
    await p.execute(req, {} as IRoute, {} as IController);
  });
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json test/v3-app/account.test.ts`
Expected: FAIL: `POST /auth/verification` answers 404, the route table lacks the two routes, the login case gets 401, the policy import has no `VerificationRegistered`.

- [ ] **Step 3: Implement**

Append to `packages/authn-http/src/v3/responses.ts`:

```ts
/** 200 with one info message of the catalogue (plan 03 body shape: `messages`). */
export function infoResponse(code: AuthnMessageCode): Ok {
  return new Ok({ messages: [authnMessage(code)] }, { Headers: [NO_STORE] });
}

/**
 * A refusal answered, not thrown, so it can carry a status @spinajs/http has no class for (429) and headers: plan 03's
 * `errorBody` with `StatusCode`.
 */
export function refusalResponse(status: number, code: AuthnErrorCode, message: string, context?: Readonly<Record<string, AuthnMessageContextValue>>, headers: readonly IResponseHeader[] = [], cookies: readonly ICookie[] = []): BadRequestResponse {
  return new BadRequestResponse(errorBody(code, message, context), { StatusCode: status, Headers: [NO_STORE, ...headers], Coockies: [...cookies] });
}

/** 429 with Retry-After and plan 03's `throttled` (4000018). */
export function throttledResponse(retryAfterSeconds: number): BadRequestResponse {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  return refusalResponse(429, 'throttled', 'too many attempts', { retryAfterSeconds: seconds }, [{ Name: 'Retry-After', Value: String(seconds) }]);
}
```

Extend its imports: `import { BadRequestResponse, Ok, Unauthorized } from '@spinajs/http';`, `import { authnMessage } from '@spinajs/authn/messages';`, `import type { AuthnErrorCode, AuthnMessageCode, AuthnMessageContextValue } from '@spinajs/authn/messages';`, and `errorBody` next to `AUTHN_FAILURE` from `'../policies/v3/errors.js'` (plan 03 put both there). `@spinajs/authn/messages` registers nothing, so importing it at module load keeps the layer inert (plan 03 Decision 6).

Append to `packages/authn-http/src/policies/v3/groups.ts` (and add `AddressStore, CodeSender, OneTimeCodeStore` to its `@spinajs/authn/contracts` import):

```ts
/** 404 while any of AddressStore, OneTimeCodeStore and CodeSender is missing: address verification is off. */
export class VerificationRegistered extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request, _action: IRoute, _instance: IController): Promise<void> {
    for (const [type, name] of [
      [AddressStore, 'AddressStore'],
      [OneTimeCodeStore, 'OneTimeCodeStore'],
      [CodeSender, 'CodeSender'],
    ] as const) {
      if (!this.Container.hasRegistered(type as unknown as Class<unknown>)) throw notFound('not_found', `address verification is off: no ${name} is registered`);
    }
  }
}
```

`packages/authn-http/src/v3/index.ts` line 8:

```ts
export { RoleSourceRegistered, ImpersonationGuardRegistered, VerificationRegistered } from '../policies/v3/groups.js';
```

and add `infoResponse, refusalResponse, throttledResponse` to the `./responses.js` export line.

Create `packages/authn-http/src/v3/controllers/AuthnVerificationController.ts`:

```ts
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { VerificationService } from '@spinajs/authn/contracts';
import type { AddressChannel, VerificationTarget } from '@spinajs/authn/contracts';

import { VerificationRegistered } from '../index.js';
import { captchaRefusal } from '../captcha.js';
import { infoResponse, refusalResponse, throttledResponse } from '../responses.js';
import { bodyField, boundedString, contextOf } from '../routes.js';

const ADDRESS_CAP = 320;
const CODE_CAP = 64;

const channelOf = (v: unknown): AddressChannel | null => (v === undefined ? 'email' : v === 'email' || v === 'sms' ? v : null);

const invalidAddress = () => refusalResponse(400, 'E_INVALID_ADDRESS', 'not a valid address');
const invalidCode = () => refusalResponse(400, 'E_CODE_INVALID', 'the code is invalid or has expired');

/**
 * Address verification (plan 06). Off (404) while AddressStore, OneTimeCodeStore or CodeSender is missing. Both routes are
 * POST: a mail scanner that follows a link redeems nothing. The request answers the same for every well-formed address.
 * @tags Authentication
 */
@BasePath('auth')
@Policy(VerificationRegistered)
export class AuthnVerificationController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  /**
   * Request a verification code
   * Body `{ channel?, address? }` (`channel` 'email' by default). Without `address`, a caller with an active session gets
   * a code for its own address of that channel. Always 200 with message 1004001 for a well-formed address. Guarded by
   * the CAPTCHA flow `verify` when a CaptchaGate is registered (plan 05).
   * @security []
   */
  @Post('verification')
  public async request(@Req() req: Request) {
    const channel = channelOf(bodyField(req, 'channel'));
    const typed = bodyField(req, 'address');
    const session = req.storage.AuthnSession;
    let target: VerificationTarget | null = null;
    if (channel !== null && typed === undefined && session?.handle.state === 'active') target = { identity: session.identity, channel };
    else if (channel !== null && boundedString(typed, ADDRESS_CAP) !== null) target = { address: { channel, value: typed as string } };
    if (target === null) return invalidAddress();

    const refusal = await captchaRefusal(this.Container, req, 'verify', 'address' in target ? target.address.value : undefined);
    if (refusal) return refusal;

    const service = await this.Container.resolve(VerificationService);
    const r = await service.request(target, contextOf(req, 'request'));
    if (r.status === 'throttled') return throttledResponse(r.retryAfterSeconds);
    if (r.status === 'invalid_address') return invalidAddress();
    return infoResponse('verification_sent');
  }

  /**
   * Confirm a verification code
   * Body `{ channel?, address, code }`. 200 with message 1004002; one 400 with message 4004001 for a wrong, expired, used
   * or exhausted code and an unknown address.
   * @security []
   */
  @Post('verification/confirm')
  public async confirm(@Req() req: Request) {
    const channel = channelOf(bodyField(req, 'channel'));
    const address = boundedString(bodyField(req, 'address'), ADDRESS_CAP);
    const code = boundedString(bodyField(req, 'code'), CODE_CAP);
    if (channel === null || address === null || code === null) return invalidCode();

    const service = await this.Container.resolve(VerificationService);
    const r = await service.confirm({ channel, value: address }, code, contextOf(req, 'request'));
    if (r.status === 'throttled') return throttledResponse(r.retryAfterSeconds);
    if (r.status !== 'verified') return invalidCode();
    return infoResponse('address_verified');
  }
}
```

`packages/authn-http/src/v3/controllers/AuthnLoginController.ts`: add `refusalResponse` to the `../responses.js` import and, in front of the line that answers a failure (line 50 today; plan 03 and 05 may have moved it), add:

```ts
    if (result.status === 'failure' && result.reason === 'unverified') return refusalResponse(403, 'E_VERIFICATION_REQUIRED', 'verify the email address first', undefined, [], cleared);
```

`cleared` clears a session the caller held, which the route revoked above.

`docs/authn/README.md`: add a section after "Throttling":

```markdown
## Verification

Identities have verifiable addresses: the email, and a phone in E.164 (`AddressStore`, implemented by `users` over
`users.Email` and `users_address`). A row of `users_address` records that one exact value was verified, so changing the
email by any path leaves the new value unverified.

- `POST /auth/verification` `{ channel?, address? }` (CAPTCHA flow `verify`) answers message 1004001 for every well-formed address and mails a
  6-digit code (`authn.codes.length`) to a known, unverified one. It counts in the `verify` throttle flow per address and IP.
  With a session and no `address`, the session's own address is used.
- `POST /auth/verification/confirm` `{ channel?, address, code }` marks the address verified (1004002) or answers 4004001.
  Links put the code in the URL fragment of `authn.verification.url`; the page POSTs it. No GET redeems a code.
- Codes are stored as HMAC-SHA256 under `authn.codes.secret` (`DbOneTimeCodeStore`, table `authn_code`, from
  `authn-orm`), single use, at most `authn.codes.maxAttempts` (5) guesses each, `authn.verification.ttlSeconds` (900 s).
  `DbOneTimeCodeStore` refuses to work without the secret.
- `authn.verification.requiredForLogin: 'email'` refuses an interactive login whose email is unverified, after the password
  verified: 403 with message 4004002. Default `false`.
- An OIDC login whose provider vouches for the email (`email_verified: true`; never for the `entra` and `github` presets)
  marks the identity's own email verified (`authn.verification.trustExternalEmail`, default true).
- Upgrade: the `users` migration marks the email of every active, not deleted user verified
  (`users.addresses.trustExistingEmails: false` skips it).
- Mail: `EmailCodeSender` (`@spinajs/email`, registered by `users`) renders and sends at once, `email.codes`. SMS needs an
  app's own `CodeSender`.
```

and in the config table add:

```markdown
| `authn.codes.*` | `DbOneTimeCodeStore`, `DefaultVerificationService` | `secret` (secret reference, 32+ characters; required by the DB store), `maxAttempts` (5), `length` (6). |
| `authn.verification.*` | `DefaultVerificationService`, `DefaultAuthnService` | `requiredForLogin` (`false`), `ttlSeconds` (900), `url` (''), `trustExternalEmail` (true). |
```

- [ ] **Step 4: GREEN + package suite**

1. `cd packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json test/v3-app/account.test.ts` — passing, including the route table.
2. `npm test` in `packages/authn-http` (both mocha configs).

- [ ] **Step 5: Commit**

```bash
git add packages/authn-http/src/v3/responses.ts packages/authn-http/src/policies/v3/groups.ts packages/authn-http/src/v3/index.ts packages/authn-http/src/v3/controllers/AuthnVerificationController.ts packages/authn-http/src/v3/controllers/AuthnLoginController.ts packages/authn-http/test/v3-app/app.ts packages/authn-http/test/v3-app/suites/verification.ts packages/authn-http/test/v3-app/suites/route-table.ts packages/authn-http/test/v3-app/suites/groups-off.ts packages/authn-http/test/v3-app/account.test.ts docs/authn/README.md
git commit -m "feat(authn-http): POST /auth/verification and /confirm; login answers 4004002 for an unverified email"
```

---

### Task 12: `users` email change and phone

**Files:**
- Modify: `packages/users/src/actions.ts:162` (`sendUserEmail` signature and `to`), new functions after `updateUser` (line 203)
- Modify: `packages/users/src/config/users.ts` (`users.email.emailChanged` after `activated`)
- Create: `packages/users/src/templates/user-email-changed-template.pug`
- Test: create `packages/users/test/email-change.test.ts`

**Interfaces:**
- Consumes: `VerificationService` (Task 9, optional in DI), `UserAddressStore` (Task 8), `normalizeAddress`.
- Produces: `changeEmail(identifier: number | string | User, email: string, ctx?: AuthnContext): Promise<User>`, `setPhone(identifier: number | string | User, phone: string | null, ctx?: AuthnContext): Promise<User>`; `sendUserEmail(u, template, model?, to?: string)`; template key `emailChanged`.

- [ ] **Step 1: Write the failing test**

Create `packages/users/test/email-change.test.ts`:

```ts
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { VerificationService } from '@spinajs/authn/contracts';
import type { AuthnContext, VerificationTarget } from '@spinajs/authn/contracts';

import { UserAddressStore, changeEmail, setPhone } from '../src/index.js';
import './migration/rbac.migration.js';
import { bootUsersDb, registerUsersTestHost, seedUser, storedUser } from './support/users-db.js';

class RecordingVerification extends VerificationService {
  public static requests: VerificationTarget[] = [];
  public async request(target: VerificationTarget, _ctx: AuthnContext) {
    RecordingVerification.requests.push(target);
    return { status: 'accepted' as const };
  }
  public async confirm() {
    return { status: 'invalid' as const };
  }
  public async send() {}
  public async redeem() {
    return { status: 'invalid' as const };
  }
}

describe('changeEmail and setPhone', function () {
  this.timeout(30000);

  let emitted: unknown[];

  before(() => registerUsersTestHost());

  beforeEach(async () => {
    await bootUsersDb((config: Configuration) => config.set('email.defaultConnection', 'rbac-email-connection'));
    emitted = [];
    sinon.stub(DefaultQueueService.prototype, 'emit').callsFake(async (e: unknown) => {
      emitted.push(e);
    });
    RecordingVerification.requests = [];
    DI.register(RecordingVerification).as(VerificationService);
  });

  afterEach(() => {
    sinon.restore();
    DI.unregister(RecordingVerification);
    DI.clearCache();
  });

  it('writes the new email unverified, asks for its verification and notifies the previous address', async () => {
    const { user, ref } = await seedUser({ login: 'chg-a', email: 'chg-old@example.test' });
    await new UserAddressStore().markVerified(ref, 'email', 'chg-old@example.test', new Date());

    await changeEmail(user.Uuid, 'Chg-New@Example.test');

    expect((await storedUser(ref.id)).Email).to.eq('Chg-New@Example.test');
    expect(await new UserAddressStore().addresses(ref)).to.deep.eq([{ channel: 'email', value: 'chg-new@example.test', verifiedAt: null }]);
    expect(RecordingVerification.requests).to.deep.eq([{ identity: ref, channel: 'email' }]);
    const notice = JSON.stringify(emitted);
    expect(notice).to.contain('chg-old@example.test').and.contain('user-email-changed');
  });

  it('refuses an email another user holds, and does nothing for the same email', async () => {
    await seedUser({ login: 'chg-b', email: 'taken@example.test' });
    const { user } = await seedUser({ login: 'chg-c', email: 'chg-c@example.test' });
    await expect(changeEmail(user.Uuid, 'taken@example.test')).to.be.rejected;
    await changeEmail(user.Uuid, 'chg-c@example.test');
    expect(RecordingVerification.requests).to.deep.eq([]);
  });

  it('sets a phone in E.164 and asks for its verification; refuses a national number', async () => {
    const { user, ref } = await seedUser({ login: 'chg-d' });
    await setPhone(user.Uuid, '0048 123 456 789');
    expect((await new UserAddressStore().addresses(ref)).find((a) => a.channel === 'sms')).to.deep.eq({ channel: 'sms', value: '+48123456789', verifiedAt: null });
    expect(RecordingVerification.requests).to.deep.eq([{ identity: ref, channel: 'sms' }]);
    await expect(setPhone(user.Uuid, '123 456 789')).to.be.rejectedWith(/E\.164/);
    await setPhone(user.Uuid, null);
    expect((await new UserAddressStore().addresses(ref)).filter((a) => a.channel === 'sms')).to.deep.eq([]);
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/users && npx ts-mocha -p tsconfig.json test/email-change.test.ts`
Expected: FAIL at compile time: `Module '"../src/index.js"' has no exported member 'changeEmail'` (and `setPhone`).

- [ ] **Step 3: Implement**

`packages/users/src/actions.ts`:

Change the `sendUserEmail` signature (line 162) to add `'emailChanged'` to the template union and a recipient override, and use it in the `emailDeferred` call:

```ts
export async function sendUserEmail(u: User, cfgTemplate: 'created' | 'confirm' | 'deactivated' | 'activated' | 'deleted' | 'unbanned' | 'banned' | 'passwordWillExpire' | 'passwordExpired' | 'emailChanged', model?: (u: User) => Promise<{ [key: string]: unknown }> | { [key: string]: unknown }, to: string = u.Email): Promise<User> {
```

and inside, `to: [u.Email],` becomes `to: [to],`. Document the new parameter in the JSDoc: `@param to - recipient, default the user's current email (the email-change notice goes to the previous one)`.

Add the imports:

```ts
import { VerificationService, normalizeAddress } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { UserAddressStore } from './identity/address-store.js';
```

(merge them with the existing `@spinajs/authn/contracts` imports at lines 23-24.)

After `updateUser` (line 203) add:

```ts
async function verificationService(): Promise<VerificationService | null> {
  // @spinajs/authn's root registers DefaultVerificationService; an app without it changes addresses without codes.
  return DI.RootContainer.hasRegistered(VerificationService) ? ((await DI.resolve(VerificationService)) as VerificationService) : null;
}

const requestContext = (): AuthnContext => ({ now: new Date(), purpose: 'request' });

/**
 * Changes the email of a user. The new value is unverified (users_address records verification per value), a code goes to
 * it through `VerificationService` when one is registered, and the previous address gets the `emailChanged` notice
 * (Kratos notify_previous_addresses). The notice is queued: it carries no secret.
 */
export async function changeEmail(identifier: number | string | User, email: string, ctx: AuthnContext = requestContext()): Promise<User> {
  const u = await getUser(identifier);
  const next = _check_arg(_trim(), _non_empty(), _is_email(), _max_length(64))(email, 'email');
  if (next === u.Email) {
    return u;
  }

  await assertUserUnique(undefined, next, u.Id);
  const previous = u.Email;
  await updateUser(u, { Email: next });
  await sendUserEmail(u, 'emailChanged', () => ({ PreviousEmail: previous }), previous);

  const verification = await verificationService();
  if (verification) {
    await verification.request({ identity: userRef(u.Uuid) as IdentityRef, channel: 'email' }, ctx);
  }
  return u;
}

/** Sets (E.164, unverified, a code sent when a VerificationService is registered) or removes (`null`) the phone of a user. */
export async function setPhone(identifier: number | string | User, phone: string | null, ctx: AuthnContext = requestContext()): Promise<User> {
  const u = await getUser(identifier);
  const ref = userRef(u.Uuid) as IdentityRef;
  const store = new UserAddressStore();
  if (phone === null) {
    await store.removePhone(ref);
    return u;
  }

  const value = normalizeAddress('sms', phone);
  if (value === null) {
    throw new InvalidArgument('Phone must be an E.164 number with its country code, e.g. +48123456789', 'phone');
  }

  if (await store.setPhone(ref, value)) {
    const verification = await verificationService();
    if (verification) {
      await verification.request({ identity: ref, channel: 'sms' }, ctx);
    }
  }
  return u;
}
```

`packages/users/src/config/users.ts`, in `users.email` after `activated`:

```ts
      // to the previous address when the email of an account changes (changeEmail)
      emailChanged: {
        enabled: true,
        template: './user-email-changed-template.pug',
        subject: 'Your email address was changed',
      },
```

Create `packages/users/src/templates/user-email-changed-template.pug`:

```pug
//- Email address changed
//-
//- Sent to the PREVIOUS address. The model is the serialized User plus PreviousEmail; the new address is deliberately
//- not printed, so a mailbox that lost the account learns nothing it could use.
doctype html
html
  head
    meta(charset='utf-8')
    title Email address changed
  body
    p Hello #{ Login || PreviousEmail },
    p The email address of your account is no longer #{ PreviousEmail }.
    p If you did not change it, contact support at once.
    p —
    p This is an automated message; please do not reply.
```

- [ ] **Step 4: GREEN + package suite**

1. `cd packages/users && npx ts-mocha -p tsconfig.json test/email-change.test.ts` — 3 passing.
2. `npm test` in `packages/users` (`shipped-config.test.ts:72` checks the top-level `users` keys only, which are unchanged).
3. Rebuild users; `cd ../users-http && npm test` (it imports users).

- [ ] **Step 5: Commit**

```bash
git add packages/users/src/actions.ts packages/users/src/config/users.ts packages/users/src/templates/user-email-changed-template.pug packages/users/test/email-change.test.ts
git commit -m "feat(users): changeEmail and setPhone: new addresses start unverified, the previous email is notified"
```

---

## Self-review

- **Spec coverage:** contracts (Task 1); MemoryOneTimeCodeStore (5) and DbOneTimeCodeStore with `authn_code` id/subject/purpose/code_hmac/attempts/expires_at/used_at/created_at, HMAC under `authn.codes.secret`, constant-time compare, maxAttempts 5, purge (6); CodeSender + EmailCodeSender (7); AddressStore in users with the storage decision and E.164 validator (1, 8); VerificationService request/verify, throttled `verify` per IP + address, same answer, link with POST-only redeem (2, 9, 11); routes (11); email change → unverified + code to new + notice to old (12); OIDC email_verified marking with the preset decision (10); `requiredForLogin` gate with 4004002 after the password (10, 11); CAPTCHA flow `verify` on the request route (11); audit events (1, 9, 10); 2.x data migration decision (8); behaviour rule A33 (4).
- **Placeholder scan:** the only conditional instructions are tied to facts that other agents may change before execution (plan 03 message names, the uncommitted throttle move, `capturingEmailService` destructuring, `MemorySessionIssuer.list`, date reading in `toDate`); each names the exact fallback.
- **Type consistency:** `VerificationService` members `request/confirm/send/redeem` match across Tasks 1, 9, 11, 12; `normalizeAddress`/`addressSubject` from `contracts/address.ts` everywhere; `MemoryAddressStore.set(identity, channel, raw, verifiedAt?)` used the same in Tasks 4, 9, 10, 11; `runOneTimeCodeStoreConformance` row view `{ subject, purpose, codeHash, attempts, expiresAt, usedAt }` matches `MemoryOneTimeCodeStore.rows()` and the DB test mapping.
