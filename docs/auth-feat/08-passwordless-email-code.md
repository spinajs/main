# Passwordless Email Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign in with a code mailed to a verified address (`POST /auth/code`, then `POST /auth/login` with `{ email, code }`), and use the same mailed code as an MFA step (`email-code`).

**Architecture:** A new `CodeStrategy` (credential kind `code`, interactive, method `code`, `aal1`) and a `DefaultCodeLoginService` that counts a request in a new `code` throttle flow, answers at once and sends later. Both live in `@spinajs/authn` core under `src/code/`. `EmailCodeMfaStep` sends its code through a new optional `MfaStep.challenge`, which a new optional `AuthnService.challengeMfa` calls for `POST /auth/mfa/challenge`. A new optional `MfaStep.sameFactorAs` keeps the email code from counting as a second factor after a code login. `DefaultMfaPolicy` also asks for MFA after code logins and gains `forbidForRoles`. Storage, sending, address normalization and lookup are plan 06's (`OneTimeCodeStore`, `CodeSender`, `AddressStore`, `normalizeAddress`, `addressSubject`), and every code is bound to the address it went to. CAPTCHA is plan 05's `captchaRefusal`, and the answers carry plan 03's `messages`.

**Tech Stack:** TypeScript (ESM + CJS builds), `@spinajs/di`, `@spinajs/configuration` (`@Config` + AJV schema), `@spinajs/http`, mocha + ts-mocha, chai, `@spinajs/authn-testing` (kit fakes and behaviour rules).

## Global Constraints

- English comments, identifiers and commits. Comment only what the code cannot say.
- Work on branch `authz-v3-refactor`. Make one commit per task, and run the package suites before each commit.
- Run every test command from the package directory: `npx ts-mocha -p tsconfig.json <file>`. A package's full suite is `npm test`.
- A package that consumes a changed package reads it from `lib/`. Rebuild before testing dependents: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json` in the changed package.
- Working-copy files use CRLF, so keep them CRLF, new files included.
- Value checks and defaults go in the module's JSON schema (`@Config` plus the AJV schema). Code keeps only DI lookups, compilation and cross-domain merges.
- Never add a schema default that changes an effective access or security value (mechanism-notes, "Lessons").
- The test harness boots in child containers of `DI.RootContainer`, never calls `DI.clear()`, and disposes the child in `afterEach`.
- When committing shared files, stage only your own hunks and check with `git diff --cached`.
- HTTP work targets the 3.0 layer (`packages/authn-http/src/v3`), never the 2.x controllers.
- Message IDs come from this plan's range only: `1006000–1006999` (info) and `4006000–4006999` (user error). Released IDs are never reused.
- The new behaviour rule continues the A-series. Plans 03, 05 and 06 each claim A33 and renumber among themselves, so this plan writes its rule as A36 (Decision 14).
- Secrets are secret references, never inline values. Codes and links never reach an event, a log or a queue (A21, SR-09).

---

## Current state

- There is no passwordless login. `AuthnLoginController.login` builds only `{ kind: 'password', login, password }` credentials.
- `ThrottleFlow` is a closed union of four flows (`login`, `mfa`, `reset`, `reauth`). Plan 06 adds a fifth, `verify`. Both throttles keep one table or row namespace per flow.
- `MfaStep` has no way to send a challenge, and `AuthnService` has no route to ask for one.
- `DefaultMfaPolicy.required` returns `[]` for every method except `'password'`. A new login method would skip TOTP entirely.
- The one-time code, sender, address and CAPTCHA contracts do not exist yet. Plans 05 and 06 create them.

## Prerequisites (they must have landed before Task 1)

- **Plan 06** (`docs/auth-feat/06-email-phone-verification.md`) provides:
  - The contracts: `packages/authn/src/contracts/codes.ts` (`OneTimeCodeStore`, `CodeSender`, `CodeMessage`, `CodePurpose`, `CodeCheck`, `IssuedCode`), and `AddressStore`, `VerifiableAddress` and `AddressChannel` with the README signatures (`docs/auth-feat/README.md:29-101`).
  - `normalizeAddress(channel, raw): string | null` and `addressSubject(channel, normalized): string` (gives `address:<channel>:<value>`) in `packages/authn/src/contracts/address.ts`. All of these are exported from `@spinajs/authn/contracts`.
  - `MemoryOneTimeCodeStore` (`packages/authn/src/codes/memory-code-store.ts`, exported from `@spinajs/authn`, never registered in DI) and `DbOneTimeCodeStore` (authn-orm, `@Injectable(OneTimeCodeStore)`).
  - The kit fakes `MemoryAddressStore` (`set(identity, channel, raw, verifiedAt?)` replaces the identity's address on that channel and returns the normalized value; `marked`) and `RecordingCodeSender` (`sent`, `fail`, `codeFor(to, purpose)`, `clear()`).
  - The `verify` throttle flow (a required `ThrottleParams.verify`), and the `authn.codes.*` schema (`secret`, `maxAttempts` 5, `length` 6).
- **Plan 05** (`05-captcha.md`, section "Integration for plans 06, 07 and 08") provides `CaptchaGate` and `CaptchaFlow` (with `'code'`) in `@spinajs/authn/contracts`, the `captcha.fail` event, and `captchaRefusal(container, req, flow, account?, cookies?): Promise<BadRequestResponse | null>` in `packages/authn-http/src/v3/captcha.ts`. The helper reads the token itself (body field `captcha` or header `x-captcha-token`), audits, and builds the 400 answer.
- **Plan 03** (`03-message-ids.md`, "How a consumer plan adds messages") provides:
  - From `@spinajs/authn/messages`: `AuthnMessageDefinition`, `authnMessage(code, context?)`, and `catalogue.ts` with `PARTS` and `DEFINITIONS`. The core code `throttled` (4000018, context `retryAfterSeconds`) is meant for the code requests of plans 06 and 08.
  - In authn-http `src/policies/v3/errors.ts`: `errorBody(code, message, context?)`, and `refused` and `notFound`, whose codes are typed against the catalogue. Bodies carry `messages: AuthnMessage[]`.

Task 1 Step 1 checks the prerequisites mechanically.

## Decisions (confirm before Task 1)

1. **Package: `@spinajs/authn` core (`src/code/`), not `authn-local`.** The strategy and the request service depend only on core contracts (`AddressStore`, `OneTimeCodeStore`, `CodeSender`, `IdentityStore`, `AuthnThrottle`). `authn-local` is the password package (hasher, pepper, policy, `PasswordMailer`). The README table lists plan 08 as `authn, authn-http`. A registered strategy that is not listed never runs (A01, `strategy-registry.ts:51-57`), so shipping it in core costs nothing.
2. **Only verified addresses get login codes.** `authn.code.allowUnverified` (default `false`) opens the Kratos behaviour, which sends to unverified addresses too. Whatever the switch, a successful code login marks an unverified address verified, because the code reached it. With the switch off, a victim's code request never logs the victim into an account someone else registered earlier with the victim's address (pre-hijacking).
3. **No "no account" mail to unknown addresses.** It would let anyone mail-bomb third parties, and registration belongs to plan 07.
4. **Code shape and limits:** 8 digits by default (`authn.code.length`, 6-10), with a lifetime of 600 s (`authn.code.ttlSeconds`). `authn.code.length` overrides plan 06's store-wide `authn.codes.length` (6) for login and MFA codes only: a code that opens a session is worth more than one that verifies an address. The wrong-answer limit is plan 06's `authn.codes.maxAttempts` (default 5), because `OneTimeCodeStore.issue` takes no attempt count. The resend cooldown is the new `code` throttle flow: account `free 3, 60 s doubling to 1 h`, ip `free 10, 10 s doubling to 15 min`. There is no separate `sendCooldownSeconds`.
5. **The lookup is `AddressStore.findByAddress('email', …)` only, never `IdentityStore.findByLogin`.** `findByLogin` also matches login names, the same reason as `default-authn-service.ts:507`.
6. **The MFA challenge is explicit.** The client calls `POST /auth/mfa/challenge` with `{ step }`, which calls the optional `AuthnService.challengeMfa`, which calls the optional `MfaStep.challenge`. Nothing is sent automatically when a session becomes pending. Otherwise every password login of a TOTP user with a verified address would mail a code, and the send would run inside the login's timing.
7. **The same-channel rule is the optional `MfaStep.sameFactorAs: readonly string[]`.** It is enforced twice. `DefaultMfaPolicy` filters such steps out, and `DefaultAuthnService.challengeMfa` and `passMfa` refuse them, so a custom policy cannot bring them back.
8. **`DefaultMfaPolicy` also applies to `code` logins.** Otherwise a mailbox compromise would bypass TOTP. When MFA is forced and no configured step may follow the login method, `required` throws, so the login fails closed with `policy_error`.
9. **`authn.mfa.policy.forbidForRoles: { [step]: roles[] }`** (default `{}`). It keeps a weak step from roles that need more, for example `{ 'email-code': ['admin'] }`. Roles that cannot be read drop the step (fail closed). It needs a `RoleSource`, as `forceForRoles` does.
10. **`email-code` enrolment is automatic.** Every identity with a verified email address counts as enrolled once the step is listed. `beginEnrolment` and `confirmEnrolment` throw, and `disable` does nothing. Listing the step turns email OTP on for every verified-email identity.
11. **Messages follow plan 03's recipe.** `packages/authn/src/messages/code-login.ts` exports `CODE_LOGIN_MESSAGES` (keys are wire codes), which joins the catalogue's `PARTS` and `DEFINITIONS`. HTTP answers are `{ messages: [authnMessage(code)] }` for info, and `errorBody(...)`, `refused(...)` or `notFound(...)` for errors. A throttled request reuses the core code `throttled` (4000018). CAPTCHA refusals are plan 05's 4003xxx. The IDs below are final.

   | Code | ID | Type |
   |---|---|---|
   | `code_requested` | 1006001 | info |
   | `code_challenge_sent` | 1006002 | info |
   | `code_invalid_email` | 4006001 | error |
   | `code_no_challenge` | 4006002 | error |
   | `code_login_off` | 4006003 | error |

12. **CAPTCHA is plan 05's `captchaRefusal(this.Container, req, 'code', email)`.** It is called once per `POST /auth/code`, after the address bound check and before the throttle and any lookup.
13. **Fakes come from plan 06:** kit `MemoryAddressStore` and `RecordingCodeSender`, and core `MemoryOneTimeCodeStore`. This plan adds no kit fake.
14. **Rule id A36.** Plans 03, 05 and 06 each claim A33 and renumber in landing order to A33-A35, and plan 07 may take the next one. If A36 is taken when Task 8 runs, use the next free id. Rename it in five places: `RULE_IDS`, the spec file name and `defineRule`, `ALL`, `registry.test.ts`, and `core.test.ts` together with `coreHarness`.
15. **The code subject is `addressSubject('email', address)` for login and MFA codes alike**, as plan 06 does for verification codes (its Decision 3). A code is valid only for the address it went to. An address change therefore voids it, an unknown address costs exactly the same store call as a known one, and no throwaway ref is needed. The purposes `login` and `mfa` keep these codes apart from plan 06's `verify` codes on the same subject.
16. **A throttled `POST /auth/code` answers 429 with Retry-After.** Its keys are the address string and the IP only, so the answer tells nothing about the account.
17. **Throttle selection moves to `selectAuthnThrottle(container, name)`**, a pure move out of `DefaultAuthnService`, so `DefaultCodeLoginService` uses the same throttle.

## Security notes

- **Enumeration (A02, SR-04):** `POST /auth/code` returns the same 202 body for every address. Its timing covers only the CAPTCHA, the address format and the throttle, and none of these depends on whether the account exists. The lookup, issue and send run after the answer. A login always asks the address store and then the code store under the address subject, whether or not the address is known.
- **Brute force:** each code allows `authn.codes.maxAttempts` (5) answers. A sustained attacker gets about 24 codes a day per address (the `code` flow tops out at a 1 h wait), so about 120 guesses a day. Against 8 digits that is about 0.04 % a year. With 6 digits it would be about 4 %, which is why 8 is the default. The `login` flow's account key (`login:<email>`, shared with password logins for that string) bounds guesses again.
- **Pre-hijacking:** see Decision 2.
- **Weakness of email codes:** the code can be phished, and whoever reads the mailbox passes it. As a first factor it gives `aal1`. As a second factor it never follows a code login (`sameFactorAs`), roles can forbid it (`forbidForRoles`), and an identity enrolled in TOTP still has to pass TOTP after a code login (Decision 8).
- **Address changes:** codes are bound to the address (Decision 15), so a code mailed to an old address never works once the address changed. An MFA code is checked against the identity's current verified address.
- **Fresh auth:** `code` is interactive, so `reauthenticate` (A13) accepts a mailed code. It proves control of the mailbox, as a password reset does.

## Facts verified (2026-10-06, working copy of `authz-v3-refactor`)

- The strategy contract is `AuthenticationStrategy` (`packages/authn/src/contracts/strategy.ts:6-24`), not `AuthnStrategy`. It has `name`, `kinds`, `interactive`, `throttleKeys(c, ctx)` and `verify(c, ctx)`.
- `StrategyRegistry` reads `@Config('authn.strategies')` (`registry/strategy-registry.ts:61-62`), resolves each service by registration name through `nearestRegistration` and `instantiate` (`registry/named.ts:28-35`; a class resolves through the container, so `@PerChildInstance` + `@Inject(Container)` work), and `candidates(c)` filters by kind (`:93-98`).
- In the `DefaultAuthnService` pipeline (`service/default-authn-service.ts`), `authenticate` runs `:208-232`, `keysFor` turns an interactive strategy's `account` key into `login:<value>` and builds `account-ip` itself (`:533-555`, `:543`), and `accept` sets `assurance: 'aal1'` (`:418`), asks `policy.required` (`:428`) and issues a pending session (`:433-436`). `completeMfa` runs `:250-307`, and `passMfa` checks `required.includes(step)` (`:478`). The `mfa` and `reauth` keys come from `identityKeys` (`:558-560`), and throttle selection is `selectThrottle` (`:607-629`, constant `MEMORY_THROTTLE` at `:41`, called at `:198`).
- `Credentials` is a union with a catch-all member (`contracts/credentials.ts:5-16`). `AuthnFailure` includes `'expired'` (`:74`).
- `MfaStep` has no challenge method (`contracts/mfa.ts:6-25`). `MfaPolicy.required(id, facts: Pick<AuthnFacts, 'method' | 'strategy'>)` (`:28-31`) sees the login method, which is enough for the same-channel rule.
- `DefaultMfaPolicy.required` starts with `if (facts.method !== 'password') return [];` (`flow/default-mfa-policy.ts:55`). Its role lookup fails closed to "forced" (`:63-75`).
- `AuthnFacts.method` and `assurance` are at `contracts/principal.ts:34-48`.
- In the working copy, `ThrottleFlow` (`contracts/throttle.ts:9`), `ThrottleParams` (`:35-43`), `THROTTLE_FLOWS` (`:45`) and `DEFAULT_THROTTLE_PARAMS` (`:50-57`) are all in `contracts/throttle.ts`. This is an uncommitted move from `throttle/params.ts` (git status `M`). If `params.ts` still holds them when Task 2 runs, make the same edits there.
- `MemoryAuthnThrottle` builds one table per flow (`throttle/memory-throttle.ts:89`), and `flow()` indexes `this.params[flow]` (`:217-220`). `DbAuthnThrottle.flowParams` does the same (`authn-orm/src/throttle/db-throttle.ts:373-376`). The DB table has no flow column: the flow is part of the row-key HMAC (`:125-133`).
- In the schema (`schemas/authn.configuration.ts`), the `mfa` block is at `:194-236`, `policy` at `:198-206`, `throttle` at `:237-251` with `propertyNames` at `:240`, and `freshAuth` at `:252-258`. The shipped config `src/config/authn.ts:9-23` must equal the schema defaults (`test/boot/config-defaults.test.ts:55-76`).
- `AuthnEventType` is at `contracts/audit.ts:21`, and the contract test lists it exactly (`test/contracts/audit.test.ts:23`, `:154-156`).
- Contract shape tests pin the member lists exactly: `test/contracts/mfa.test.ts:199-219` and `:268-282`, `test/contracts/strategy.test.ts:146-163` and `:209-220`, `test/contracts/credentials.test.ts:46`, `test/contracts/throttle.test.ts:172-177`. The full schema defaults are pinned in `test/contracts/config-schema.test.ts:63-71` and `:271`.
- The enumeration-safe pattern is `LocalPasswordService.requestReset`: count, then defer (`authn-local/src/service.ts:189-199`). `DeferredWork` lives in `authn-local/src/deferred.ts:7-25`, and core cannot import it (dependency direction).
- `LocalPasswordStrategy.verify` reads the store for a fresh `randomUUID()` ref when the login is unknown (`authn-local/src/strategy.ts:99-104`). This plan needs no such ref, because the code subject comes from the input.
- `identityKey` exists only in `authn-orm/src/identity.ts:5` and `authn-totp/src/store/identity.ts:5`. Core has none, which is one more reason for address subjects.
- `packages/authn-orm/test/throttle-config.test.ts:22` (untracked) pins `THROTTLE_FLOWS`.
- Cross-plan facts are taken from the plan texts. Plan 06: Decision 3 and its `contracts/address.ts`, `MemoryAddressStore`, `RecordingCodeSender` and `MemoryOneTimeCodeStore`, `THROTTLE_FLOWS` with `verify`. Plan 05: "Integration for plans 06, 07 and 08" and Task 8's `captchaRefusal`. Plan 03: "How a consumer plan adds messages", `errorBody`, `refused`, `notFound`, core code `throttled` 4000018.
- `AuthnLoginController.login` (`authn-http/src/v3/controllers/AuthnLoginController.ts:33-60`) builds password credentials only (`:44-49`). `AuthnMfaController.complete` is at `:46-68`. The helpers `bodyField`, `boundedString`, `contextOf` and `pendingSteps` are in `src/v3/routes.ts:25-43` and `:106-112`, and `authnFailureResponse` is in `src/v3/responses.ts:23-27`.
- `@spinajs/http` has no 202 or 429 class, but `IResponseOptions.StatusCode` exists (`packages/http/src/interfaces.ts:297-301`), as do `HTTP_STATUS_CODE.ACCEPTED` (`:333`) and `TOO_MANY_REQUESTS` (`:420`).
- DI resolves the last registration of a type (`packages/di/src/container.ts:427`), and a child's own registry comes before its parent's (`packages/di/src/registry.ts:89-95`).
- Test harness (`packages/authn/test/behaviour/harness.ts`): `CoreOptions` is at `:31-45`, `bind` at `:156-159`, `buildCore` at `:195-204`, `prepareCore` at `:207-253`, `coreHarnessOf` at `:316-353` and `coreHarness` at `:356-358`. The v3 app (`authn-http/test/v3-app/app.ts`) has its config at `:57-68`, `wire` at `:128-145` and `resetRecorders` at `:308-314`. Its route list is in `suites/route-table.ts:26-40`.
- The kit rules are listed in `authn-testing/src/behaviour/types.ts:8` (`RULE_IDS`), with ports at `:17-57` and the rule list at `behaviour/index.ts:40`. The registry test pins `RULE_IDS` and the facet map (`authn-testing/test/registry.test.ts:7`, `:48-54`). `EventsPort` has only `all()` and `clear()` (`harness/ports.ts:120-123`).
- Throttle selection is already covered by `test/service/default-authn-service.test.ts:1517-1549`.

**Facts that contradict the brief:** the contract is named `AuthenticationStrategy`. `maxAttempts` belongs to plan 06's `authn.codes`, not to `authn.code`. `sendCooldownSeconds` is replaced by the `code` throttle flow. The default policy currently ignores every method except `password`. `ThrottleFlow` has no `code` member.

## File structure

| File | Task | Responsibility |
|---|---|---|
| `packages/authn/src/contracts/code-login.ts` (new) | 1 | `CodeLoginService`, `CodeRequestResult`, bounds |
| `packages/authn/src/messages/code-login.ts` (new), `messages/catalogue.ts` | 1 | `CODE_LOGIN_MESSAGES` in plan 03's catalogue |
| `packages/authn/src/contracts/{credentials,audit,mfa,service,index}.ts` | 1 | `code` credential, `code.request`, `MfaStep.challenge?`/`sameFactorAs?`, `AuthnService.challengeMfa?` |
| `packages/authn/src/contracts/throttle.ts`, `throttle/memory-throttle.ts`, `authn-orm/src/throttle/db-throttle.ts`, schema, shipped config | 2 | the `code` throttle flow |
| `packages/authn/src/code/support.ts` (new) | 3 | `requiredService`, `optionalService` |
| `packages/authn/src/code/code-strategy.ts` (new) | 3 | `CodeStrategy` |
| `packages/authn/src/throttle/select.ts` (new) | 4 | `selectAuthnThrottle` (moved) |
| `packages/authn/src/code/code-login-service.ts` (new) | 4 | `DefaultCodeLoginService` |
| `packages/authn/src/flow/same-factor.ts` (new) | 5 | `duplicatesFirstFactor` |
| `packages/authn/src/code/email-code-step.ts` (new) | 5 | `EmailCodeMfaStep` |
| `packages/authn/src/service/default-authn-service.ts` | 4, 5 | throttle selection call, `challengeMfa`, same-factor guard |
| `packages/authn/src/flow/default-mfa-policy.ts` | 6 | code logins, same-factor filter, `forbidForRoles` |
| `packages/authn-http/src/v3/controllers/AuthnCodeController.ts` (new), `AuthnLoginController.ts`, `AuthnMfaController.ts`, `routes.ts`, `responses.ts` | 7 | HTTP routes |
| `packages/authn-testing/src/behaviour/A36-email-code.spec.ts` (new) + kit registry | 8 | behaviour rule |
| `docs/authn/README.md` | 8 | documentation |

The tasks run strictly in order, because each one rebuilds `authn` before the next reads `lib/`.

---

### Task 1: Contracts and messages for code login

**Files:**
- Create: `packages/authn/src/contracts/code-login.ts`, `packages/authn/src/messages/code-login.ts`
- Modify: `packages/authn/src/contracts/credentials.ts:5-16`, `packages/authn/src/contracts/audit.ts:21`, `packages/authn/src/contracts/mfa.ts:5-25`, `packages/authn/src/contracts/service.ts` (whole file), `packages/authn/src/contracts/index.ts` (one line), `packages/authn/src/messages/catalogue.ts` (`PARTS`, `DEFINITIONS`), `packages/authn/src/messages/index.ts` (one line)
- Test: `packages/authn/test/contracts/code-login.test.ts` (new); `test/messages/catalogue.test.ts` (`PINNED`, range test); `docs/authn/messages.md` (golden, regenerated); `credentials.test.ts:46` and after `:64`; `audit.test.ts:23`; `mfa.test.ts:199-219`, `:233-248`, `:268-282`; `strategy.test.ts:146-163`, `:209-220`

**Interfaces:**
- Consumes: nothing new.
- Produces (all from `@spinajs/authn/contracts`):
  - `Credentials` member `{ readonly kind: 'code'; readonly email: string; readonly code: string }`
  - `AuthnEventType` member `'code.request'`
  - `MfaStep.sameFactorAs?: readonly string[]`, `MfaStep.challenge?(id: IdentityRef): Promise<void>`
  - `type MfaChallengeResult = { readonly status: 'sent' } | { readonly status: 'throttled'; readonly retryAfterSeconds: number } | { readonly status: 'refused' }`
  - `AuthnService.challengeMfa?(pending: SessionHandle, step: string, ctx: AuthnContext): Promise<MfaChallengeResult>`
  - `abstract class CodeLoginService extends AsyncService { abstract request(email: string, ctx: AuthnContext): Promise<CodeRequestResult> }`
  - `type CodeRequestResult = { readonly status: 'accepted' } | { readonly status: 'throttled'; readonly retryAfterSeconds: number } | { readonly status: 'invalid' } | { readonly status: 'disabled' }`
  - `EMAIL_MAX_LENGTH = 254`, `LOGIN_CODE_MAX_LENGTH = 10`
- Produces (from `@spinajs/authn/messages`): `CODE_LOGIN_MESSAGES` with the codes `code_requested` (1006001), `code_challenge_sent` (1006002), `code_invalid_email` (4006001), `code_no_challenge` (4006002) and `code_login_off` (4006003). All of them join `AuthnMessageCode`, and the three errors join `AuthnErrorCode`.

- [ ] **Step 1: Check the prerequisites**

Run from the repo root:
```bash
grep -n "export abstract class OneTimeCodeStore\|export abstract class CodeSender" packages/authn/src/contracts/codes.ts
grep -n "export abstract class AddressStore" packages/authn/src/contracts/identity.ts
grep -n "export function normalizeAddress\|export const addressSubject" packages/authn/src/contracts/address.ts
grep -n "export class MemoryOneTimeCodeStore" packages/authn/src/codes/memory-code-store.ts
grep -n "export class MemoryAddressStore\|export class RecordingCodeSender" packages/authn-testing/src/fakes/addresses.ts packages/authn-testing/src/fakes/codes.ts
grep -n "'verify'" packages/authn/src/contracts/throttle.ts
grep -n "export abstract class CaptchaGate" packages/authn/src/contracts/captcha.ts
grep -n "'captcha.fail'" packages/authn/src/contracts/audit.ts
grep -n "export async function captchaRefusal" packages/authn-http/src/v3/captcha.ts
grep -n "const PARTS\|const DEFINITIONS" packages/authn/src/messages/catalogue.ts
grep -n "export function errorBody" packages/authn-http/src/policies/v3/errors.ts
```
Expected: each command prints at least one line. If one prints nothing, stop: plans 03, 05 or 06 have not landed.

- [ ] **Step 2: Write the failing tests**

Create `packages/authn/test/contracts/code-login.test.ts`:

```ts
import { expect } from 'chai';
import 'mocha';
import { AsyncService } from '@spinajs/di';

import { CodeLoginService, EMAIL_MAX_LENGTH, LOGIN_CODE_MAX_LENGTH } from '../../src/contracts/code-login.js';
import type { CodeRequestResult } from '../../src/contracts/code-login.js';
import * as index from '../../src/contracts/index.js';
import { authnMessage } from '../../src/messages/index.js';
import { same } from './source-shape.js';

describe('contracts: code login (plan 08)', () => {
  it('CodeLoginService is an abstract AsyncService re-exported from the index', () => {
    expect(Object.getPrototypeOf(CodeLoginService)).to.eq(AsyncService);
    expect(index.CodeLoginService).to.eq(CodeLoginService);
  });

  it('CodeRequestResult is exactly the four answers', () => {
    same<CodeRequestResult, { readonly status: 'accepted' } | { readonly status: 'throttled'; readonly retryAfterSeconds: number } | { readonly status: 'invalid' } | { readonly status: 'disabled' }>(true);
  });

  it('bounds an address and a code', () => {
    expect([EMAIL_MAX_LENGTH, LOGIN_CODE_MAX_LENGTH]).to.deep.eq([254, 10]);
  });

  it('the catalogue renders the plan 08 messages', () => {
    expect(authnMessage('code_requested')).to.deep.eq({ id: 1006001, code: 'code_requested', type: 'info', text: 'If this address belongs to an account, a sign-in code is on its way.' });
    expect(authnMessage('code_no_challenge').id).to.eq(4006002);
  });
});
```

In `packages/authn/test/messages/catalogue.test.ts`, append to `PINNED`:

```ts
  [1006001, 'code_requested', 'info'],
  [1006002, 'code_challenge_sent', 'info'],
  [4006001, 'code_invalid_email', 'error'],
  [4006002, 'code_no_challenge', 'error'],
  [4006003, 'code_login_off', 'error'],
```

In the `each part stays in its README range` test, add after the `PASSWORD_MESSAGES` loop (and add `CODE_LOGIN_MESSAGES` to the `'../../src/messages/code-login.js'` import of that file):

```ts
    for (const [code, d] of Object.entries(CODE_LOGIN_MESSAGES) as [string, AuthnMessageDefinition][]) {
      expect(within(d.id, 1006000, 1006999) || within(d.id, 4006000, 4006999), code).to.eq(true);
    }
```

In `test/contracts/credentials.test.ts` replace line 46 with:

```ts
      same<Credentials, { readonly kind: 'password'; readonly login: string; readonly password: string } | { readonly kind: 'bearer'; readonly token: string } | { readonly kind: 'jws-assertion'; readonly jws: string } | { readonly kind: 'http-signature'; readonly request: SignedRequest } | { readonly kind: 'key-challenge'; readonly keyId: string; readonly challengeId: string; readonly signature: string } | { readonly kind: 'external'; readonly provider: string; readonly payload: Readonly<Record<string, unknown>> } | { readonly kind: 'code'; readonly email: string; readonly code: string } | { readonly kind: string; readonly [k: string]: unknown }>(true);
```

and right after the `same<Password, …>(true);` line (64) add:

```ts
      type Code = Extract<Credentials, { kind: 'code' }>;
      same<Code, { readonly kind: 'code'; readonly email: string; readonly code: string }>(true);
```

In `test/contracts/audit.test.ts` line 23, append `'code.request'` as the last member of `EVENT_TYPES`. Keep every member that plans 04-07 appended before it:

```ts
const EVENT_TYPES = [/* …every member already listed, unchanged… */ 'throttle.block', /* members other plans appended */ 'code.request'] as const;
```

(Write the literal list: today's line 23 plus whatever 05 and 06 appended, with `'code.request'` last.)

In `test/contracts/mfa.test.ts`, in the `MfaStep` member list (`:203-212`), add after the `disable` entry:

```ts
            { name: 'sameFactorAs', modifiers: ['readonly'], optional: true, params: null },
            { name: 'challenge', modifiers: [], optional: true, params: ['id'] },
```

In the `docs carry the rules a reader needs` test (after `:247`) add:

```ts
      expect(docOf(step, 'sameFactorAs')).to.contain('no second factor');
      expect(docOf(step, 'challenge')).to.contain("'code' throttle flow");
```

In `MfaStep members have the design types` (after `:281`) add:

```ts
      same<MfaStep['sameFactorAs'], readonly string[] | undefined>(true);
      same<MfaStep['challenge'], ((id: IdentityRef) => Promise<void>) | undefined>(true);
```

In `test/contracts/strategy.test.ts`, in the `AuthnService` member list (`:150-156`), add after the `completeMfa` entry:

```ts
            { name: 'challengeMfa', modifiers: [], params: ['pending', 'step', 'ctx'] },
```

In `AuthnService members have the design types` (after `:219`) add:

```ts
      same<AuthnService['challengeMfa'], ((pending: SessionHandle, step: string, ctx: AuthnContext) => Promise<MfaChallengeResult>) | undefined>(true);
```

and extend the `service.js` import on line 10:

```ts
import { AuthnService, PrincipalFactory } from '../../src/contracts/service.js';
import type { MfaChallengeResult } from '../../src/contracts/service.js';
```

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/code-login.test.ts test/contracts/credentials.test.ts test/contracts/audit.test.ts test/contracts/mfa.test.ts test/contracts/strategy.test.ts test/messages/catalogue.test.ts`
Expected: FAIL at compile time with `Cannot find module '../../src/contracts/code-login.js'`, `Module '"../../src/contracts/service.js"' has no exported member 'MfaChallengeResult'`, and `Argument of type '"code_requested"' is not assignable to parameter of type 'AuthnMessageCode'`.

- [ ] **Step 4: Implement**

Create `packages/authn/src/contracts/code-login.ts`:

```ts
import { AsyncService } from '@spinajs/di';
import type { AuthnContext } from './credentials.js';

/** RFC 5321 path limit; a longer value is never an address. */
export const EMAIL_MAX_LENGTH = 254;

/** The longest code `authn.code.length` allows. */
export const LOGIN_CODE_MAX_LENGTH = 10;

export type CodeRequestResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'throttled'; readonly retryAfterSeconds: number }
  /** Not one email address. */
  | { readonly status: 'invalid' }
  /** No listed strategy takes credentials of kind 'code'. */
  | { readonly status: 'disabled' };

/** POST /auth/code (plan 08). */
export abstract class CodeLoginService extends AsyncService {
  /**
   * Counts the request in the 'code' throttle flow (address and ip keys) and answers at once; the lookup, issue and send run
   * afterwards, so the answer and its timing are the same for every address (A02, SR-04). Only a verified address of an active
   * identity (any address under authn.code.allowUnverified) gets a code of purpose 'login'.
   */
  abstract request(email: string, ctx: AuthnContext): Promise<CodeRequestResult>;
}
```

Create `packages/authn/src/messages/code-login.ts`:

```ts
import type { AuthnMessageDefinition } from './types.js';

// Plan 08's range (docs/auth-feat/README.md, "Message IDs"). Append only: a released id never changes its meaning.
export const CODE_LOGIN_MESSAGES = {
  code_requested: { id: 1006001, type: 'info', text: 'If this address belongs to an account, a sign-in code is on its way.' },
  code_challenge_sent: { id: 1006002, type: 'info', text: 'A sign-in code was sent to your verified email address.' },
  code_invalid_email: { id: 4006001, type: 'error', text: 'Enter one valid email address.' },
  code_no_challenge: { id: 4006002, type: 'error', text: 'This step does not send codes.' },
  code_login_off: { id: 4006003, type: 'error', text: 'Sign-in by email code is not enabled.' },
} as const satisfies Readonly<Record<string, AuthnMessageDefinition>>;
```

In `packages/authn/src/messages/catalogue.ts`, import it (`import { CODE_LOGIN_MESSAGES } from './code-login.js';`), add `CODE_LOGIN_MESSAGES` to the `PARTS` tuple, and add `...CODE_LOGIN_MESSAGES` to the `DEFINITIONS` spread. Other plans' parts stay as they are. In `packages/authn/src/messages/index.ts` add `export * from './code-login.js';`.

In `packages/authn/src/contracts/credentials.ts` replace lines 5-16 with:

```ts
export type Credentials =
  | { readonly kind: 'password'; readonly login: string; readonly password: string }
  /** spt_… API token or a JWT. */
  | { readonly kind: 'bearer'; readonly token: string }
  /** Client assertion signed by a registered key. */
  | { readonly kind: 'jws-assertion'; readonly jws: string }
  /** RFC 9421 subset. */
  | { readonly kind: 'http-signature'; readonly request: SignedRequest }
  | { readonly kind: 'key-challenge'; readonly keyId: string; readonly challengeId: string; readonly signature: string }
  /** OIDC code, SAML response, LDAP bind. */
  | { readonly kind: 'external'; readonly provider: string; readonly payload: Readonly<Record<string, unknown>> }
  /** A sign-in code mailed by POST /auth/code, with the address it went to. */
  | { readonly kind: 'code'; readonly email: string; readonly code: string }
  | { readonly kind: string; readonly [k: string]: unknown };
```

In `packages/authn/src/contracts/audit.ts` line 21, append `| 'code.request'` as the last member of `AuthnEventType`. Keep the members other plans appended.

In `packages/authn/src/contracts/mfa.ts` replace lines 5-25 (the `MfaStep` class and its doc) with:

```ts
/** TotpMfaStep in authn-totp; EmailCodeMfaStep in authn (plan 08). */
export abstract class MfaStep {
  /** e.g. 'totp'. 'recovery' is reserved: completeMfa's step for recovery codes. */
  abstract readonly name: string;
  abstract enrolled(id: IdentityRef): Promise<boolean>;
  /** Shown to the owner only. The caller requires fresh auth first (A10). */
  abstract beginEnrolment(id: IdentityRef): Promise<{ provisioning: string }>;
  /** Recovery codes are returned once, stored as SHA-256 and single use (A10). */
  abstract confirmEnrolment(id: IdentityRef, response: string): Promise<{ recoveryCodes?: readonly string[] }>;
  /** Takes a step code only, never a recovery code. Counts into the throttle via AuthnService (flow 'mfa'); a code (time step) is accepted once (A10). */
  abstract verify(id: IdentityRef, response: string): Promise<boolean>;
  /** For steps that issue recovery codes. Single use; counts into the throttle via AuthnService (flow 'mfa') (A10). */
  verifyRecovery?(id: IdentityRef, code: string): Promise<boolean>;
  /** /user/mfa/recovery-codes; the route requires fresh auth (A13). Returns the new codes once and voids the old ones (A10). */
  regenerateRecoveryCodes?(id: IdentityRef): Promise<readonly string[]>;
  /**
   * Owner: the caller checks fresh auth and a valid code or recovery code first.
   * Admin reset (target guard, A25) also lands here and never receives a secret (A10).
   */
  abstract disable(id: IdentityRef): Promise<void>;
  /**
   * AuthnFacts.method values this step proves the same thing as: after a login by one of them it is no second factor, and
   * neither DefaultMfaPolicy nor AuthnService takes it (email-code after a code login).
   */
  readonly sameFactorAs?: readonly string[];
  /** Steps that send their code (email, SMS): issues and sends one. AuthnService.challengeMfa calls it, counted in the 'code' throttle flow. */
  challenge?(id: IdentityRef): Promise<void>;
}
```

Replace `packages/authn/src/contracts/service.ts` with:

```ts
import { AsyncService } from '@spinajs/di';
import type { AuthenticationResult, AuthnContext, Credentials, IdentityRef } from './credentials.js';
import type { AuthnFacts, Ceiling, Principal } from './principal.js';
import type { SessionHandle } from './session.js';
import type { AuthenticationStrategy } from './strategy.js';

export type MfaChallengeResult = { readonly status: 'sent' } | { readonly status: 'throttled'; readonly retryAfterSeconds: number } | { readonly status: 'refused' };

/** The entry point. One per app (root container). */
export abstract class AuthnService extends AsyncService {
  abstract authenticate(c: Credentials, ctx: AuthnContext): Promise<AuthenticationResult>;
  /** Step 'recovery' (POST /auth/mfa/recovery): `response` is a recovery code, checked by the pending steps' MfaStep.verifyRecovery (A10). */
  abstract completeMfa(pending: SessionHandle, step: string, response: string, ctx: AuthnContext): Promise<AuthenticationResult>;
  /**
   * POST /auth/mfa/challenge: has `step`, one the pending session needs, send its code (MfaStep.challenge), counted in the 'code'
   * throttle flow under the identity's keys. 'refused' covers no pending session, a step it does not need, a step that sends
   * nothing, and one that duplicates the first factor; the reason goes to audit only.
   */
  challengeMfa?(pending: SessionHandle, step: string, ctx: AuthnContext): Promise<MfaChallengeResult>;
  /**
   * Fresh authentication (A13). A success counts for the current request only: it changes no session facts and does not rotate the id.
   * A throttled re-authentication returns false; the route answers like any failed re-authentication.
   */
  abstract reauthenticate(session: SessionHandle, c: Credentials, ctx: AuthnContext): Promise<boolean>;
  /** Via PrincipalFactory. */
  abstract principalOf(result: Extract<AuthenticationResult, { status: 'success' }>): Promise<Principal>;
  abstract strategies(): readonly AuthenticationStrategy[];
}

/** users: UserPrincipalFactory; apps: service and agent principals. */
export abstract class PrincipalFactory {
  /** extra.attributes come from the strategy (see StrategyOutcome.attributes); keys this factory or a PrincipalAttributeProvider derives win over them (§18.3(e)). */
  abstract principalOf(id: IdentityRef, facts: AuthnFacts, extra: { ceiling?: Ceiling; onBehalfOf?: Principal; delegation?: 'inherit' | 'intersect'; attributes?: Readonly<Record<string, unknown>> }): Promise<Principal>;
}
```

In `packages/authn/src/contracts/index.ts` add as the last line:

```ts
export * from './code-login.js';
```

- [ ] **Step 5: GREEN, package suite, dependents**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/code-login.test.ts test/contracts/credentials.test.ts test/contracts/audit.test.ts test/contracts/mfa.test.ts test/contracts/strategy.test.ts test/messages/catalogue.test.ts`. Expected: all passing.
2. Regenerate the message docs: `cd packages/authn && UPDATE_GOLDEN=1 npx ts-mocha -p tsconfig.json test/messages/doc.test.ts`. Expected: `docs/authn/messages.md` gains the five `code_*` rows.
3. `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npm test`. Expected: all passing (`test/contracts/boundary.test.ts` reads both builds).
4. Dependents compile. In each of `packages/authn-testing`, `packages/authn-http` and `packages/authn-totp`, run `npx tsc -b tsconfig.mjs.json`. Expected: no output. Every new member is optional, so `FakeAuthnService` and the TOTP step need no change.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/messages/code-login.ts packages/authn/src/messages/catalogue.ts packages/authn/src/messages/index.ts packages/authn/test/messages/catalogue.test.ts docs/authn/messages.md packages/authn/src/contracts/code-login.ts packages/authn/src/contracts/credentials.ts packages/authn/src/contracts/audit.ts packages/authn/src/contracts/mfa.ts packages/authn/src/contracts/service.ts packages/authn/src/contracts/index.ts packages/authn/test/contracts/code-login.test.ts packages/authn/test/contracts/credentials.test.ts packages/authn/test/contracts/audit.test.ts packages/authn/test/contracts/mfa.test.ts packages/authn/test/contracts/strategy.test.ts
git diff --cached --stat
git commit -m "feat(authn): contracts for passwordless email code login and MFA challenges"
```

---

### Task 2: The `code` throttle flow

**Files:**
- Modify: `packages/authn/src/contracts/throttle.ts:9`, `:35-57` (or `throttle/params.ts`, see Facts)
- Modify: `packages/authn/src/throttle/memory-throttle.ts:11` (import), `:89`, `:217-220`
- Modify: `packages/authn-orm/src/throttle/db-throttle.ts:3` (import), `:373-376`
- Modify: `packages/authn/src/schemas/authn.configuration.ts:240-246`
- Modify: `packages/authn/src/config/authn.ts:16-23`
- Test: `packages/authn/test/contracts/throttle.test.ts:172-177`, `packages/authn/test/throttle/memory-throttle.test.ts` (describe `flows`, after `:351`), `packages/authn/test/contracts/config-schema.test.ts:63-71`, `packages/authn-orm/test/db-throttle.test.ts` (store describe), `packages/authn-orm/test/throttle-config.test.ts:22`

This task builds on plan 06's `verify` flow. Afterwards there are six flows, in this order: `login`, `mfa`, `reset`, `reauth`, `verify`, `code`. Plan 06 made `verify` required in `ThrottleParams` and it stays required. `code` is optional and falls back to its defaults, so explicit params written before it (kit, tests) keep working. Line numbers below are today's; plan 06 shifts them by its one-line additions next to each `reauth` entry.

**Interfaces:**
- Consumes: plan 06's `verify` member in `ThrottleFlow`, `ThrottleParams`, `THROTTLE_FLOWS`, `DEFAULT_THROTTLE_PARAMS`, the schema, the shipped config and the memory throttle tables.
- Produces: `ThrottleFlow` member `'code'`. `ThrottleParams.code?: ThrottleFlowParams`. `DEFAULT_THROTTLE_PARAMS: ThrottleParams & { readonly code: ThrottleFlowParams }` with `code = { account: { free: 3, baseDelayMs: 60000, maxDelayMs: 3600000 }, ip: { free: 10, baseDelayMs: 10000, maxDelayMs: 900000 } }`. `throttleFlowParams(p: ThrottleParams, flow: ThrottleFlow): ThrottleFlowParams`. Schema key `authn.throttle.code`.

- [ ] **Step 1: Schema additions**

In `authn.configuration.ts`, line 240 becomes:

```ts
      propertyNames: { enum: ['service', 'login', 'mfa', 'reset', 'reauth', 'verify', 'code', 'resetAfterSeconds', 'global', 'maxRows'] },
```

and after plan 06's `verify:` line (after `reauth:`, line 246 today) add:

```ts
        code: flow({ free: 3, baseDelayMs: 60000, maxDelayMs: 3600000 }, { free: 10, baseDelayMs: 10000, maxDelayMs: 900000 }),
```

In `src/config/authn.ts`, after plan 06's `verify:` line (after `reauth:`, line 20 today) add:

```ts
      code: { account: { free: 3, baseDelayMs: 60000, maxDelayMs: 3600000 }, ip: { free: 10, baseDelayMs: 10000, maxDelayMs: 900000 } },
```

- [ ] **Step 2: Write the failing tests**

`test/contracts/throttle.test.ts`, replace `:172-177` with:

```ts
    it('ThrottleFlow is exactly the six flows', () => {
      same<ThrottleFlow, 'login' | 'mfa' | 'reset' | 'reauth' | 'verify' | 'code'>(true);
      // @ts-expect-error no signup flow
      const f: ThrottleFlow = 'signup';
      void f;
    });
```

`test/throttle/memory-throttle.test.ts`, in `describe('flows')` after the `reauth has no ip gate by default` test add:

```ts
    it('code follows its own account parameters', async () => {
      const p = DEFAULT_THROTTLE_PARAMS.code.account!;
      await walkBackoff({ throttle: real(DEFAULT_THROTTLE_PARAMS), flow: 'code', params: p, clock, attempts: p.free + 4, keysFor: () => [{ kind: 'account', value: 'flow-code@example.test' }] });
    });

    it('code takes DEFAULT_THROTTLE_PARAMS.code when explicit params predate the flow', async () => {
      const p = DEFAULT_THROTTLE_PARAMS.code.account!;
      await walkBackoff({ throttle: real(DEFAULT_THROTTLE), flow: 'code', params: p, clock, attempts: p.free + 4, keysFor: () => [{ kind: 'account', value: 'old-params@example.test' }] });
    });
```

`packages/authn-orm/test/throttle-config.test.ts:22` becomes:

```ts
    expect(THROTTLE_FLOWS).to.deep.eq(['login', 'mfa', 'reset', 'reauth', 'verify', 'code']);
```

`test/contracts/config-schema.test.ts`, in `THROTTLE_DEFAULTS` (`:63-71`), add after plan 06's `verify`:

```ts
  code: { account: { free: 3, baseDelayMs: 60000, maxDelayMs: 3600000 }, ip: { free: 10, baseDelayMs: 10000, maxDelayMs: 900000 } },
```

`packages/authn-orm/test/db-throttle.test.ts`, inside `describe(\`DbAuthnThrottle store (${kind})\`)` after the `peek refuses while a delay holds` test add:

```ts
    it('counts the code flow under the §22.5 code limits when the params predate the flow', async () => {
      const throttle = new DbAuthnThrottle(db.driver, DEFAULT_THROTTLE);
      const key: ThrottleKey = { kind: 'account', value: 'code-flow@example.test' };
      for (let i = 0; i < 3; i++) expect(await throttle.attempt([key], 'code', ctxAt(T0)), `attempt ${i + 1}`).to.deep.eq({ allowed: true });
      expect(await throttle.attempt([key], 'code', ctxAt(T0))).to.deep.eq({ allowed: false, retryAfterSeconds: 60 });
      expect(await throttle.attempt([key], 'login', ctxAt(T0)), 'flows count apart').to.deep.eq({ allowed: true });
    });
```

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/throttle.test.ts test/throttle/memory-throttle.test.ts test/contracts/config-schema.test.ts`
Expected: FAIL at compile time with `Type '"code"' is not assignable to type 'ThrottleFlow'` and `Property 'code' does not exist on type 'ThrottleParams'`.

- [ ] **Step 4: Implement**

`contracts/throttle.ts`:

```ts
export type ThrottleFlow = 'login' | 'mfa' | 'reset' | 'reauth' | 'verify' | 'code';
```

In `ThrottleParams`, after plan 06's `readonly verify: ThrottleFlowParams;` add:

```ts
  /** Sign-in code requests (plan 08). Optional so params written before the flow existed still type-check; throttles then use DEFAULT_THROTTLE_PARAMS.code. */
  readonly code?: ThrottleFlowParams;
```

Replace `THROTTLE_FLOWS` and `DEFAULT_THROTTLE_PARAMS` with:

```ts
export const THROTTLE_FLOWS: readonly ThrottleFlow[] = Object.freeze(['login', 'mfa', 'reset', 'reauth', 'verify', 'code']);

const backoff = (free: number, baseDelayMs: number, maxDelayMs: number): BackoffParams => Object.freeze({ free, baseDelayMs, maxDelayMs });

/** Design §22.5 `authn.throttle`; the schema defaults equal it (test/boot/config-defaults.test.ts). */
export const DEFAULT_THROTTLE_PARAMS: ThrottleParams & { readonly code: ThrottleFlowParams } = Object.freeze({
  login: Object.freeze({ account: backoff(5, 1000, 60000), ip: backoff(20, 1000, 300000) }),
  mfa: Object.freeze({ account: backoff(3, 1000, 300000), ip: backoff(20, 1000, 300000) }),
  reset: Object.freeze({ account: backoff(1, 60000, 3600000), ip: backoff(5, 10000, 900000) }),
  reauth: Object.freeze({ account: backoff(3, 1000, 300000) }),
  verify: Object.freeze({ account: backoff(3, 60000, 3600000), ip: backoff(10, 10000, 900000) }),
  code: Object.freeze({ account: backoff(3, 60000, 3600000), ip: backoff(10, 10000, 900000) }),
  resetAfterSeconds: 86400,
  global: null,
});

/** The params of `flow`; params written before the code flow existed get DEFAULT_THROTTLE_PARAMS.code. */
export function throttleFlowParams(p: ThrottleParams, flow: ThrottleFlow): ThrottleFlowParams {
  return p[flow] ?? DEFAULT_THROTTLE_PARAMS[flow];
}
```

`throttle/memory-throttle.ts`: add `throttleFlowParams` to the `'../contracts/throttle.js'` import (line 11). Line 89 becomes:

```ts
    this.tables = Object.freeze({ login: table(), mfa: table(), reset: table(), reauth: table(), verify: table(), code: table() });
```

and `flow()` (`:217-220`):

```ts
  private flow(flow: ThrottleFlow): ThrottleFlowParams {
    if (!THROTTLE_FLOWS.includes(flow)) throw new InvalidArgument(`MemoryAuthnThrottle: unknown flow ${JSON.stringify(String(flow))}`);
    return throttleFlowParams(this.params, flow);
  }
```

`authn-orm/src/throttle/db-throttle.ts`: add `throttleFlowParams` to the `@spinajs/authn/contracts` import (line 3). `flowParams` (`:373-376`) becomes:

```ts
  private flowParams(flow: ThrottleFlow): ThrottleFlowParams {
    if (!THROTTLE_FLOWS.includes(flow)) throw new InvalidArgument(`DbAuthnThrottle: unknown flow ${JSON.stringify(String(flow))}`);
    return throttleFlowParams(this.params, flow);
  }
```

- [ ] **Step 5: GREEN, package suites, dependents**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/throttle.test.ts test/throttle/memory-throttle.test.ts test/contracts/config-schema.test.ts test/boot/config-defaults.test.ts`. Expected: all passing. `config-defaults` passes because the shipped config and the schema both gained `code`, and both equal `DEFAULT_THROTTLE_PARAMS`.
2. `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npm test`. Expected: all passing.
3. `cd packages/authn-orm && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npx ts-mocha -p tsconfig.json test/db-throttle.test.ts`. Expected: passing for sqlite. Postgres is skipped with a warning when `127.0.0.1:15432` is unreachable.
4. `cd packages/authn-orm && npm test` and `cd packages/authn-testing && npm test`. Expected: all passing, `throttle-config.test.ts` included.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/contracts/throttle.ts packages/authn/src/throttle/memory-throttle.ts packages/authn/src/schemas/authn.configuration.ts packages/authn/src/config/authn.ts packages/authn-orm/src/throttle/db-throttle.ts packages/authn/test/contracts/throttle.test.ts packages/authn/test/throttle/memory-throttle.test.ts packages/authn/test/contracts/config-schema.test.ts packages/authn-orm/test/db-throttle.test.ts packages/authn-orm/test/throttle-config.test.ts
git diff --cached --stat
git commit -m "feat(authn): a code throttle flow for sign-in code requests"
```

---

### Task 3: `CodeStrategy`, the `authn.code` schema, code-login harness

**Files:**
- Create: `packages/authn/src/code/support.ts`, `packages/authn/src/code/code-strategy.ts`, `packages/authn/src/code/index.ts`
- Modify: `packages/authn/src/index.ts` (one line), `packages/authn/src/schemas/authn.configuration.ts` (after the `freshAuth` block, `:252-258` today)
- Modify: `packages/authn/test/behaviour/harness.ts`: imports `:5`, `:8`; a constant after `:16`; `CoreOptions` `:31-45`; `CoreParts` `:47-67`; `prepareCore` `:216-248`
- Test: `packages/authn/test/code/code-strategy.test.ts` (new), `packages/authn/test/contracts/config-schema.test.ts:271`, `packages/authn/test/boot/config-defaults.test.ts:75`

**Interfaces:**
- Consumes:
  - Plan 06: `AddressStore`, `OneTimeCodeStore`, `CodeSender`, `normalizeAddress`, `addressSubject` (contracts), `MemoryOneTimeCodeStore` (`@spinajs/authn`), and the kit fakes `MemoryAddressStore` and `RecordingCodeSender`.
  - Task 1: `LOGIN_CODE_MAX_LENGTH`.
- Produces:
  - Core: `requiredService<T>(container, type, name, owner): Promise<T>`, `optionalService<T>(container, type): Promise<T | null>`, and `class CodeStrategy` (name `'code'`, kinds `['code']`, interactive, method `'code'`). The code subject is `addressSubject('email', address)`, purpose `'login'`.
  - Schema `authn.code`: `{ ttlSeconds: 600 (60-3600), length: 8 (6-10), allowUnverified: false }`.
  - Harness: `CoreOptions.codeLogin?: boolean`; `CoreParts.addresses: MemoryAddressStore`, `CoreParts.codes: MemoryOneTimeCodeStore`, `CoreParts.codeSender: RecordingCodeSender`. All three are registered in every core child as `KitAddressStore`, `KitCodeStore` and `KitCodeSender`. A test's own `register` binding of the same name comes later and wins, which keeps plan 06's tests unchanged.

- [ ] **Step 1: Schema additions**

In `authn.configuration.ts`, after the `freshAuth` block add:

```ts
    code: {
      type: 'object',
      default: {},
      description: 'Sign-in codes sent by email (plan 08): CodeStrategy, DefaultCodeLoginService and EmailCodeMfaStep. Wrong answers per code: authn.codes.maxAttempts.',
      propertyNames: { enum: ['ttlSeconds', 'length', 'allowUnverified'] },
      properties: {
        ttlSeconds: { type: 'integer', minimum: 60, maximum: 3600, default: 600, description: 'How long a mailed login or MFA code stays valid.' },
        length: { type: 'integer', minimum: 6, maximum: 10, default: 8, description: 'Digits per login or MFA code; overrides authn.codes.length for these. With 5 answers per code and the code throttle flow, 8 digits keep a sustained guess near 0.04% a year per address.' },
        allowUnverified: { type: 'boolean', default: false, description: 'Also mail login codes to unverified addresses; a successful code login then marks the address verified. Off: a code never completes an account someone registered with the address first.' },
      },
    },
```

- [ ] **Step 2: Write the failing tests**

Create `packages/authn/test/code/code-strategy.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';
import { Configuration } from '@spinajs/configuration';

import { CodeStrategy, MemoryOneTimeCodeStore, OneTimeCodeStore, StrategyRegistry, addressSubject } from '../../src/index.js';
import type { AuthenticationResult, AuthnContext, CodeCheck, CodePurpose, IdentityRef } from '../../src/index.js';
import { bind, buildCore, configuredChild, useHarnessLog, violationPaths } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

const EMAIL = 'alice@example.test';
const ctx = (): AuthnContext => ({ now: new Date(), purpose: 'login', ip: '192.0.2.10' });
const INVALID = { status: 'failure', reason: 'invalid_credentials' };

function success(r: AuthenticationResult): Extract<AuthenticationResult, { status: 'success' }> {
  if (r.status !== 'success') throw new assert.AssertionError({ message: `expected a success, got ${JSON.stringify(r)}` });
  return r;
}

/** Records every subject and purpose the strategy asks about. */
class SpyCodeStore extends MemoryOneTimeCodeStore {
  readonly asked: string[] = [];

  async verify(subject: string, purpose: CodePurpose, code: string): Promise<CodeCheck> {
    this.asked.push(`${purpose}|${subject}`);
    return super.verify(subject, purpose, code);
  }
}

describe('CodeStrategy (plan 08)', function () {
  this.timeout(30000);

  useHarnessLog();

  let p: CoreParts;
  let alice: IdentityRef;

  async function boot(codes?: OneTimeCodeStore): Promise<void> {
    p = await buildCore({}, { codeLogin: true, ...(codes ? { register: (c) => bind(c, OneTimeCodeStore, 'KitCodeStore', codes) } : {}) });
    alice = p.identities.add({ login: 'alice', email: EMAIL });
    p.addresses.set(alice, 'email', EMAIL, new Date(0));
  }

  beforeEach(() => boot());

  afterEach(() => p.dispose());

  const issue = async (email: string, purpose = 'login'): Promise<string> => (await p.codes.issue(addressSubject('email', email), purpose, { ttlSeconds: 600, length: 8 })).code;

  it('is listed as code, interactive, for credentials of kind code, keyed by the normalized address', async () => {
    const candidates = (await p.child.resolve(StrategyRegistry)).candidates({ kind: 'code', email: EMAIL, code: '1' });
    assert.deepStrictEqual(
      candidates.map((s) => [s.name, s.interactive]),
      [['code', true]],
    );
    assert.ok(candidates[0] instanceof CodeStrategy);
    assert.deepStrictEqual(candidates[0].throttleKeys({ kind: 'code', email: ' Alice@Example.TEST ', code: '1' }, ctx()), [{ kind: 'account', value: EMAIL }]);
    assert.deepStrictEqual(candidates[0].throttleKeys({ kind: 'code', email: 'not-an-address', code: '1' }, ctx()), []);
  });

  it('logs in with a login code at aal1 with method code, and the code works once', async () => {
    const code = await issue(EMAIL);
    const r = success(await p.service.authenticate({ kind: 'code', email: ' Alice@Example.test', code }, ctx()));
    assert.deepStrictEqual(r.identity, alice);
    assert.deepStrictEqual([r.facts.method, r.facts.strategy, r.facts.assurance], ['code', 'code', 'aal1']);
    assert.deepStrictEqual(await p.service.authenticate({ kind: 'code', email: EMAIL, code }, ctx()), INVALID);
  });

  it("refuses an MFA code, another address's code, a wrong code, an unknown address and malformed input with one answer", async () => {
    const bob = p.identities.add({ login: 'bob', email: 'bob@example.test' });
    p.addresses.set(bob, 'email', 'bob@example.test', new Date(0));
    const mfa = await issue(EMAIL, 'mfa');
    const bobs = await issue('bob@example.test');
    const cases: [string, string, string][] = [
      ['an mfa code', EMAIL, mfa],
      ["bob's code", EMAIL, bobs],
      ['a wrong code', EMAIL, '00000000'],
      ['an unknown address', 'nobody@example.test', bobs],
      ['a code that is not digits', EMAIL, 'abc'],
      ['a code longer than 10 digits', EMAIL, '12345678901'],
      ['no address', 'not-an-address', bobs],
    ];
    for (const [what, email, code] of cases) assert.deepStrictEqual(await p.service.authenticate({ kind: 'code', email, code }, ctx()), INVALID, what);
  });

  it('asks the code store under the address subject, known address or not (A02)', async () => {
    await p.dispose();
    const spy = new SpyCodeStore();
    await boot(spy);
    await p.service.authenticate({ kind: 'code', email: 'nobody@example.test', code: '12345678' }, ctx());
    await p.service.authenticate({ kind: 'code', email: EMAIL, code: '12345678' }, ctx());
    assert.deepStrictEqual(spy.asked, [`login|${addressSubject('email', 'nobody@example.test')}`, `login|${addressSubject('email', EMAIL)}`]);
  });

  it('answers expired for an expired code', async () => {
    await p.dispose();
    const expired = new (class extends MemoryOneTimeCodeStore {
      async verify(): Promise<CodeCheck> {
        return 'expired';
      }
    })();
    await boot(expired);
    assert.deepStrictEqual(await p.service.authenticate({ kind: 'code', email: EMAIL, code: '12345678' }, ctx()), { status: 'failure', reason: 'expired' });
  });

  it('refuses a banned identity whose code is right', async () => {
    const code = await issue(EMAIL);
    p.identities.setStatus(alice, { banned: true });
    assert.deepStrictEqual(await p.service.authenticate({ kind: 'code', email: EMAIL, code }, ctx()), INVALID);
  });

  it('marks an unverified address verified on success', async () => {
    const carol = p.identities.add({ login: 'carol', email: 'carol@example.test' });
    p.addresses.set(carol, 'email', 'carol@example.test', null);
    const now = ctx();
    success(await p.service.authenticate({ kind: 'code', email: 'carol@example.test', code: await issue('carol@example.test') }, now));
    assert.deepStrictEqual(p.addresses.marked, [{ identity: carol, channel: 'email', value: 'carol@example.test', at: now.now }]);
  });
});

describe('authn.code schema (plan 08)', function () {
  this.timeout(30000);

  it('fills the defaults', async () => {
    const child = await configuredChild({ authn: {} });
    try {
      assert.deepStrictEqual(child.get(Configuration)!.get('authn.code'), { ttlSeconds: 600, length: 8, allowUnverified: false });
    } finally {
      await child.dispose();
    }
  });

  it('refuses values out of range and unknown keys, naming each path', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ length: 5 }, 'authn.code.length'],
      [{ length: 11 }, 'authn.code.length'],
      [{ ttlSeconds: 59 }, 'authn.code.ttlSeconds'],
      [{ ttlSeconds: 3601 }, 'authn.code.ttlSeconds'],
      [{ maxAttempts: 5 }, 'authn.code.maxAttempts'],
    ];
    for (const [code, path] of cases) {
      const paths = await violationPaths(configuredChild({ authn: { code } }));
      assert.ok(paths.includes(path), `${JSON.stringify(code)}: ${paths.join(', ')}`);
    }
  });
});
```

In `test/contracts/config-schema.test.ts`, add after `TOKEN_DEFAULTS` (`:60`):

```ts
const CODE_DEFAULTS = { ttlSeconds: 600, length: 8, allowUnverified: false };
```

and add `code: CODE_DEFAULTS` to the object asserted at `:271`, next to `freshAuth`.

In `test/boot/config-defaults.test.ts` line 75, add `code: check({}).config.code` to the expected object, after `jwt: { issuers: [] }`.

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/code/code-strategy.test.ts`
Expected: FAIL at compile time with `Module '"../../src/index.js"' has no exported member 'CodeStrategy'` and `Object literal may only specify known properties, and 'codeLogin' does not exist in type 'CoreOptions'`.

- [ ] **Step 4: Implement**

Create `packages/authn/src/code/support.ts`:

```ts
import type { Class, IContainer } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';

type Abstract<T> = abstract new (...args: never[]) => T;

export async function requiredService<T>(container: IContainer, type: Abstract<T>, name: string, owner: string): Promise<T> {
  if (!container.hasRegistered(type as unknown as Class<T>)) throw new InvalidOperation(`${owner}: no ${name} is registered`);
  return (await container.resolve(type as unknown as Class<T>)) as T;
}

export async function optionalService<T>(container: IContainer, type: Abstract<T>): Promise<T | null> {
  return container.hasRegistered(type as unknown as Class<T>) ? ((await container.resolve(type as unknown as Class<T>)) as T) : null;
}
```

Create `packages/authn/src/code/code-strategy.ts`:

```ts
import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { addressSubject, normalizeAddress } from '../contracts/address.js';
import { LOGIN_CODE_MAX_LENGTH } from '../contracts/code-login.js';
import { OneTimeCodeStore } from '../contracts/codes.js';
import type { AuthnContext, Credentials, IdentityRef, StrategyOutcome } from '../contracts/credentials.js';
import { AddressStore } from '../contracts/identity.js';
import { AuthenticationStrategy } from '../contracts/strategy.js';
import type { ThrottleKey } from '../contracts/throttle.js';
import { requiredService } from './support.js';

const INVALID: StrategyOutcome = { ok: false, reason: 'invalid_credentials' };
const UNSUPPORTED: StrategyOutcome = { ok: false, reason: 'unsupported_credentials' };

const isCodeKind = (c: Credentials): boolean => c !== null && typeof c === 'object' && c.kind === 'code';

/** The normalized address and the code of a 'code' credential, or null when either is missing or out of bounds. */
function codeFields(c: Credentials): { email: string; code: string } | null {
  if (!isCodeKind(c)) return null;
  const { email, code } = c as { email: unknown; code: unknown };
  if (typeof code !== 'string' || code.length > LOGIN_CODE_MAX_LENGTH || !/^[0-9]+$/.test(code)) return null;
  const address = normalizeAddress('email', email);
  return address === null ? null : { email: address, code };
}

/**
 * Passwordless login with a code mailed by POST /auth/code (plan 08). Verify only: the service counts the 'login' flow
 * under `login:<address>`, checks the status, asks the MFA policy and opens the session.
 */
@PerChildInstance()
@Injectable(AuthenticationStrategy)
@Inject(Container)
export class CodeStrategy extends AuthenticationStrategy {
  public readonly name = 'code';
  public readonly kinds: readonly string[] = ['code'];
  public readonly interactive = true;

  private addresses!: AddressStore;
  private codes!: OneTimeCodeStore;

  constructor(private readonly container: IContainer) {
    super();
  }

  public async resolve(): Promise<void> {
    this.addresses = await requiredService(this.container, AddressStore, 'AddressStore', 'CodeStrategy');
    this.codes = await requiredService(this.container, OneTimeCodeStore, 'OneTimeCodeStore', 'CodeStrategy');
    await super.resolve();
  }

  public throttleKeys(c: Credentials, _ctx: AuthnContext): readonly ThrottleKey[] {
    const fields = codeFields(c);
    return fields ? [{ kind: 'account', value: fields.email }] : [];
  }

  public async verify(c: Credentials, ctx: AuthnContext): Promise<StrategyOutcome> {
    const fields = codeFields(c);
    if (!fields) return isCodeKind(c) ? INVALID : UNSUPPORTED;
    // Both stores are asked on every path, so a known and an unknown address cost the same (A02).
    const id = await this.addresses.findByAddress('email', fields.email);
    const check = await this.codes.verify(addressSubject('email', fields.email), 'login', fields.code);
    if (check === 'expired') return { ok: false, reason: 'expired' };
    if (check !== 'ok' || !id) return INVALID;
    return (await this.proven(id, fields.email, ctx)) ? { ok: true, identity: id, method: 'code' } : INVALID;
  }

  /** The code reached `email`, so an unverified address becomes verified; false when it is no longer an address of `id`. */
  private async proven(id: IdentityRef, email: string, ctx: AuthnContext): Promise<boolean> {
    const address = (await this.addresses.addresses(id)).find((a) => a.channel === 'email' && a.value === email);
    if (!address) return false;
    return address.verifiedAt !== null || (await this.addresses.markVerified(id, 'email', email, ctx.now));
  }
}
```

Create `packages/authn/src/code/index.ts`:

```ts
export * from './support.js';
export * from './code-strategy.js';
```

In `packages/authn/src/index.ts` add as the last line:

```ts
export * from './code/index.js';
```

Harness (`packages/authn/test/behaviour/harness.ts`):

- Import line 5: add `MemoryAddressStore, RecordingCodeSender` to the `@spinajs/authn-testing` import.
- Import line 8: add `AddressStore, CodeSender, MemoryOneTimeCodeStore, OneTimeCodeStore` to the `'../../src/index.js'` import.
- After `export const KIT_MFA_STEP = 'KitMfaStep';` (`:16`) add:

```ts
/** CodeStrategy, listed as `code` after the other strategies when CoreOptions.codeLogin is set. */
const CODE_STRATEGY: StrategySpec = { name: 'code', service: 'CodeStrategy', listed: true };
```

- In `CoreOptions` (before the closing brace at `:45`) add:

```ts
  /** Lists CodeStrategy (plan 08) after the other strategies. The address, code and sender fakes are registered either way. */
  readonly codeLogin?: boolean;
```

- In `CoreParts` (before `dispose(): Promise<void>;`) add:

```ts
  readonly addresses: MemoryAddressStore;
  readonly codes: MemoryOneTimeCodeStore;
  readonly codeSender: RecordingCodeSender;
```

- In `prepareCore`, replace the `const strategies = …` line (`:221`) with:

```ts
  const addresses = new MemoryAddressStore();
  const codes = new MemoryOneTimeCodeStore();
  const codeSender = new RecordingCodeSender();
  const strategies = [...(opts.strategies ?? kitStrategies(identities, passwords, tokens, externalSubjects)), ...(opts.codeLogin ? [CODE_STRATEGY] : [])];
```

- After `bind(child, MfaStep, KIT_MFA_STEP, step);` (`:243`), before `opts.register?.(child);`, add:

```ts
    bind(child, AddressStore, 'KitAddressStore', addresses);
    bind(child, OneTimeCodeStore, 'KitCodeStore', codes);
    bind(child, CodeSender, 'KitCodeSender', codeSender);
```

- In the returned object (`:248`) add `addresses, codes, codeSender`.

- [ ] **Step 5: GREEN, package suite, dependents**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/code/code-strategy.test.ts test/contracts/config-schema.test.ts test/boot/config-defaults.test.ts`. Expected: all passing (9 in `code-strategy.test.ts`).
2. `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npm test`. Expected: all passing, plan 06's verification tests included (they bind their own `KitAddressStore`, which wins).
3. `cd packages/authn-http && npx tsc -b tsconfig.mjs.json`. Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/code/support.ts packages/authn/src/code/code-strategy.ts packages/authn/src/code/index.ts packages/authn/src/index.ts packages/authn/src/schemas/authn.configuration.ts packages/authn/test/behaviour/harness.ts packages/authn/test/code/code-strategy.test.ts packages/authn/test/contracts/config-schema.test.ts packages/authn/test/boot/config-defaults.test.ts
git diff --cached --stat
git commit -m "feat(authn): CodeStrategy logs in with a mailed sign-in code"
```

---

### Task 4: `DefaultCodeLoginService` (POST /auth/code) and `selectAuthnThrottle`

**Files:**
- Create: `packages/authn/src/throttle/select.ts`, `packages/authn/src/code/code-login-service.ts`
- Modify: `packages/authn/src/throttle/index.ts` (one line), `packages/authn/src/code/index.ts` (one line)
- Modify: `packages/authn/src/service/default-authn-service.ts`: import block `:18-26`, delete `:41` (`MEMORY_THROTTLE`), `:198`, delete `:607-629` (`selectThrottle`)
- Test: `packages/authn/test/code/code-login-service.test.ts` (new); the existing `test/service/default-authn-service.test.ts:1517-1549` guards the move

**Interfaces:**
- Consumes: Task 1 `CodeLoginService`, `CodeRequestResult`. Task 2 flow `'code'`. Plan 06 `normalizeAddress`, `addressSubject`. Task 3 `requiredService`, `optionalService`, the harness `codeLogin` option and the code fakes.
- Produces: `selectAuthnThrottle(container: IContainer, name: string | undefined): Promise<AuthnThrottle>`, and `class DefaultCodeLoginService extends CodeLoginService` with `request(email, ctx)` and `drain(): Promise<void>`. Audit `code.request` failure reasons are `unknown_address`, `status`, `unverified`, `no_sender` and `send_error`, all with `data.purpose: 'login'`. A refused request publishes `throttle.block` with `data.flow: 'code'`.

- [ ] **Step 1: Schema additions**

None. Task 3 added `authn.code`.

- [ ] **Step 2: Write the failing tests**

Create `packages/authn/test/code/code-login-service.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';

import { CodeLoginService, DefaultCodeLoginService, addressSubject } from '../../src/index.js';
import type { AuthnContext, IdentityRef } from '../../src/index.js';
import { buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

const EMAIL = 'alice@example.test';
const ctx = (): AuthnContext => ({ now: new Date(), purpose: 'login', ip: '192.0.2.10' });

describe('DefaultCodeLoginService (plan 08)', function () {
  this.timeout(30000);

  useHarnessLog();

  let p: CoreParts | undefined;

  afterEach(async () => {
    await p?.dispose();
    p = undefined;
  });

  async function boot(opts: { codeLogin?: boolean; code?: Record<string, unknown> } = {}): Promise<{ parts: CoreParts; svc: DefaultCodeLoginService; alice: IdentityRef }> {
    p = await buildCore({}, { codeLogin: opts.codeLogin ?? true, ...(opts.code ? { raw: { authn: { code: opts.code } } } : {}) });
    const svc = (await p.child.resolve(CodeLoginService)) as DefaultCodeLoginService;
    assert.ok(svc instanceof DefaultCodeLoginService);
    const alice = p.identities.add({ login: 'alice', email: EMAIL });
    return { parts: p, svc, alice };
  }

  it('answers accepted for a verified, an unverified and an unknown address, before any send; only the verified one gets a login code', async () => {
    const { parts, svc, alice } = await boot();
    parts.addresses.set(alice, 'email', EMAIL, new Date(0));
    const bob = parts.identities.add({ login: 'bob', email: 'bob@example.test' });
    parts.addresses.set(bob, 'email', 'bob@example.test', null);

    assert.deepStrictEqual(await svc.request(' Alice@Example.test', ctx()), { status: 'accepted' });
    assert.strictEqual(parts.codeSender.sent.length, 0, 'nothing is sent before the answer (SR-04)');
    for (const email of ['bob@example.test', 'nobody@example.test']) assert.deepStrictEqual(await svc.request(email, ctx()), { status: 'accepted' }, email);
    await svc.drain();

    assert.deepStrictEqual(
      parts.codeSender.sent.map((m) => [m.channel, m.to, m.purpose, m.ttlSeconds, m.identity]),
      [['email', EMAIL, 'login', 600, alice]],
    );
    assert.match(parts.codeSender.sent[0].code, /^[0-9]{8}$/);
    assert.strictEqual(await parts.codes.verify(addressSubject('email', EMAIL), 'login', parts.codeSender.sent[0].code), 'ok', 'issued under the address subject');
    // The three sends run concurrently after the answers, so their events come in no fixed order.
    assert.deepStrictEqual(
      parts.events
        .ofType('code.request')
        .map((e) => `${e.outcome}:${e.reason ?? ''}`)
        .sort(),
      ['failure:unknown_address', 'failure:unverified', 'success:'],
    );
  });

  it('mails an unverified address under authn.code.allowUnverified, with the configured length and lifetime', async () => {
    const { parts, svc, alice } = await boot({ code: { allowUnverified: true, length: 6, ttlSeconds: 300 } });
    parts.addresses.set(alice, 'email', EMAIL, null);
    await svc.request(EMAIL, ctx());
    await svc.drain();
    assert.strictEqual(parts.codeSender.sent.length, 1);
    assert.match(parts.codeSender.sent[0].code, /^[0-9]{6}$/);
    assert.strictEqual(parts.codeSender.sent[0].ttlSeconds, 300);
  });

  it('sends nothing to an inactive, banned or deleted identity, and audits why', async () => {
    const { parts, svc, alice } = await boot();
    parts.addresses.set(alice, 'email', EMAIL, new Date(0));
    for (const status of [{ active: false }, { banned: true }, { deleted: true }]) {
      parts.identities.setStatus(alice, { active: true, banned: false, deleted: false, ...status });
      await svc.request(EMAIL, ctx());
      await svc.drain();
    }
    await svc.drain();
    assert.strictEqual(parts.codeSender.sent.length, 0);
    assert.deepStrictEqual(
      parts.events.ofType('code.request').map((e) => e.reason),
      ['status', 'status', 'status'],
    );
  });

  it('counts each request in the code flow under the address and the ip, and answers throttled with Retry-After', async () => {
    const { parts, svc } = await boot();
    for (let i = 0; i < 3; i++) assert.deepStrictEqual(await svc.request(EMAIL, ctx()), { status: 'accepted' }, `request ${i + 1}`);
    assert.deepStrictEqual(await svc.request(EMAIL, ctx()), { status: 'throttled', retryAfterSeconds: 60 });
    assert.deepStrictEqual(await svc.request('other@example.test', ctx()), { status: 'accepted' }, 'another address is not held back');
    await svc.drain();
    assert.deepStrictEqual(
      parts.events.ofType('throttle.block').map((e) => e.data),
      [{ flow: 'code' }],
    );
  });

  it('answers invalid for something that is not one address, and disabled when no listed strategy takes kind code', async () => {
    const { svc } = await boot();
    for (const bad of ['', 'no-at-sign']) assert.deepStrictEqual(await svc.request(bad, ctx()), { status: 'invalid' }, bad);
    await p!.dispose();
    const off = await boot({ codeLogin: false });
    assert.deepStrictEqual(await off.svc.request(EMAIL, ctx()), { status: 'disabled' });
  });

  it('audits a failing sender as send_error by error class, and never puts the code in an event', async () => {
    const { parts, svc, alice } = await boot();
    parts.addresses.set(alice, 'email', EMAIL, new Date(0));
    parts.codeSender.fail = new TypeError('smtp down');
    await svc.request(EMAIL, ctx());
    await svc.drain();
    const [failed] = parts.events.ofType('code.request');
    assert.deepStrictEqual([failed.reason, failed.data], ['send_error', { purpose: 'login', error: 'TypeError' }]);
    parts.codeSender.fail = null;
    await svc.request(EMAIL, { ...ctx(), ip: '192.0.2.99' });
    await svc.drain();
    const code = parts.codeSender.sent[0].code;
    assert.ok(!JSON.stringify(parts.events.all()).includes(code), 'no event carries the code (A21)');
  });
});
```

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/code/code-login-service.test.ts`
Expected: FAIL at compile time with `Module '"../../src/index.js"' has no exported member 'DefaultCodeLoginService'`.

- [ ] **Step 4: Implement**

Create `packages/authn/src/throttle/select.ts` (the body of `DefaultAuthnService.selectThrottle`, moved unchanged apart from the parameters):

```ts
import type { IContainer } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';

import { AuthnThrottle } from '../contracts/throttle.js';
import { instantiate, nearestRegistration, q, registeredNames } from '../registry/named.js';

const MEMORY_THROTTLE = 'MemoryAuthnThrottle';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `authn.throttle.service` (`name`); when that is unset, the only registered throttle, or the only one besides
 * `MemoryAuthnThrottle` (so an app that imports authn-orm gets `DbAuthnThrottle`). Fails rather than falling back to memory,
 * which would throttle each instance of a multi-instance app apart.
 */
export async function selectAuthnThrottle(container: IContainer, name: string | undefined): Promise<AuthnThrottle> {
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
  if (!isObject(throttle) || typeof throttle.attempt !== 'function' || typeof throttle.succeed !== 'function') {
    throw new InvalidOption(`authn.throttle.service ${q(chosen)} is not an AuthnThrottle`);
  }
  return throttle as unknown as AuthnThrottle;
}
```

`packages/authn/src/throttle/index.ts`, add:

```ts
export * from './select.js';
```

In `default-authn-service.ts`:
- Add `import { selectAuthnThrottle } from '../throttle/select.js';` after the `'../throttle/peek.js'` imports (`:25-26`).
- Delete line 41 (`const MEMORY_THROTTLE = 'MemoryAuthnThrottle';`).
- Line 198 becomes `this.throttle = await selectAuthnThrottle(this.container, this.ThrottleService);`.
- Delete `selectThrottle()` (`:607-629`).
- Keep the `instantiate, nearestRegistration, registeredNames` import, because `selectPolicy` still uses it.

Create `packages/authn/src/code/code-login-service.ts`:

```ts
import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';

import { AuthnAudit } from '../audit/authn-audit.js';
import type { AuthnEvent } from '../contracts/audit.js';
import { CodeLoginService } from '../contracts/code-login.js';
import type { CodeRequestResult } from '../contracts/code-login.js';
import { CodeSender, OneTimeCodeStore } from '../contracts/codes.js';
import type { AuthnContext } from '../contracts/credentials.js';
import { AddressStore, IdentityStore } from '../contracts/identity.js';
import type { AuthnThrottle, ThrottleKey } from '../contracts/throttle.js';
import { StrategyRegistry } from '../registry/strategy-registry.js';
import { selectAuthnThrottle } from '../throttle/select.js';
import { addressSubject, normalizeAddress } from '../contracts/address.js';
import { optionalService, requiredService } from './support.js';

type EventBody = Omit<AuthnEvent, 'at' | 'ip' | 'userAgent'>;

interface Stores {
  readonly identities: IdentityStore;
  readonly addresses: AddressStore;
  readonly codes: OneTimeCodeStore;
  readonly sender: CodeSender | null;
}

// The class only: a message may echo what the sender was given.
const errorClass = (err: unknown): string => (err instanceof Error && err.name ? err.name : typeof err);

/**
 * POST /auth/code (plan 08): counts the request, answers, and only then looks the address up, issues and sends, the way
 * LocalPasswordService.requestReset does (A02, SR-04). The stores are resolved on the first send, so an app that does not
 * list CodeStrategy needs none of them.
 */
@PerChildInstance()
@Injectable(CodeLoginService)
@Inject(Container)
export class DefaultCodeLoginService extends CodeLoginService {
  @Config('authn.throttle.service')
  protected ThrottleService: string | undefined;

  @Config('authn.code.ttlSeconds')
  protected TtlSeconds!: number;

  @Config('authn.code.length')
  protected Length!: number;

  @Config('authn.code.allowUnverified')
  protected AllowUnverified!: boolean;

  private throttle!: AuthnThrottle;
  private auditor!: AuthnAudit;
  private registry!: StrategyRegistry;
  private stores: Stores | undefined;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly container: IContainer) {
    super();
  }

  public async resolve(): Promise<void> {
    this.throttle = await selectAuthnThrottle(this.container, this.ThrottleService);
    this.auditor = await this.container.resolve(AuthnAudit);
    this.registry = await this.container.resolve(StrategyRegistry);
    await super.resolve();
  }

  public async request(email: string, ctx: AuthnContext): Promise<CodeRequestResult> {
    if (!this.registry.strategies().some((s) => s.kinds.includes('code'))) return { status: 'disabled' };
    const address = normalizeAddress('email', email);
    if (address === null) return { status: 'invalid' };
    // Callers without ctx.ip share one ip bucket rather than going unthrottled, as the reset flow does.
    const keys: ThrottleKey[] = [
      { kind: 'account', value: address },
      { kind: 'ip', value: ctx.ip ?? 'unknown' },
    ];
    const gate = await this.throttle.attempt(keys, 'code', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', reason: 'throttled', data: { flow: 'code' } });
      return { status: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }
    this.defer(ctx, () => this.send(address, ctx));
    return { status: 'accepted' };
  }

  /** Resolves once every send scheduled so far has finished, including sends scheduled while draining (tests, shutdown). */
  public async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  protected async send(address: string, ctx: AuthnContext): Promise<void> {
    const { identities, addresses, codes, sender } = await this.storesOf();
    const id = await addresses.findByAddress('email', address);
    if (!id) return this.audit(ctx, { type: 'code.request', outcome: 'failure', reason: 'unknown_address', data: { purpose: 'login' } });
    const about = { identity: id, data: { purpose: 'login' } };
    const st = await identities.status(id);
    if (!st.exists || st.deleted || st.banned || !st.active) return this.audit(ctx, { type: 'code.request', outcome: 'failure', reason: 'status', ...about });
    const known = (await addresses.addresses(id)).find((a) => a.channel === 'email' && a.value === address);
    if (!known || (known.verifiedAt === null && this.AllowUnverified !== true)) return this.audit(ctx, { type: 'code.request', outcome: 'failure', reason: 'unverified', ...about });
    if (!sender) return this.audit(ctx, { type: 'code.request', outcome: 'failure', reason: 'no_sender', ...about });
    // Issued right before the send (SR-09): a failed send leaves a code nobody holds, never a queued one.
    const issued = await codes.issue(addressSubject('email', address), 'login', { ttlSeconds: this.TtlSeconds, length: this.Length });
    await sender.send({ channel: 'email', to: address, purpose: 'login', code: issued.code, ttlSeconds: issued.ttlSeconds, identity: id });
    await this.audit(ctx, { type: 'code.request', outcome: 'success', ...about });
  }

  private defer(ctx: AuthnContext, work: () => Promise<void>): void {
    const p: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(work)
      .catch((err) => this.audit(ctx, { type: 'code.request', outcome: 'failure', reason: 'send_error', data: { purpose: 'login', error: errorClass(err) } }))
      .catch(() => undefined)
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  private async storesOf(): Promise<Stores> {
    this.stores ??= {
      identities: await requiredService(this.container, IdentityStore, 'IdentityStore', 'DefaultCodeLoginService'),
      addresses: await requiredService(this.container, AddressStore, 'AddressStore', 'DefaultCodeLoginService'),
      codes: await requiredService(this.container, OneTimeCodeStore, 'OneTimeCodeStore', 'DefaultCodeLoginService'),
      sender: await optionalService(this.container, CodeSender),
    };
    return this.stores;
  }

  private audit(ctx: AuthnContext, e: EventBody): Promise<void> {
    return this.auditor.publish({ ...e, at: ctx.now, ...(ctx.ip ? { ip: ctx.ip } : {}), ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}) });
  }
}
```

`packages/authn/src/code/index.ts`, add:

```ts
export * from './code-login-service.js';
```

- [ ] **Step 5: GREEN, package suite**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/code/code-login-service.test.ts test/service/default-authn-service.test.ts`. Expected: all passing. The throttle-selection cases at `:1517-1549` keep their exact messages.
2. `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npm test`. Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/throttle/select.ts packages/authn/src/throttle/index.ts packages/authn/src/code/code-login-service.ts packages/authn/src/code/index.ts packages/authn/src/service/default-authn-service.ts packages/authn/test/code/code-login-service.test.ts
git diff --cached --stat
git commit -m "feat(authn): DefaultCodeLoginService mails login codes without telling which addresses exist"
```

---

### Task 5: `EmailCodeMfaStep`, `challengeMfa` and the same-factor guard

**Files:**
- Create: `packages/authn/src/flow/same-factor.ts`, `packages/authn/src/code/email-code-step.ts`
- Modify: `packages/authn/src/flow/index.ts` (one line), `packages/authn/src/code/index.ts` (one line)
- Modify: `packages/authn/src/service/default-authn-service.ts`: imports `:11`, `:14`; new method after `completeMfa` (after `:307`); `passMfa` (`:478-479`)
- Test: `packages/authn/test/code/email-code-step.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 `MfaStep.challenge?`, `MfaStep.sameFactorAs?`, `MfaChallengeResult` and `AuthnService.challengeMfa?`. Plan 06 `addressSubject`. Task 3 `requiredService`, `optionalService` and the harness. Task 2 flow `'code'`.
- Produces: `duplicatesFirstFactor(step: MfaStep, method: string): boolean`; `EMAIL_CODE_STEP = 'email-code'`; `class EmailCodeMfaStep extends MfaStep` (`sameFactorAs = ['code']`); `DefaultAuthnService.challengeMfa(pending, step, ctx): Promise<MfaChallengeResult>`. The `passMfa` refusal reason is `same_factor`. The `challengeMfa` audit uses `code.request` with `data: { purpose: 'mfa', step }`, and its failure reasons are `not_pending`, `policy_error`, `no_challenge` and `step_error`.

- [ ] **Step 1: Schema additions**

None.

- [ ] **Step 2: Write the failing tests**

Create `packages/authn/test/code/email-code-step.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';
import { InvalidOperation } from '@spinajs/exceptions';
import { fakeHash } from '@spinajs/authn-testing';

import { EmailCodeMfaStep, MfaPolicy, MfaStepRegistry, addressSubject } from '../../src/index.js';
import type { AuthenticationResult, AuthnContext, IdentityRef, SessionHandle } from '../../src/index.js';
import { KIT_MFA_STEP, bind, buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreOptions, CoreParts } from '../behaviour/harness.js';

const EMAIL = 'alice@example.test';
const PASSWORD = 'Alice-Pass-1234';
const STEPS = [
  { name: 'fake', service: KIT_MFA_STEP },
  { name: 'email-code', service: 'EmailCodeMfaStep' },
];
const ctx = (): AuthnContext => ({ now: new Date(), purpose: 'login', ip: '192.0.2.10' });

/** A custom policy that asks for email-code after every login, so the core's own guard is what refuses it. */
class EveryLoginPolicy extends MfaPolicy {
  async required(): Promise<readonly string[]> {
    return ['email-code'];
  }
}

function pendingOf(r: AuthenticationResult): SessionHandle {
  if (r.status !== 'mfa_required') throw new assert.AssertionError({ message: `expected mfa_required, got ${JSON.stringify(r)}` });
  return r.pending;
}

describe('EmailCodeMfaStep and AuthnService.challengeMfa (plan 08)', function () {
  this.timeout(30000);

  useHarnessLog();

  let p: CoreParts;
  let alice: IdentityRef;

  async function boot(opts: { policy?: boolean } = {}): Promise<void> {
    const options: CoreOptions = {
      codeLogin: true,
      raw: { authn: { mfa: { steps: STEPS, ...(opts.policy ? { policy: { service: 'KitEveryLoginPolicy' } } : {}) } } },
      ...(opts.policy ? { register: (c) => bind(c, MfaPolicy, 'KitEveryLoginPolicy', new EveryLoginPolicy()) } : {}),
    };
    p = await buildCore({}, options);
    alice = p.identities.add({ login: EMAIL, email: EMAIL });
    await p.passwords.set(alice, fakeHash(PASSWORD));
  }

  afterEach(() => p.dispose());

  const stepOf = async (): Promise<EmailCodeMfaStep> => (await p.child.resolve(MfaStepRegistry)).get('email-code') as EmailCodeMfaStep;
  const passwordLogin = async (): Promise<SessionHandle> => pendingOf(await p.service.authenticate({ kind: 'password', login: EMAIL, password: PASSWORD }, ctx()));

  it('counts as enrolled exactly when the identity has a verified email address', async () => {
    await boot();
    const step = await stepOf();
    assert.strictEqual(step.name, 'email-code');
    assert.deepStrictEqual(step.sameFactorAs, ['code']);
    assert.strictEqual(await step.enrolled(alice), false);
    p.addresses.set(alice, 'email', EMAIL, null);
    assert.strictEqual(await step.enrolled(alice), false);
    p.addresses.set(alice, 'email', EMAIL, new Date(0));
    assert.strictEqual(await step.enrolled(alice), true);
  });

  it('a password login needs it; challengeMfa mails an mfa code to the verified address; the code elevates to aal2', async () => {
    await boot();
    p.addresses.set(alice, 'email', EMAIL, new Date(0));
    const pending = await passwordLogin();
    assert.deepStrictEqual(await p.service.challengeMfa!(pending, 'email-code', ctx()), { status: 'sent' });
    const sent = p.codeSender.sent[0];
    assert.deepStrictEqual([sent.channel, sent.to, sent.purpose, sent.ttlSeconds, sent.identity], ['email', EMAIL, 'mfa', 600, alice]);
    const done = await p.service.completeMfa(pending, 'email-code', sent.code, ctx());
    assert.strictEqual(done.status, 'success', JSON.stringify(done));
    assert.deepStrictEqual(done.status === 'success' && [done.facts.assurance, done.facts.mfa], ['aal2', ['email-code']]);
    const events = p.events.ofType('code.request');
    assert.deepStrictEqual(
      events.map((e) => [e.outcome, e.data]),
      [['success', { purpose: 'mfa', step: 'email-code' }]],
    );
    assert.ok(!JSON.stringify(p.events.all()).includes(sent.code), 'no event carries the code (A21)');
  });

  it('refuses a challenge for a step the session does not need, for a step that sends nothing, and for an active session', async () => {
    await boot();
    p.addresses.set(alice, 'email', EMAIL, new Date(0));
    p.step.enrol(alice);
    const pending = await passwordLogin();
    assert.deepStrictEqual(await p.service.challengeMfa!(pending, 'fake', ctx()), { status: 'refused' }, 'the kit step sends nothing');
    assert.deepStrictEqual(await p.service.challengeMfa!(pending, 'totp', ctx()), { status: 'refused' }, 'not a pending step');
    const done = await p.service.completeMfa(pending, 'fake', p.step.nextCode(alice), ctx());
    assert.strictEqual(done.status, 'success');
    const active = done.status === 'success' ? done.session! : pending;
    assert.deepStrictEqual(await p.service.challengeMfa!(active, 'email-code', ctx()), { status: 'refused' });
    assert.deepStrictEqual(
      p.events.ofType('code.request').map((e) => e.reason),
      ['no_challenge', 'no_challenge', 'not_pending'],
    );
    assert.strictEqual(p.codeSender.sent.length, 0);
  });

  it('counts each challenge in the code flow and answers throttled', async () => {
    await boot();
    p.addresses.set(alice, 'email', EMAIL, new Date(0));
    const pending = await passwordLogin();
    for (let i = 0; i < 3; i++) assert.deepStrictEqual(await p.service.challengeMfa!(pending, 'email-code', ctx()), { status: 'sent' }, `challenge ${i + 1}`);
    assert.deepStrictEqual(await p.service.challengeMfa!(pending, 'email-code', ctx()), { status: 'throttled', retryAfterSeconds: 60 });
    assert.strictEqual(p.codeSender.sent.length, 3);
  });

  it('is no second factor after a code login, even when a custom policy asks for it', async () => {
    await boot({ policy: true });
    p.addresses.set(alice, 'email', EMAIL, new Date(0));
    const login = (await p.codes.issue(addressSubject('email', EMAIL), 'login', { ttlSeconds: 600 })).code;
    const pending = pendingOf(await p.service.authenticate({ kind: 'code', email: EMAIL, code: login }, ctx()));
    assert.deepStrictEqual(await p.service.challengeMfa!(pending, 'email-code', ctx()), { status: 'refused' });
    const mfa = (await p.codes.issue(addressSubject('email', EMAIL), 'mfa', { ttlSeconds: 600 })).code;
    assert.deepStrictEqual(await p.service.completeMfa(pending, 'email-code', mfa, ctx()), { status: 'failure', reason: 'invalid_credentials' });
    assert.strictEqual(p.events.ofType('mfa.verify').at(-1)?.reason, 'same_factor');
  });

  it('has nothing to enrol or disable', async () => {
    await boot();
    const step = await stepOf();
    await assert.rejects(step.beginEnrolment(alice), InvalidOperation);
    await assert.rejects(step.confirmEnrolment(alice, '123456'), InvalidOperation);
    await step.disable(alice);
  });
});
```

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/code/email-code-step.test.ts`
Expected: FAIL at compile time with `Module '"../../src/index.js"' has no exported member 'EmailCodeMfaStep'`.

- [ ] **Step 4: Implement**

Create `packages/authn/src/flow/same-factor.ts`:

```ts
import type { MfaStep } from '../contracts/mfa.js';

/** True when `step` proves what a login by `method` already proved (MfaStep.sameFactorAs), so it is no second factor after it. */
export function duplicatesFirstFactor(step: MfaStep, method: string): boolean {
  const same: unknown = step.sameFactorAs;
  return Array.isArray(same) && same.includes(method);
}
```

`packages/authn/src/flow/index.ts`, add:

```ts
export * from './same-factor.js';
```

Create `packages/authn/src/code/email-code-step.ts`:

```ts
import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';

import { CodeSender, OneTimeCodeStore } from '../contracts/codes.js';
import type { IdentityRef } from '../contracts/credentials.js';
import { AddressStore } from '../contracts/identity.js';
import { MfaStep } from '../contracts/mfa.js';
import { addressSubject } from '../contracts/address.js';
import { optionalService, requiredService } from './support.js';

export const EMAIL_CODE_STEP = 'email-code';

const NO_ENROLMENT = 'email-code needs no enrolment: a verified email address enrols the identity';

/**
 * A code mailed to the identity's verified address (plan 08). Once the step is listed in authn.mfa.steps, every identity with a
 * verified email is enrolled. Weaker than TOTP or WebAuthn (phishable; a mailbox compromise passes it): it is no second factor
 * after a code login, and authn.mfa.policy.forbidForRoles keeps it from roles that need more.
 */
@PerChildInstance()
@Injectable(MfaStep)
@Inject(Container)
export class EmailCodeMfaStep extends MfaStep {
  public readonly name = EMAIL_CODE_STEP;
  public readonly sameFactorAs: readonly string[] = ['code'];

  @Config('authn.code.ttlSeconds')
  protected TtlSeconds!: number;

  @Config('authn.code.length')
  protected Length!: number;

  constructor(private readonly container: IContainer) {
    super();
  }

  public async enrolled(id: IdentityRef): Promise<boolean> {
    return (await this.verifiedEmail(id)) !== null;
  }

  public beginEnrolment(_id: IdentityRef): Promise<{ provisioning: string }> {
    return Promise.reject(new InvalidOperation(NO_ENROLMENT));
  }

  public confirmEnrolment(_id: IdentityRef, _response: string): Promise<{ recoveryCodes?: readonly string[] }> {
    return Promise.reject(new InvalidOperation(NO_ENROLMENT));
  }

  public async verify(id: IdentityRef, response: string): Promise<boolean> {
    // Bound to the current verified address: a code mailed before the address changed no longer passes.
    const to = await this.verifiedEmail(id);
    if (to === null) return false;
    const codes = await requiredService(this.container, OneTimeCodeStore, 'OneTimeCodeStore', 'EmailCodeMfaStep');
    return (await codes.verify(addressSubject('email', to), 'mfa', response)) === 'ok';
  }

  public async challenge(id: IdentityRef): Promise<void> {
    const to = await this.verifiedEmail(id);
    if (to === null) throw new InvalidOperation('EmailCodeMfaStep: the identity has no verified email address');
    const sender = await optionalService(this.container, CodeSender);
    if (!sender) throw new InvalidOperation('EmailCodeMfaStep: no CodeSender is registered');
    const codes = await requiredService(this.container, OneTimeCodeStore, 'OneTimeCodeStore', 'EmailCodeMfaStep');
    const issued = await codes.issue(addressSubject('email', to), 'mfa', { ttlSeconds: this.TtlSeconds, length: this.Length });
    await sender.send({ channel: 'email', to, purpose: 'mfa', code: issued.code, ttlSeconds: issued.ttlSeconds, identity: id });
  }

  /** Nothing is stored for the step; removing the verified address is what ends it. */
  public disable(_id: IdentityRef): Promise<void> {
    return Promise.resolve();
  }

  private async verifiedEmail(id: IdentityRef): Promise<string | null> {
    const addresses = await requiredService(this.container, AddressStore, 'AddressStore', 'EmailCodeMfaStep');
    return (await addresses.addresses(id)).find((a) => a.channel === 'email' && a.verifiedAt !== null)?.value ?? null;
  }
}
```

`packages/authn/src/code/index.ts`, add:

```ts
export * from './email-code-step.js';
```

In `default-authn-service.ts`:
- After line 11 (`import { MfaPolicy } from '../contracts/mfa.js';`) add `import type { MfaStep } from '../contracts/mfa.js';`.
- After line 14 add `import type { MfaChallengeResult } from '../contracts/service.js';`.
- After the `MfaStepRegistry` import (`:21`) add `import { duplicatesFirstFactor } from '../flow/same-factor.js';`.
- In `passMfa`, after `if (!s) return 'unknown_step';` (`:479`) add:

```ts
    if (duplicatesFirstFactor(s, facts.method)) return 'same_factor';
```

- After `completeMfa` (closing brace at `:307`) add:

```ts
  public async challengeMfa(pending: SessionHandle, step: string, ctx: AuthnContext): Promise<MfaChallengeResult> {
    const asked = { purpose: 'mfa', step };
    const stored = await this.restore(pending);
    if (!stored || stored.handle.state !== 'pending') {
      await this.audit(ctx, { type: 'code.request', outcome: 'failure', reason: 'not_pending', data: asked });
      return { status: 'refused' };
    }
    const id = stored.identity;
    const about = { identity: id, strategy: stored.facts.strategy, ...(nonEmpty(stored.facts.sessionHandle) ? { session: stored.facts.sessionHandle } : {}) };
    let s: MfaStep | undefined;
    try {
      const required = await this.policy!.required(id, { method: stored.facts.method, strategy: stored.facts.strategy });
      s = required.includes(step) ? this.steps!.get(step) : undefined;
    } catch (err) {
      await this.audit(ctx, { type: 'code.request', outcome: 'failure', reason: 'policy_error', ...about, data: { ...asked, error: errorClass(err) } });
      return { status: 'refused' };
    }
    if (!s || typeof s.challenge !== 'function' || duplicatesFirstFactor(s, stored.facts.method)) {
      await this.audit(ctx, { type: 'code.request', outcome: 'failure', reason: 'no_challenge', ...about, data: asked });
      return { status: 'refused' };
    }
    const gate = await this.throttle.attempt(this.identityKeys(id, ctx), 'code', ctx);
    if (!gate.allowed) {
      await this.audit(ctx, { type: 'throttle.block', outcome: 'failure', reason: 'throttled', ...about, data: { flow: 'code' } });
      return { status: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    }
    try {
      await s.challenge(id);
    } catch (err) {
      await this.audit(ctx, { type: 'code.request', outcome: 'failure', reason: 'step_error', ...about, data: { ...asked, error: errorClass(err) } });
      return { status: 'refused' };
    }
    await this.audit(ctx, { type: 'code.request', outcome: 'success', ...about, data: asked });
    return { status: 'sent' };
  }
```

- [ ] **Step 5: GREEN, package suite**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/code/email-code-step.test.ts`. Expected: 6 passing.
2. `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npm test`. Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/flow/same-factor.ts packages/authn/src/flow/index.ts packages/authn/src/code/email-code-step.ts packages/authn/src/code/index.ts packages/authn/src/service/default-authn-service.ts packages/authn/test/code/email-code-step.test.ts
git diff --cached --stat
git commit -m "feat(authn): email-code MFA step, challengeMfa, and no same-channel second factor"
```

---

### Task 6: `DefaultMfaPolicy` covers code logins, skips same-factor steps, honours `forbidForRoles`

**Files:**
- Modify: `packages/authn/src/flow/default-mfa-policy.ts:1-76` (whole file)
- Modify: `packages/authn/src/schemas/authn.configuration.ts:201-205` (`policy` properties)
- Modify: `packages/authn/src/config/authn.ts:10-14`
- Test: `packages/authn/test/flow/mfa.test.ts` (`:1-8` imports, `:164-170`, new tests in `describe('DefaultMfaPolicy')`), `packages/authn/test/boot/config-defaults.test.ts:68`, `packages/authn/test/contracts/config-schema.test.ts:271`

**Interfaces:**
- Consumes: Task 5 `duplicatesFirstFactor`. Task 3 harness `codeLogin`, `addresses` and `codes`.
- Produces: `DefaultMfaPolicy.forbidForRoles: Readonly<Record<string, readonly string[]>>`, and the schema key `authn.mfa.policy.forbidForRoles` (default `{}`). `required` throws `InvalidOperation` when MFA is forced and no step may follow the login method.

- [ ] **Step 1: Schema additions**

In the `policy.properties` block (`:202-204`) replace `force` and add `forbidForRoles`:

```ts
            force: { type: 'boolean', default: false, description: "Requires a step on logins whose strategy reports method 'password' or 'code' only (D13): key and OIDC logins get none." },
            forceForRoles: { ...stringList, default: [] },
            forbidForRoles: {
              type: 'object',
              default: {},
              additionalProperties: { ...stringList, minItems: 1 },
              description: "Step name → roles that may not use it as a second factor, e.g. { 'email-code': ['admin'] }. Needs a RoleSource; an identity whose roles cannot be read does not get the step.",
            },
```

`src/config/authn.ts`, the `policy` object becomes:

```ts
      policy: {
        service: 'DefaultMfaPolicy',
        force: false,
        forceForRoles: [] as string[],
        forbidForRoles: {} as Record<string, string[]>,
      },
```

- [ ] **Step 2: Write the failing tests**

`test/flow/mfa.test.ts`: add `import { InvalidOperation } from '@spinajs/exceptions';` to the imports, and `addressSubject` to the `'../../src/index.js'` import (line 5). Replace `takes the policy defaults from the schema` (`:164-170`) with:

```ts
    it('takes the policy defaults from the schema', async () => {
      const p = await boot();
      assert.deepStrictEqual(p.configuration.get('authn.mfa.policy'), { service: 'DefaultMfaPolicy', force: false, forceForRoles: [], forbidForRoles: {} });
      const policy = await policyOf(p);
      assert.strictEqual(policy.force, false);
      assert.deepStrictEqual(policy.forceForRoles, []);
      assert.deepStrictEqual(policy.forbidForRoles, {});
    });
```

and add, inside `describe('DefaultMfaPolicy')`:

```ts
    const sameAsCode = (name: string): FakeMfaStep => Object.defineProperty(new FakeMfaStep({ name }), 'sameFactorAs', { value: ['code'] });
    const CODE = { method: 'code', strategy: 'code' };

    it('requires the enrolled steps after a code login too, minus the steps that duplicate it', async () => {
      const email = sameAsCode('email-like');
      const p = await boot({ extra: [email] });
      p.step.enrol(ALICE);
      email.enrol(ALICE);
      const policy = await policyOf(p);
      assert.deepStrictEqual(await policy.required(ALICE, CODE), ['fake']);
      assert.deepStrictEqual(await policy.required(ALICE, PASSWORD), ['fake', 'email-like']);
    });

    it('under force skips a duplicating step and fails closed when no other step is configured', async () => {
      const email = sameAsCode('email-like');
      const p = await boot({ extra: [email], steps: [{ name: 'email-like', service: 'Step_email-like' }, { name: 'fake', service: KIT_MFA_STEP }], mfa: { policy: { force: true } } });
      assert.deepStrictEqual(await (await policyOf(p)).required(ALICE, CODE), ['fake']);
      await p.dispose();
      const only = await boot({ extra: [sameAsCode('email-like')], steps: [{ name: 'email-like', service: 'Step_email-like' }], mfa: { policy: { force: true } } });
      await assert.rejects((await policyOf(only)).required(ALICE, CODE), InvalidOperation);
    });

    it('drops a step of forbidForRoles for holders of a listed role, keeps it for others, and drops it when roles cannot be read', async () => {
      const forbid = { mfa: { policy: { forbidForRoles: { second: ['admin'] } } } };
      const cases: [readonly string[] | Error, string[]][] = [
        [['admin'], []],
        [['editor'], ['second']],
        [new Error('down'), []],
      ];
      for (const [roles, expected] of cases) {
        // boot() keeps the last parts for afterEach; earlier ones are disposed here.
        await parts?.dispose();
        const second = new FakeMfaStep({ name: 'second' });
        second.enrol(ALICE);
        const p = await boot({ extra: [second], ...forbid, register: (c) => bind(c, RoleSource, 'KitRoles', new Roles(roles)) });
        assert.deepStrictEqual(await (await policyOf(p)).required(ALICE, PASSWORD), expected, String(roles));
      }
    });

    it('fails boot when forbidForRoles names roles and no RoleSource is registered', async () => {
      await bootFails({ mfa: { policy: { forbidForRoles: { fake: ['admin'] } } } }, 'forbidForRoles', 'RoleSource');
    });

    it('drives a code login: an identity enrolled in a step gets a pending session', async () => {
      parts = await buildCore({}, { codeLogin: true });
      const id = parts.identities.add({ login: 'alice', email: 'alice@example.test' });
      parts.addresses.set(id, 'email', 'alice@example.test', new Date(0));
      parts.step.enrol(id);
      const code = (await parts.codes.issue(addressSubject('email', 'alice@example.test'), 'login', { ttlSeconds: 600 })).code;
      const r = await parts.service.authenticate({ kind: 'code', email: 'alice@example.test', code }, { now: new Date(), purpose: 'login' });
      assert.strictEqual(r.status, 'mfa_required', JSON.stringify(r));
      assert.deepStrictEqual(r.status === 'mfa_required' && r.steps, ['fake']);
    });
```

`test/boot/config-defaults.test.ts:68` becomes:

```ts
    expect(authn.mfa.policy).to.deep.eq({ service: 'DefaultMfaPolicy', force: false, forceForRoles: [], forbidForRoles: {} });
```

`test/contracts/config-schema.test.ts:271`: in the expected `mfa.policy`, add `forbidForRoles: {}`.

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/flow/mfa.test.ts test/boot/config-defaults.test.ts test/contracts/config-schema.test.ts`
Expected: FAIL at compile time with `Property 'forbidForRoles' does not exist on type 'DefaultMfaPolicy'`. After you stub it, the new cases fail on values: `required(ALICE, CODE)` is `[]`, not `['fake']`.

- [ ] **Step 4: Implement**

Replace `packages/authn/src/flow/default-mfa-policy.ts` with:

```ts
import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';

import type { IdentityRef } from '../contracts/credentials.js';
import { RoleSource } from '../contracts/hooks.js';
import { MfaPolicy } from '../contracts/mfa.js';
import type { MfaStep } from '../contracts/mfa.js';
import type { AuthnFacts } from '../contracts/principal.js';
import { PrincipalFactory } from '../contracts/service.js';
import { MfaStepRegistry } from './mfa-step-registry.js';
import { duplicatesFirstFactor } from './same-factor.js';

/** Logins a second factor follows; a key challenge proves possession and an IdP does its own MFA (D13). */
const SECOND_FACTOR_METHODS: ReadonlySet<string> = new Set(['password', 'code']);

type Facts = Pick<AuthnFacts, 'method' | 'strategy'>;

/**
 * Design §22.3: the steps of `authn.mfa.steps` the identity is enrolled in, after password and code logins only (D13, plan 08).
 * A step whose `sameFactorAs` names the login method is skipped, and so is a step `forbidForRoles` keeps from one of the
 * identity's roles (asked through RoleSource; unreadable roles drop it). When none is enrolled, `force`, or a role of
 * `forceForRoles`, requires the first step left, so the pending session can only enrol; with none left the login fails closed.
 * Boot fails when forceForRoles or forbidForRoles has no RoleSource or PrincipalFactory to ask; the schema refuses force and
 * forceForRoles with no step to require.
 */
@PerChildInstance()
@Injectable(MfaPolicy)
@Inject(Container)
export class DefaultMfaPolicy extends MfaPolicy {
  @Config('authn.mfa.policy.force')
  protected Force: boolean;

  @Config('authn.mfa.policy.forceForRoles')
  protected ForceForRoles: string[];

  @Config('authn.mfa.policy.forbidForRoles')
  protected ForbidForRoles: Record<string, string[]>;

  constructor(private readonly container: IContainer) {
    super();
  }

  public get force(): boolean {
    return this.Force === true;
  }

  public get forceForRoles(): readonly string[] {
    return this.ForceForRoles ?? [];
  }

  public get forbidForRoles(): Readonly<Record<string, readonly string[]>> {
    return this.ForbidForRoles ?? {};
  }

  public resolve(): void {
    const keys = [...(this.forceForRoles.length > 0 ? ['forceForRoles'] : []), ...(Object.values(this.forbidForRoles).some((r) => r.length > 0) ? ['forbidForRoles'] : [])];
    for (const key of keys) {
      for (const [type, name] of [
        [RoleSource, 'RoleSource'],
        [PrincipalFactory, 'PrincipalFactory'],
      ] as const) {
        if (!this.container.hasRegistered(type as unknown as Class<unknown>)) throw new InvalidOption(`authn.mfa.policy.${key} needs a ${name} to read roles, and none is registered`);
      }
    }
    super.resolve();
  }

  public async required(id: IdentityRef, facts: Facts): Promise<readonly string[]> {
    if (!SECOND_FACTOR_METHODS.has(facts.method)) return [];
    const all = (await this.container.resolve(MfaStepRegistry)).steps();
    if (all.length === 0) return [];
    let asked: Promise<readonly string[] | null> | undefined;
    const roles = (): Promise<readonly string[] | null> => (asked ??= this.rolesOf(id, facts));
    const steps: MfaStep[] = [];
    for (const s of all) {
      if (duplicatesFirstFactor(s, facts.method)) continue;
      const forbidden = this.forbidForRoles[s.name] ?? [];
      if (forbidden.length > 0) {
        const held = await roles();
        if (held === null || held.some((r) => forbidden.includes(r))) continue;
      }
      steps.push(s);
    }
    const enrolled: string[] = [];
    for (const s of steps) if (await s.enrolled(id)) enrolled.push(s.name);
    if (enrolled.length > 0 || !(await this.forced(roles))) return enrolled;
    if (steps.length === 0) throw new InvalidOperation(`DefaultMfaPolicy: MFA is forced for ${id.type} ${id.id} and no configured step may follow a ${facts.method} login`);
    return [steps[0].name];
  }

  private async forced(roles: () => Promise<readonly string[] | null>): Promise<boolean> {
    if (this.force) return true;
    if (this.forceForRoles.length === 0) return false;
    const held = await roles();
    // Fail closed: without the roles, ask for the step.
    return held === null || held.some((r) => this.forceForRoles.includes(r));
  }

  /** The role names of `id`, or null when they cannot be read. */
  private async rolesOf(id: IdentityRef, facts: Facts): Promise<readonly string[] | null> {
    try {
      const principals = (await this.container.resolve(PrincipalFactory as unknown as Class<PrincipalFactory>)) as PrincipalFactory;
      const principal = await principals.principalOf(id, { ...facts, assurance: 'aal1', mfa: [], authenticatedAt: new Date() }, {});
      const held = await ((await this.container.resolve(RoleSource as unknown as Class<RoleSource>)) as RoleSource).rolesOf(principal);
      return held.map((r) => r.role);
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 5: GREEN, package suite, dependents**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/flow/mfa.test.ts test/boot/config-defaults.test.ts test/contracts/config-schema.test.ts test/code/email-code-step.test.ts`. Expected: all passing. The existing `forceForRoles` cases keep passing, `RoleSource` is asked once per `required`, and `requires nothing for logins other than password` still holds for `oidc`, `key-challenge` and `token`.
2. `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npm test`. Expected: all passing.
3. `cd packages/authn-http && npm test`. Expected: all passing. `MfaSatisfied` and `pendingSteps` call the same policy.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/flow/default-mfa-policy.ts packages/authn/src/schemas/authn.configuration.ts packages/authn/src/config/authn.ts packages/authn/test/flow/mfa.test.ts packages/authn/test/boot/config-defaults.test.ts packages/authn/test/contracts/config-schema.test.ts
git diff --cached --stat
git commit -m "feat(authn): MFA after code logins, no same-factor steps, authn.mfa.policy.forbidForRoles"
```

---

### Task 7: HTTP routes (`POST /auth/code`, code credentials on `POST /auth/login`, `POST /auth/mfa/challenge`)

**Files:**
- Create: `packages/authn-http/src/v3/controllers/AuthnCodeController.ts`
- Modify: `packages/authn-http/src/v3/responses.ts` (`authnFailureResponse`), `packages/authn-http/src/v3/routes.ts` (imports, one function appended), `packages/authn-http/src/v3/controllers/AuthnLoginController.ts` (import, doc comment, credential lines), `packages/authn-http/src/v3/controllers/AuthnMfaController.ts` (imports, a new method after `recovery`)
- Test: `packages/authn-http/test/v3/inert.test.ts:36`, `packages/authn-http/test/v3-app/app.ts` (config `:60-65`, `resetRecorders`), `packages/authn-http/test/v3-app/suites/code.ts` (new), `packages/authn-http/test/v3-app/account.test.ts`, `packages/authn-http/test/v3-app/suites/route-table.ts:26-40`

Plans 03, 05 and 06 edit the same files first: plan 03 the bodies and `errors.ts`, plan 05 the `captchaRefusal` call in `login`, plan 06 the `refusalResponse` line in `login` and the v3-app fakes. Keep their lines. The edits below name the lines to replace by their content, not by number.

**Interfaces:**
- Consumes:
  - Task 1: `CodeLoginService`, `EMAIL_MAX_LENGTH`, `LOGIN_CODE_MAX_LENGTH`, `AuthnService.challengeMfa?` and the `code_*` message codes.
  - Plan 03: `authnMessage` (`@spinajs/authn/messages`), and `errorBody`, `refused` and `notFound` (`src/policies/v3/errors.ts`).
  - Plan 05: `captchaRefusal` (`src/v3/captcha.ts`).
  - Plan 06: the v3-app exports `addresses` (`MemoryAddressStore`) and `codeSender` (`RecordingCodeSender`), with the code store already bound.
  - Tasks 3-5: `CodeStrategy` and `EmailCodeMfaStep` (by service name), and `DefaultCodeLoginService.drain()`.
- Produces:
  - `retryAfterHeader(seconds: number): IResponseHeader` (responses.ts).
  - `type LoginCredentials` and `loginCredentialsOf(req, passwordCap): LoginCredentials | null` (routes.ts).
  - `POST /auth/code` answers 202 `{ messages: [code_requested] }`, 400 `code_invalid_email` or plan 05's CAPTCHA answer, 404 `code_login_off`, or 429 `throttled` with Retry-After.
  - `POST /auth/login` also takes `{ email, code }`.
  - `POST /auth/mfa/challenge` answers 200 `{ messages: [code_challenge_sent] }`, 401, 403 `mfa_not_pending` or `code_no_challenge`, or 429 `throttled`.

- [ ] **Step 1: Schema additions**

None.

- [ ] **Step 2: Write the failing tests**

`test/v3/inert.test.ts:36`: add `'AuthnCodeController'` to `V3_CONTROLLERS`.

`test/v3-app/app.ts` (plan 06 already binds `AddressStore`, `CodeSender` and `OneTimeCodeStore`, and exports `addresses` and `codeSender`):
- Config `:60-65`: `strategies` gains `{ name: 'code', service: 'CodeStrategy' },` as its last entry, and `mfa` becomes `mfa: { steps: [{ name: 'totp', service: 'V3AppMfaStep' }, { name: 'email-code', service: 'EmailCodeMfaStep' }] },`.
- In `resetRecorders()` add `codeSender.clear();` unless plan 06 already added it.

Create `packages/authn-http/test/v3-app/suites/code.ts`:

```ts
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { CodeLoginService } from '@spinajs/authn/contracts';

import { AUTHN_FAILURE_BODY } from '../../../src/v3/index.js';
import { Client, addresses, codeSender, resetRecorders, seedUser, step, throttle } from '../app.js';
import type { KitUser } from '../app.js';

/** Waits for the sends POST /auth/code scheduled after its answer. */
async function drain(): Promise<void> {
  await ((await DI.resolve(CodeLoginService)) as unknown as { drain(): Promise<void> }).drain();
}

async function verifiedUser(): Promise<KitUser> {
  const u = await seedUser();
  addresses.set(u.ref, 'email', u.login, new Date());
  return u;
}

export function codeSuite(): void {
  beforeEach(resetRecorders);

  it('POST /auth/code answers 202 with one body for a verified, an unverified and an unknown address; only the verified one gets a code', async () => {
    const known = await verifiedUser();
    const unverified = await seedUser();
    addresses.set(unverified.ref, 'email', unverified.login, null);
    const bodies: unknown[] = [];
    for (const email of [known.login, unverified.login, `nobody-${Date.now()}@example.test`]) {
      const res = await new Client().post('/auth/code', { email });
      expect(res.status, email).to.eq(202);
      expect(res.headers['cache-control']).to.eq('no-store');
      bodies.push(res.body);
    }
    expect(bodies[1]).to.deep.eq(bodies[0]);
    expect(bodies[2]).to.deep.eq(bodies[0]);
    expect(bodies[0]).to.deep.eq({ messages: [{ id: 1006001, code: 'code_requested', type: 'info', text: 'If this address belongs to an account, a sign-in code is on its way.' }] });
    await drain();
    expect(codeSender.sent.map((m) => [m.to, m.purpose])).to.deep.eq([[known.login, 'login']]);
  });

  it('POST /auth/login with { email, code } logs in at aal1 with method code, once', async () => {
    const u = await verifiedUser();
    await new Client().post('/auth/code', { email: u.login });
    await drain();
    const code = codeSender.codeFor(u.login, 'login')!;
    const c = new Client();
    const res = await c.post('/auth/login', { email: u.login, code });
    expect(res.status, JSON.stringify(res.body)).to.eq(200);
    expect(res.body.Identity).to.deep.eq({ type: 'user', id: u.ref.id });
    expect(res.body.Authn).to.include({ method: 'code', strategy: 'code', assurance: 'aal1' });
    expect(c.cookie).to.not.eq(null);
    const again = await new Client().post('/auth/login', { email: u.login, code });
    expect(again.status).to.eq(401);
    expect(again.body).to.deep.eq(AUTHN_FAILURE_BODY);
  });

  it('POST /auth/login without a code or with an over-long one answers the one failure body', async () => {
    const u = await verifiedUser();
    for (const body of [{ email: u.login }, { email: u.login, code: '1'.repeat(11) }, { email: 'x'.repeat(255), code: '12345678' }]) {
      const res = await new Client().post('/auth/login', body);
      expect(res.status, JSON.stringify(body)).to.eq(401);
      expect(res.body).to.deep.eq(AUTHN_FAILURE_BODY);
    }
  });

  it('POST /auth/code answers 400 for a malformed address and 429 with Retry-After when throttled', async () => {
    const bad = await new Client().post('/auth/code', { email: 'not an address' });
    expect(bad.status).to.eq(400);
    expect(bad.body.error).to.eq('code_invalid_email');
    expect(bad.body.messages[0].id).to.eq(4006001);
    throttle.refuse(42);
    const held = await new Client().post('/auth/code', { email: 'someone@example.test' });
    expect(held.status).to.eq(429);
    expect(held.headers['retry-after']).to.eq('42');
    expect(held.body.messages[0]).to.include({ id: 4000018, code: 'throttled' });
    expect(held.body.messages[0].context).to.deep.eq({ retryAfterSeconds: 42 });
    expect(throttle.attempts.at(-1)?.flow).to.eq('code');
  });

  it('POST /auth/mfa/challenge mails the email-code step, and /auth/mfa/verify takes the code (aal2)', async () => {
    const u = await verifiedUser();
    const c = new Client();
    const login = await c.post('/auth/login', { login: u.login, password: u.password });
    expect(login.body).to.deep.eq({ MfaRequired: ['email-code'] });
    const sent = await c.post('/auth/mfa/challenge', { step: 'email-code' });
    expect(sent.status, JSON.stringify(sent.body)).to.eq(200);
    expect(sent.body.messages[0].id).to.eq(1006002);
    const code = codeSender.codeFor(u.login, 'mfa')!;
    const done = await c.post('/auth/mfa/verify', { step: 'email-code', code });
    expect(done.status, JSON.stringify(done.body)).to.eq(200);
    expect(done.body.Authn).to.include({ assurance: 'aal2' });
    expect(done.body.Authn.mfa).to.deep.eq(['email-code']);
  });

  it('POST /auth/mfa/challenge refuses a step that sends nothing (403) and a caller with no session (401)', async () => {
    const u = await verifiedUser();
    step.enrol(u.ref);
    const c = new Client();
    const login = await c.post('/auth/login', { login: u.login, password: u.password });
    expect(login.body).to.deep.eq({ MfaRequired: ['totp', 'email-code'] });
    const refusedRes = await c.post('/auth/mfa/challenge', { step: 'totp' });
    expect(refusedRes.status).to.eq(403);
    expect(refusedRes.body.error).to.eq('code_no_challenge');
    expect(refusedRes.body.messages[0].id).to.eq(4006002);
    expect((await new Client().post('/auth/mfa/challenge', { step: 'email-code' })).status).to.eq(401);
  });
}
```

`test/v3-app/account.test.ts`: add `import { codeSuite } from './suites/code.js';`, and after `describe('MFA completion of a pending session', mfaSuite);` add:

```ts
    describe('sign-in by email code', codeSuite);
```

`test/v3-app/suites/route-table.ts`: add `'POST /auth/code'` and `'POST /auth/mfa/challenge'` to `ACCOUNT_ROUTES_V3`.

CAPTCHA on `POST /auth/code` is plan 05's `captchaRefusal`. Plan 05's own suite tests that helper, and this suite runs with every CAPTCHA flow off (plan 05's v3-app default).

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json --grep "sign-in by email code|route table"`
Expected: FAIL with `expected 404 to equal 202` (no `/auth/code` route), and the route table misses `POST /auth/code` and `POST /auth/mfa/challenge`.

- [ ] **Step 4: Implement**

`src/v3/responses.ts`: give `authnFailureResponse` a shared Retry-After helper. Keep the body that plan 03 gave it.

```ts
/** Retry-After in whole seconds, never negative. */
export function retryAfterHeader(seconds: number): IResponseHeader {
  return { Name: 'Retry-After', Value: String(Math.max(0, Math.ceil(seconds))) };
}
```

and in `authnFailureResponse` replace the `headers.push({ Name: 'Retry-After', … })` line with:

```ts
  if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)) headers.push(retryAfterHeader(retryAfterSeconds));
```

`src/v3/routes.ts`: add `EMAIL_MAX_LENGTH, LOGIN_CODE_MAX_LENGTH` to the `@spinajs/authn/contracts` value import, and append:

```ts
export type LoginCredentials = { readonly kind: 'password'; readonly login: string; readonly password: string } | { readonly kind: 'code'; readonly email: string; readonly code: string };

/** `{ login, password }` (2.x `Email`, `Password`), or `{ email, code }` for a mailed code; null when neither is complete or a value is over-long (N3). */
export function loginCredentialsOf(req: Request, passwordCap: number): LoginCredentials | null {
  if (bodyField(req, 'password', 'Password') !== undefined) {
    const login = boundedString(bodyField(req, 'login', 'Email'), passwordCap);
    const password = boundedString(bodyField(req, 'password', 'Password'), passwordCap);
    return login === null || password === null ? null : { kind: 'password', login, password };
  }
  const email = boundedString(bodyField(req, 'email', 'login'), EMAIL_MAX_LENGTH);
  const code = boundedString(bodyField(req, 'code'), LOGIN_CODE_MAX_LENGTH);
  return email === null || code === null ? null : { kind: 'code', email, code };
}
```

`src/v3/controllers/AuthnLoginController.ts`: add `loginCredentialsOf` to the `'../routes.js'` import and drop `bodyField` and `boundedString` from it if nothing else in the file uses them. In the `login` doc comment, replace "Body `{ login, password }` (the 2.x `Email` and `Password` names work too)." with "Body `{ login, password }` (the 2.x `Email` and `Password` names work too), or `{ email, code }` with a code from `POST /auth/code`." Then replace the credential lines, from `const login = boundedString(…)` up to and including plan 05's `if (refusal) return refusal;`, with:

```ts
    // Over-long values never verify (N3), so they reach no strategy, no throttle and no log.
    const credentials = loginCredentialsOf(req, PASSWORD_HARD_CAP);
    if (credentials === null) return authnFailureResponse(undefined, cleared);
    // Before any lookup and before the throttle: a refused request neither names an account nor spends its free attempts.
    const refusal = await captchaRefusal(this.Container, req, 'login', credentials.kind === 'password' ? credentials.login : credentials.email, cleared);
    if (refusal) return refusal;
```

In the `authenticate` call, replace `{ kind: 'password', login, password }` with `credentials`. Plan 06's `refusalResponse` line after it stays.

Create `src/v3/controllers/AuthnCodeController.ts`:

```ts
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BadRequestResponse, BaseController, BasePath, HTTP_STATUS_CODE, Ok, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { CodeLoginService, EMAIL_MAX_LENGTH } from '@spinajs/authn/contracts';
import { authnMessage } from '@spinajs/authn/messages';

import { errorBody, notFound } from '../../policies/v3/errors.js';
import { captchaRefusal } from '../captcha.js';
import { NO_STORE, retryAfterHeader } from '../responses.js';
import { bodyField, boundedString, contextOf } from '../routes.js';

// Scanned only when an app lists src/v3/controllers (N8c); this file must not load the @spinajs/authn root at module load.

/**
 * Passwordless login, first request (plan 08): mails a sign-in code that `POST /auth/login` takes as `{ email, code }`.
 * @tags Authentication
 */
@BasePath('auth')
export class AuthnCodeController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  /**
   * Request a sign-in code
   * Body `{ email, captcha? }`. 202 with the same body whether or not the address belongs to an account (A02); only a
   * verified address of an active identity gets a code. 400 for a malformed address or a failed CAPTCHA, 404 when code
   * login is off, 429 with Retry-After when throttled.
   * @security []
   */
  @Post('code')
  public async request(@Req() req: Request) {
    const invalid = () => new BadRequestResponse(errorBody('code_invalid_email', 'enter one valid email address'), { Headers: [NO_STORE] });
    const email = boundedString(bodyField(req, 'email'), EMAIL_MAX_LENGTH);
    if (email === null) return invalid();
    const refusal = await captchaRefusal(this.Container, req, 'code', email);
    if (refusal) return refusal;
    const result = await (await this.Container.resolve(CodeLoginService)).request(email, contextOf(req, 'login'));
    if (result.status === 'accepted') return new Ok({ messages: [authnMessage('code_requested')] }, { StatusCode: HTTP_STATUS_CODE.ACCEPTED, Headers: [NO_STORE] });
    if (result.status === 'throttled') {
      const retryAfterSeconds = Math.max(0, Math.ceil(result.retryAfterSeconds));
      return new Ok(errorBody('throttled', 'too many code requests', { retryAfterSeconds }), { StatusCode: HTTP_STATUS_CODE.TOO_MANY_REQUESTS, Headers: [NO_STORE, retryAfterHeader(retryAfterSeconds)] });
    }
    if (result.status === 'invalid') return invalid();
    throw notFound('code_login_off', 'sign-in by email code is not enabled');
  }
}
```

`src/v3/controllers/AuthnMfaController.ts`: add `HTTP_STATUS_CODE` to the `@spinajs/http` import, `retryAfterHeader` to the `'../responses.js'` import, `errorBody` to the `'../../policies/v3/errors.js'` import, and `import { authnMessage } from '@spinajs/authn/messages';`. After the `recovery` route add:

```ts
  /**
   * Send a step's code
   * Body `{ step? }`: `step` when it is one of the pending steps, else the first pending step. 200 when the step mailed a
   * code; 403 when it sends none (TOTP) or would repeat the first factor; 429 with Retry-After when throttled.
   * @security cookieAuth
   */
  @Post('mfa/challenge')
  public async challenge(@Req() req: Request) {
    const session = req.storage.AuthnSession;
    if (!session) throw unauthenticated('this route needs a pending session');
    if (session.handle.state !== 'pending') throw refused('mfa_not_pending', 'this session needs no second factor');
    const steps = await pendingSteps(this.Container, session);
    const asked = bodyField(req, 'step');
    const step = typeof asked === 'string' && steps.includes(asked) ? asked : steps[0];
    const authn = await this.Container.resolve(AuthnService);
    if (step === undefined || typeof authn.challengeMfa !== 'function') throw refused('code_no_challenge', 'this step sends no code');
    const result = await authn.challengeMfa(session.handle, step, contextOf(req, 'login', session.handle));
    if (result.status === 'sent') return new Ok({ messages: [authnMessage('code_challenge_sent')] }, { Headers: [NO_STORE] });
    if (result.status === 'throttled') {
      const retryAfterSeconds = Math.max(0, Math.ceil(result.retryAfterSeconds));
      return new Ok(errorBody('throttled', 'too many code requests', { retryAfterSeconds }), { StatusCode: HTTP_STATUS_CODE.TOO_MANY_REQUESTS, Headers: [NO_STORE, retryAfterHeader(retryAfterSeconds)] });
    }
    throw refused('code_no_challenge', 'this step sends no code');
  }
```

- [ ] **Step 5: GREEN, package suite**

1. `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/v3/inert.test.ts test/v3/route-table-n8c.test.ts`. Expected: all passing.
2. `cd packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json`. Expected: all passing. That includes `sign-in by email code` (6), and the existing `MFA completion` cases, whose users have no address, so `email-code` is never enrolled for them.
3. `cd packages/authn-http && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npm test`. Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add packages/authn-http/src/v3/responses.ts packages/authn-http/src/v3/routes.ts packages/authn-http/src/v3/controllers/AuthnCodeController.ts packages/authn-http/src/v3/controllers/AuthnLoginController.ts packages/authn-http/src/v3/controllers/AuthnMfaController.ts packages/authn-http/test/v3/inert.test.ts packages/authn-http/test/v3-app/app.ts packages/authn-http/test/v3-app/suites/code.ts packages/authn-http/test/v3-app/account.test.ts packages/authn-http/test/v3-app/suites/route-table.ts
git diff --cached --stat
git commit -m "feat(authn-http): POST /auth/code, code login on POST /auth/login, POST /auth/mfa/challenge"
```

---

### Task 8: Behaviour rule A36 and documentation

**Files:**
- Create: `packages/authn-testing/src/behaviour/A36-email-code.spec.ts`
- Modify: `packages/authn-testing/src/harness/ports.ts` (`Harness` `:9-55`, a new interface after `EventsPort` `:120-123`); `packages/authn-testing/src/behaviour/types.ts:8`, `:17-57`; `packages/authn-testing/src/behaviour/index.ts:30`, `:40`; `packages/authn-testing/README.md` (Lane → facets table, `:106-120`)
- Modify: `packages/authn/test/behaviour/harness.ts` (imports `:5-8`, `coreHarnessOf` `:316-353`, `coreHarness` `:356-358`), `packages/authn/test/behaviour/core.test.ts:11`, `:15`
- Modify: `docs/authn/README.md` (`:123-124`, after `:161`, after `:215`, after `:285`, `:470`, `:511-513`, `:611`, after `:635`)
- Test: `packages/authn-testing/test/registry.test.ts:7`, `:48-54`, new case after `:78`

Line numbers are today's. Plans 03, 05 and 06 add their rules (A33-A35) to the same lists first; append after theirs.

**Interfaces:**
- Consumes: Task 4 `CodeLoginService`, `DefaultCodeLoginService.drain()`. Task 3 harness parts `addresses` and `codeSender`.
- Produces: kit port `codeLogin?: CodeLoginPort` with `address(id, email, verified): Promise<void>`, `request(email, ctx): Promise<CodeRequestResult>` (resolves after the deferred send) and `sent(email, purpose: 'login' | 'mfa'): Promise<string | null>`. Rule `A36` with facet `A36/core`, claimed by the core lane.

- [ ] **Step 1: Schema additions**

None.

- [ ] **Step 2: Write the failing tests**

`packages/authn-testing/test/registry.test.ts`:
- Line 7: append `'A36/core'` to `FACET_MAP`.
- Replace the first test (`:48-54`) with:

```ts
  it('RULE_IDS are A01–A27 and A30–A36 in order', () => {
    const expected = [...Array.from({ length: 27 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`), 'A30', 'A31', 'A32', 'A33', 'A34', 'A35', 'A36'];
    assert.deepStrictEqual([...RULE_IDS], expected);
    assert.deepStrictEqual([...AUTHN_RULES.keys()], expected);
    assert.strictEqual(AUTHN_RULES.has('A28' as RuleId), false);
    assert.strictEqual(AUTHN_RULES.has('A29' as RuleId), false);
  });
```

- After the `batch 5 transcribed …` test (`:73`) add:

```ts
  it('plan 08 added A36 with 4 cases', () => {
    assert.strictEqual(AUTHN_RULES.get('A36' as RuleId)!.cases.length, 4);
  });
```

`packages/authn/test/behaviour/core.test.ts`: append `'A36/core'` to `FACETS` (line 11) and `'A36'` to the rule list (line 15).

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn-testing && npx ts-mocha -p tsconfig.json test/registry.test.ts`
Expected: FAIL. The `RULE_IDS` test fails with `Expected values to be strictly deep-equal` (no `'A36'`), and `plan 08 added A36` fails with `Cannot read properties of undefined (reading 'cases')`.

- [ ] **Step 4: Implement the kit rule**

`src/harness/ports.ts`: add `CodeRequestResult` to the `@spinajs/authn/contracts` type import (line 1). In `Harness`, after `readonly events?: EventsPort;` add:

```ts
  readonly codeLogin?: CodeLoginPort;
```

After `EventsPort` (`:123`) add:

```ts
/** Sign-in by mailed code (plan 08). */
export interface CodeLoginPort {
  /** Adds `email` to the addresses of `id`, verified or not. */
  address(id: IdentityRef, email: string, verified: boolean): Promise<void>;
  /** CodeLoginService.request; resolves once the lane's deferred lookup and send have run. */
  request(email: string, ctx: AuthnContext): Promise<CodeRequestResult>;
  /** The newest code mailed to `email` for `purpose`, or null. */
  sent(email: string, purpose: 'login' | 'mfa'): Promise<string | null>;
}
```

`src/behaviour/types.ts`: line 8 appends `'A36'` to `RULE_IDS`, and `portNames` gains `codeLogin: 1,` after `events: 1,`.

Create `src/behaviour/A36-email-code.spec.ts`:

```ts
import assert from 'node:assert/strict';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { ALICE, BOB, NOBODY, auth, expectFailure, expectSuccess } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule, CaseKit, HarnessWith } from './types.js';

async function withAddress(h: HarnessWith<'seed' | 'codeLogin'>, login: string, verified = true): Promise<IdentityRef> {
  const id = await h.seed.user({ login, email: login });
  await h.codeLogin.address(id, login, verified);
  return id;
}

async function mailedCode(h: HarnessWith<'codeLogin'>, k: CaseKit, email: string): Promise<string> {
  assert.deepStrictEqual(await h.codeLogin.request(email, k.ctx()), { status: 'accepted' });
  const code = await h.codeLogin.sent(email, 'login');
  assert.ok(code, `a login code was mailed to ${email}`);
  return code;
}

export const A36: AuthnRule = defineRule('A36', 'a mailed sign-in code logs in once, and asking for one tells nothing about the address', [
  defineCase({
    name: 'A36 the request answer is the same for a verified, an unverified and an unknown address; only the verified one gets a code',
    facet: 'A36/core',
    needs: ['seed', 'codeLogin'],
    async run(h, k) {
      await withAddress(h, ALICE.login);
      await withAddress(h, BOB.login, false);
      const answers = [];
      for (const email of [ALICE.login, BOB.login, NOBODY]) answers.push(await h.codeLogin.request(email, k.ctx()));
      assert.deepStrictEqual(answers, [{ status: 'accepted' }, { status: 'accepted' }, { status: 'accepted' }]);
      assert.notStrictEqual(await h.codeLogin.sent(ALICE.login, 'login'), null);
      assert.strictEqual(await h.codeLogin.sent(BOB.login, 'login'), null);
      assert.strictEqual(await h.codeLogin.sent(NOBODY, 'login'), null);
    },
  }),
  defineCase({
    name: 'A36 a mailed code logs in once, at aal1 with method code',
    facet: 'A36/core',
    needs: ['service', 'seed', 'codeLogin'],
    async run(h, k) {
      const alice = await withAddress(h, ALICE.login);
      const code = await mailedCode(h, k, ALICE.login);
      const first = await auth(h, k, { kind: 'code', email: ALICE.login, code });
      expectSuccess(first);
      assert.deepStrictEqual([first.identity, first.facts.method, first.facts.assurance], [alice, 'code', 'aal1']);
      expectFailure(await auth(h, k, { kind: 'code', email: ALICE.login, code }), 'invalid_credentials');
    },
  }),
  defineCase({
    name: 'A36 a code logs in only the identity it was mailed to',
    facet: 'A36/core',
    needs: ['service', 'seed', 'codeLogin'],
    async run(h, k) {
      await withAddress(h, ALICE.login);
      await withAddress(h, BOB.login);
      const bobs = await mailedCode(h, k, BOB.login);
      expectFailure(await auth(h, k, { kind: 'code', email: ALICE.login, code: bobs }), 'invalid_credentials');
      expectSuccess(await auth(h, k, { kind: 'code', email: BOB.login, code: bobs }));
    },
  }),
  defineCase({
    name: 'A36 a code request is audited as code.request and no event carries the code',
    facet: 'A36/core',
    needs: ['seed', 'codeLogin', 'events'],
    async run(h, k) {
      const alice = await withAddress(h, ALICE.login);
      const code = await mailedCode(h, k, ALICE.login);
      const requests = h.events.all().filter((e) => e.type === 'code.request');
      assert.deepStrictEqual(
        requests.map((e) => [e.outcome, e.identity]),
        [['success', alice]],
      );
      assert.ok(!JSON.stringify(h.events.all()).includes(code), 'no event carries the code (A21)');
    },
  }),
]);
```

`src/behaviour/index.ts`: after the last rule import add `import { A36 } from './A36-email-code.spec.js';`, and append `A36` as the last member of `ALL`.

`packages/authn-testing/README.md`, Lane → facets table: add the row

```md
| plan 08 | A36/core |
```

Rebuild the kit: `cd packages/authn-testing && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.

- [ ] **Step 5: Implement the core lane port**

`packages/authn/test/behaviour/harness.ts`:
- Add `CodeLoginPort` to the `@spinajs/authn-testing` type import (line 6), and `CodeLoginService, DefaultCodeLoginService` to the `'../../src/index.js'` import (line 8).
- Before `coreHarnessOf` add:

```ts
function codeLoginPort(parts: CoreParts): CodeLoginPort {
  const service = async (): Promise<DefaultCodeLoginService> => (await parts.child.resolve(CodeLoginService)) as DefaultCodeLoginService;
  return {
    address: async (id, email, verified) => parts.addresses.set(id, 'email', email, verified ? new Date(0) : null),
    request: async (email, ctx) => {
      const s = await service();
      const r = await s.request(email, ctx);
      await s.drain();
      return r;
    },
    sent: async (email, purpose) => parts.codeSender.codeFor(email, purpose),
  };
}
```

- In `coreHarnessOf`'s returned object, after `events: parts.events,` add:

```ts
    ...(parts.strategies.some((s) => s.service === 'CodeStrategy') ? { codeLogin: codeLoginPort(parts) } : {}),
```

- `coreHarness` becomes:

```ts
/** The lane's harness factory for runAuthnBehaviour; A36 boots with CodeStrategy listed. */
export async function coreHarness(ctx: HarnessContext): Promise<Harness> {
  return coreHarnessOf(await buildCore(ctx.config, { codeLogin: ctx.rule === 'A36' }));
}
```

- [ ] **Step 6: Documentation**

Edit `docs/authn/README.md`:

- `:123-124`: "for password logins only" becomes "after password and code logins only, skipping a step whose `sameFactorAs` names the login method and a step `forbidForRoles` keeps from one of the identity's roles".
- After the `oidc:<name>` row of the strategy table (`:161`) add:

```md
| `code` (`CodeStrategy`) | `code` (`{ email, code }`, mailed by `POST /auth/code`) | yes | `authn` |
```

- After the `### OIDC` section (`:213-215`) add:

```md
### Email code (`code`)

Passwordless login in two requests (plan 08). `POST /auth/code` with `{ email }` counts the request in the
`code` throttle flow (address and IP keys) and answers 202 with the same body for every address. The
lookup, issue and send run after the answer, so neither the body nor the timing tells whether the address
has an account (A02). Only a verified address of an active identity gets a code
(`authn.code.allowUnverified` also mails unverified ones). The code has `authn.code.length` digits
(default 8), lives `authn.code.ttlSeconds` (600) and dies after `authn.codes.maxAttempts` wrong answers.
`POST /auth/login` with `{ email, code }` then logs in through `CodeStrategy`: method `code`, `aal1`,
counted in the `login` flow under the address. A success marks an unverified address verified. List the
strategy to use it: `{ name: 'code', service: 'CodeStrategy' }`. It needs an `AddressStore`
(`@spinajs/users`), a `OneTimeCodeStore` (`DbOneTimeCodeStore`, `authn-orm`) and a `CodeSender` (`EmailCodeSender`, `@spinajs/email`).

An identity enrolled in a second factor still passes it after a code login. The email code is weaker than
TOTP or WebAuthn: it can be phished, and whoever reads the mailbox passes it.
```

- After the MFA bullet list (`:285`) add:

```md
- `EmailCodeMfaStep` (`email-code`, plan 08): once the step is listed, every identity with a verified email
  address is enrolled. `POST /auth/mfa/challenge` with `{ step: 'email-code' }` mails the code, and
  `POST /auth/mfa/verify` takes it. It is no second factor after a code login (`sameFactorAs`), and
  `authn.mfa.policy.forbidForRoles` keeps it from roles that need more, for example
  `{ 'email-code': ['admin'] }`.
```

- In the throttle sample, after the `reauth:` line (`:470`) add:

```md
    code:   { account: { free: 3, baseDelayMs: 60000, maxDelayMs: 3600000 },
              ip:      { free: 10, baseDelayMs: 10000, maxDelayMs: 900000 } },
```

- `:511-513`: add `code.request` to the event type list, before `throttle.block`.
- `:611`: the `policy` sample becomes `policy: { service: 'DefaultMfaPolicy', force: false, forceForRoles: [], forbidForRoles: {} }`.
- After the `authn.throttle.*` row of the key table (`:635`) add:

```md
| `authn.code.*` | `CodeStrategy`, `DefaultCodeLoginService`, `EmailCodeMfaStep` (plan 08) | `ttlSeconds` (600, 60-3600), `length` (8, 6-10), `allowUnverified` (false). The wrong-answer limit is `authn.codes.maxAttempts`. |
```

- [ ] **Step 7: GREEN, package suites**

1. `cd packages/authn-testing && npx ts-mocha -p tsconfig.json test/registry.test.ts test/pending-smoke.test.ts`. Expected: all passing. The pending smoke lists `[pending: missing seed, codeLogin]` and similar for A36.
2. `cd packages/authn-testing && npm test`. Expected: all passing.
3. `cd packages/authn && npx ts-mocha -p tsconfig.json test/behaviour/core.test.ts`. Expected: all passing, with 4 `A36` cases run, not pending.
4. `cd packages/authn && npm test` and `cd packages/authn-http && npm test`. Expected: all passing.

- [ ] **Step 8: Commit**

```bash
git add packages/authn-testing/src/harness/ports.ts packages/authn-testing/src/behaviour/types.ts packages/authn-testing/src/behaviour/index.ts packages/authn-testing/src/behaviour/A36-email-code.spec.ts packages/authn-testing/README.md packages/authn-testing/test/registry.test.ts packages/authn/test/behaviour/harness.ts packages/authn/test/behaviour/core.test.ts docs/authn/README.md
git diff --cached --stat
git commit -m "test(authn-testing): A36 sign-in by mailed code, and the docs for code login"
```

---

## Self-review

**Spec coverage.**

| Brief item | Where it is covered |
|---|---|
| `POST /auth/code`, enumeration-safe, equal timing | Task 4 (service) and Task 7 (route) |
| Issue purpose `login` to an active identity, send through `CodeSender` | Task 4 `send` |
| No-account mail | Decision 3: not sent |
| `{ kind: 'code', email, code }` on `/auth/login` | Task 1 (type), Task 3 (strategy), Task 7 (controller) |
| Package choice | Decision 1 |
| Method `code`, `aal1` | Task 3 test |
| `code` flow per IP and per address | Tasks 2 and 4 |
| Verify attempts in the `login` flow plus `maxAttempts` | Task 3 (`throttleKeys` → `login:<address>`) and the plan 06 store |
| Verified-only codes, `markVerified` on success | Decision 2, Task 3 |
| `EmailCodeMfaStep`, automatic enrolment, `mfa` purpose | Task 5 |
| Challenge trigger | Task 1 contracts, Task 5 service, Task 7 route |
| Not `aal2` after a code login (enforced) | Tasks 5 and 6 |
| Weaker than TOTP; forbid per role | Task 6 `forbidForRoles`, Security notes |
| CAPTCHA flow `code` | Task 7, through plan 05's `captchaRefusal` |
| Audit `code.request`; login audited with strategy `code` | Task 1 type, Tasks 4 and 5; the existing `accept` audits `login` with `strategy: s.name` |
| Config `authn.code.*` through `@Config` and the schema | Task 3 |
| Message IDs in the plan's range | Task 1, through plan 03's catalogue |
| A-series rule | Task 8 |

**Placeholder scan.** Some steps depend on text that parallel plans write:
- Task 1 Step 2 appends `'code.request'` after whatever plans 04-07 appended to `EVENT_TYPES` and `AuthnEventType`, and the step says to write the literal list.
- Tasks 2, 7 and 8 name lines that plans 03, 05 and 06 shift, so they identify each line by its content as well as its number.
- Decision 14 says what to do when A36 is taken.

No step has TBD, TODO or "similar to".

**Cross-plan alignment** (checked against plans 03, 05 and 06 as written on 2026-10-06):
- **Plan 06.** This plan uses plan 06's `normalizeAddress` and `addressSubject` in place of a local normalizer and identity subjects, and reuses its kit fakes `MemoryAddressStore` and `RecordingCodeSender` and its core `MemoryOneTimeCodeStore`. The `code` flow comes after plan 06's `verify`, and the v3-app wiring of the three stores is plan 06's.
- **Plan 05.** `captchaRefusal(container, req, 'code', email)` replaces a local helper. The login route keeps plan 05's call, with the code login's address as the account.
- **Plan 03.** The five messages are a catalogue part with wire codes. Answers use `messages`, `errorBody`, `refused` and `notFound`, and throttled answers reuse the core code `throttled` (4000018).
- **Rule id.** Plans 03, 05 and 06 all claim A33, so this plan's rule is A36.

**Type consistency.** These names are the same in every task:
- `CodeRequestResult` statuses `accepted`, `throttled`, `invalid` and `disabled` (Tasks 1, 4, 7, 8).
- `MfaChallengeResult` statuses `sent`, `throttled` and `refused` (Tasks 1, 5, 7).
- `addressSubject('email', address)` with the purposes `login` and `mfa` (Tasks 3, 4, 5, 6).
- `CoreOptions.codeLogin`, and `CoreParts.addresses`, `codes` and `codeSender` (Tasks 3-6, 8).
- `MemoryAddressStore.set` and `marked`, and `RecordingCodeSender.codeFor`, `fail` and `clear` (Tasks 3, 4, 5, 7, 8).
- `duplicatesFirstFactor(step, method)` (Tasks 5 and 6).
- `selectAuthnThrottle(container, name)` (Task 4).
- `retryAfterHeader` and `loginCredentialsOf` (Task 7).
- The message codes `code_requested`, `code_challenge_sent`, `code_invalid_email`, `code_no_challenge` and `code_login_off` (Tasks 1 and 7).
