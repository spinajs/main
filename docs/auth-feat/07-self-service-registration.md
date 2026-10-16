# Self-service Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Visitors can sign up through `POST /auth/registration` (off by default) without the endpoint revealing whether an email already has an account, confirm the address with a mailed code, and get a session according to `authn.registration.loginAfter`; OIDC just-in-time provisioning creates accounts through the same registrar.

**Architecture:** `@spinajs/authn` gets the contracts (`IdentityRegistrar` as the README fixes it, `RegistrationService`, `RegistrationHook`), the `register` throttle flow, the `authn.registration` schema and messages 1005xxx/4005xxx. `@spinajs/authn-local` implements `LocalRegistrationService`, because the README's `RegistrationInput.passwordHash` is "already hashed by the password strategy" and the hasher and password policy live there. `@spinajs/users` implements `IdentityRegistrar` (and `IdentityStore.provision` on top of it). `@spinajs/authn-http` mounts `POST /auth/registration` and `POST /auth/registration/confirm` in the 3.0 layer, guarded by plan 05's CAPTCHA flow `register`. Codes, addresses and marking verified come from plan 06's `VerificationService`.

**Tech Stack:** TypeScript (ESM + CJS builds), mocha via `ts-mocha`, chai / `node:assert`, `@spinajs/di`, `@spinajs/configuration` (`@Config` + AJV schema), `@spinajs/orm` on sqlite in tests, argon2 (authn-local's hasher).

## Global Constraints

- Code comments, identifiers and commit messages are in English. Comment only what the code cannot say.
- Work on branch `authz-v3-refactor`, one commit per task, and run the package suites before each commit.
- Every test command runs from the package directory: `npx ts-mocha -p tsconfig.json <file>`. A package's full suite is `npm test`.
- A package that consumes a changed package reads it from `lib/`. Rebuild before testing dependents: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json` in the changed package.
- Working-copy files use CRLF. Keep them CRLF.
- A value check moves into the module's JSON schema. Code keeps only checks a schema cannot make. Defaults move into the schema; never add a default that changes an effective access/security value (registration is off by default).
- Secrets are secret references, never inline values.
- Each new behaviour rule gets a row in `packages/authn-testing`, continuing the A-series. This plan writes its rule as **A34**; plans 02–06 land first and claim ids, so at execution take the next free id and rename it everywhere Task 3 lists.
- HTTP work targets the 3.0 layer (`packages/authn-http/src/v3`), never the 2.x controllers.
- Plans 02, 03, 05 and 06 must have landed: this plan uses their names unchanged (see "Consumed from other plans").
- Committing shared files: stage only your hunks; check `git diff --cached` before every commit.

---

## Current state

- There is no self-service sign-up in the 3.0 stack. Accounts come from `users.create()` (`packages/users/src/actions.ts:642-745`): it validates email (≤ 64) and login (≤ 32), checks uniqueness, grants `authz.rbac.defaultRoles` (or the given roles) at GLOBAL through `AuthzAdmin` with a dry run first, inserts the row with `IsActive: false` and `RegisteredAt` now, takes a **plain** password through `PasswordService.set` (or marks an invite), runs the `users.actions.create.*` middleware and emits `UserCreated`.
- `authz.rbac.defaultRoles` is checked at boot by `DefaultRolesBootCheck` (`packages/users/src/default-roles-check.ts:19-53`); `defaultRoles()` and `assignGlobalRoles()` live in `packages/users/src/role-assignments.ts:23-88`.
- `UserIdentityStore` has no `provision` (`packages/users/src/identity/identity-store.ts:14`, pinned by `packages/users/test/identity-store.test.ts:33-36`). `DefaultAuthnService` calls `provision` only when `authn.linking.jit` and the provider's own `jit` switch are on (`packages/authn/src/service/default-authn-service.ts:511-513`), after linking by verified email was tried (`:506-510`).
- `docs/auth-feat/README.md` fixes `RegistrationInput`, `RegistrationOutcome`, `IdentityRegistrar` (owner: this plan) in `packages/authn/src/contracts/identity.ts`.

## Consumed from other plans (exact names)

- **Plan 06** (`06-email-phone-verification.md`): `normalizeAddress(channel, raw)`, `AddressStore`, `CodePurpose`, `CodeMessage`, `VerificationService` with `request(target, ctx)`, `send(identity, address, purpose, opts?: { linkBase?, ttlSeconds?, locale? })`, `redeem(address, code, purpose, ctx): Promise<{ status: 'verified'; identity } | { status: 'invalid' }>`; fakes `MemoryAddressStore` (`set(identity, channel, raw, verifiedAt?)`, `marked`) and `RecordingCodeSender` (`sent`, `codeFor(to, purpose)`, `clear()`); messages `E_CODE_INVALID` (4004001) and `E_INVALID_ADDRESS` (4004003); throttle flow `verify`; helpers `infoResponse(code)`, `refusalResponse(status, code, message, context?, headers?, cookies?)`, `throttledResponse(retryAfterSeconds)` in `packages/authn-http/src/v3/responses.ts`; `authn.verification.requiredForLogin`.
- **Plan 05** (`05-captcha.md`, "Integration for plans 06, 07 and 08"): `captchaRefusal(this.Container, req, 'register', email)` from `packages/authn-http/src/v3/captcha.ts`, called once, after the bounds checks and before any lookup; it answers plan 05's 400 itself. `CaptchaFlow` already holds `'register'`.
- **Plan 03** (`03-message-ids.md`, "How a consumer plan adds messages"): `AuthnMessageDefinition`, `authnMessage(code, context?)`, `passwordViolationMessages(violations, policy)`, `PARTS`/`DEFINITIONS` in `catalogue.ts`, `PINNED` in `test/messages/catalogue.test.ts`, the docs golden; `errorBody(code, message, context?)` and `notFound(code, message)` in `packages/authn-http/src/policies/v3/errors.ts`; core codes `throttled` (4000018), `already_authenticated` (4000005), `not_found` (4000011).
- **Plan 02** (`02-password-breach-and-similarity.md`): `PasswordCheckContext { identifiers }`, `LocalPasswordPolicy.check(password, context?)` and `PasswordService.check(password, context?)`; violations `breached` and `similar`, mapped by `PASSWORD_VIOLATION_CODES`.

## Decisions (confirm before Task 1)

1. **The orchestrator lives in `authn-local` (`LocalRegistrationService`), behind a core contract `RegistrationService`.** The README's `RegistrationInput.passwordHash` is hashed before the registrar sees it, and only `authn-local` has a hasher (`PasswordHasher`, `packages/authn-local/src/hasher.ts:33`), the password policy and the deferred-work helper. The core cannot import `authn-local`, and a second `PasswordHasher` class in contracts would clash with authn-local's by DI name. `authn-http` resolves the contract, so it never imports `authn-local`.
2. **Enumeration safety.** Before answering, every request does the same work whether or not the email is known: bounds and shape checks, CAPTCHA (route), the `register` throttle, domain and method checks, the password policy (with identifiers), `beforeRegister` hooks (which see the input only) and **one password hash**. Then it answers `accepted` and runs the rest as deferred work: `IdentityRegistrar.register`, the code, `afterRegister` hooks, audit. An existing email gets the same answer, no code, and the owner gets a notice mail (Decision 3). This is the `requestReset` technique (`packages/authn-local/src/service.ts:189-200`).
3. **The "someone tried to sign up with your address" notice is a `users` lifecycle mail (`users.email.registrationAttempt`), sent by `UserIdentityRegistrar.register` when the email exists.** Not `CodeSender`: `CodeMessage.code` is a code shown to the user (README), and the notice carries none; `users` owns lifecycle mails and queues them (`sendUserEmail`, no secret inside). A soft-deleted account (its email stays taken by the unique index) is told nothing. JIT provisioning uses `registerSilently`, which never mails.
4. **`loginAfter`: `'never' | 'when-verified' (default) | 'immediately'`.**
   - `when-verified`: the registration answer never carries a session; `POST /auth/registration/confirm` with the mailed code (purpose `register`) marks the email verified and issues the session.
   - `never`: confirm verifies only; the user logs in afterwards.
   - `immediately`: the account is created inline and a session issued at once, and the address gets a normal `verify` code (`VerificationService.request`). This answers differently for an existing email (no session), so it gives up enumeration safety; the docs say so. The schema refuses it together with `authn.verification.requiredForLogin: 'email'`.
   - Sessions are issued with facts `{ method: 'password' | 'code', strategy: 'registration', assurance: 'aal1' }` after asking `MfaPolicy`; if it requires steps, the session is pending and the answer is `{ MfaRequired }`.
5. **Codes:** purpose `register`, subject the address (plan 06 Decision 3), link `authn.registration.url` with the code in the fragment, TTL `authn.registration.ttlSeconds` (900). Redeemed through `VerificationService.redeem(…, 'register', …)`, which also marks the address verified.
6. **Throttle flow `register`:** the request counts `account` = `register:<normalized email>` (no mail-bombing one address) and `ip`; confirm counts `ip` only. Defaults `account { free: 2, baseDelayMs: 60000, maxDelayMs: 3600000 }`, `ip { free: 10, baseDelayMs: 10000, maxDelayMs: 900000 }`. `succeed` is never called (time clears it).
7. **CAPTCHA** is applied by the route through plan 05's `captchaRefusal(…, 'register', email)`; the service does not know about it. Without a registered `CaptchaGate`, it is off.
8. **Input:** `email` always; `password` (method `password`) or none (method `code`, passwordless) per `authn.registration.methods` (default `['password']`); `login` only with `fields.login` (default false) and matching `^[\p{L}\p{N}._-]{3,32}$` (no `@`, so the field cannot probe emails); `name` only with `fields.name`. A taken login answers `E_LOGIN_TAKEN`: this enumerates logins (public display names), not emails, as Kratos does with username identifiers; documented. `users` has no name column: the name seeds the derived login. An email longer than 64 characters (the `users.Email` column) is refused up front as invalid, so no accepted request fails silently later.
9. **Domains:** `blockedDomains` refuses a domain or any subdomain of it; a non-empty `allowedDomains` admits only those (and subdomains). Lower-case entries, checked by a schema pattern. The answer (`E_REGISTRATION_DOMAIN`) says nothing about accounts.
10. **`users` registrar:** `IsActive` from `users.registration.active` (code default `true`; `false` makes sign-up moderated: an admin activates). `RegisteredAt` now. Roles: `authz.rbac.defaultRoles` only (dry run, then grant), exactly as `create()` without roles. The `users.actions.create.*` middleware runs and `UserCreated` is emitted, so 2.x subscribers see sign-ups. The hash is written with `UserPasswordStore.set` and `PasswordSetAt` stamped. A parallel registration of the same email that loses the unique index answers `created: false`.
11. **JIT:** `UserIdentityStore.provision(external)` registers a new account through the registrar (no notice), named from the `name` claim, without password. It never returns an existing account: an email that exists throws `UserAlreadyExists`, so the login fails with the A02 answer (audit reason `store_error`, `data.error: 'UserAlreadyExists'`) instead of taking the account over by an unverified email. No email → `InvalidArgument`. It stays behind `authn.linking.jit` and the provider switch. Plan 06 marks the email verified on that login when the provider vouches for it.
12. **Hooks:** `RegistrationHook` (registered with `Array.ofType`, like `ExternalLoginHook`): `beforeRegister(input)` may throw to refuse (answer `E_REGISTRATION_REFUSED`, for new and existing emails alike); `afterRegister(identity, input)` runs after creation and a throw is only logged. Plan 10 webhooks listen to the audit event `registration` instead.
13. **Audit `registration`:** success `{ identity, data: { method, step: 'register' } }` and `{ identity, data: { step: 'confirm' } }`; failure reasons `exists` (with the existing identity), `vetoed`, `invalid_code`. Never the email or the password.
14. **Messages (1005000–1005999 / 4005000–4005999)**, keys are the wire `error` codes (plan 03):

    | Code | ID | Type | Text |
    |---|---|---|---|
    | `registration_accepted` | 1005001 | info | Check your email to finish signing up. |
    | `registration_confirmed` | 1005002 | info | Your account is ready. |
    | `E_REGISTRATION_DOMAIN` | 4005001 | error | Sign-up with this email domain is not available. |
    | `E_REGISTRATION_METHOD` | 4005002 | error | This sign-up method is not available. |
    | `E_REGISTRATION_PASSWORD` | 4005003 | error | Choose a different password. |
    | `E_LOGIN_INVALID` | 4005004 | error | Choose a login of 3 to 32 letters, digits, dots, dashes or underscores. |
    | `E_LOGIN_TAKEN` | 4005005 | error | This login is not available. |
    | `E_REGISTRATION_REFUSED` | 4005006 | error | Sign-up was refused. |
    | `E_REGISTRATION_INPUT` | 4005007 | error | A field of the form is malformed. |

    Reused: plan 06's `E_INVALID_ADDRESS` (invalid email) and `E_CODE_INVALID` (confirm), plan 03's `throttled` and `already_authenticated` (a caller with a session), plan 05's CAPTCHA answer. A password refusal carries `E_REGISTRATION_PASSWORD` followed by `passwordViolationMessages(violations, policy)`.

## Security notes

- Off by default (`authn.registration.enabled: false`): the routes answer 404 until an app turns them on and a `RegistrationService` and `IdentityRegistrar` are registered.
- No answer and no timing difference tells a known email from a new one (`when-verified`, `never`); rule A34 pins status equality, the absence of a code, the owner notice and equal timing.
- New accounts get only `authz.rbac.defaultRoles`; the request cannot name roles.
- A code is 6 digits, single use, 5 guesses, 15 minutes, keyed-hashed (plan 06); confirm is throttled per IP.
- JIT never hands out an existing account; linking an existing account stays the job of `byVerifiedEmail` with a provider-verified email.
- `immediately` trades enumeration safety for convenience and cannot be combined with a verified-email login requirement.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `packages/authn/src/contracts/identity.ts` | modify | README contract: `RegistrationInput`, `RegistrationOutcome`, `IdentityRegistrar` |
| `packages/authn/src/contracts/registration.ts` | create | `RegistrationService`, request/result types, `RegistrationHook`, `REGISTRATION_STRATEGY` |
| `packages/authn/src/contracts/audit.ts`, `throttle.ts`, `index.ts` | modify | `registration` event, flow `register`, exports |
| `packages/authn/src/schemas/authn.configuration.ts`, `src/throttle/memory-throttle.ts`, `src/config/authn.ts` | modify | `authn.registration`, root rule, throttle `register` |
| `packages/authn/src/messages/registration.ts`, `messages/catalogue.ts` | create/modify | messages 1005xxx/4005xxx |
| `packages/authn-testing/src/fakes/registration.ts`, `behaviour/A34-registration.spec.ts`, `harness/ports.ts`, `behaviour/types.ts`, `behaviour/index.ts` | create/modify | `FakeIdentityRegistrar`, `FakeVerificationService`, rule A34 |
| `packages/users/src/actions.ts`, `src/identity/registrar.ts`, `src/identity/identity-store.ts`, `src/identity/index.ts`, `src/config/users.ts`, `src/templates/user-registration-attempt-template.pug` | modify/create | `registerUser`, `UserIdentityRegistrar`, `provision`, notice |
| `packages/authn-local/src/registration.ts`, `src/index.ts` | create/modify | `LocalRegistrationService` |
| `packages/authn-http/src/v3/controllers/AuthnRegistrationController.ts`, `src/policies/v3/groups.ts`, `src/v3/index.ts` | create/modify | routes, `RegistrationEnabled` |
| `docs/authn/README.md` | modify | "Registration" section, config rows |

## Task order

```
1 contracts → 2 throttle + schema + messages → 3 authn-testing (fakes, A34)
→ 4 users registrar → 5 users provision → 6 authn-local service → 7 HTTP
```

## Facts verified (2026-10-06, working copy of `authz-v3-refactor`, plus sibling plan texts)

- `IdentityStore`/`PasswordCredentialStore`: `packages/authn/src/contracts/identity.ts:12-33`; plan 06 appends `AddressStore` there and pins `['IdentityStore', 'PasswordCredentialStore', 'AddressStore']` in `packages/authn/test/contracts/identity.test.ts:144`.
- `AuthnEventType` `packages/authn/src/contracts/audit.ts:21` (plans 04–06 append members), pinned in `packages/authn/test/contracts/audit.test.ts:23,155`.
- `ThrottleFlow`, `ThrottleParams`, `THROTTLE_FLOWS`, `DEFAULT_THROTTLE_PARAMS`: `packages/authn/src/contracts/throttle.ts:9,35-57` (working copy; plan 06 adds `verify`, plan 08 adds `code`); memory tables literal `packages/authn/src/throttle/memory-throttle.ts:89`; throttle schema `packages/authn/src/schemas/authn.configuration.ts:237-251`; shipped `packages/authn/src/config/authn.ts:16-23`; pins `packages/authn/test/contracts/throttle.test.ts:172-176`, `test/contracts/config-schema.test.ts:63-71,271`, `test/boot/config-defaults.test.ts:75`, `packages/authn-orm/test/throttle-config.test.ts:22`.
- `DefaultAuthnService.linked()` and the JIT gate: `default-authn-service.ts:501-515`; `ExternalLoginHook` chain `:449-458`; `errorClass` `:97`.
- `SessionIssuer.issue(identity, facts, opts?: { pending?: { steps } })` `packages/authn/src/contracts/session.ts:17`; `MfaPolicy.required(id, { method, strategy })` `packages/authn/src/contracts/mfa.ts:30`; `AuthnFacts` `packages/authn/src/contracts/principal.ts`.
- authn-local: `LocalPasswordService` Deps pattern and DI fallbacks `packages/authn-local/src/service.ts:33-56,370-440`; `requestReset` deferral `:189-200`; `DeferredWork` `src/deferred.ts`; `publishAuthnEvent(sinks, event, log)` and `AuditLog` `src/audit.ts`; `PasswordHasher` / `Argon2PasswordHasher` `src/hasher.ts:33,58-90`; `LocalPasswordPolicy` `src/policy.ts:75-125`; test setup `test/service.test.ts:52-85`; kit run `test/kit.test.ts`.
- users: `create()` `packages/users/src/actions.ts:642-745` (private helpers `runCreateMiddleware` `:438`, `discardInsertedUser` `:603`, `assertUserUnique` `:567`); imports of `insertModel`, `recordPasswordSetAt`, `UserPasswordStore`, `userRef`, `DEFAULT_ROLES_KEY`, `defaultRoles`, `assignGlobalRoles` at `:1-29`; `UserAlreadyExists` `packages/users/src/exceptions.ts:45`; `usersMatchingLogin` `src/identity/sql.ts:36-52`; `isReservedLogin` `src/models/User.ts:254`; `users.Email` varchar(64) unique, `Login` unique (`src/migrations/RBACInitial_2022_06_28_01_13_00.ts:10-13,31`); `sendUserEmail` `src/actions.ts:162` (plan 06 widens its template union and adds `to`); email templates `src/config/users.ts:49-108`, `src/templates/*.pug`; test helpers `bootUsersDb`, `registerUsersTestHost`, `seedUser` (`test/support/users-db.ts`), `globalRolesOf` (`test/support/authz-host.ts`), test config grants `authz.rbac.defaultRoles: ['user']` (`test/create.test.ts:80-85`).
- authn-http 3.0: `answerFor`, `bodyField`, `boundedString`, `contextOf`, `stampClient` (`packages/authn-http/src/v3/routes.ts:25-103`); `NO_STORE`, `authnSessionCookie` (`src/v3/responses.ts:17,35`); principal from a session through `PrincipalFactory` (`src/v3/controllers/AuthnActiveRoleController.ts:66-71`); `PASSWORD_HARD_CAP` (`src/policies/v3/fresh-auth.ts`); group policy pattern (`src/policies/v3/groups.ts`); v3-app wiring `test/v3-app/app.ts:128-145`, route table `test/v3-app/suites/route-table.ts:26-40`, suites `test/v3-app/account.test.ts`.
- Plan 05's `captchaRefusal` signature (`05-captcha.md:2676`); plan 03's `errorBody` (`03-message-ids.md:829`), catalogue `PARTS` (`:456`); plan 02's `check(password, context?)` (`02-password-breach-and-similarity.md:116-118`).

---

### Task 1: Registration contracts

**Files:**
- Modify: `packages/authn/src/contracts/identity.ts` (append after plan 06's `AddressStore`)
- Create: `packages/authn/src/contracts/registration.ts`
- Modify: `packages/authn/src/contracts/audit.ts:21`, `packages/authn/src/contracts/index.ts`
- Test: create `packages/authn/test/contracts/registration.test.ts`; modify `test/contracts/identity.test.ts:144`, `test/contracts/audit.test.ts:23`, `test/contracts/boundary.test.ts:18`

**Interfaces:**
- Consumes: `IdentityRef`, `AuthnContext`, `PasswordViolation`, `SessionHandle`.
- Produces (from `@spinajs/authn/contracts`): `RegistrationInput`, `RegistrationOutcome`, `IdentityRegistrar.register(input)` (README, verbatim); `REGISTRATION_STRATEGY = 'registration'`; `RegistrationRequest { email; password?; login?; name?; locale? }`; `RegistrationRefusal`; `RegistrationResult = { status: 'accepted'; session?; mfaRequired? } | RegistrationRefusal`; `RegistrationConfirmResult`; abstract `RegistrationService.register(request, ctx)`, `.confirm(email, code, ctx)`; `RegistrationHookInput { email; login?; name?; ip? }`; `RegistrationHook.beforeRegister(input)`, `.afterRegister(identity, input)` (no-op defaults); `AuthnEventType` gains `'registration'`.

- [ ] **Step 1: Write the failing tests**

Create `packages/authn/test/contracts/registration.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import * as index from '../../src/contracts/index.js';
import { IdentityRegistrar } from '../../src/contracts/identity.js';
import type { RegistrationInput, RegistrationOutcome } from '../../src/contracts/identity.js';
import { REGISTRATION_STRATEGY, RegistrationHook, RegistrationService } from '../../src/contracts/registration.js';
import type { RegistrationConfirmResult, RegistrationRefusal, RegistrationRequest, RegistrationResult } from '../../src/contracts/registration.js';
import type { IdentityRef } from '../../src/contracts/credentials.js';
import type { PasswordViolation } from '../../src/contracts/password.js';
import type { SessionHandle } from '../../src/contracts/session.js';
import { classMembers, same } from './source-shape.js';

const expect = chai.expect;

describe('registration contracts', () => {
  it('are exported from the contracts index', () => {
    for (const name of ['IdentityRegistrar', 'RegistrationService', 'RegistrationHook', 'REGISTRATION_STRATEGY']) expect(index, name).to.have.property(name);
    expect(REGISTRATION_STRATEGY).to.eq('registration');
  });

  it('keep the README shapes of the registrar', () => {
    same<RegistrationInput, { readonly email: string; readonly login?: string; readonly name?: string; readonly passwordHash?: string; readonly locale?: string }>(true);
    same<RegistrationOutcome, { readonly created: true; readonly identity: IdentityRef } | { readonly created: false; readonly existing: IdentityRef }>(true);
    same<Parameters<IdentityRegistrar['register']>, [RegistrationInput]>(true);
  });

  it('RegistrationService answers the documented results', () => {
    same<RegistrationRequest, { readonly email: string; readonly password?: string; readonly login?: string; readonly name?: string; readonly locale?: string }>(true);
    same<
      RegistrationRefusal,
      | { readonly status: 'throttled'; readonly retryAfterSeconds: number }
      | { readonly status: 'invalid_email' }
      | { readonly status: 'domain' }
      | { readonly status: 'method' }
      | { readonly status: 'invalid_login' }
      | { readonly status: 'password'; readonly violations: readonly PasswordViolation[] }
      | { readonly status: 'login_taken' }
      | { readonly status: 'vetoed' }
    >(true);
    same<RegistrationResult, { readonly status: 'accepted'; readonly session?: SessionHandle; readonly mfaRequired?: readonly string[] } | RegistrationRefusal>(true);
    same<RegistrationConfirmResult, { readonly status: 'confirmed'; readonly identity: IdentityRef; readonly session?: SessionHandle; readonly mfaRequired?: readonly string[] } | { readonly status: 'invalid' } | { readonly status: 'throttled'; readonly retryAfterSeconds: number }>(true);
  });

  it('declares the members in source', () => {
    expect(Object.keys(classMembers('registration.ts'))).to.deep.eq(['RegistrationService', 'RegistrationHook']);
    expect(classMembers('registration.ts').RegistrationService.members.map((m) => m.name)).to.deep.eq(['register', 'confirm']);
    expect(classMembers('registration.ts').RegistrationHook.members.map((m) => m.name)).to.deep.eq(['beforeRegister', 'afterRegister']);
  });

  it('a hook overrides only what it needs: the defaults do nothing', async () => {
    class OnlyAfter extends RegistrationHook {}
    await new OnlyAfter().beforeRegister({ email: 'a@b.c' });
    await new OnlyAfter().afterRegister({ type: 'user', id: 'u' }, { email: 'a@b.c' });
    expect(RegistrationService).to.be.a('function');
  });
});
```

`packages/authn/test/contracts/identity.test.ts:144` (as plan 06 left it): the class list becomes `['IdentityStore', 'PasswordCredentialStore', 'AddressStore', 'IdentityRegistrar']`, and add after the `AddressStore` shape:

```ts
      expect(c.IdentityRegistrar.base).to.eq(null);
      expect(shape(c.IdentityRegistrar.members)).to.deep.eq([{ name: 'register', modifiers: ['abstract'], optional: false, params: ['input'] }]);
```

`packages/authn/test/contracts/audit.test.ts:23`: append `'registration'` at the end of `EVENT_TYPES`.

`packages/authn/test/contracts/boundary.test.ts:18`: append `'IdentityRegistrar', 'RegistrationService', 'RegistrationHook', 'REGISTRATION_STRATEGY'` to `RUNTIME_EXPORTS`.

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/registration.test.ts test/contracts/identity.test.ts test/contracts/audit.test.ts`
Expected: FAIL at compile time: `Cannot find module '../../src/contracts/registration.js'`, `Module '"../../src/contracts/identity.js"' has no exported member 'IdentityRegistrar'`.

- [ ] **Step 3: Implement**

Append to `packages/authn/src/contracts/identity.ts` (README block, verbatim):

```ts

export interface RegistrationInput {
  readonly email: string;
  readonly login?: string;
  readonly name?: string;
  /** Already hashed by the password strategy; absent for passwordless sign-up. */
  readonly passwordHash?: string;
  readonly locale?: string;
}

export type RegistrationOutcome = { readonly created: true; readonly identity: IdentityRef } | { readonly created: false; readonly existing: IdentityRef };

export abstract class IdentityRegistrar {
  abstract register(input: RegistrationInput): Promise<RegistrationOutcome>;
}
```

Create `packages/authn/src/contracts/registration.ts`:

```ts
import type { AuthnContext, IdentityRef } from './credentials.js';
import type { PasswordViolation } from './password.js';
import type { SessionHandle } from './session.js';

/** `facts.strategy` of a session that registration issues. */
export const REGISTRATION_STRATEGY = 'registration';

export interface RegistrationRequest {
  readonly email: string;
  /** Absent: passwordless sign-up (method 'code'). */
  readonly password?: string;
  readonly login?: string;
  readonly name?: string;
  readonly locale?: string;
}

/** None of these depends on whether the email has an account. */
export type RegistrationRefusal =
  | { readonly status: 'throttled'; readonly retryAfterSeconds: number }
  | { readonly status: 'invalid_email' }
  | { readonly status: 'domain' }
  | { readonly status: 'method' }
  | { readonly status: 'invalid_login' }
  | { readonly status: 'password'; readonly violations: readonly PasswordViolation[] }
  | { readonly status: 'login_taken' }
  | { readonly status: 'vetoed' };

/** `session` only with authn.registration.loginAfter 'immediately'; pending, with `mfaRequired`, when the MFA policy asks for steps. */
export type RegistrationResult = { readonly status: 'accepted'; readonly session?: SessionHandle; readonly mfaRequired?: readonly string[] } | RegistrationRefusal;

export type RegistrationConfirmResult =
  | { readonly status: 'confirmed'; readonly identity: IdentityRef; readonly session?: SessionHandle; readonly mfaRequired?: readonly string[] }
  | { readonly status: 'invalid' }
  | { readonly status: 'throttled'; readonly retryAfterSeconds: number };

/** LocalRegistrationService in @spinajs/authn-local. */
export abstract class RegistrationService {
  /**
   * POST /auth/registration. Answers 'accepted' for a known email exactly as for a new one, after the same work (one
   * password hash included); the identity is created and the code sent afterwards, unless loginAfter is 'immediately'.
   */
  abstract register(request: RegistrationRequest, ctx: AuthnContext): Promise<RegistrationResult>;
  /** POST /auth/registration/confirm. Redeems the code of purpose 'register' and marks the email verified. */
  abstract confirm(email: string, code: string, ctx: AuthnContext): Promise<RegistrationConfirmResult>;
}

export interface RegistrationHookInput {
  /** Normalized. */
  readonly email: string;
  readonly login?: string;
  readonly name?: string;
  readonly ip?: string;
}

/** Registered with Array.ofType. Override what you need; both defaults do nothing. */
export abstract class RegistrationHook {
  /**
   * Runs for every request that passed the checks, before anything is stored and before the answer; a throw refuses the
   * sign-up. It sees the input only, so it cannot tell a new email from a known one.
   */
  public async beforeRegister(_input: RegistrationHookInput): Promise<void> {}
  /** Runs after a new identity was created, after the answer; a throw is logged and undoes nothing. */
  public async afterRegister(_identity: IdentityRef, _input: RegistrationHookInput): Promise<void> {}
}
```

`packages/authn/src/contracts/audit.ts:21`: append `| 'registration'` at the end of the `AuthnEventType` union (after whatever plans 04–06 appended).

Append to `packages/authn/src/contracts/index.ts`:

```ts
export * from './registration.js';
```

- [ ] **Step 4: GREEN + package suite + rebuild**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/registration.test.ts test/contracts/identity.test.ts test/contracts/audit.test.ts` — passing.
2. Rebuild (`npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`), then `npx ts-mocha -p tsconfig.json test/contracts/boundary.test.ts` and `npm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/authn/src/contracts/identity.ts packages/authn/src/contracts/registration.ts packages/authn/src/contracts/audit.ts packages/authn/src/contracts/index.ts packages/authn/test/contracts/registration.test.ts packages/authn/test/contracts/identity.test.ts packages/authn/test/contracts/audit.test.ts packages/authn/test/contracts/boundary.test.ts
git commit -m "feat(authn): IdentityRegistrar, RegistrationService and RegistrationHook contracts"
```

---

### Task 2: Throttle flow `register`, schema `authn.registration`, messages

**Files:**
- Modify: `packages/authn/src/contracts/throttle.ts` (`ThrottleFlow`, `ThrottleParams`, `THROTTLE_FLOWS`, `DEFAULT_THROTTLE_PARAMS`)
- Modify: `packages/authn/src/throttle/memory-throttle.ts:89`, `packages/authn/src/config/authn.ts` (throttle block)
- Modify: `packages/authn/src/schemas/authn.configuration.ts` (throttle `propertyNames` and `register`; `registration` block after plan 06's `verification`; a root `allOf`)
- Create: `packages/authn/src/messages/registration.ts`; modify `packages/authn/src/messages/catalogue.ts`, `docs/authn/messages.md` (regenerated)
- Test: `packages/authn/test/contracts/throttle.test.ts`, `test/contracts/config-schema.test.ts` (`THROTTLE_DEFAULTS`, line 271, a new test), `test/boot/config-defaults.test.ts:75`, `test/messages/catalogue.test.ts`, `packages/authn-orm/test/throttle-config.test.ts:22`

**Interfaces:**
- Produces: `ThrottleFlow` gains `'register'`; `DEFAULT_THROTTLE_PARAMS.register = { account: (2, 60000, 3600000), ip: (10, 10000, 900000) }`; config `authn.registration.{ enabled: false, methods: ['password'], loginAfter: 'when-verified', fields: { login: false, name: false }, blockedDomains: [], allowedDomains: [], url: '', ttlSeconds: 900 }`; violation path `authn.registration.loginAfter` for `immediately` with `verification.requiredForLogin: 'email'`; `REGISTRATION_MESSAGES` (Decision 14).

- [ ] **Step 1: Schema additions**

Throttle block: add `'register'` to `propertyNames.enum` and, after plan 06's `verify` line:

```ts
        register: flow({ free: 2, baseDelayMs: 60000, maxDelayMs: 3600000 }, { free: 10, baseDelayMs: 10000, maxDelayMs: 900000 }),
```

Above `AUTHN_CONFIGURATION_SCHEMA` add:

```ts
// A lower-case DNS name with at least one dot; IDNs in their xn-- form.
const DOMAIN = { type: 'string', pattern: '^(?=.{3,253}$)[a-z0-9-]+(\\.[a-z0-9-]+)+$' };
```

After plan 06's `verification` block:

```ts
    registration: {
      type: 'object',
      default: {},
      propertyNames: { enum: ['enabled', 'methods', 'loginAfter', 'fields', 'blockedDomains', 'allowedDomains', 'url', 'ttlSeconds'] },
      properties: {
        enabled: { type: 'boolean', default: false, description: 'POST /auth/registration; off: the routes answer 404.' },
        methods: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['password', 'code'] }, default: ['password'], description: "'code': sign-up without a password, confirmed by the mailed code." },
        loginAfter: { enum: ['never', 'when-verified', 'immediately'], default: 'when-verified', description: "'immediately' answers a known email differently (no session): it gives up enumeration safety." },
        fields: {
          type: 'object',
          default: {},
          propertyNames: { enum: ['login', 'name'] },
          properties: {
            login: { type: 'boolean', default: false, description: 'Accept a chosen login; a taken one is answered, which enumerates logins (not emails).' },
            name: { type: 'boolean', default: false },
          },
        },
        blockedDomains: { type: 'array', default: [], items: DOMAIN, description: 'Refused, with every subdomain (disposable mail services).' },
        allowedDomains: { type: 'array', default: [], items: DOMAIN, description: 'Not empty: only these domains and their subdomains may sign up.' },
        url: { type: 'string', default: '', description: 'App page the confirmation link opens; the code travels in its fragment.' },
        ttlSeconds: { type: 'integer', minimum: 60, maximum: 86400, default: 900 },
      },
    },
```

After the root `properties` object (the schema has no root `allOf` today) add:

```ts
  allOf: [
    // A session at sign-up would skip the verified-email login requirement.
    {
      if: { type: 'object', required: ['verification'], properties: { verification: { type: 'object', required: ['requiredForLogin'], properties: { requiredForLogin: { const: 'email' } } } } },
      then: { properties: { registration: { properties: { loginAfter: { not: { const: 'immediately' } } } } } },
    },
  ],
```

- [ ] **Step 2: Write the failing tests**

`packages/authn/test/contracts/throttle.test.ts`, the flow test (plan 06 made it "five flows"):

```ts
    it('ThrottleFlow is exactly the six flows', () => {
      same<ThrottleFlow, 'login' | 'mfa' | 'reset' | 'reauth' | 'verify' | 'register'>(true);
      // @ts-expect-error no signup flow
      const f: ThrottleFlow = 'signup';
      void f;
    });
```

(If plan 08 landed `'code'` first, keep it in the union and say "seven".)

`packages/authn/test/contracts/config-schema.test.ts`: add to `THROTTLE_DEFAULTS` after `verify`:

```ts
  register: { account: { free: 2, baseDelayMs: 60000, maxDelayMs: 3600000 }, ip: { free: 10, baseDelayMs: 10000, maxDelayMs: 900000 } },
```

in the expected object of line 271 add after plan 06's `verification: {…},`:

```ts
registration: { enabled: false, methods: ['password'], loginAfter: 'when-verified', fields: { login: false, name: false }, blockedDomains: [], allowedDomains: [], url: '', ttlSeconds: 900 },
```

and add:

```ts
    it('takes authn.registration within its bounds and refuses immediate sessions under requiredForLogin email', () => {
      expect(check({ registration: { enabled: true, methods: ['password', 'code'], loginAfter: 'never', fields: { login: true }, blockedDomains: ['mailinator.com'], allowedDomains: ['example.com'] } }).ok).to.eq(true);
      expect(check({ registration: { methods: [] } }).paths).to.include('/registration/methods');
      expect(check({ registration: { methods: ['sms'] } }).paths).to.include('/registration/methods/0');
      expect(check({ registration: { loginAfter: 'later' } }).paths).to.include('/registration/loginAfter');
      expect(check({ registration: { blockedDomains: ['Mailinator.COM'] } }).paths).to.include('/registration/blockedDomains/0');
      expect(check({ registration: { blockedDomains: ['localhost'] } }).paths).to.include('/registration/blockedDomains/0');
      expect(check({ registration: { loginAfter: 'immediately' } }).ok).to.eq(true);
      expect(check({ registration: { loginAfter: 'immediately' }, verification: { requiredForLogin: 'email' } }).paths).to.include('/registration/loginAfter');
    });
```

`packages/authn/test/boot/config-defaults.test.ts:75`: add `registration: check({}).config.registration` next to plan 06's `verification`.

`packages/authn/test/messages/catalogue.test.ts` (plan 03): append to `PINNED`, sorted by id:

```ts
  [1005001, 'registration_accepted', 'info'],
  [1005002, 'registration_confirmed', 'info'],
  [4005001, 'E_REGISTRATION_DOMAIN', 'error'],
  [4005002, 'E_REGISTRATION_METHOD', 'error'],
  [4005003, 'E_REGISTRATION_PASSWORD', 'error'],
  [4005004, 'E_LOGIN_INVALID', 'error'],
  [4005005, 'E_LOGIN_TAKEN', 'error'],
  [4005006, 'E_REGISTRATION_REFUSED', 'error'],
  [4005007, 'E_REGISTRATION_INPUT', 'error'],
```

and in `each part stays in its README range` (with `import { REGISTRATION_MESSAGES } from '../../src/messages/registration.js';`):

```ts
    for (const [code, d] of Object.entries(REGISTRATION_MESSAGES) as [string, AuthnMessageDefinition][]) {
      expect(within(d.id, 1005000, 1005999) || within(d.id, 4005000, 4005999), code).to.eq(true);
    }
```

`packages/authn-orm/test/throttle-config.test.ts:22`: append `'register'` to the expected `THROTTLE_FLOWS`.

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/throttle.test.ts test/contracts/config-schema.test.ts test/boot/config-defaults.test.ts test/messages/catalogue.test.ts`
Expected: FAIL: `throttle.test.ts` compile error on `'register'`; config deep-equal mismatches (no `register`, no `registration`); `Cannot find module '../../src/messages/registration.js'`.

- [ ] **Step 4: Implement**

`packages/authn/src/contracts/throttle.ts`: add `'register'` to `ThrottleFlow` (after `'verify'`), `readonly register: ThrottleFlowParams;` to `ThrottleParams`, `'register'` to `THROTTLE_FLOWS`, and to `DEFAULT_THROTTLE_PARAMS`:

```ts
  register: Object.freeze({ account: backoff(2, 60000, 3600000), ip: backoff(10, 10000, 900000) }),
```

`packages/authn/src/throttle/memory-throttle.ts:89`: add `register: table()` to the tables literal.

`packages/authn/src/config/authn.ts`, throttle block after `verify`:

```ts
      register: { account: { free: 2, baseDelayMs: 60000, maxDelayMs: 3600000 }, ip: { free: 10, baseDelayMs: 10000, maxDelayMs: 900000 } },
```

Create `packages/authn/src/messages/registration.ts`:

```ts
import type { AuthnMessageDefinition } from './types.js';

/** Plan 07 range: 1005000–1005999 (info) and 4005000–4005999 (user error). Keys are the wire `error` codes. */
export const REGISTRATION_MESSAGES = {
  registration_accepted: { id: 1005001, type: 'info', text: 'Check your email to finish signing up.' },
  registration_confirmed: { id: 1005002, type: 'info', text: 'Your account is ready.' },
  E_REGISTRATION_DOMAIN: { id: 4005001, type: 'error', text: 'Sign-up with this email domain is not available.' },
  E_REGISTRATION_METHOD: { id: 4005002, type: 'error', text: 'This sign-up method is not available.' },
  E_REGISTRATION_PASSWORD: { id: 4005003, type: 'error', text: 'Choose a different password.' },
  E_LOGIN_INVALID: { id: 4005004, type: 'error', text: 'Choose a login of 3 to 32 letters, digits, dots, dashes or underscores.' },
  E_LOGIN_TAKEN: { id: 4005005, type: 'error', text: 'This login is not available.' },
  E_REGISTRATION_REFUSED: { id: 4005006, type: 'error', text: 'Sign-up was refused.' },
  E_REGISTRATION_INPUT: { id: 4005007, type: 'error', text: 'A field of the form is malformed.' },
} as const satisfies Readonly<Record<string, AuthnMessageDefinition>>;
```

In `packages/authn/src/messages/catalogue.ts`: `import { REGISTRATION_MESSAGES } from './registration.js';`, append `REGISTRATION_MESSAGES` to `PARTS` and `...REGISTRATION_MESSAGES` to `DEFINITIONS` (after the parts already there). Regenerate the docs: `UPDATE_GOLDEN=1 npx ts-mocha -p tsconfig.json test/messages/doc.test.ts`.

- [ ] **Step 5: GREEN + package suite + dependants**

1. The four test files pass; `npx ts-mocha -p tsconfig.json test/messages/doc.test.ts` passes without `UPDATE_GOLDEN`.
2. `npm test` in `packages/authn`; rebuild; `cd ../authn-orm && npm test`; `cd ../authn-testing && npm test`.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/contracts/throttle.ts packages/authn/src/throttle/memory-throttle.ts packages/authn/src/config/authn.ts packages/authn/src/schemas/authn.configuration.ts packages/authn/src/messages/registration.ts packages/authn/src/messages/catalogue.ts docs/authn/messages.md packages/authn/test/contracts/throttle.test.ts packages/authn/test/contracts/config-schema.test.ts packages/authn/test/boot/config-defaults.test.ts packages/authn/test/messages/catalogue.test.ts packages/authn-orm/test/throttle-config.test.ts
git commit -m "feat(authn): authn.registration schema, throttle flow register, registration message ids"
```

---

### Task 3: authn-testing — registrar and verification fakes, rule A34

**Files:**
- Create: `packages/authn-testing/src/fakes/registration.ts`; modify `src/fakes/index.ts`
- Create: `packages/authn-testing/src/behaviour/A34-registration.spec.ts`
- Modify: `packages/authn-testing/src/behaviour/types.ts` (`RULE_IDS`, `portNames`), `src/harness/ports.ts` (`Harness`, `RegistrationPort`), `src/behaviour/index.ts` (`ALL`)
- Test: create `packages/authn-testing/test/registration-fakes.test.ts`; modify `test/registry.test.ts` (`FACET_MAP` and the `RULE_IDS` test)

The rule id appears in: the spec file (name, `defineRule`, case names, facet), `RULE_IDS`, `ALL`, `registry.test.ts`, and Task 6's `kit` run.

**Interfaces:**
- Consumes: Task 1 contracts; plan 06's `MemoryAddressStore`, `RecordingCodeSender`, `normalizeAddress`, `VerificationService`.
- Produces (from `@spinajs/authn-testing`):
  - `FakeIdentityRegistrar(identities: FakeIdentityStore, addresses: MemoryAddressStore)` with `created: RegistrationInput[]`, `notified: string[]` (normalized emails).
  - `FakeVerificationService(addresses: AddressStore, sender: RecordingCodeSender)` implementing all four members synchronously (no deferral), with `requests: VerificationTarget[]`.
  - Port `registration?: RegistrationPort` = `{ service: RegistrationService; drain(): Promise<void>; sent(): readonly CodeMessage[]; notified(): readonly string[]; existing(email: string): Promise<IdentityRef>; veto(on: boolean): void }`.
  - Rule `A34` (facet `A34/local`): the lane runs it with `authn.registration` `{ enabled: true, methods: ['password', 'code'], loginAfter: 'when-verified' }` and a throttle that never refuses.

- [ ] **Step 1: Write the failing tests**

Create `packages/authn-testing/test/registration-fakes.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';

import { FakeIdentityRegistrar, FakeIdentityStore, FakeVerificationService, MemoryAddressStore, RecordingCodeSender } from '../src/fakes/index.js';

describe('registration fakes', () => {
  it('FakeIdentityRegistrar creates once per normalized email and notes the second attempt', async () => {
    const identities = new FakeIdentityStore();
    const addresses = new MemoryAddressStore();
    const r = new FakeIdentityRegistrar(identities, addresses);
    const first = await r.register({ email: 'Alice@Example.test', passwordHash: 'h' });
    assert.strictEqual(first.created, true);
    const again = await r.register({ email: 'alice@example.test' });
    assert.deepStrictEqual(again, { created: false, existing: (first as { identity: unknown }).identity });
    assert.deepStrictEqual(r.notified, ['alice@example.test']);
    assert.strictEqual(r.created.length, 1);
  });

  it('FakeVerificationService sends a code and redeems it once for its purpose, marking the address', async () => {
    const addresses = new MemoryAddressStore();
    const sender = new RecordingCodeSender();
    const v = new FakeVerificationService(addresses, sender);
    const id = { type: 'user', id: 'u1' };
    addresses.set(id, 'email', 'u1@example.test');
    await v.send(id, { channel: 'email', value: 'U1@example.test' }, 'register', { ttlSeconds: 60 });
    const code = sender.codeFor('u1@example.test', 'register')!;
    const ctx = { now: new Date(1), purpose: 'request' as const };
    assert.deepStrictEqual(await v.redeem({ channel: 'email', value: 'u1@example.test' }, code, 'verify', ctx), { status: 'invalid' });
    assert.deepStrictEqual(await v.redeem({ channel: 'email', value: 'u1@example.test' }, code, 'register', ctx), { status: 'verified', identity: id });
    assert.deepStrictEqual(await v.redeem({ channel: 'email', value: 'u1@example.test' }, code, 'register', ctx), { status: 'invalid' });
    assert.strictEqual(addresses.marked.length, 1);
  });
});
```

`packages/authn-testing/test/registry.test.ts`: append `'A34/local'` to `FACET_MAP`; in the `RULE_IDS` test append `'A34'` to `expected` (after plan 06's id) and update the title.

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn-testing && npx ts-mocha -p tsconfig.json test/registration-fakes.test.ts test/registry.test.ts`
Expected: FAIL at compile time: `Module '"../src/fakes/index.js"' has no exported member 'FakeIdentityRegistrar'`.

- [ ] **Step 3: Implement**

Create `packages/authn-testing/src/fakes/registration.ts`:

```ts
import { randomInt } from 'node:crypto';
import { IdentityRegistrar, VerificationService, normalizeAddress } from '@spinajs/authn/contracts';
import type { AddressInput, AddressStore, AuthnContext, CodePurpose, CodeRedeemResult, CodeSendOptions, IdentityRef, RegistrationInput, RegistrationOutcome, VerificationConfirmResult, VerificationRequestResult, VerificationTarget } from '@spinajs/authn/contracts';

import type { FakeIdentityStore } from './identity.js';
import type { MemoryAddressStore } from './addresses.js';
import type { RecordingCodeSender } from './codes.js';

/** Creates kit identities with an unverified email address; a known email answers `created: false` and is noted. */
export class FakeIdentityRegistrar extends IdentityRegistrar {
  readonly created: RegistrationInput[] = [];
  /** Normalized emails whose owner a real registrar would tell about the attempt. */
  readonly notified: string[] = [];

  constructor(private readonly identities: FakeIdentityStore, private readonly addresses: MemoryAddressStore) {
    super();
  }

  async register(input: RegistrationInput): Promise<RegistrationOutcome> {
    const email = normalizeAddress('email', input.email);
    if (email === null) throw new RangeError('FakeIdentityRegistrar: not an email address');
    const existing = await this.addresses.findByAddress('email', email);
    if (existing) {
      this.notified.push(email);
      return { created: false, existing };
    }
    const identity = this.identities.add({ login: input.login ?? email, email: input.email, ...(input.name ? { name: input.name } : {}) });
    this.addresses.set(identity, 'email', input.email);
    this.created.push(input);
    return { created: true, identity };
  }
}

/** VerificationService over a code map: no throttle, no audit, no deferral. */
export class FakeVerificationService extends VerificationService {
  readonly requests: VerificationTarget[] = [];
  private readonly codes = new Map<string, string>();

  constructor(private readonly addresses: AddressStore, private readonly sender: RecordingCodeSender) {
    super();
  }

  async request(target: VerificationTarget, _ctx: AuthnContext): Promise<VerificationRequestResult> {
    this.requests.push(target);
    const channel = 'identity' in target ? target.channel : target.address.channel;
    const identity = 'identity' in target ? target.identity : await this.addresses.findByAddress(channel, normalizeAddress(channel, target.address.value) ?? '');
    if (!identity) return { status: 'accepted' };
    const own = (await this.addresses.addresses(identity)).find((a) => a.channel === channel);
    if (own && own.verifiedAt === null) await this.send(identity, { channel, value: own.value }, 'verify');
    return { status: 'accepted' };
  }

  async confirm(address: AddressInput, code: string, ctx: AuthnContext): Promise<VerificationConfirmResult> {
    return this.redeem(address, code, 'verify', ctx);
  }

  async send(identity: IdentityRef, address: AddressInput, purpose: CodePurpose, opts: CodeSendOptions = {}): Promise<void> {
    const value = normalizeAddress(address.channel, address.value);
    if (value === null) throw new RangeError('FakeVerificationService: not a valid address');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.codes.set(`${purpose}|${address.channel}:${value}`, code);
    await this.sender.send({ channel: address.channel, to: value, purpose, code, ttlSeconds: opts.ttlSeconds ?? 900, identity, ...(opts.linkBase ? { link: `${opts.linkBase}#code=${code}` } : {}), ...(opts.locale ? { locale: opts.locale } : {}) });
  }

  async redeem(address: AddressInput, code: string, purpose: CodePurpose, ctx: AuthnContext): Promise<CodeRedeemResult> {
    const value = normalizeAddress(address.channel, address.value);
    const key = `${purpose}|${address.channel}:${value}`;
    if (value === null || this.codes.get(key) !== code) return { status: 'invalid' };
    this.codes.delete(key);
    const identity = await this.addresses.findByAddress(address.channel, value);
    if (!identity || !(await this.addresses.markVerified(identity, address.channel, value, ctx.now))) return { status: 'invalid' };
    return { status: 'verified', identity };
  }
}
```

Append to `packages/authn-testing/src/fakes/index.ts`:

```ts
export * from './registration.js';
```

`packages/authn-testing/src/harness/ports.ts`: add `CodeMessage, RegistrationService` to the contracts type import, `readonly registration?: RegistrationPort;` to `Harness` (after plan 06's `codeStorage`), and:

```ts
export interface RegistrationPort {
  readonly service: RegistrationService;
  /** Waits for the work the service does after answering. */
  drain(): Promise<void>;
  /** Code messages sent so far. */
  sent(): readonly CodeMessage[];
  /** Normalized emails whose owner the registrar told about another sign-up. */
  notified(): readonly string[];
  /** An identity holding `email`, as an earlier sign-up leaves it. */
  existing(email: string): Promise<IdentityRef>;
  /** On: every registration hook refuses. */
  veto(on: boolean): void;
}
```

`packages/authn-testing/src/behaviour/types.ts`: append `'A34'` to `RULE_IDS`; add `registration: 1,` to `portNames`.

Create `packages/authn-testing/src/behaviour/A34-registration.spec.ts`:

```ts
import assert from 'node:assert/strict';

import { assertSameTiming, repeat } from '../helpers/index.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule } from './types.js';

const PASSWORD = 'Sign-Up-Pass-9';
const KNOWN = 'known@example.test';
let fresh = 0;
const newEmail = () => `new-${++fresh}-${Date.now()}@example.test`;

export const A34: AuthnRule = defineRule('A34', 'self-service registration does not tell whether an email has an account', [
  defineCase({
    name: 'A34 a known email gets the same answer as a new one',
    facet: 'A34/local',
    needs: ['registration'],
    async run(h, k) {
      await h.registration.existing(KNOWN);
      const known = await h.registration.service.register({ email: KNOWN, password: PASSWORD }, k.ctx());
      const unknown = await h.registration.service.register({ email: newEmail(), password: PASSWORD }, k.ctx());
      assert.deepStrictEqual({ ...known }, { status: 'accepted' });
      assert.deepStrictEqual({ ...unknown }, { ...known });
    },
  }),
  defineCase({
    name: 'A34 a new email gets a register code; a known one gets none and its owner is told',
    facet: 'A34/local',
    needs: ['registration'],
    async run(h, k) {
      await h.registration.existing(KNOWN);
      const email = newEmail();
      await h.registration.service.register({ email, password: PASSWORD }, k.ctx());
      await h.registration.service.register({ email: KNOWN, password: PASSWORD }, k.ctx());
      await h.registration.drain();
      const sent = h.registration.sent();
      assert.deepStrictEqual(sent.map((m) => [m.to, m.purpose]), [[email, 'register']]);
      assert.deepStrictEqual([...h.registration.notified()], [KNOWN]);
    },
  }),
  defineCase({
    name: 'A34 the answer takes the same time for a known and a new email',
    facet: 'A34/local',
    needs: ['registration'],
    timeoutMs: 600_000,
    async run(h, k) {
      await h.registration.existing(KNOWN);
      await assertSameTiming(
        repeat(() => h.registration.service.register({ email: KNOWN, password: PASSWORD }, k.ctx())),
        repeat(() => h.registration.service.register({ email: newEmail(), password: PASSWORD }, k.ctx())),
      );
    },
  }),
  defineCase({
    name: 'A34 the register code confirms the new account once',
    facet: 'A34/local',
    needs: ['registration'],
    async run(h, k) {
      const email = newEmail();
      await h.registration.service.register({ email }, k.ctx());
      await h.registration.drain();
      const code = h.registration.sent().find((m) => m.to === email && m.purpose === 'register')!.code;
      const confirmed = await h.registration.service.confirm(email, code, k.ctx());
      assert.strictEqual(confirmed.status, 'confirmed');
      assert.deepStrictEqual({ ...(await h.registration.service.confirm(email, code, k.ctx())) }, { status: 'invalid' });
    },
  }),
  defineCase({
    name: 'A34 a refusing hook answers vetoed for a known and a new email alike',
    facet: 'A34/local',
    needs: ['registration'],
    async run(h, k) {
      await h.registration.existing(KNOWN);
      h.registration.veto(true);
      assert.deepStrictEqual({ ...(await h.registration.service.register({ email: KNOWN, password: PASSWORD }, k.ctx())) }, { status: 'vetoed' });
      assert.deepStrictEqual({ ...(await h.registration.service.register({ email: newEmail(), password: PASSWORD }, k.ctx())) }, { status: 'vetoed' });
    },
  }),
]);
```

`packages/authn-testing/src/behaviour/index.ts`: `import { A34 } from './A34-registration.spec.js';` and append `A34` to `ALL`.

- [ ] **Step 4: GREEN + package suite + rebuild**

1. `cd packages/authn-testing && npx ts-mocha -p tsconfig.json test/registration-fakes.test.ts test/registry.test.ts` — passing.
2. `npm test` in `packages/authn-testing`; rebuild (`npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`).

- [ ] **Step 5: Commit**

```bash
git add packages/authn-testing/src/fakes/registration.ts packages/authn-testing/src/fakes/index.ts packages/authn-testing/src/behaviour/A34-registration.spec.ts packages/authn-testing/src/behaviour/types.ts packages/authn-testing/src/behaviour/index.ts packages/authn-testing/src/harness/ports.ts packages/authn-testing/test/registration-fakes.test.ts packages/authn-testing/test/registry.test.ts
git commit -m "test(authn-testing): rule A34 for enumeration-safe registration, registrar and verification fakes"
```

---

### Task 4: `users` — `registerUser` and `UserIdentityRegistrar`

**Files:**
- Modify: `packages/users/src/actions.ts` (new `registerUser` after `createUser`, line 745; `'registrationAttempt'` in the `sendUserEmail` template union)
- Create: `packages/users/src/identity/registrar.ts`; modify `packages/users/src/identity/index.ts`
- Modify: `packages/users/src/config/users.ts` (`users.email.registrationAttempt`)
- Create: `packages/users/src/templates/user-registration-attempt-template.pug`
- Test: create `packages/users/test/registrar.test.ts`

**Interfaces:**
- Consumes: `IdentityRegistrar`, `RegistrationInput` (Task 1); plan 06's `normalizeAddress`, `UserAddressStore`.
- Produces: `registerUser(data: IRegisterUserData): Promise<User>` with `IRegisterUserData { Email: string; Login: string; PasswordHash?: string; IsActive: boolean }`; `REGISTRATION_ACTIVE_KEY = 'users.registration.active'`; `@Injectable(IdentityRegistrar) UserIdentityRegistrar` with `register(input)` (notifies an existing owner) and `registerSilently(input)` (never mails).

- [ ] **Step 1: Write the failing test**

Create `packages/users/test/registrar.test.ts`:

```ts
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { IdentityRegistrar, PasswordCredentialStore } from '@spinajs/authn/contracts';

import { User, UserAddressStore, UserIdentityRegistrar } from '../src/index.js';
import './migration/rbac.migration.js';
import { globalRolesOf } from './support/authz-host.js';
import { bootUsersDb, registerUsersTestHost, seedUser, setIdentityFlags, storedUser } from './support/users-db.js';

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaA';

describe('UserIdentityRegistrar', function () {
  this.timeout(30000);

  let emitted: unknown[];
  let registrar: UserIdentityRegistrar;

  before(() => registerUsersTestHost());

  beforeEach(async () => {
    await bootUsersDb((config: Configuration) => config.set('email.defaultConnection', 'rbac-email-connection'));
    emitted = [];
    sinon.stub(DefaultQueueService.prototype, 'emit').callsFake(async (e: unknown) => {
      emitted.push(e);
    });
    registrar = new UserIdentityRegistrar();
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  const notices = () => JSON.stringify(emitted).split('rbac-user-registrationAttempt').length - 1;

  it('is the registered IdentityRegistrar', async () => {
    expect(await DI.resolve(IdentityRegistrar)).to.be.instanceOf(UserIdentityRegistrar);
  });

  it('creates an active user with the default roles, the stored hash and an unverified email', async () => {
    const outcome = await registrar.register({ email: ' New.One@Example.test ', passwordHash: HASH });
    expect(outcome.created).to.eq(true);
    const ref = (outcome as { identity: { type: string; id: string } }).identity;
    const u = await storedUser(ref.id);
    expect(u).to.include({ Email: 'New.One@Example.test', IsActive: true });
    expect(u.Login).to.eq('new.one', 'derived from the normalized local part');
    expect(u.RegisteredAt).to.be.ok;
    expect(u.PasswordSetAt).to.be.ok;
    expect(await globalRolesOf(u.Uuid)).to.deep.eq(['user']);
    expect(await (await DI.resolve(PasswordCredentialStore)).get(ref)).to.eq(HASH);
    expect(await new UserAddressStore().addresses(ref)).to.deep.eq([{ channel: 'email', value: 'new.one@example.test', verifiedAt: null }]);
    expect(JSON.stringify(emitted)).to.contain('UserCreated');
  });

  it('creates a passwordless user and takes the given login', async () => {
    const outcome = await registrar.register({ email: 'nopass@example.test', login: 'chosen-login' });
    const u = await storedUser((outcome as { identity: { id: string } }).identity.id);
    expect(u.Login).to.eq('chosen-login');
    expect(await (await DI.resolve(PasswordCredentialStore)).get({ type: 'user', id: u.Uuid })).to.eq(null);
  });

  it('derives a free login from the name or the local part', async () => {
    await seedUser({ login: 'taken', email: 'someone@example.test' });
    const a = await registrar.register({ email: 'taken@example.test' });
    const b = await registrar.register({ email: 'b@example.test', name: 'Ada Lovelace' });
    expect((await storedUser((a as { identity: { id: string } }).identity.id)).Login).to.match(/^taken-[0-9a-f]{6}$/);
    expect((await storedUser((b as { identity: { id: string } }).identity.id)).Login).to.eq('AdaLovelace');
  });

  it('answers created false for a known email in any case, and mails its owner the notice', async () => {
    const { ref } = await seedUser({ login: 'known', email: 'Known@Example.test' });
    expect(await registrar.register({ email: 'known@example.TEST' })).to.deep.eq({ created: false, existing: ref });
    expect(notices()).to.eq(1);
    expect(await registrar.registerSilently({ email: 'known@example.test' })).to.deep.eq({ created: false, existing: ref });
    expect(notices()).to.eq(1, 'registerSilently never mails');
  });

  it('tells a soft-deleted account nothing', async () => {
    const { ref } = await seedUser({ login: 'gone', email: 'gone@example.test' });
    await setIdentityFlags(ref, { deleted: true });
    expect(await registrar.register({ email: 'gone@example.test' })).to.deep.eq({ created: false, existing: ref });
    expect(notices()).to.eq(0);
  });

  it('creates an inactive user with users.registration.active false', async () => {
    DI.get(Configuration)!.set('users.registration.active', false);
    const outcome = await registrar.register({ email: 'moderated@example.test' });
    expect((await storedUser((outcome as { identity: { id: string } }).identity.id)).IsActive).to.eq(false);
  });

  it('refuses an input that is not an email', async () => {
    await expect(registrar.register({ email: 'not-an-email' })).to.be.rejected;
    expect(await User.query().where('Login', 'not-an-email').first()).to.not.exist;
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/users && npx ts-mocha -p tsconfig.json test/registrar.test.ts`
Expected: FAIL at compile time: `Module '"../src/index.js"' has no exported member 'UserIdentityRegistrar'`.

- [ ] **Step 3: Implement**

`packages/users/src/actions.ts`: add `'registrationAttempt'` to the `cfgTemplate` union of `sendUserEmail` (after plan 06's `'emailChanged'`), add `import type { IdentityRef } from '@spinajs/authn/contracts';` if plan 06 did not, and after `createUser` (line 745) add:

```ts
/** The account {@link registerUser} makes. */
export interface IRegisterUserData {
  Email: string;
  Login: string;
  /** Already hashed by authn; absent: no password (passwordless sign-up, JIT). */
  PasswordHash?: string;
  IsActive: boolean;
}

/**
 * Inserts an account for self-service registration and JIT provisioning (`UserIdentityRegistrar`). Like {@link create}
 * without roles: `authz.rbac.defaultRoles` (dry run first), the `users.actions.create.*` middleware and `UserCreated`. Unlike
 * it, the password arrives hashed (or not at all) and no mail is sent: authn sends the verification code. A failure of the
 * password or the grants removes the row again.
 */
export async function registerUser(data: IRegisterUserData): Promise<User> {
  const email = _check_arg(_trim(), _non_empty(), _is_email(), _max_length(64))(data?.Email, 'email');
  const login = _check_arg(_trim(), _non_empty(), _max_length(32))(data?.Login, 'login');
  await assertUserUnique(login, email);

  const roleNames = defaultRoles(cfg<unknown>(DEFAULT_ROLES_KEY, []));
  const uuid = uuidv4();
  await assignGlobalRoles(uuid, roleNames, { reason: 'users:register', field: 'roles', dryRun: true });

  const now = DateTime.now();
  let u = new User({ Email: email, Login: login, Password: NO_PASSWORD, RegisteredAt: now, CreatedAt: now, IsActive: data.IsActive, Uuid: uuid });
  u = await runCreateMiddleware(u, 'users.actions.create.beforeCreate');
  await insertModel(u);

  try {
    if (data.PasswordHash !== undefined) {
      await new UserPasswordStore().set(userRef(u.Uuid) as IdentityRef, data.PasswordHash);
      await recordPasswordSetAt(u.Uuid, new Date());
    }
    await assignGlobalRoles(u.Uuid, roleNames, { reason: 'users:register', field: 'roles' });
  } catch (err) {
    await discardInsertedUser(u);
    throw err;
  }

  try {
    u = await runCreateMiddleware(u, 'users.actions.create.afterCreate');
    await ev(new UserCreated(u, roleNames));
  } catch (err) {
    const error = (err as Error)?.name ?? typeof err;
    throw new UserCreatedIncomplete(`Account ${uuid} was created, but a later step failed (${error})`, { user: uuid, resendInvite: false, error });
  }

  return u;
}
```

Create `packages/users/src/identity/registrar.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import { cfg } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { IdentityRegistrar, normalizeAddress } from '@spinajs/authn/contracts';
import type { RegistrationInput, RegistrationOutcome } from '@spinajs/authn/contracts';

import { registerUser, sendUserEmail } from '../actions.js';
import { UserAlreadyExists } from '../exceptions.js';
import { isReservedLogin } from '../models/User.js';
import type { User } from '../models/User.js';
import { runAsSystem } from '../system.js';
import { usersMatchingLogin, usersOrmUp } from './sql.js';

/** `false`: a self-registered account waits for an admin to activate it. */
export const REGISTRATION_ACTIVE_KEY = 'users.registration.active';

const LOGIN_BASE_MAX = 20;
const LOGIN_TRIES = 5;

/**
 * Accounts for self-service registration (authn-local's LocalRegistrationService) and JIT provisioning. A known email,
 * compared normalized and soft-deleted rows included, answers `created: false`; `register` then mails its owner the
 * `registrationAttempt` notice, `registerSilently` does not.
 */
@Injectable(IdentityRegistrar)
export class UserIdentityRegistrar extends IdentityRegistrar {
  public register(input: RegistrationInput): Promise<RegistrationOutcome> {
    return this.registerAs(input, true);
  }

  public registerSilently(input: RegistrationInput): Promise<RegistrationOutcome> {
    return this.registerAs(input, false);
  }

  protected async registerAs(input: RegistrationInput, notify: boolean): Promise<RegistrationOutcome> {
    const email = typeof input?.email === 'string' ? input.email.trim() : '';
    const normalized = normalizeAddress('email', email);
    if (normalized === null) throw new InvalidArgument('registration needs a valid email address', 'email');
    await usersOrmUp();

    const known = await this.holderOf(normalized);
    if (known) return this.existing(known, notify);

    const login = input.login ?? (await this.freeLogin(input.name, normalized));
    try {
      const u = await registerUser({ Email: email, Login: login, ...(input.passwordHash !== undefined ? { PasswordHash: input.passwordHash } : {}), IsActive: cfg<boolean>(REGISTRATION_ACTIVE_KEY, true) !== false });
      return { created: true, identity: { type: 'user', id: u.Uuid } };
    } catch (err) {
      // A parallel registration of this email got past the check first.
      const winner = err instanceof UserAlreadyExists ? await this.holderOf(normalized) : undefined;
      if (winner) return this.existing(winner, notify);
      throw err;
    }
  }

  private async holderOf(normalized: string): Promise<User | undefined> {
    const rows = await runAsSystem('registrar', () => usersMatchingLogin(normalized));
    return rows.find((u) => normalizeAddress('email', u.Email) === normalized);
  }

  private async existing(u: User, notify: boolean): Promise<RegistrationOutcome> {
    if (notify && !u.DeletedAt) await sendUserEmail(u, 'registrationAttempt');
    return { created: false, existing: { type: 'user', id: u.Uuid } };
  }

  /** The name or the local part, cut to letters, digits, `.`, `_` and `-`; a short random suffix when taken. */
  private async freeLogin(name: string | undefined, email: string): Promise<string> {
    const raw = (name ?? email.slice(0, email.indexOf('@'))).normalize('NFKC').replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, LOGIN_BASE_MAX);
    const base = raw === '' || isReservedLogin(raw) ? 'user' : raw;
    for (let i = 0; i < LOGIN_TRIES; i++) {
      const candidate = i === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
      if ((await runAsSystem('registrar', () => usersMatchingLogin(candidate))).length === 0) return candidate;
    }
    return `user-${randomBytes(6).toString('hex')}`;
  }
}
```

`actions.ts` already imports from `./identity/*`, and the registrar imports `actions.ts`: the cycle only touches functions called at run time, never at module load, so ESM resolves it.

Append to `packages/users/src/identity/index.ts`:

```ts
export * from './registrar.js';
```

`packages/users/src/config/users.ts`, in `users.email` after plan 06's `emailChanged`:

```ts
      // to the owner of an email someone tried to sign up with again (UserIdentityRegistrar)
      registrationAttempt: {
        enabled: true,
        template: './user-registration-attempt-template.pug',
        subject: 'Someone tried to sign up with your email address',
      },
```

Create `packages/users/src/templates/user-registration-attempt-template.pug`:

```pug
//- Registration attempt with an existing email
//-
//- Model: the serialized User. Sent instead of a sign-up code, so the sign-up page cannot tell a known address from a new one.
doctype html
html
  head
    meta(charset='utf-8')
    title Sign-up attempt
  body
    p Hello #{ Login || Email },
    p Someone tried to create an account with this email address, which already has one.
    p If it was you, log in, or reset your password if you forgot it. If it was not you, you can ignore this mail.
    p —
    p This is an automated message; please do not reply.
```

- [ ] **Step 4: GREEN + package suite + rebuild**

1. `cd packages/users && npx ts-mocha -p tsconfig.json test/registrar.test.ts` — passing.
2. `npm test` in `packages/users` (`shipped-config.test.ts:72` checks only the top-level `users` keys, which are unchanged). Rebuild.

- [ ] **Step 5: Commit**

```bash
git add packages/users/src/actions.ts packages/users/src/identity/registrar.ts packages/users/src/identity/index.ts packages/users/src/config/users.ts packages/users/src/templates/user-registration-attempt-template.pug packages/users/test/registrar.test.ts
git commit -m "feat(users): UserIdentityRegistrar: default roles, hashed password, a notice instead of a duplicate"
```

---

### Task 5: `users` — JIT provisioning through the registrar

**Files:**
- Modify: `packages/users/src/identity/identity-store.ts:1-14` (imports, class doc) and a new method after `display`
- Test: `packages/users/test/identity-store.test.ts:33-36`

**Interfaces:**
- Consumes: `UserIdentityRegistrar.registerSilently` (Task 4), `ExternalSubject`.
- Produces: `UserIdentityStore.provision(external: ExternalSubject): Promise<IdentityRef>`.

- [ ] **Step 1: Write the failing test**

In `packages/users/test/identity-store.test.ts` replace the test at lines 33-36 with:

```ts
  it('is the registered IdentityStore and provisions through the registrar (used only behind authn.linking.jit)', async () => {
    expect(await DI.resolve(IdentityStore)).to.be.instanceOf(UserIdentityStore);
    expect(store.provision).to.be.a('function');
  });

  describe('provision', () => {
    beforeEach(() => {
      sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    });

    it('creates a new account from the external email and name, without a password', async () => {
      const ref = await store.provision({ provider: 'oidc:google', subject: 'g-42', email: 'Jit.User@Example.test', emailVerified: true, claims: { name: 'Jit User' } });
      const u = await User.query().where('Uuid', ref.id).firstOrFail();
      expect(u).to.include({ Email: 'Jit.User@Example.test', Login: 'JitUser' });
      expect(await store.findByLogin('jit.user@example.test')).to.deep.eq(ref);
    });

    it('never hands out an existing account', async () => {
      await seedUser({ login: 'owner', email: 'owner@example.test' });
      await expect(store.provision({ provider: 'oidc:google', subject: 'g-43', email: 'OWNER@example.test' })).to.be.rejectedWith(UserAlreadyExists);
    });

    it('needs an email', async () => {
      await expect(store.provision({ provider: 'oidc:github', subject: '7' })).to.be.rejected;
    });
  });
```

Add to its imports: `import { DefaultQueueService } from '@spinajs/queue';` and `UserAlreadyExists` to the `../src/index.js` import.

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/users && npx ts-mocha -p tsconfig.json test/identity-store.test.ts`
Expected: FAIL: `expected undefined to be a function`, then `store.provision is not a function`.

- [ ] **Step 3: Implement**

`packages/users/src/identity/identity-store.ts`: imports become

```ts
import { Injectable } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { IdentityStore } from '@spinajs/authn/contracts';
import type { ExternalSubject, IdentityRef, IdentityStatus } from '@spinajs/authn/contracts';

import { UserAlreadyExists } from '../exceptions.js';
import { USER_COMMON_METADATA, User } from '../models/User.js';
import { runAsSystem } from '../system.js';
import { UserIdentityRegistrar } from './registrar.js';
import { usersMatchingLogin, usersOrmUp } from './sql.js';
```

In the class doc replace the last sentence ("No `provision`: …") with: `` `provision` creates accounts for JIT provisioning, which authn calls only behind authn.linking.jit and the provider's own switch. ``

After `display()` add:

```ts
  /**
   * A new account for an external subject, through UserIdentityRegistrar (no password, no notice). Never an existing
   * account: one holding this email throws UserAlreadyExists, so an unverified provider email cannot take it over (linking
   * an existing account is authn.linking.byVerifiedEmail's job).
   */
  public async provision(external: ExternalSubject): Promise<IdentityRef> {
    if (typeof external?.email !== 'string' || external.email.trim() === '') {
      throw new InvalidArgument('JIT provisioning needs the email of the external subject', 'email');
    }
    const name = typeof external.claims?.name === 'string' && external.claims.name.trim() !== '' ? external.claims.name : undefined;
    const outcome = await new UserIdentityRegistrar().registerSilently({ email: external.email, ...(name ? { name } : {}) });
    if (!outcome.created) {
      throw new UserAlreadyExists('An account already holds this email', { fields: ['Email'] });
    }
    return outcome.identity;
  }
```

- [ ] **Step 4: GREEN + package suite + dependants**

1. `cd packages/users && npx ts-mocha -p tsconfig.json test/identity-store.test.ts test/identity-conformance.test.ts` — passing.
2. `npm test` in `packages/users`; rebuild; `cd ../authn-oidc && npm test` (it uses a JIT-capable fake, not `users`, and must stay green).

- [ ] **Step 5: Commit**

```bash
git add packages/users/src/identity/identity-store.ts packages/users/test/identity-store.test.ts
git commit -m "feat(users): IdentityStore.provision for OIDC JIT through UserIdentityRegistrar, never an existing account"
```

---

### Task 6: `LocalRegistrationService` (authn-local)

**Files:**
- Create: `packages/authn-local/src/registration.ts`; modify `packages/authn-local/src/index.ts`
- Test: create `packages/authn-local/test/registration.test.ts`

**Interfaces:**
- Consumes: Task 1 contracts; `ThrottleFlow 'register'` and `authn.registration` (Task 2); `FakeIdentityRegistrar`, `FakeVerificationService`, rule A34 (Task 3); plan 06 `normalizeAddress`, `VerificationService`; plan 02 `check(password, { identifiers })`; authn-local `PasswordHasher`, `LocalPasswordPolicy`, `DeferredWork`, `publishAuthnEvent`, `AuditLog`.
- Produces: `@Injectable(RegistrationService) LocalRegistrationService(deps?: LocalRegistrationServiceDeps)` with `drain()`; `RegistrationSettings` (the `authn.registration` shape); `LocalRegistrationServiceDeps { registrar; identities; verification; throttle; hasher; policy; sessions?; mfa?; hooks?; sinks; log?; settings }`.

- [ ] **Step 1: Write the failing test**

Create `packages/authn-local/test/registration.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import type { AuthnContext, RegistrationHookInput, ThrottleKey } from '@spinajs/authn/contracts';
import { RegistrationHook } from '@spinajs/authn/contracts';
import { FakeIdentityRegistrar, FakeIdentityStore, FakeVerificationService, MemoryAddressStore, MemorySessionIssuer, RecordingCodeSender, RecordingEventSink, RecordingThrottle, runAuthnBehaviour } from '@spinajs/authn-testing';
import type { HarnessContext } from '@spinajs/authn-testing';

import { Argon2PasswordHasher } from '../src/hasher.js';
import { LocalPasswordPolicy } from '../src/policy.js';
import { LocalRegistrationService } from '../src/registration.js';
import type { LocalRegistrationServiceDeps, RegistrationSettings } from '../src/registration.js';

const NOW = new Date('2026-10-06T12:00:00Z');
const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: NOW, ip: '198.51.100.7', purpose: 'login', ...over });
const PASSWORD = 'Sign-Up-Pass-9';

const SETTINGS: RegistrationSettings = { enabled: true, methods: ['password', 'code'], loginAfter: 'when-verified', fields: { login: false, name: false }, blockedDomains: [], allowedDomains: [], url: 'https://app.test/sign-up', ttlSeconds: 900 };

class SwitchHook extends RegistrationHook {
  public vetoing = false;
  public readonly after: string[] = [];
  public async beforeRegister(input: RegistrationHookInput): Promise<void> {
    if (this.vetoing) throw new Error(`no sign-ups for ${input.email}`);
  }
  public async afterRegister(_id: unknown, input: RegistrationHookInput): Promise<void> {
    this.after.push(input.email);
  }
}

class RecordingPolicy extends LocalPasswordPolicy {
  public readonly identifiers: (readonly string[])[] = [];
  public async check(password: string, context?: { readonly identifiers: readonly string[] }) {
    this.identifiers.push(context?.identifiers ?? []);
    return super.check(password, context);
  }
}

async function setup(settings: Partial<RegistrationSettings> = {}) {
  const identities = new FakeIdentityStore();
  const addresses = new MemoryAddressStore();
  const sender = new RecordingCodeSender();
  const registrar = new FakeIdentityRegistrar(identities, addresses);
  const verification = new FakeVerificationService(addresses, sender);
  const throttle = new RecordingThrottle();
  const sessions = new MemorySessionIssuer();
  const events = new RecordingEventSink();
  const hook = new SwitchHook();
  const hasher = new Argon2PasswordHasher({});
  await hasher.resolve();
  const policy = new RecordingPolicy({});
  const deps: LocalRegistrationServiceDeps = { registrar, identities, verification, throttle, hasher, policy, sessions, hooks: [hook], sinks: [events], log: { warn: () => undefined }, settings: { ...SETTINGS, ...settings } };
  return { service: new LocalRegistrationService(deps), identities, addresses, sender, registrar, verification, throttle, sessions, events, hook, policy };
}

describe('LocalRegistrationService', function () {
  this.timeout(60_000);

  it('accepts a new email, then creates the identity with a hashed password and sends a register code with a link', async () => {
    const k = await setup();
    expect(await k.service.register({ email: ' New@Example.test ', password: PASSWORD }, ctx())).to.deep.eq({ status: 'accepted' });
    expect(k.registrar.created, 'nothing before the answer').to.have.length(0);
    await k.service.drain();
    expect(k.registrar.created).to.have.length(1);
    expect(k.registrar.created[0].email).to.eq('New@Example.test');
    expect(k.registrar.created[0].passwordHash).to.match(/^\$argon2id\$/);
    expect(k.sender.sent.map((m) => [m.to, m.purpose, m.ttlSeconds])).to.deep.eq([['new@example.test', 'register', 900]]);
    expect(k.sender.sent[0].link).to.match(/^https:\/\/app\.test\/sign-up#/);
    expect(k.hook.after).to.deep.eq(['new@example.test']);
    expect(k.events.ofType('registration').map((e) => [e.outcome, e.data])).to.deep.eq([['success', { method: 'password', step: 'register' }]]);
    expect(JSON.stringify(k.events.all())).to.not.contain('new@example.test').and.not.contain(PASSWORD);
  });

  it('counts in the register flow per normalized email and ip, and answers throttled before any other work', async () => {
    const k = await setup();
    await k.service.register({ email: 'A@Example.test', password: PASSWORD }, ctx());
    expect(k.throttle.attempts.map((a) => [a.flow, a.keys.map((x: ThrottleKey) => `${x.kind}=${x.value}`)])).to.deep.eq([['register', ['account=register:a@example.test', 'ip=198.51.100.7']]]);
    k.throttle.refuse(45);
    expect(await k.service.register({ email: 'b@example.test', password: 'short' }, ctx())).to.deep.eq({ status: 'throttled', retryAfterSeconds: 45 });
  });

  it('refuses a malformed or over-long email, a blocked or not allowed domain, and an unavailable method', async () => {
    const k = await setup({ methods: ['password'], blockedDomains: ['mailinator.com'], allowedDomains: [] });
    expect(await k.service.register({ email: 'nope', password: PASSWORD }, ctx())).to.deep.eq({ status: 'invalid_email' });
    expect(await k.service.register({ email: `${'a'.repeat(60)}@example.test`, password: PASSWORD }, ctx())).to.deep.eq({ status: 'invalid_email' });
    expect(await k.service.register({ email: 'x@eu.mailinator.com', password: PASSWORD }, ctx())).to.deep.eq({ status: 'domain' });
    expect(await k.service.register({ email: 'x@example.test' }, ctx())).to.deep.eq({ status: 'method' });
    const allow = await setup({ allowedDomains: ['corp.example'] });
    expect(await allow.service.register({ email: 'x@example.test', password: PASSWORD }, ctx())).to.deep.eq({ status: 'domain' });
    expect(await allow.service.register({ email: 'x@dept.corp.example', password: PASSWORD }, ctx())).to.deep.eq({ status: 'accepted' });
  });

  it('checks the password with the email, login and name as identifiers', async () => {
    const k = await setup({ fields: { login: true, name: true } });
    expect(await k.service.register({ email: 'p@example.test', password: 'short', login: 'pat', name: 'Pat' }, ctx())).to.deep.eq({ status: 'password', violations: ['too_short'] });
    expect(k.policy.identifiers).to.deep.eq([['p@example.test', 'pat', 'Pat']]);
  });

  it('takes a login only when enabled, in its pattern, and answers a taken one', async () => {
    const off = await setup();
    await off.service.register({ email: 'l@example.test', password: PASSWORD, login: 'ignored' }, ctx());
    await off.service.drain();
    expect(off.registrar.created[0].login).to.eq(undefined);
    const on = await setup({ fields: { login: true, name: false } });
    expect(await on.service.register({ email: 'l@example.test', password: PASSWORD, login: 'a@b' }, ctx())).to.deep.eq({ status: 'invalid_login' });
    on.identities.add({ login: 'taken' });
    expect(await on.service.register({ email: 'l@example.test', password: PASSWORD, login: 'taken' }, ctx())).to.deep.eq({ status: 'login_taken' });
  });

  it('a refusing hook answers vetoed and nothing is created', async () => {
    const k = await setup();
    k.hook.vetoing = true;
    expect(await k.service.register({ email: 'v@example.test', password: PASSWORD }, ctx())).to.deep.eq({ status: 'vetoed' });
    await k.service.drain();
    expect(k.registrar.created).to.deep.eq([]);
  });

  it('confirm redeems the register code once and issues a session with loginAfter when-verified', async () => {
    const k = await setup();
    await k.service.register({ email: 'c@example.test' }, ctx());
    await k.service.drain();
    const code = k.sender.codeFor('c@example.test', 'register')!;
    const r = await k.service.confirm('C@example.test', code, ctx());
    expect(r.status).to.eq('confirmed');
    const session = (r as { session?: { id: string } }).session!;
    const stored = await k.sessions.restore(session.id);
    expect(stored?.facts).to.include({ method: 'code', strategy: 'registration', assurance: 'aal1' });
    expect(await k.service.confirm('c@example.test', code, ctx())).to.deep.eq({ status: 'invalid' });
    expect(k.throttle.attempts.filter((a) => a.flow === 'register').at(-1)!.keys).to.deep.eq([{ kind: 'ip', value: '198.51.100.7' }]);
  });

  it('confirm issues no session with loginAfter never', async () => {
    const k = await setup({ loginAfter: 'never' });
    await k.service.register({ email: 'n@example.test' }, ctx());
    await k.service.drain();
    const r = await k.service.confirm('n@example.test', k.sender.codeFor('n@example.test', 'register')!, ctx());
    expect(r).to.have.property('status', 'confirmed');
    expect(r).to.not.have.property('session');
  });

  it('loginAfter immediately creates inline, asks a verify code and answers with a session', async () => {
    const k = await setup({ loginAfter: 'immediately' });
    const r = await k.service.register({ email: 'i@example.test', password: PASSWORD }, ctx());
    expect(r.status).to.eq('accepted');
    expect((r as { session?: unknown }).session).to.be.ok;
    expect(k.verification.requests).to.have.length(1);
    expect(k.sender.sent.map((m) => m.purpose)).to.deep.eq(['verify']);
  });

  describe('behaviour rule A34', () => {
    runAuthnBehaviour(
      ['A34'],
      async (_c: HarnessContext) => {
        const k = await setup();
        return {
          registration: {
            service: k.service,
            drain: () => k.service.drain(),
            sent: () => k.sender.sent,
            notified: () => k.registrar.notified,
            existing: async (email: string) => {
              const outcome = await k.registrar.register({ email });
              return outcome.created ? outcome.identity : outcome.existing;
            },
            veto: (on: boolean) => {
              k.hook.vetoing = on;
            },
          },
        };
      },
      { claim: ['A34/local'], facets: ['A34/local'], title: 'authn behaviour (authn-local registration)', timeoutMs: 600_000 },
    );
  });
});
```

`existing()` goes through the fake registrar, so `notified` stays empty for it (it creates); only the service's own second sign-up is noted.

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/registration.test.ts`
Expected: FAIL at compile time: `Cannot find module '../src/registration.js'`.

- [ ] **Step 3: Implement**

Create `packages/authn-local/src/registration.ts`:

```ts
import { DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { AuthnEventSink, AuthnThrottle, IdentityRegistrar, IdentityStore, MfaPolicy, REGISTRATION_STRATEGY, RegistrationHook, RegistrationService, SessionIssuer, VerificationService, normalizeAddress } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnEvent, AuthnFacts, IdentityRef, RegistrationConfirmResult, RegistrationHookInput, RegistrationInput, RegistrationRequest, RegistrationResult, SessionHandle, ThrottleKey } from '@spinajs/authn/contracts';

import { publishAuthnEvent } from './audit.js';
import type { AuditLog } from './audit.js';
import { DeferredWork } from './deferred.js';
import { PasswordHasher } from './hasher.js';
import { LocalPasswordPolicy } from './policy.js';

/** `authn.registration` as the schema delivers it. */
export interface RegistrationSettings {
  readonly enabled: boolean;
  readonly methods: readonly ('password' | 'code')[];
  readonly loginAfter: 'never' | 'when-verified' | 'immediately';
  readonly fields: { readonly login: boolean; readonly name: boolean };
  readonly blockedDomains: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly url: string;
  readonly ttlSeconds: number;
}

export interface LocalRegistrationServiceDeps {
  readonly registrar: IdentityRegistrar;
  readonly identities: IdentityStore;
  readonly verification: VerificationService;
  readonly throttle: AuthnThrottle;
  readonly hasher: PasswordHasher;
  readonly policy: LocalPasswordPolicy;
  /** Needed only when a flow issues a session (loginAfter 'when-verified' or 'immediately'). */
  readonly sessions?: SessionIssuer;
  readonly mfa?: MfaPolicy;
  readonly hooks?: readonly RegistrationHook[];
  readonly sinks: readonly AuthnEventSink[];
  readonly log?: AuditLog;
  readonly settings: RegistrationSettings;
}

type SessionPart = { readonly session?: SessionHandle; readonly mfaRequired?: readonly string[] };

/** users.Email holds 64 characters: a longer address is refused now rather than failing after the answer. */
const EMAIL_MAX = 64;
const NAME_MAX = 64;
// No `@`: a login field must not let anyone test emails.
const LOGIN_PATTERN = /^[\p{L}\p{N}._-]{3,32}$/u;

const ipKey = (ctx: AuthnContext): ThrottleKey => ({ kind: 'ip', value: ctx.ip ?? 'unknown' });

const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined);

const within = (domain: string, list: readonly string[]): boolean => list.some((d) => domain === d || domain.endsWith(`.${d}`));

function domainAccepted(email: string, s: RegistrationSettings): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (within(domain, s.blockedDomains)) return false;
  return s.allowedDomains.length === 0 || within(domain, s.allowedDomains);
}

/**
 * Self-service registration (plan 07). Every request does the same work before its answer, whether or not the email is
 * known: throttle, checks, hooks, one password hash. The identity, the code and the afterRegister hooks follow as deferred
 * work, so neither the answer nor its timing tells a known email from a new one (A34). With loginAfter 'immediately' the
 * account is created inline, which gives that up for a session at once. Collaborators come from the container on use;
 * with `deps` the container is not used.
 */
@Injectable(RegistrationService)
export class LocalRegistrationService extends RegistrationService {
  @Config('authn.registration')
  protected Settings: RegistrationSettings;

  @Logger('authn-local')
  protected Log: Log;

  private _work?: DeferredWork;

  constructor(protected readonly Deps?: LocalRegistrationServiceDeps) {
    super();
  }

  /** Resolves once every deferred registration scheduled so far has finished (tests, shutdown). */
  public drain(): Promise<void> {
    return this.work().drain();
  }

  public async register(request: RegistrationRequest, ctx: AuthnContext): Promise<RegistrationResult> {
    const s = this.settings();
    const email = normalizeAddress('email', request?.email);
    if (email === null || email.length > EMAIL_MAX) return { status: 'invalid_email' };

    const gate = await this.throttle().attempt([{ kind: 'account', value: `register:${email}` }, ipKey(ctx)], 'register', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', reason: 'throttled', data: { flow: 'register' } });
      return { status: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }
    if (!domainAccepted(email, s)) return { status: 'domain' };

    const password = typeof request.password === 'string' && request.password !== '' ? request.password : undefined;
    if (!s.methods.includes(password === undefined ? 'code' : 'password')) return { status: 'method' };

    const login = s.fields.login ? text(request.login, 64) : undefined;
    if (login !== undefined && !LOGIN_PATTERN.test(login)) return { status: 'invalid_login' };
    const name = s.fields.name ? text(request.name, NAME_MAX) : undefined;

    if (password !== undefined) {
      const violations = await this.policy().check(password, { identifiers: [email, ...(login ? [login] : []), ...(name ? [name] : [])] });
      if (violations.length > 0) return { status: 'password', violations };
    }
    if (login !== undefined && (await this.identities().findByLogin(login)) !== null) return { status: 'login_taken' };

    const input: RegistrationHookInput = { email, ...(login ? { login } : {}), ...(name ? { name } : {}), ...(ctx.ip ? { ip: ctx.ip } : {}) };
    for (const hook of await this.hooks()) {
      try {
        await hook.beforeRegister(input);
      } catch (err) {
        await this.audit(ctx, { type: 'registration', outcome: 'failure', reason: 'vetoed', data: { error: (err as Error)?.name ?? typeof err } });
        return { status: 'vetoed' };
      }
    }

    // One hash per request with a password, for a known email as for a new one.
    const passwordHash = password === undefined ? undefined : await (await this.hasher()).hash(password);
    const registration: RegistrationInput = {
      email: String(request.email).trim(),
      ...(login ? { login } : {}),
      ...(name ? { name } : {}),
      ...(passwordHash !== undefined ? { passwordHash } : {}),
      ...(typeof request.locale === 'string' && request.locale !== '' ? { locale: request.locale } : {}),
    };

    if (s.loginAfter === 'immediately') return this.registerNow(registration, input, ctx);
    this.work().defer(() => this.finish(registration, input, ctx));
    return { status: 'accepted' };
  }

  public async confirm(email: string, code: string, ctx: AuthnContext): Promise<RegistrationConfirmResult> {
    const gate = await this.throttle().attempt([ipKey(ctx)], 'register', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', reason: 'throttled', data: { flow: 'register' } });
      return { status: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }
    const r = await this.verification().redeem({ channel: 'email', value: email }, code, 'register', ctx);
    if (r.status !== 'verified') {
      await this.audit(ctx, { type: 'registration', outcome: 'failure', reason: 'invalid_code', data: { step: 'confirm' } });
      return { status: 'invalid' };
    }
    await this.audit(ctx, { type: 'registration', outcome: 'success', identity: r.identity, data: { step: 'confirm' } });
    const login = this.settings().loginAfter === 'when-verified' ? await this.sessionFor(r.identity, 'code', ctx) : {};
    return { status: 'confirmed', identity: r.identity, ...login };
  }

  protected async finish(registration: RegistrationInput, input: RegistrationHookInput, ctx: AuthnContext): Promise<void> {
    const outcome = await this.registrar().register(registration);
    if (!outcome.created) {
      await this.audit(ctx, { type: 'registration', outcome: 'failure', reason: 'exists', identity: outcome.existing });
      return;
    }
    await this.created(outcome.identity, registration, ctx);
    const s = this.settings();
    await this.verification().send(outcome.identity, { channel: 'email', value: registration.email }, 'register', {
      ...(s.url ? { linkBase: s.url } : {}),
      ttlSeconds: s.ttlSeconds,
      ...(registration.locale ? { locale: registration.locale } : {}),
    });
    await this.afterHooks(outcome.identity, input);
  }

  protected async registerNow(registration: RegistrationInput, input: RegistrationHookInput, ctx: AuthnContext): Promise<RegistrationResult> {
    const outcome = await this.registrar().register(registration);
    if (!outcome.created) {
      await this.audit(ctx, { type: 'registration', outcome: 'failure', reason: 'exists', identity: outcome.existing });
      return { status: 'accepted' };
    }
    await this.created(outcome.identity, registration, ctx);
    await this.verification().request({ identity: outcome.identity, channel: 'email' }, ctx);
    await this.afterHooks(outcome.identity, input);
    return { status: 'accepted', ...(await this.sessionFor(outcome.identity, registration.passwordHash !== undefined ? 'password' : 'code', ctx)) };
  }

  /** A session for a new account, unless it may not log in yet (users.registration.active false); pending when MFA asks. */
  protected async sessionFor(id: IdentityRef, method: 'password' | 'code', ctx: AuthnContext): Promise<SessionPart> {
    const sessions = await this.sessions();
    if (!sessions) return {};
    const st = await this.identities().status(id);
    if (!st.exists || !st.active || st.banned || st.deleted) return {};
    const facts: AuthnFacts = { method, strategy: REGISTRATION_STRATEGY, assurance: 'aal1', mfa: [], authenticatedAt: ctx.now };
    const mfa = await this.mfa();
    const steps = mfa ? [...(await mfa.required(id, { method, strategy: REGISTRATION_STRATEGY }))] : [];
    if (steps.length > 0) {
      const pending = await sessions.issue(id, facts, { pending: { steps } });
      await this.audit(ctx, { type: 'mfa.challenge', outcome: 'success', strategy: REGISTRATION_STRATEGY, identity: id });
      return { session: pending, mfaRequired: steps };
    }
    const session = await sessions.issue(id, facts);
    await this.audit(ctx, { type: 'login', outcome: 'success', strategy: REGISTRATION_STRATEGY, identity: id });
    await this.audit(ctx, { type: 'session.issue', outcome: 'success', strategy: REGISTRATION_STRATEGY, identity: id });
    return { session };
  }

  private async created(identity: IdentityRef, registration: RegistrationInput, ctx: AuthnContext): Promise<void> {
    await this.audit(ctx, { type: 'registration', outcome: 'success', identity, data: { method: registration.passwordHash !== undefined ? 'password' : 'code', step: 'register' } });
  }

  private async afterHooks(identity: IdentityRef, input: RegistrationHookInput): Promise<void> {
    for (const hook of await this.hooks()) {
      try {
        await hook.afterRegister(identity, input);
      } catch (err) {
        this.log().warn(`A RegistrationHook failed after ${identity.type} ${identity.id} was created: ${(err as Error)?.name ?? typeof err}`);
      }
    }
  }

  protected async audit(ctx: AuthnContext, e: Omit<AuthnEvent, 'at' | 'ip' | 'userAgent'>): Promise<void> {
    const event: AuthnEvent = { ...e, at: ctx.now, ...(ctx.ip !== undefined ? { ip: ctx.ip } : {}), ...(ctx.userAgent !== undefined ? { userAgent: ctx.userAgent } : {}) };
    await publishAuthnEvent(await this.sinks(), event, this.log());
  }

  protected work(): DeferredWork {
    return (this._work ??= new DeferredWork(this.log()));
  }

  protected settings(): RegistrationSettings {
    return this.Deps ? this.Deps.settings : this.Settings;
  }

  protected registrar(): IdentityRegistrar {
    return this.Deps ? this.Deps.registrar : DI.resolve(IdentityRegistrar);
  }

  protected identities(): IdentityStore {
    return this.Deps ? this.Deps.identities : DI.resolve(IdentityStore);
  }

  protected verification(): VerificationService {
    return this.Deps ? this.Deps.verification : DI.resolve(VerificationService);
  }

  protected throttle(): AuthnThrottle {
    return this.Deps ? this.Deps.throttle : DI.resolve(AuthnThrottle);
  }

  protected policy(): LocalPasswordPolicy {
    return this.Deps ? this.Deps.policy : DI.resolve(LocalPasswordPolicy);
  }

  protected async hasher(): Promise<PasswordHasher> {
    return this.Deps ? this.Deps.hasher : await DI.resolve(PasswordHasher);
  }

  protected async sessions(): Promise<SessionIssuer | null> {
    if (this.Deps) return this.Deps.sessions ?? null;
    return DI.check(SessionIssuer) ? await DI.resolve(SessionIssuer) : null;
  }

  protected async mfa(): Promise<MfaPolicy | null> {
    if (this.Deps) return this.Deps.mfa ?? null;
    return DI.check(MfaPolicy) ? await DI.resolve(MfaPolicy) : null;
  }

  protected async hooks(): Promise<readonly RegistrationHook[]> {
    if (this.Deps) return this.Deps.hooks ?? [];
    const all = DI.check(RegistrationHook) ? ((await Promise.resolve(DI.resolve(Array.ofType(RegistrationHook)))) as RegistrationHook[]) : [];
    // A resolve of the abstract base itself leaves an instance of it in the list; it is no hook.
    return all.filter((h) => h?.constructor !== RegistrationHook);
  }

  protected async sinks(): Promise<readonly AuthnEventSink[]> {
    if (this.Deps) return this.Deps.sinks;
    return DI.check(AuthnEventSink) ? await Promise.resolve(DI.resolve(Array.ofType(AuthnEventSink))) : [];
  }

  protected log(): AuditLog {
    return this.Deps ? (this.Deps.log ?? { warn: () => undefined }) : this.Log;
  }
}
```

`DI.resolve(VerificationService)` reaches `DefaultVerificationService` of `@spinajs/authn`'s root, which the app loads (`registerAuthnHttpV3` imports it); `DI.resolve(MfaPolicy)` reaches `DefaultMfaPolicy` like `LocalPasswordService` reaches its collaborators.

Append to `packages/authn-local/src/index.ts`:

```ts
export * from './registration.js';
```

- [ ] **Step 4: GREEN + package suite + rebuild**

1. `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/registration.test.ts` — 9 unit tests and the 5 A34 cases pass (the timing case can take minutes).
2. `npm test` in `packages/authn-local`; rebuild; `cd ../users && npm test` (users imports authn-local).

- [ ] **Step 5: Commit**

```bash
git add packages/authn-local/src/registration.ts packages/authn-local/src/index.ts packages/authn-local/test/registration.test.ts
git commit -m "feat(authn-local): LocalRegistrationService: enumeration-safe sign-up with deferred creation and register codes"
```

---

### Task 7: 3.0 HTTP routes `POST /auth/registration` and `/confirm`

**Files:**
- Modify: `packages/authn-http/src/policies/v3/groups.ts` (append `RegistrationEnabled`), `packages/authn-http/src/v3/index.ts` (export it)
- Create: `packages/authn-http/src/v3/controllers/AuthnRegistrationController.ts`
- Create: `packages/authn-http/test/v3-app/support/RegistrationFake.ts`, `packages/authn-http/test/v3-app/suites/registration.ts`
- Modify: `packages/authn-http/test/v3-app/app.ts` (config and binding), `test/v3-app/suites/route-table.ts`, `test/v3-app/account.test.ts`
- Modify: `docs/authn/README.md` ("Registration" section after plan 06's "Verification", config rows)

**Interfaces:**
- Consumes: `RegistrationService`, `PrincipalFactory`, `SessionIssuer`, `PasswordService` (contracts); plan 06 helpers `infoResponse`, `refusalResponse`, `throttledResponse`; plan 05 `captchaRefusal`; plan 03 `authnMessage`, `passwordViolationMessages`, `errorBody`, `notFound`; `answerFor`, `bodyField`, `boundedString`, `contextOf`, `stampClient`, `NO_STORE`, `authnSessionCookie`, `PASSWORD_HARD_CAP`.
- Produces: routes (404 unless `authn.registration.enabled` and a `RegistrationService` is registered):
  - `POST /auth/registration` `{ email, password?, login?, name?, locale?, captcha? }` → 200 `{ messages: [1005001] }`, or with a session the principal summary plus `messages`, or `{ MfaRequired }` with a pending session; 400 `E_INVALID_ADDRESS`, `E_REGISTRATION_DOMAIN`, `E_REGISTRATION_METHOD`, `E_LOGIN_INVALID`, `E_LOGIN_TAKEN`, `E_REGISTRATION_INPUT`, `E_REGISTRATION_PASSWORD` (+ violation messages); 403 `E_REGISTRATION_REFUSED`, `already_authenticated`; 429 `throttled`; plan 05's CAPTCHA 400.
  - `POST /auth/registration/confirm` `{ email, code }` → 200 `{ messages: [1005002] }` (+ session as above); 400 `E_CODE_INVALID`; 429.
  - `RegistrationEnabled` policy.

- [ ] **Step 1: Write the failing tests**

Create `packages/authn-http/test/v3-app/support/RegistrationFake.ts`:

```ts
import { DI } from '@spinajs/di';
import { RegistrationService, SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef, RegistrationConfirmResult, RegistrationRequest, RegistrationResult } from '@spinajs/authn/contracts';

/** Answers what a test sets; with `sessionFor`, issues a real session of the app's issuer for that identity. */
export class RegistrationFake extends RegistrationService {
  public static calls: { request: RegistrationRequest; ctx: AuthnContext }[] = [];
  public static next: RegistrationResult = { status: 'accepted' };
  public static nextConfirm: RegistrationConfirmResult = { status: 'invalid' };
  public static sessionFor: IdentityRef | null = null;

  public async register(request: RegistrationRequest, ctx: AuthnContext): Promise<RegistrationResult> {
    RegistrationFake.calls.push({ request, ctx });
    const r = RegistrationFake.next;
    if (r.status !== 'accepted' || !RegistrationFake.sessionFor) return r;
    return { status: 'accepted', session: await this.issue(RegistrationFake.sessionFor, ctx) };
  }

  public async confirm(_email: string, _code: string, ctx: AuthnContext): Promise<RegistrationConfirmResult> {
    const r = RegistrationFake.nextConfirm;
    if (r.status !== 'confirmed' || !RegistrationFake.sessionFor) return r;
    return { ...r, session: await this.issue(RegistrationFake.sessionFor, ctx) };
  }

  private async issue(id: IdentityRef, ctx: AuthnContext) {
    const sessions = (await DI.resolve(SessionIssuer)) as SessionIssuer;
    return sessions.issue(id, { method: 'code', strategy: 'registration', assurance: 'aal1', mfa: [], authenticatedAt: ctx.now });
  }

  public static reset(): void {
    RegistrationFake.calls = [];
    RegistrationFake.next = { status: 'accepted' };
    RegistrationFake.nextConfirm = { status: 'invalid' };
    RegistrationFake.sessionFor = null;
  }
}
```

Create `packages/authn-http/test/v3-app/suites/registration.ts`:

```ts
import { expect } from 'chai';
import type { RegistrationResult } from '@spinajs/authn/contracts';

import { RegistrationFake } from '../support/RegistrationFake.js';
import { Client, config, loggedIn, resetRecorders, seedUser } from '../app.js';

const idsOf = (body: { messages?: { id: number }[] }): number[] => (body.messages ?? []).map((m) => m.id);

export function registrationSuite(): void {
  beforeEach(() => {
    resetRecorders();
    RegistrationFake.reset();
  });

  it('is off (404) while authn.registration.enabled is false', async () => {
    config().set('authn.registration.enabled', false);
    try {
      expect((await new Client().post('/auth/registration', { email: 'a@example.test' })).status).to.eq(404);
      expect((await new Client().post('/auth/registration/confirm', { email: 'a@example.test', code: '123456' })).status).to.eq(404);
    } finally {
      config().set('authn.registration.enabled', true);
    }
  });

  it('accepted: 200 with 1005001 and no cookie; the request reaches the service with ctx purpose login', async () => {
    const c = new Client();
    const r = await c.post('/auth/registration', { email: 'new@example.test', password: 'Sign-Up-Pass-9', login: 'newbie', name: 'New', locale: 'pl' });
    expect(r.status).to.eq(200);
    expect(idsOf(r.body)).to.deep.eq([1005001]);
    expect(c.cookie).to.eq(null);
    expect(RegistrationFake.calls[0].request).to.deep.eq({ email: 'new@example.test', password: 'Sign-Up-Pass-9', login: 'newbie', name: 'New', locale: 'pl' });
    expect(RegistrationFake.calls[0].ctx.purpose).to.eq('login');
  });

  it('maps each refusal to its code and message id', async () => {
    const cases: [RegistrationResult, number, string, number][] = [
      [{ status: 'invalid_email' }, 400, 'E_INVALID_ADDRESS', 4004003],
      [{ status: 'domain' }, 400, 'E_REGISTRATION_DOMAIN', 4005001],
      [{ status: 'method' }, 400, 'E_REGISTRATION_METHOD', 4005002],
      [{ status: 'invalid_login' }, 400, 'E_LOGIN_INVALID', 4005004],
      [{ status: 'login_taken' }, 400, 'E_LOGIN_TAKEN', 4005005],
      [{ status: 'vetoed' }, 403, 'E_REGISTRATION_REFUSED', 4005006],
      [{ status: 'throttled', retryAfterSeconds: 12 }, 429, 'throttled', 4000018],
    ];
    for (const [next, status, code, id] of cases) {
      RegistrationFake.next = next;
      const r = await new Client().post('/auth/registration', { email: 'x@example.test', password: 'Sign-Up-Pass-9' });
      expect(r.status, code).to.eq(status);
      expect(r.body.error, code).to.eq(code);
      expect(idsOf(r.body)[0], code).to.eq(id);
    }
  });

  it('a password refusal names the registration message and each violation', async () => {
    RegistrationFake.next = { status: 'password', violations: ['too_short'] };
    const r = await new Client().post('/auth/registration', { email: 'x@example.test', password: 'short' });
    expect(r.status).to.eq(400);
    expect(r.body.error).to.eq('E_REGISTRATION_PASSWORD');
    expect(idsOf(r.body)).to.deep.eq([4005003, 4001001]);
  });

  it('a malformed field answers E_REGISTRATION_INPUT without calling the service', async () => {
    for (const body of [{}, { email: 42 }, { email: 'a@b.c', password: 'x'.repeat(10_000) }, { email: 'a@b.c', login: ['x'] }]) {
      const r = await new Client().post('/auth/registration', body);
      expect(r.status, JSON.stringify(body).slice(0, 40)).to.eq(400);
      expect(r.body.error).to.eq('E_REGISTRATION_INPUT');
    }
    expect(RegistrationFake.calls).to.deep.eq([]);
  });

  it('refuses a caller that holds a session with already_authenticated', async () => {
    const c = await loggedIn(await seedUser());
    const r = await c.post('/auth/registration', { email: 'y@example.test' });
    expect(r.status).to.eq(403);
    expect(r.body.error).to.eq('already_authenticated');
    expect(RegistrationFake.calls).to.deep.eq([]);
  });

  it('a session from registration sets the cookie and answers the principal summary with 1005001', async () => {
    const u = await seedUser();
    RegistrationFake.sessionFor = u.ref;
    const c = new Client();
    const r = await c.post('/auth/registration', { email: 'z@example.test', password: 'Sign-Up-Pass-9' });
    expect(r.status).to.eq(200);
    expect(r.body.Identity).to.deep.eq({ type: 'user', id: u.ref.id });
    expect(r.body.Authn).to.include({ strategy: 'registration' });
    expect(idsOf(r.body)).to.deep.eq([1005001]);
    expect(c.cookie).to.not.eq(null);
  });

  it('confirm: 200 with 1005002 (and a session when the service issues one); otherwise one E_CODE_INVALID', async () => {
    const u = await seedUser();
    RegistrationFake.nextConfirm = { status: 'confirmed', identity: u.ref };
    const plain = await new Client().post('/auth/registration/confirm', { email: u.login, code: '123456' });
    expect(plain.status).to.eq(200);
    expect(idsOf(plain.body)).to.deep.eq([1005002]);
    RegistrationFake.sessionFor = u.ref;
    const c = new Client();
    expect((await c.post('/auth/registration/confirm', { email: u.login, code: '123456' })).status).to.eq(200);
    expect(c.cookie).to.not.eq(null);
    RegistrationFake.reset();
    const bad = await new Client().post('/auth/registration/confirm', { email: u.login, code: '000000' });
    expect(bad.status).to.eq(400);
    expect(bad.body.error).to.eq('E_CODE_INVALID');
    expect(idsOf(bad.body)).to.deep.eq([4004001]);
  });
}
```

In `packages/authn-http/test/v3-app/app.ts`:
- `V3AppConfiguration.onLoad()`: add `registration: { enabled: true },` inside `authn`.
- `wire()`, before `await registerAuthnHttpV3();`:

```ts
  const { RegistrationService } = await import('@spinajs/authn/contracts');
  const { RegistrationFake } = await import('./support/RegistrationFake.js');
  DI.register(RegistrationFake).as(RegistrationService);
```

(`test/v3-app/support` is already a controller directory of the app; the file declares no controller, so the scan ignores it.)

`packages/authn-http/test/v3-app/suites/route-table.ts`: append `'POST /auth/registration'` and `'POST /auth/registration/confirm'` to `ACCOUNT_ROUTES_V3`.

`packages/authn-http/test/v3-app/account.test.ts`: import `{ registrationSuite } from './suites/registration.js'` and add `describe('self-service registration', registrationSuite);` before the route table.

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json test/v3-app/account.test.ts`
Expected: FAIL: `POST /auth/registration` answers 404 in the accepted case, the route table lacks the two routes.

- [ ] **Step 3: Implement**

Append to `packages/authn-http/src/policies/v3/groups.ts` (add `Config` from `@spinajs/configuration` and `RegistrationService` from `@spinajs/authn/contracts` to the imports):

```ts
/** 404 unless authn.registration.enabled is true and a RegistrationService is registered: sign-up is off. */
export class RegistrationEnabled extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('authn.registration.enabled', { defaultValue: false })
  protected Enabled: boolean;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request, _action: IRoute, _instance: IController): Promise<void> {
    if (this.Enabled !== true || !this.Container.hasRegistered(RegistrationService as unknown as Class<RegistrationService>)) throw notFound('not_found', 'self-service registration is off');
  }
}
```

`packages/authn-http/src/v3/index.ts`: add `RegistrationEnabled` to the `../policies/v3/groups.js` export.

Create `packages/authn-http/src/v3/controllers/AuthnRegistrationController.ts`:

```ts
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BadRequestResponse, BaseController, BasePath, Ok, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { PasswordService, PrincipalFactory, RegistrationService, SessionIssuer } from '@spinajs/authn/contracts';
import type { PasswordViolation, RegistrationRequest, RegistrationResult, SessionHandle } from '@spinajs/authn/contracts';
import { authnMessage, passwordViolationMessages } from '@spinajs/authn/messages';
import type { AuthnMessageCode } from '@spinajs/authn/messages';

import { RegistrationEnabled } from '../index.js';
import { captchaRefusal } from '../captcha.js';
import { errorBody } from '../../policies/v3/errors.js';
import { PASSWORD_HARD_CAP } from '../../policies/v3/fresh-auth.js';
import { NO_STORE, authnSessionCookie, infoResponse, refusalResponse, throttledResponse } from '../responses.js';
import { answerFor, bodyField, boundedString, contextOf, stampClient } from '../routes.js';

const EMAIL_CAP = 320;
const FIELD_CAP = 256;
const CODE_CAP = 64;

/** Absent: undefined; a string within `cap`: it; anything else: null (malformed). */
function optional(value: unknown, cap: number): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  return boundedString(value, cap);
}

const malformed = () => refusalResponse(400, 'E_REGISTRATION_INPUT', 'a field of the form is malformed');

/**
 * Self-service registration (plan 07). Off (404) until authn.registration.enabled and a RegistrationService. The answer
 * for a known email equals the answer for a new one, unless authn.registration.loginAfter is 'immediately'. Guarded by
 * the CAPTCHA flow `register` when a CaptchaGate is registered (plan 05).
 * @tags Authentication
 */
@BasePath('auth')
@Policy(RegistrationEnabled)
export class AuthnRegistrationController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  /**
   * Sign up
   * Body `{ email, password?, login?, name?, locale? }`, plus the CAPTCHA token when one is required. 200 with message
   * 1005001; with authn.registration.loginAfter 'immediately' a new account also gets its session.
   * @security []
   */
  @Post('registration')
  public async register(@Req() req: Request) {
    if (req.storage.AuthnSession) return refusalResponse(403, 'already_authenticated', 'log out before signing up');
    const email = boundedString(bodyField(req, 'email', 'Email'), EMAIL_CAP);
    const password = optional(bodyField(req, 'password', 'Password'), PASSWORD_HARD_CAP);
    const login = optional(bodyField(req, 'login', 'Login'), FIELD_CAP);
    const name = optional(bodyField(req, 'name'), FIELD_CAP);
    const locale = optional(bodyField(req, 'locale'), FIELD_CAP);
    if (email === null || password === null || login === null || name === null || locale === null) return malformed();

    const refusal = await captchaRefusal(this.Container, req, 'register', email);
    if (refusal) return refusal;

    const request: RegistrationRequest = { email, ...(password !== undefined ? { password } : {}), ...(login !== undefined ? { login } : {}), ...(name !== undefined ? { name } : {}), ...(locale !== undefined ? { locale } : {}) };
    const r = await (await this.Container.resolve(RegistrationService)).register(request, contextOf(req, 'login'));
    return this.answer(req, r);
  }

  /**
   * Confirm a sign-up
   * Body `{ email, code }`: the code of the sign-up mail. 200 with message 1005002, and the session when
   * authn.registration.loginAfter is 'when-verified'; one 400 E_CODE_INVALID for anything else.
   * @security []
   */
  @Post('registration/confirm')
  public async confirm(@Req() req: Request) {
    const email = boundedString(bodyField(req, 'email', 'Email'), EMAIL_CAP);
    const code = boundedString(bodyField(req, 'code'), CODE_CAP);
    if (email === null || code === null) return refusalResponse(400, 'E_CODE_INVALID', 'the code is invalid or has expired');

    const r = await (await this.Container.resolve(RegistrationService)).confirm(email, code, contextOf(req, 'login'));
    if (r.status === 'throttled') return throttledResponse(r.retryAfterSeconds);
    if (r.status !== 'confirmed') return refusalResponse(400, 'E_CODE_INVALID', 'the code is invalid or has expired');
    return r.session ? this.withSession(req, r.session, r.mfaRequired, 'registration_confirmed') : infoResponse('registration_confirmed');
  }

  protected async answer(req: Request, r: RegistrationResult) {
    switch (r.status) {
      case 'accepted':
        return r.session ? this.withSession(req, r.session, r.mfaRequired, 'registration_accepted') : infoResponse('registration_accepted');
      case 'throttled':
        return throttledResponse(r.retryAfterSeconds);
      case 'invalid_email':
        return refusalResponse(400, 'E_INVALID_ADDRESS', 'not a valid email address');
      case 'domain':
        return refusalResponse(400, 'E_REGISTRATION_DOMAIN', 'this email domain may not sign up');
      case 'method':
        return refusalResponse(400, 'E_REGISTRATION_METHOD', 'this sign-up method is off');
      case 'invalid_login':
        return refusalResponse(400, 'E_LOGIN_INVALID', 'the login does not match its pattern');
      case 'login_taken':
        return refusalResponse(400, 'E_LOGIN_TAKEN', 'the login is taken');
      case 'vetoed':
        return refusalResponse(403, 'E_REGISTRATION_REFUSED', 'the sign-up was refused');
      case 'password':
        return this.passwordRefusal(r.violations);
    }
  }

  protected async passwordRefusal(violations: readonly PasswordViolation[]): Promise<BadRequestResponse> {
    const policy = this.Container.hasRegistered(PasswordService) ? (await this.Container.resolve(PasswordService)).policy() : { minLength: 8, maxLength: 128 };
    const body = errorBody('E_REGISTRATION_PASSWORD', 'the password was refused');
    return new BadRequestResponse({ ...body, messages: [...body.messages, ...passwordViolationMessages(violations, policy)] }, { Headers: [NO_STORE] });
  }

  /** The session cookie, then `{ MfaRequired }` for a pending session or the principal summary with the info message. */
  protected async withSession(req: Request, session: SessionHandle, mfaRequired: readonly string[] | undefined, info: AuthnMessageCode) {
    const sessions = await this.Container.resolve(SessionIssuer);
    await stampClient(sessions, session, req);
    const cookie = authnSessionCookie(this._cfg, session);
    if (mfaRequired && mfaRequired.length > 0) return new Ok({ MfaRequired: [...mfaRequired] }, { Coockies: [cookie], Headers: [NO_STORE] });
    const stored = await sessions.restore(session.id);
    if (!stored) return infoResponse(info);
    const principal = await (await this.Container.resolve(PrincipalFactory)).principalOf(stored.identity, stored.facts, {});
    return new Ok({ ...(await answerFor(this.Container, 'login', principal)), messages: [authnMessage(info)] }, { Coockies: [cookie], Headers: [NO_STORE] });
  }
}
```

`docs/authn/README.md`: after plan 06's "Verification" section add:

```markdown
## Registration

Self-service sign-up is off until `authn.registration.enabled: true`. `authn-local` provides `LocalRegistrationService` and
`users` provides `UserIdentityRegistrar`.

- `POST /auth/registration` `{ email, password?, login?, name?, locale? }` (CAPTCHA flow `register`) answers message 1005001
  for a known email exactly as for a new one, after the same work (one password hash included). A new account gets a
  6-digit code (purpose `register`, link `authn.registration.url` with the code in its fragment); the owner of a known email
  gets the `registrationAttempt` notice instead. It counts in the `register` throttle flow per email and IP.
- `POST /auth/registration/confirm` `{ email, code }` verifies the email (1005002) and, with `loginAfter: 'when-verified'`
  (default), issues the session. `never`: the user logs in afterwards. `immediately`: the account and its session are created
  at once (a known email gets no session, so this reveals which emails have accounts; the schema refuses it with
  `authn.verification.requiredForLogin: 'email'`).
- `methods`: `['password']` (default) and/or `'code'` (passwordless). `fields.login`/`fields.name` accept those fields; a
  taken login is answered (4005005), which reveals logins, never emails. `blockedDomains` and `allowedDomains` filter by
  domain and subdomain.
- New accounts get `authz.rbac.defaultRoles` only, `IsActive` from `users.registration.active` (default true; false waits
  for an admin), and an unverified email.
- `RegistrationHook` (`Array.ofType`): `beforeRegister` may refuse (4005006), `afterRegister` enriches. Audit event
  `registration` (plan 10 webhooks listen to it).
- OIDC JIT (`authn.linking.jit` plus the provider switch) creates accounts through the same registrar; it never hands out
  an account that already holds the email.
```

and in the config table:

```markdown
| `authn.registration.*` | `LocalRegistrationService`, `authn-http` | `enabled` (false), `methods` (`['password']`), `loginAfter` (`'when-verified'`), `fields`, `blockedDomains`, `allowedDomains`, `url`, `ttlSeconds` (900). |
| `users.registration.active` | `UserIdentityRegistrar` | Code default `true`; `false` creates inactive accounts. |
```

- [ ] **Step 4: GREEN + package suite**

1. `cd packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json test/v3-app/account.test.ts` — passing, route table included.
2. `npm test` in `packages/authn-http`.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-http/src/policies/v3/groups.ts packages/authn-http/src/v3/index.ts packages/authn-http/src/v3/controllers/AuthnRegistrationController.ts packages/authn-http/test/v3-app/support/RegistrationFake.ts packages/authn-http/test/v3-app/suites/registration.ts packages/authn-http/test/v3-app/app.ts packages/authn-http/test/v3-app/suites/route-table.ts packages/authn-http/test/v3-app/account.test.ts docs/authn/README.md
git commit -m "feat(authn-http): POST /auth/registration and /confirm in the 3.0 layer, off by default"
```

---

## Self-review

- **Spec coverage:** route off by default (Tasks 2, 7); email + optional login/name/password per `methods`/`fields` (2, 6, 7); CAPTCHA flow `register`, optional (7, plan 05 helper); throttle `register` per IP (+ email) (2, 6); password policy with identifiers incl. plan 02 checks (6); `IdentityRegistrar.register` in users with `IsActive` per config and only default roles via `assignGlobalRoles`/`defaultRoles` as `create()` does (4); verification code after creation (6, plan 06 `send`); enumeration safety with identical answer, owner notice instead, equal timing with the hash (Decisions 2-3, Tasks 3, 4, 6); `loginAfter` never/when-verified/immediately (2, 6, 7); blocked/allowed domains (2, 6); `RegistrationHook` before/after (1, 6); audit `registration` for plan 10 (1, 6); messages 1005xxx/4005xxx (2, 7); JIT provision on the registrar behind `authn.linking.jit` (5); behaviour rule A34 (3, 6).
- **Placeholder scan:** conditional steps are tied to sibling plans that may land in another order (the throttle union with plan 08's `code`, the A-id) and name the exact adjustment; no step defers code to the implementer.
- **Type consistency:** `RegistrationResult`/`RegistrationConfirmResult` statuses match across Tasks 1, 6, 7 and the fake; `RegistrationSettings` matches the schema of Task 2; `FakeIdentityRegistrar(identities, addresses)` and `FakeVerificationService(addresses, sender)` are used the same in Tasks 3 and 6; `UserIdentityRegistrar.registerSilently` is used by Task 5; plan 06 names (`normalizeAddress`, `VerificationService.send/redeem/request`, `infoResponse`, `refusalResponse`, `throttledResponse`, `E_CODE_INVALID`, `E_INVALID_ADDRESS`) match plan 06's text.
