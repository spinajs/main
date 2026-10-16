# Stable numeric message IDs for i18n Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every refusal and failure that the 3.0 authn HTTP layer and authn-oidc send names its message by a stable numeric id, as Kratos does. Each message is `{ id, code, type, text, context? }`. Clients translate by `id` and never parse English.

**Architecture:** A pure-data catalogue in `packages/authn/src/messages/` holds one part per plan range. It has a factory that checks context keys against the catalogue and fills the English text. The catalogue is published as the subpath `@spinajs/authn/messages`. That subpath loads no service module, so authn-http can import it at load and stay inert. authn-http adds `messages: AuthnMessage[]` next to the existing `error`/`message` fields. authn-oidc does the same for its bodies and appends a constant `?error_id=` to its failure redirect. A pin test freezes every id↔code pair. A golden test keeps `docs/authn/messages.md` equal to the catalogue. Behaviour rule A33 makes the wire contract part of the authn test kit.

**Tech Stack:** TypeScript (node16 ESM + CJS builds), mocha + chai via ts-mocha, `@spinajs/exceptions`, `@spinajs/http`, `@spinajs/authn-testing`.

## Global Constraints

- English comments, identifiers and commits. Comment only what the code cannot say.
- Branch `authz-v3-refactor`. One commit per task. Run the package suites before each commit.
- Run every test command from the package directory: `npx ts-mocha -p tsconfig.json <file>`. A package's full suite is `npm test`.
- A package that consumes a changed package reads it from `lib/`. Rebuild the changed package before you test the packages that depend on it: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
- Working-copy files use CRLF (`core.autocrlf=true`). Keep them CRLF, and create new files with CRLF.
- Value checks and defaults go in the module's JSON schema. This plan adds no configuration.
- HTTP work targets the 3.0 layer (`packages/authn-http/src/v3`, `packages/authn-http/src/policies/v3`) and authn-oidc. It never touches the 2.x controllers (`packages/authn-http/src/account`, `src/token`).
- ID ranges are fixed by `docs/auth-feat/README.md` ("Message IDs"). This plan owns 1000000–1000999 and 4000000–4000999. It also numbers the existing password violations in 4001000–4001999, which plan 02 extends. A leading `1` means info and a leading `4` means a user error. A released id is never reused with another meaning.
- A new behaviour rule takes the next free A-number. The last one is A32 today. If plan 01 or 02 has taken A33 by the time Task 5 runs, use the next free number in every file Task 5 names.
- Committing shared files: stage only your hunks. Before you commit, check with `git diff --cached` that nothing of another agent is staged.

---

## Current state

How the 3.0 layer answers today (all bodies are JSON):

| Answer | Status | Body | Source |
|---|---|---|---|
| Login, MFA, inline re-auth failed (A02) | 401 | `{ error: { code: 'E_AUTH_FAILED', message }, message }`. `Retry-After` when login or MFA is throttled. Re-auth never carries it (N3). | `v3/responses.ts:14,23-27`, `policies/v3/errors.ts:4,24-26` |
| Policy refusals, thrown | 401/403/404 | `{ error: '<code>', message }` (+ `stack` outside production). @spinajs/http spreads the error's own props into the body. | `policies/v3/errors.ts:9-21`, `packages/http/src/error.ts:53-62` |
| Controller refusals, returned | 400/404 | literal `{ error: 'invalid_role' \| 'invalid_target' \| 'not_impersonating' \| 'session_not_found', message }` | controllers, see Facts |
| Pending MFA (login 200, whoami 200) | 200 | `{ MfaRequired: [steps] }` only (SR-07) | `AuthnLoginController.ts:53,93` |
| CSRF origin refusal | 403 | `{ error: { code: 'E_CSRF_ORIGIN', message } }` | `middleware/csrf.ts:15,136` |
| OIDC failure | 401 / 303 | `OIDC_FAILURE_BODY` = `{ error: { code: 'E_AUTH_FAILED', message } }`. A browser gets a 303 to `redirects.failure` with nothing appended (D3). | `authn-oidc/src/login.ts:11,213-218` |
| OIDC unlink refused | 403/409 | `{ error: { code: 'E_LINK_REFUSED' } }` | `authn-oidc/src/login.ts:72,204-209` |
| Password change, reset, invite | none in 3.0 | `PasswordService` returns results (`changed`, `accepted`, `reset`/`invite`, `invalid`, `throttled`, `rejected` + `PasswordViolation[]`). Only the 2.x `PasswordResetController` serves HTTP. | `authn/src/contracts/password.ts:16-36` |

No answer carries a numeric id. `@spinajs/intl` translates by English phrase, and `@spinajs/intl-http` picks the language from `?lang`, a cookie or an `x-lang` header, never from `Accept-Language`.

## Decisions (confirm before Task 1)

1. **Body shape.** Answers gain `messages: AuthnMessage[]`, a list as in Kratos' `ui.messages`, alongside the existing `error` and `message` fields, which stay unchanged for compatibility. The rejected alternative was a richer `error: { code, id, text, context }`. It would change `error` from a string to an object for every thrown refusal, and the A02 body already uses an object there. A list also leaves room for several violations of one password.
2. **Catalogue codes are the existing wire codes.** The codes are `E_AUTH_FAILED`, `unauthenticated`, `session_required`, `E_LINK_REFUSED` and the like, so `messages[0].code === error` for every refusal. Password violations get a `password_` prefix, because a bare `rule` would be ambiguous.
3. **A02 wins over throttle context.** A throttled login, MFA or re-auth keeps the exact A02 body (`messages: [4000001]`), and `Retry-After` stays the only signal. The A02/http case "a throttled login answers ... alike" pins `expectSameBody`. The catalogue still holds `throttled` (4000018, context `{ retryAfterSeconds }`) for answers outside A02, such as reset-request and the code requests of plans 06 and 08.
4. **Pending answers stay `{ MfaRequired }`.** A09 "SR-07 pending whoami shows only MfaRequired" pins `Object.keys(body)` to `['MfaRequired']`, and so does an A07 case. No info message is added there.
5. **No server-side translation in this plan.** Ids are the contract. `@spinajs/intl` keys its tables by English phrase, and authn-http does not depend on it. Thrown refusals are rendered by @spinajs/http's error handler, which has no request-scoped hook. An app that wants server-rendered text can map `id` → its own phrase table. A later plan can add an opt-in `AuthnMessageTranslator` without changing ids.
6. **Subpath `@spinajs/authn/messages`, outside the frozen contracts.** Like `contracts`, it is pure data that does no DI registration and loads no authn service module. The authn-http inert test learns to allow `lib/cjs/messages/`. `src/messages` matches no frozen file pattern (`scripts/api-snapshot.mjs:51-52`), so no API snapshot or RFC is needed. The pin test is what keeps ids stable. The root barrel re-exports it too.
7. **`context` is narrowed.** It is `Readonly<Record<string, number | boolean | string | readonly string[]>>`, not `unknown`. The factory accepts exactly the keys that the catalogue declares for that code, and strings of at most 256 characters. A login, an email address or a record cannot ride along by accident (the A21 rule's spirit, applied to answers).
8. **`text` is a template rendered by the factory** (`{minLength}` → `8`). It may be reworded later. `id`, `code` and `type` are pinned and may not change.
9. **Reset, change and invite.** The catalogue numbers their outcomes (info 1000001–1000004; errors `throttled` 4000018, `reset_invalid` 4000019). It also ships `passwordViolationMessages(violations, policy)`. No route uses them yet, because 3.0 has no such route and the 2.x controllers are out of scope. The 3.0 password routes (N8b) use them when they land.
10. **`E_CSRF_ORIGIN` is left to plan 04.** Plan 04 rewrites `middleware/csrf.ts` and owns 4002000–4002999. It numbers this answer 4002001 and adds `messages` there.
11. **OIDC.** Every failure redirect gets `?error_id=4000001`, merged into an existing query and placed before a fragment. The id is the same for every reason, so D3 ("no reason in the URL") holds. `OIDC_FAILURE_BODY` and the link refusal body gain `messages`. That `OIDC_FAILURE_BODY` lacks the top-level `message` of `AUTHN_FAILURE_BODY` is a known difference, and this plan does not fix it.
12. **Docs.** `docs/authn/messages.md` is generated by a golden test (`UPDATE_GOLDEN=1`, the convention of `authz-convert/test/golden.test.ts:13-14`). The table cannot drift from the code.
13. **Behaviour rule A33** ("every answer names its messages by a stable catalogued id") gets two http cases. The authn-http v3-app lane claims it.

## Security notes

- A02 is unchanged. Every login failure, throttled ones included, answers one body with one message (4000001), and the OIDC redirect id is a constant. No new oracle appears, because ids map 1:1 to codes that are already on the wire.
- SR-07 is unchanged: a pending session still sees only `MfaRequired`.
- `context` is allow-listed per code, and the values must be plain. A denylist test rejects context keys that look like secrets or personal data (`secret`, `token`, `password`, `email`, `login`, `phone`, `session`, `address`, `ip`, `user`).
- `text` comes from the catalogue, filled only with typed context values, never with request input. Nothing reflected can reach a client that renders `text` as HTML.

## Facts verified (2026-10-06)

- `packages/authn/package.json`: `exports` has `.`, `./contracts`, `./env`. `typesVersions["*"]` maps `contracts` and `env` to `lib/cjs/...`. Dependencies include `@spinajs/exceptions`.
- `packages/authn/src/index.ts:1-10`: the root barrel lists ten `export *` lines. `src/contracts/index.ts:1-19`.
- `packages/authn/src/contracts/password.ts:6-13` `PasswordPolicy { minLength; maxLength; pattern?; description? }`. `:16` `PasswordViolation = 'too_short' | 'too_long' | 'rule' | 'blocklisted'`. `:22` `PasswordRefusal`. `:24-36` the result types. `packages/authn-local/src/policy.ts:171-184` produces the four violations.
- `packages/authn/test/contracts/boundary.test.ts:13` derives `PKG_ROOT` from `import.meta.url`. Copy that pattern.
- `scripts/api-snapshot.mjs:51-52`: the frozen files are `src/contracts.ts`, `src/api.ts` and `src/contracts/index.ts` of `auth[nz]*` packages. `scripts/api-snapshot.json:13`: authn snapshots `src/contracts/index.ts` only.
- `packages/authn-http/src/policies/v3/errors.ts:4` `AUTHN_FAILURE`. `:9-11` `unauthenticated`. `:14-16` `refused(code: string, ...)`. `:19-21` `notFound`. `:24-26` `authnFailed`. `:29` `isAuthnFailed` compares `error === AUTHN_FAILURE`.
- `packages/authn-http/src/v3/responses.ts:8` imports `AUTHN_FAILURE`. `:14` `AUTHN_FAILURE_BODY`. `:23-27` `authnFailureResponse(retryAfterSeconds?, cookies)`.
- `packages/http/src/error.ts:53-62`: the error body is `{ ...err, message: err.message }`. `:74-80` maps the response by class through `__http_error_map__`. `packages/http/src/interfaces.ts:878`: `Response` keeps `protected responseData` and `protected options`.
- `refused` callers: `policies/v3/fresh-auth.ts:40,41,49`, `policies/v3/mfa.ts:36,40,61,65,67`, `policies/v3/principal.ts:39,51,67,79`, `v3/controllers/AuthnActiveRoleController.ts:55,78`, `AuthnImpersonationController.ts:65,83`, `AuthnMfaController.ts:49`, `AuthnSessionsController.ts:79`. `notFound`: `policies/v3/groups.ts:22,36` (code `not_found`). `unauthenticated`: `policies/v3/principal.ts:11`, `policies/v3/mfa.ts:60`, `v3/routes.ts:73`, `AuthnLoginController.ts:73,94`, `AuthnMfaController.ts:48`, `AuthnActiveRoleController.ts:70`. Nothing outside `src/v3` and `src/policies/v3` imports `policies/v3/errors.js`.
- Literal bodies: `AuthnActiveRoleController.ts:52` (`invalid_role`, `ROLE_CAP = 256` at `:14`). `AuthnImpersonationController.ts:67` (`invalid_target`) and `:101` (`not_impersonating`). `AuthnSessionsController.ts:58` (`session_not_found`, `NotFound`).
- `packages/authn-http/src/index.ts:50` re-exports `AUTHN_FAILURE_BODY` and friends, so the package loads `responses.ts` at import.
- `packages/authn-http/test/v3/inert.test.ts:57` filters `require.cache` for `authn/lib/cjs` files that are not `contracts/` and not `boot/env.js`. `:123` asserts that list is `[]`. `:143` pins the N10 body literally.
- `packages/authn-http/test/v3-app/suites/login.ts:118` pins the A02 body literally. `:131-139` covers a throttled login with the same body and `Retry-After`. `:168-172` whoami 401 `unauthenticated`. `suites/sessions.ts:47` `session_not_found`. `suites/active-role.ts:107-112` invalid role 400. `suites/impersonation.ts:85-90` `not_impersonating`. `test/v3/authn-policies.test.ts:626-632` 401 `unauthenticated` over HTTP.
- `packages/authn-http/test/v3-app/behaviour/behaviour.test.ts:11` `CLAIM`, `:13` `RULES`. The harness `ROUTES` has `login` and `logout` (`behaviour/harness.ts:72`).
- `packages/authn-testing/src/behaviour/A02-one-failure-answer.spec.ts:122-160`: the http facet requires the same body for every failure and for a throttled one (`expectSameBody`). `A09-pending-session.spec.ts:156-170` pins pending whoami keys to `['MfaRequired']`. `A07-session-ids.spec.ts:175` checks the same key list.
- `packages/authn-testing/src/behaviour/types.ts:8` `RULE_IDS`. `:178-180` `defineRule(id, title, cases)`. `index.ts:40` `ALL`. `test/registry.test.ts:7` `FACET_MAP`, `:48-53` the pinned id list. `steps.ts:21-22` `NOBODY`, `WRONG`. `:151` `send`. `src/harness/http.ts:24-25` `login`, `logout` route builders. `package.json` depends on `@spinajs/authn`.
- `packages/authn-oidc/src/login.ts:11` `OIDC_FAILURE_BODY`. `:72` `REFUSED_BODY`. `:198` unlink 401. `:213-218` `failure()`, a 303 to `this.d.redirects.failure` or a 401 with the body. `src/options/schema.ts:11` `OIDC_APP_PATH_PATTERN` allows `?` and `#` in the path. `src/contracts.ts:57` `OidcAppPath = \`/${string}\``. `test/contracts.test.ts:29-37` pins the barrel's value exports, so do not export a new name from `login.ts`.
- OIDC tests that pin the failure location: `test/strategy.test.ts:318`, `test/linking.test.ts:153`, `test/login-hardening.test.ts:84` (`'/login'`), and `test/acceptance.test.ts:320` (`'/'`).
- `packages/intl/src/index.ts:134-153`: `__()` looks up by phrase. `packages/intl-http/src/index.ts:14-24`: language from query, cookie or `x-<param>` header. `:91` `req.storage.language`.
- `docs/authn/oidc.md:127-129` says the failure redirect carries "no reason in the URL". `docs/authn/README.md:13` is the OIDC bullet. `:73` and `:687` say "A01-A32". `docs/plans/2026-10-01-authz-v3-design.md:4202` is the A32 row of the §22.17 rule table.
- `packages/authz-convert/test/golden.test.ts:13-14` is the `UPDATE_GOLDEN=1` convention.

## File structure

| File | Responsibility |
|---|---|
| `packages/authn/src/messages/types.ts` (new) | `AuthnMessage`, `AuthnMessageType`, `AuthnMessageContextValue`, `AuthnMessageDefinition` |
| `packages/authn/src/messages/core.ts` (new) | `CORE_MESSAGES`: plan 03's info and error entries |
| `packages/authn/src/messages/password.ts` (new) | `PASSWORD_MESSAGES`, `PasswordMessageCode`, `PASSWORD_VIOLATION_CODES` (plan 02 appends) |
| `packages/authn/src/messages/catalogue.ts` (new) | merges the parts, refuses duplicates, `AUTHN_MESSAGES`, `AuthnMessageCode`, `AuthnErrorCode` |
| `packages/authn/src/messages/factory.ts` (new) | `authnMessage`, `passwordViolationMessages` |
| `packages/authn/src/messages/index.ts` (new) | the subpath's public surface |
| `packages/authn/src/index.ts` | re-export `./messages/index.js` |
| `packages/authn/package.json` | `./messages` export and `typesVersions` entry |
| `packages/authn/test/messages/catalogue.test.ts` (new) | pin table, uniqueness, ranges, freezing, factory, boundary, subpath |
| `packages/authn/test/messages/doc.test.ts` (new) | golden check of `docs/authn/messages.md` |
| `docs/authn/messages.md` (new, generated) | the catalogue for client developers |
| `packages/authn-http/src/policies/v3/errors.ts` | `messages` on every thrown refusal, `errorBody`, `AUTHN_FAILURE_MESSAGES` |
| `packages/authn-http/src/v3/responses.ts` | `AUTHN_FAILURE_BODY.messages` |
| `packages/authn-http/src/v3/controllers/{AuthnActiveRoleController,AuthnImpersonationController,AuthnSessionsController}.ts` | literal bodies through `errorBody` |
| `packages/authn-http/test/v3/messages.test.ts` (new) | unit tests of the helpers |
| `packages/authn-oidc/src/login.ts` | `messages` in both bodies, `?error_id=` on the failure redirect |
| `packages/authn-oidc/test/messages.test.ts` (new) | OIDC messages and redirect id |
| `packages/authn-testing/src/behaviour/A33-message-ids.spec.ts` (new) | rule A33 |

## How a consumer plan (02, 04–09) adds messages

1. Create `packages/authn/src/messages/<topic>.ts` that exports `<TOPIC>_MESSAGES = { ... } as const satisfies Readonly<Record<string, AuthnMessageDefinition>>`, with ids in its README range. Plan 02 appends to `PASSWORD_MESSAGES` and to `PASSWORD_VIOLATION_CODES` instead. A new `PasswordViolation` member does not compile until it has a code.
2. In `catalogue.ts`, add the part to `PARTS` and to the `DEFINITIONS` spread.
3. Add the new rows to `PINNED` in `test/messages/catalogue.test.ts`, and add the range to the range test.
4. Regenerate the docs: `UPDATE_GOLDEN=1 npx ts-mocha -p tsconfig.json test/messages/doc.test.ts` in `packages/authn`.

## Task order

```
Task 1 (authn catalogue)
  then in parallel: Task 2 (docs)   Task 3 (authn-http)   Task 4 (authn-oidc)
  then:             Task 5 (A33, after Task 3)
```

Tasks 3, 4 and 5 read `@spinajs/authn` from `lib/`. Task 1 ends with a rebuild.

---

### Task 1: The message catalogue in `@spinajs/authn`

**Files:**
- Create: `packages/authn/src/messages/types.ts`, `core.ts`, `password.ts`, `catalogue.ts`, `factory.ts`, `index.ts`
- Modify: `packages/authn/src/index.ts:10` (add a line after it)
- Modify: `packages/authn/package.json` (`exports`, `typesVersions`)
- Test: `packages/authn/test/messages/catalogue.test.ts`

**Interfaces:**
- Consumes: `PasswordPolicy`, `PasswordViolation` (types) from `packages/authn/src/contracts/password.ts`, and `InvalidArgument` from `@spinajs/exceptions`.
- Produces (from `@spinajs/authn/messages` and from `@spinajs/authn`):
  - `type AuthnMessageType = 'info' | 'error'`
  - `type AuthnMessageContextValue = number | boolean | string | readonly string[]`
  - `interface AuthnMessage { readonly id: number; readonly code: string; readonly type: AuthnMessageType; readonly text: string; readonly context?: Readonly<Record<string, AuthnMessageContextValue>> }`
  - `interface AuthnMessageDefinition { readonly id: number; readonly type: AuthnMessageType; readonly text: string; readonly context?: readonly string[] }`
  - `type AuthnMessageCode`: the keys of the catalogue. `type AuthnErrorCode`: those of type `'error'`.
  - `const AUTHN_MESSAGES: { readonly [C in AuthnMessageCode]: AuthnMessageDefinition }` (deep-frozen)
  - `function authnMessage(code: AuthnMessageCode, context?: Readonly<Record<string, AuthnMessageContextValue>>): AuthnMessage` (frozen result; throws `InvalidArgument` on an unknown code, on context keys other than the declared ones, or on a value that is not plain)
  - `type PasswordMessageCode`, `const PASSWORD_VIOLATION_CODES: Readonly<Record<PasswordViolation, PasswordMessageCode>>`
  - `function passwordViolationMessages(violations: readonly PasswordViolation[], policy: Pick<PasswordPolicy, 'minLength' | 'maxLength'>): AuthnMessage[]`
  - Internal, for tests and consumer plans: `CORE_MESSAGES` (`core.ts`), `PASSWORD_MESSAGES` (`password.ts`), `assertDistinctMessages(parts)` (`catalogue.ts`).

- [ ] **Step 1: Write the failing test**

Create `packages/authn/test/messages/catalogue.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidArgument } from '@spinajs/exceptions';

import { AUTHN_MESSAGES, PASSWORD_VIOLATION_CODES, authnMessage, passwordViolationMessages } from '../../src/messages/index.js';
import type { AuthnMessageCode, AuthnMessageDefinition } from '../../src/messages/index.js';
import { assertDistinctMessages } from '../../src/messages/catalogue.js';
import { CORE_MESSAGES } from '../../src/messages/core.js';
import { PASSWORD_MESSAGES } from '../../src/messages/password.js';
import * as root from '../../src/index.js';

const expect = chai.expect;

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Released ids: clients translate by them. Append rows; never edit or remove one.
const PINNED: readonly (readonly [number, string, 'info' | 'error'])[] = [
  [1000001, 'password_reset_requested', 'info'],
  [1000002, 'password_reset', 'info'],
  [1000003, 'invite_accepted', 'info'],
  [1000004, 'password_changed', 'info'],
  [4000001, 'E_AUTH_FAILED', 'error'],
  [4000002, 'unauthenticated', 'error'],
  [4000003, 'session_required', 'error'],
  [4000004, 'session_exists', 'error'],
  [4000005, 'already_authenticated', 'error'],
  [4000006, 'impersonating', 'error'],
  [4000007, 'fresh_auth_required', 'error'],
  [4000008, 'mfa_required', 'error'],
  [4000009, 'mfa_not_pending', 'error'],
  [4000010, 'enrolment_closed', 'error'],
  [4000011, 'not_found', 'error'],
  [4000012, 'session_not_found', 'error'],
  [4000013, 'invalid_role', 'error'],
  [4000014, 'role_not_held', 'error'],
  [4000015, 'invalid_target', 'error'],
  [4000016, 'impersonation_refused', 'error'],
  [4000017, 'not_impersonating', 'error'],
  [4000018, 'throttled', 'error'],
  [4000019, 'reset_invalid', 'error'],
  [4000020, 'E_LINK_REFUSED', 'error'],
  [4001001, 'password_too_short', 'error'],
  [4001002, 'password_too_long', 'error'],
  [4001003, 'password_rule', 'error'],
  [4001004, 'password_blocklisted', 'error'],
];

const entries = (): [string, AuthnMessageDefinition][] => Object.entries(AUTHN_MESSAGES);
const within = (id: number, from: number, to: number) => id >= from && id <= to;

describe('authn message catalogue', () => {
  it('pins every released id to its code and type', () => {
    const actual = entries()
      .map(([code, d]) => [d.id, code, d.type] as const)
      .sort((a, b) => a[0] - b[0]);
    expect(actual).to.deep.eq(PINNED);
  });

  it('ids are unique; info ids start with 1 and error ids with 4', () => {
    const ids = entries().map(([, d]) => d.id);
    expect(new Set(ids).size).to.eq(ids.length);
    for (const [code, d] of entries()) expect(Math.floor(d.id / 1000000), code).to.eq(d.type === 'info' ? 1 : 4);
  });

  it('each part stays in its README range', () => {
    for (const [code, d] of Object.entries(CORE_MESSAGES) as [string, AuthnMessageDefinition][]) {
      expect(within(d.id, 1000000, 1000999) || within(d.id, 4000000, 4000999), code).to.eq(true);
    }
    for (const [code, d] of Object.entries(PASSWORD_MESSAGES) as [string, AuthnMessageDefinition][]) {
      expect(within(d.id, 4001000, 4001999), code).to.eq(true);
    }
  });

  it('the catalogue, each definition and each context list are frozen', () => {
    expect(Object.isFrozen(AUTHN_MESSAGES)).to.eq(true);
    for (const [code, d] of entries()) {
      expect(Object.isFrozen(d), code).to.eq(true);
      if (d.context) expect(Object.isFrozen(d.context), code).to.eq(true);
    }
  });

  it('the placeholders of a text are exactly its declared context keys', () => {
    for (const [code, d] of entries()) {
      const placeholders = [...d.text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(placeholders, code).to.deep.eq([...(d.context ?? [])].sort());
    }
  });

  it('no context key names a secret or personal data', () => {
    for (const [code, d] of entries()) {
      for (const key of d.context ?? []) expect(key, code).to.not.match(/secret|token|password|email|login|phone|session|address|^ip$|user/i);
    }
  });

  it('assertDistinctMessages refuses a code or an id used twice', () => {
    const a = { one: { id: 4009001, type: 'error', text: 'One.' } } as const;
    expect(() => assertDistinctMessages([a, { one: { id: 4009002, type: 'error', text: 'Two.' } }])).to.throw(InvalidArgument, /one is defined twice/);
    expect(() => assertDistinctMessages([a, { two: { id: 4009001, type: 'error', text: 'Two.' } }])).to.throw(InvalidArgument, /4009001 is used by one and two/);
    expect(() => assertDistinctMessages([a, { two: { id: 4009002, type: 'error', text: 'Two.' } }])).to.not.throw();
  });
});

describe('authnMessage', () => {
  it('builds a frozen message without context', () => {
    const m = authnMessage('E_AUTH_FAILED');
    expect(m).to.deep.eq({ id: 4000001, code: 'E_AUTH_FAILED', type: 'error', text: 'The login or password is incorrect.' });
    expect(m).to.not.have.property('context');
    expect(Object.isFrozen(m)).to.eq(true);
  });

  it('fills the text from the context and keeps a frozen copy of the values', () => {
    const m = authnMessage('throttled', { retryAfterSeconds: 30 });
    expect(m).to.deep.eq({ id: 4000018, code: 'throttled', type: 'error', text: 'Too many attempts. Try again in 30 seconds.', context: { retryAfterSeconds: 30 } });
    expect(Object.isFrozen(m.context)).to.eq(true);
  });

  it('refuses a missing, an undeclared or an extra context key', () => {
    expect(() => authnMessage('throttled')).to.throw(InvalidArgument, /takes the context retryAfterSeconds, not none/);
    expect(() => authnMessage('throttled', { retryAfterSeconds: 3, email: 'alice@example.test' })).to.throw(InvalidArgument, /not retryAfterSeconds, email/);
    expect(() => authnMessage('E_AUTH_FAILED', { login: 'alice' })).to.throw(InvalidArgument, /takes the context none, not login/);
  });

  it('refuses a context value that is not plain', () => {
    expect(() => authnMessage('throttled', { retryAfterSeconds: { user: 'alice' } as never })).to.throw(InvalidArgument, /context retryAfterSeconds must be/);
    expect(() => authnMessage('throttled', { retryAfterSeconds: Number.NaN })).to.throw(InvalidArgument);
    expect(() => authnMessage('invalid_role', { maxLength: 'x'.repeat(257) })).to.throw(InvalidArgument);
  });

  it('refuses an unknown code, inherited names included', () => {
    expect(() => authnMessage('nope' as AuthnMessageCode)).to.throw(InvalidArgument, /unknown authn message code nope/);
    expect(() => authnMessage('toString' as AuthnMessageCode)).to.throw(InvalidArgument);
  });
});

describe('password violations', () => {
  it('passwordViolationMessages numbers each violation with the policy limits', () => {
    expect(passwordViolationMessages(['too_short', 'too_long', 'rule', 'blocklisted'], { minLength: 8, maxLength: 128 })).to.deep.eq([
      { id: 4001001, code: 'password_too_short', type: 'error', text: 'The password must be at least 8 characters long.', context: { minLength: 8 } },
      { id: 4001002, code: 'password_too_long', type: 'error', text: 'The password must be at most 128 characters long.', context: { maxLength: 128 } },
      { id: 4001003, code: 'password_rule', type: 'error', text: 'The password does not match the password rule.' },
      { id: 4001004, code: 'password_blocklisted', type: 'error', text: 'This password is too common. Choose another one.' },
    ]);
  });

  it('PASSWORD_VIOLATION_CODES maps every PasswordViolation', () => {
    expect(Object.keys(PASSWORD_VIOLATION_CODES).sort()).to.deep.eq(['blocklisted', 'rule', 'too_long', 'too_short']);
    expect(Object.isFrozen(PASSWORD_VIOLATION_CODES)).to.eq(true);
  });
});

describe('the messages subpath', () => {
  it('imports only its own files, @spinajs/exceptions and contract types: it loads no service module', () => {
    const dir = join(PKG_ROOT, 'src', 'messages');
    const offending: string[] = [];
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const m of text.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?\sfrom\s+'([^']+)'/gm)) {
        const typeOnly = m[1] !== undefined;
        const spec = m[2];
        const ok = spec.startsWith('./') || spec === '@spinajs/exceptions' || (typeOnly && spec.startsWith('../contracts/'));
        if (!ok) offending.push(`${file}: ${m[0]}`);
      }
    }
    expect(offending).to.deep.eq([]);
  });

  it('is published as @spinajs/authn/messages and re-exported by the root', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
    expect(pkg.exports['./messages']).to.deep.eq({ types: './lib/mjs/messages/index.d.ts', import: './lib/mjs/messages/index.js', require: './lib/cjs/messages/index.js' });
    expect(pkg.typesVersions['*'].messages).to.deep.eq(['lib/cjs/messages/index.d.ts']);
    expect(root.AUTHN_MESSAGES).to.eq(AUTHN_MESSAGES);
    expect(root.authnMessage).to.eq(authnMessage);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/messages/catalogue.test.ts`
Expected: FAIL, `Cannot find module '../../src/messages/index.js'` (TS2307, or ERR_MODULE_NOT_FOUND from the ESM loader).

- [ ] **Step 3: Write the implementation**

Create `packages/authn/src/messages/types.ts`:

```ts
export type AuthnMessageType = 'info' | 'error';

/** What a client may interpolate into its own translation. */
export type AuthnMessageContextValue = number | boolean | string | readonly string[];

/** One message of an answer's `messages`. Clients translate by `id`; `text` is the English default. */
export interface AuthnMessage {
  readonly id: number;
  readonly code: string;
  readonly type: AuthnMessageType;
  readonly text: string;
  readonly context?: Readonly<Record<string, AuthnMessageContextValue>>;
}

export interface AuthnMessageDefinition {
  readonly id: number;
  readonly type: AuthnMessageType;
  /** `{key}` placeholders name context keys. */
  readonly text: string;
  /** The context keys the message takes; every one is required, no other is accepted. */
  readonly context?: readonly string[];
}
```

Create `packages/authn/src/messages/core.ts`:

```ts
import type { AuthnMessageDefinition } from './types.js';

// Plan 03's range (docs/auth-feat/README.md, "Message IDs"). Append only: a released id never changes its meaning.
export const CORE_MESSAGES = {
  password_reset_requested: { id: 1000001, type: 'info', text: 'If an account matches, a password reset link is on its way.' },
  password_reset: { id: 1000002, type: 'info', text: 'The password has been reset. Log in with the new password.' },
  invite_accepted: { id: 1000003, type: 'info', text: 'The invitation is accepted and the password is set.' },
  password_changed: { id: 1000004, type: 'info', text: 'The password has been changed.' },

  E_AUTH_FAILED: { id: 4000001, type: 'error', text: 'The login or password is incorrect.' },
  unauthenticated: { id: 4000002, type: 'error', text: 'Log in to continue.' },
  session_required: { id: 4000003, type: 'error', text: 'This action needs a login session.' },
  session_exists: { id: 4000004, type: 'error', text: 'This action is not available while a session is open.' },
  already_authenticated: { id: 4000005, type: 'error', text: 'You are already logged in. Log out first.' },
  impersonating: { id: 4000006, type: 'error', text: 'This action is not available while impersonating another user.' },
  fresh_auth_required: { id: 4000007, type: 'error', text: 'Confirm your password to continue.' },
  mfa_required: { id: 4000008, type: 'error', text: 'This action needs a second authentication factor.' },
  mfa_not_pending: { id: 4000009, type: 'error', text: 'This session does not need a second factor.' },
  enrolment_closed: { id: 4000010, type: 'error', text: 'Second-factor enrolment is not available here.' },
  not_found: { id: 4000011, type: 'error', text: 'This feature is not available.' },
  session_not_found: { id: 4000012, type: 'error', text: 'No such session.' },
  invalid_role: { id: 4000013, type: 'error', text: 'The role must be a non-empty name of at most {maxLength} characters.', context: ['maxLength'] },
  role_not_held: { id: 4000014, type: 'error', text: 'You do not hold this role.' },
  invalid_target: { id: 4000015, type: 'error', text: 'The target must be a user id or an identity reference.' },
  impersonation_refused: { id: 4000016, type: 'error', text: 'Impersonating this user is refused.' },
  not_impersonating: { id: 4000017, type: 'error', text: 'No impersonation is active.' },
  throttled: { id: 4000018, type: 'error', text: 'Too many attempts. Try again in {retryAfterSeconds} seconds.', context: ['retryAfterSeconds'] },
  reset_invalid: { id: 4000019, type: 'error', text: 'The reset link is invalid or has expired.' },
  E_LINK_REFUSED: { id: 4000020, type: 'error', text: 'The account link was refused.' },
} as const satisfies Readonly<Record<string, AuthnMessageDefinition>>;
```

Create `packages/authn/src/messages/password.ts`:

```ts
import type { PasswordViolation } from '../contracts/password.js';
import type { AuthnMessageDefinition } from './types.js';

// Plan 03 numbers the violations of today; plan 02 appends its kinds from 4001005.
export const PASSWORD_MESSAGES = {
  password_too_short: { id: 4001001, type: 'error', text: 'The password must be at least {minLength} characters long.', context: ['minLength'] },
  password_too_long: { id: 4001002, type: 'error', text: 'The password must be at most {maxLength} characters long.', context: ['maxLength'] },
  password_rule: { id: 4001003, type: 'error', text: 'The password does not match the password rule.' },
  password_blocklisted: { id: 4001004, type: 'error', text: 'This password is too common. Choose another one.' },
} as const satisfies Readonly<Record<string, AuthnMessageDefinition>>;

export type PasswordMessageCode = keyof typeof PASSWORD_MESSAGES;

/** A new PasswordViolation does not compile until it is numbered here. */
export const PASSWORD_VIOLATION_CODES: Readonly<Record<PasswordViolation, PasswordMessageCode>> = Object.freeze({
  too_short: 'password_too_short',
  too_long: 'password_too_long',
  rule: 'password_rule',
  blocklisted: 'password_blocklisted',
});
```

Create `packages/authn/src/messages/catalogue.ts`:

```ts
import { InvalidArgument } from '@spinajs/exceptions';

import { CORE_MESSAGES } from './core.js';
import { PASSWORD_MESSAGES } from './password.js';
import type { AuthnMessageDefinition } from './types.js';

/** A spread merge would silently keep the last of two equal codes, so the parts are checked first. */
export function assertDistinctMessages(parts: readonly Readonly<Record<string, AuthnMessageDefinition>>[]): void {
  const codes = new Set<string>();
  const ids = new Map<number, string>();
  for (const part of parts) {
    for (const [code, def] of Object.entries(part)) {
      if (codes.has(code)) throw new InvalidArgument(`authn message code ${code} is defined twice`);
      const other = ids.get(def.id);
      if (other !== undefined) throw new InvalidArgument(`authn message id ${def.id} is used by ${other} and ${code}`);
      codes.add(code);
      ids.set(def.id, code);
    }
  }
}

const PARTS = [CORE_MESSAGES, PASSWORD_MESSAGES] as const;
assertDistinctMessages(PARTS);

const DEFINITIONS = { ...CORE_MESSAGES, ...PASSWORD_MESSAGES };

export type AuthnMessageCode = keyof typeof DEFINITIONS;
export type AuthnErrorCode = { [C in AuthnMessageCode]: (typeof DEFINITIONS)[C]['type'] extends 'error' ? C : never }[AuthnMessageCode];

for (const def of Object.values(DEFINITIONS)) {
  Object.freeze(def);
  if ('context' in def) Object.freeze(def.context);
}

export const AUTHN_MESSAGES: { readonly [C in AuthnMessageCode]: AuthnMessageDefinition } = Object.freeze(DEFINITIONS);
```

Create `packages/authn/src/messages/factory.ts`:

```ts
import { InvalidArgument } from '@spinajs/exceptions';

import type { PasswordPolicy, PasswordViolation } from '../contracts/password.js';
import { AUTHN_MESSAGES } from './catalogue.js';
import type { AuthnMessageCode } from './catalogue.js';
import { PASSWORD_VIOLATION_CODES } from './password.js';
import type { AuthnMessage, AuthnMessageContextValue, AuthnMessageDefinition } from './types.js';

const MAX_CONTEXT_STRING = 256;
const PLACEHOLDER = /\{(\w+)\}/g;

// Context reaches the client: only declared keys and plain values pass, so a secret, a login or a record cannot ride
// along by accident.
function isContextValue(v: unknown): v is AuthnMessageContextValue {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return true;
  if (typeof v === 'string') return v.length <= MAX_CONTEXT_STRING;
  return Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length <= MAX_CONTEXT_STRING);
}

const shown = (v: AuthnMessageContextValue): string => (typeof v === 'object' ? v.join(', ') : String(v));

export function authnMessage(code: AuthnMessageCode, context?: Readonly<Record<string, AuthnMessageContextValue>>): AuthnMessage {
  const def: AuthnMessageDefinition | undefined = Object.prototype.hasOwnProperty.call(AUTHN_MESSAGES, code) ? AUTHN_MESSAGES[code] : undefined;
  if (def === undefined) throw new InvalidArgument(`unknown authn message code ${String(code)}`);
  const declared = def.context ?? [];
  const given = Object.keys(context ?? {});
  if (given.length !== declared.length || declared.some((k) => !given.includes(k))) {
    throw new InvalidArgument(`authn message ${code} takes the context ${declared.join(', ') || 'none'}, not ${given.join(', ') || 'none'}`);
  }
  const values: Record<string, AuthnMessageContextValue> = {};
  for (const key of declared) {
    const value: unknown = context![key];
    if (!isContextValue(value)) throw new InvalidArgument(`authn message ${code}: context ${key} must be a finite number, a boolean, or strings of at most ${MAX_CONTEXT_STRING} characters`);
    values[key] = typeof value === 'object' ? Object.freeze([...value]) : value;
  }
  const text = def.text.replace(PLACEHOLDER, (_match, key: string) => shown(values[key]));
  return Object.freeze({ id: def.id, code, type: def.type, text, ...(declared.length > 0 ? { context: Object.freeze(values) } : {}) });
}

/** One message per violation, in order, with the policy's limits as context. */
export function passwordViolationMessages(violations: readonly PasswordViolation[], policy: Pick<PasswordPolicy, 'minLength' | 'maxLength'>): AuthnMessage[] {
  return violations.map((violation) => {
    const code = PASSWORD_VIOLATION_CODES[violation];
    if (code === 'password_too_short') return authnMessage(code, { minLength: policy.minLength });
    if (code === 'password_too_long') return authnMessage(code, { maxLength: policy.maxLength });
    return authnMessage(code);
  });
}
```

Create `packages/authn/src/messages/index.ts`:

```ts
export * from './types.js';
export { AUTHN_MESSAGES } from './catalogue.js';
export type { AuthnErrorCode, AuthnMessageCode } from './catalogue.js';
export { PASSWORD_VIOLATION_CODES } from './password.js';
export type { PasswordMessageCode } from './password.js';
export { authnMessage, passwordViolationMessages } from './factory.js';
```

In `packages/authn/src/index.ts`, add after line 10 (`export * from './impersonation/index.js';`):

```ts
export * from './messages/index.js';
```

In `packages/authn/package.json`, add to `exports` after the `"./env"` entry:

```json
    "./messages": {
      "types": "./lib/mjs/messages/index.d.ts",
      "import": "./lib/mjs/messages/index.js",
      "require": "./lib/cjs/messages/index.js"
    }
```

and to `typesVersions["*"]` after `"env"`:

```json
      "messages": [
        "lib/cjs/messages/index.d.ts"
      ]
```

(Add the comma after the preceding `}` / `]`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/messages/catalogue.test.ts`
Expected: PASS, 16 passing.

- [ ] **Step 5: Run the package suite and rebuild**

Run: `cd packages/authn && npm test`
Expected: every test passes (0 failing). The contracts boundary test is unchanged, because `src/contracts` was not touched.

Run: `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`
Expected: no output, and `lib/mjs/messages/index.js` and `lib/cjs/messages/index.js` exist.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/messages packages/authn/src/index.ts packages/authn/package.json packages/authn/test/messages/catalogue.test.ts
git commit -m "feat(authn): stable numeric message ids in @spinajs/authn/messages"
```

---

### Task 2: Generated catalogue page `docs/authn/messages.md`

**Files:**
- Create: `packages/authn/test/messages/doc.test.ts`
- Create (generated): `docs/authn/messages.md`
- Modify: `docs/authn/README.md:13` (add a bullet after it)

**Interfaces:**
- Consumes: `AUTHN_MESSAGES` (Task 1).
- Produces: `docs/authn/messages.md`, which consumer plans regenerate with `UPDATE_GOLDEN=1`.

- [ ] **Step 1: Write the failing test**

Create `packages/authn/test/messages/doc.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTHN_MESSAGES } from '../../src/messages/index.js';
import type { AuthnMessageDefinition } from '../../src/messages/index.js';

const expect = chai.expect;

// UPDATE_GOLDEN=1 rewrites the page; review the diff before committing it.
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const DOC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'docs', 'authn', 'messages.md');

const HEADER = [
  '# Authentication messages',
  '',
  'Generated from `packages/authn/src/messages` by `packages/authn/test/messages/doc.test.ts`. Do not edit it by hand: run `UPDATE_GOLDEN=1 npx ts-mocha -p tsconfig.json test/messages/doc.test.ts` in `packages/authn`.',
  '',
  'Every refusal and failure of the 3.0 HTTP layer carries `messages`, a list of `{ id, code, type, text, context? }`. A client translates by `id`. `text` is the English default with the `context` values filled in, and `context` holds the values a translation may use. An `id` keeps its meaning for good and is never reused. IDs that start with 1 are information, IDs that start with 4 are user errors. Each plan numbers its messages in its own range: [docs/auth-feat/README.md](../auth-feat/README.md#message-ids-owner-03-consumers-04-to-09).',
  '',
  '| ID | Code | Type | Text | Context |',
  '|---|---|---|---|---|',
];

const row = ([code, d]: [string, AuthnMessageDefinition]) => `| ${d.id} | \`${code}\` | ${d.type} | ${d.text} | ${(d.context ?? []).map((k) => `\`${k}\``).join(', ') || '-'} |`;

const render = (): string => [...HEADER, ...(Object.entries(AUTHN_MESSAGES) as [string, AuthnMessageDefinition][]).sort(([, a], [, b]) => a.id - b.id).map(row), ''].join('\n');

const unix = (s: string) => s.replace(/\r\n/g, '\n');

describe('docs/authn/messages.md', () => {
  it('lists the catalogue as it is', () => {
    const expected = render();
    if (UPDATE) writeFileSync(DOC, expected.replace(/\n/g, '\r\n'));
    expect(unix(readFileSync(DOC, 'utf8'))).to.eq(expected);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/messages/doc.test.ts`
Expected: FAIL, `ENOENT: no such file or directory, open '...docs/authn/messages.md'`.

- [ ] **Step 3: Generate the page**

Run: `cd packages/authn && UPDATE_GOLDEN=1 npx ts-mocha -p tsconfig.json test/messages/doc.test.ts`. In PowerShell, run `$env:UPDATE_GOLDEN='1'; npx ts-mocha -p tsconfig.json test/messages/doc.test.ts; Remove-Item Env:UPDATE_GOLDEN`.
Expected: 1 passing. `docs/authn/messages.md` (CRLF) must read exactly:

```markdown
# Authentication messages

Generated from `packages/authn/src/messages` by `packages/authn/test/messages/doc.test.ts`. Do not edit it by hand: run `UPDATE_GOLDEN=1 npx ts-mocha -p tsconfig.json test/messages/doc.test.ts` in `packages/authn`.

Every refusal and failure of the 3.0 HTTP layer carries `messages`, a list of `{ id, code, type, text, context? }`. A client translates by `id`. `text` is the English default with the `context` values filled in, and `context` holds the values a translation may use. An `id` keeps its meaning for good and is never reused. IDs that start with 1 are information, IDs that start with 4 are user errors. Each plan numbers its messages in its own range: [docs/auth-feat/README.md](../auth-feat/README.md#message-ids-owner-03-consumers-04-to-09).

| ID | Code | Type | Text | Context |
|---|---|---|---|---|
| 1000001 | `password_reset_requested` | info | If an account matches, a password reset link is on its way. | - |
| 1000002 | `password_reset` | info | The password has been reset. Log in with the new password. | - |
| 1000003 | `invite_accepted` | info | The invitation is accepted and the password is set. | - |
| 1000004 | `password_changed` | info | The password has been changed. | - |
| 4000001 | `E_AUTH_FAILED` | error | The login or password is incorrect. | - |
| 4000002 | `unauthenticated` | error | Log in to continue. | - |
| 4000003 | `session_required` | error | This action needs a login session. | - |
| 4000004 | `session_exists` | error | This action is not available while a session is open. | - |
| 4000005 | `already_authenticated` | error | You are already logged in. Log out first. | - |
| 4000006 | `impersonating` | error | This action is not available while impersonating another user. | - |
| 4000007 | `fresh_auth_required` | error | Confirm your password to continue. | - |
| 4000008 | `mfa_required` | error | This action needs a second authentication factor. | - |
| 4000009 | `mfa_not_pending` | error | This session does not need a second factor. | - |
| 4000010 | `enrolment_closed` | error | Second-factor enrolment is not available here. | - |
| 4000011 | `not_found` | error | This feature is not available. | - |
| 4000012 | `session_not_found` | error | No such session. | - |
| 4000013 | `invalid_role` | error | The role must be a non-empty name of at most {maxLength} characters. | `maxLength` |
| 4000014 | `role_not_held` | error | You do not hold this role. | - |
| 4000015 | `invalid_target` | error | The target must be a user id or an identity reference. | - |
| 4000016 | `impersonation_refused` | error | Impersonating this user is refused. | - |
| 4000017 | `not_impersonating` | error | No impersonation is active. | - |
| 4000018 | `throttled` | error | Too many attempts. Try again in {retryAfterSeconds} seconds. | `retryAfterSeconds` |
| 4000019 | `reset_invalid` | error | The reset link is invalid or has expired. | - |
| 4000020 | `E_LINK_REFUSED` | error | The account link was refused. | - |
| 4001001 | `password_too_short` | error | The password must be at least {minLength} characters long. | `minLength` |
| 4001002 | `password_too_long` | error | The password must be at most {maxLength} characters long. | `maxLength` |
| 4001003 | `password_rule` | error | The password does not match the password rule. | - |
| 4001004 | `password_blocklisted` | error | This password is too common. Choose another one. | - |
```

If the generated file differs, fix the catalogue text or the test, not the page.

In `docs/authn/README.md`, after line 13 (`- OIDC single sign-on: [oidc.md](./oidc.md).`), add:

```markdown
- Message ids for translating answers: [messages.md](./messages.md).
```

- [ ] **Step 4: Run the test to verify it passes without the switch**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/messages/doc.test.ts`
Expected: PASS, 1 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/authn/test/messages/doc.test.ts docs/authn/messages.md docs/authn/README.md
git commit -m "docs(authn): generated message id catalogue, pinned by a golden test"
```

---

### Task 3: authn-http 3.0 answers carry `messages`

**Files:**
- Modify: `packages/authn-http/src/policies/v3/errors.ts` (whole file, 29 lines)
- Modify: `packages/authn-http/src/v3/responses.ts:8,14,26`
- Modify: `packages/authn-http/src/v3/controllers/AuthnActiveRoleController.ts:8,52`
- Modify: `packages/authn-http/src/v3/controllers/AuthnImpersonationController.ts:9,67,101`
- Modify: `packages/authn-http/src/v3/controllers/AuthnSessionsController.ts:7,58`
- Create: `packages/authn-http/test/v3/messages.test.ts`
- Modify tests: `packages/authn-http/test/v3/inert.test.ts:57,143`, `test/v3/authn-policies.test.ts:630`, `test/v3-app/suites/login.ts:118,172`, `suites/sessions.ts:47`, `suites/active-role.ts:107-112`, `suites/impersonation.ts:90`

**Interfaces:**
- Consumes: `authnMessage`, `AuthnErrorCode`, `AuthnMessage`, `AuthnMessageContextValue` from `@spinajs/authn/messages` (Task 1, built).
- Produces (internal to authn-http, `src/policies/v3/errors.ts`):
  - `AUTHN_FAILURE_MESSAGES: readonly AuthnMessage[]`
  - `interface ErrorBody { readonly error: AuthnErrorCode; readonly message: string; readonly messages: readonly AuthnMessage[] }`
  - `errorBody(code: AuthnErrorCode, message: string, context?: Readonly<Record<string, AuthnMessageContextValue>>): ErrorBody`
  - `refused(code: AuthnErrorCode, message: string)` and `notFound(code: AuthnErrorCode, message: string)`, whose code is now type-checked against the catalogue.
  - `AUTHN_FAILURE_BODY` (public) gains `messages`.

- [ ] **Step 1: Write the failing test**

Create `packages/authn-http/test/v3/messages.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AuthenticationFailed, Forbidden, ResourceNotFound } from '@spinajs/exceptions';
import type { Unauthorized } from '@spinajs/http';

import { AUTHN_FAILURE, authnFailed, errorBody, isAuthnFailed, notFound, refused, unauthenticated } from '../../src/policies/v3/errors.js';
import { AUTHN_FAILURE_BODY, authnFailureResponse } from '../../src/v3/responses.js';

const E_AUTH_FAILED = { id: 4000001, code: 'E_AUTH_FAILED', type: 'error', text: 'The login or password is incorrect.' };

// @spinajs/http answers a thrown error with its own enumerable props plus `message` (packages/http/src/error.ts).
const bodyOf = (err: Error): unknown => JSON.parse(JSON.stringify({ ...err, message: err.message }));
const dataOf = (r: Unauthorized): unknown => JSON.parse(JSON.stringify((r as unknown as { responseData: unknown }).responseData));
const headersOf = (r: Unauthorized) => (r as unknown as { options: { Headers: { Name: string; Value: string }[] } }).options.Headers;

describe('3.0 answers name their messages', () => {
  it('unauthenticated(): 401 with message 4000002', () => {
    const e = unauthenticated('this route needs an authenticated caller');
    expect(e).to.be.instanceOf(AuthenticationFailed);
    expect(bodyOf(e)).to.deep.eq({ error: 'unauthenticated', message: 'this route needs an authenticated caller', messages: [{ id: 4000002, code: 'unauthenticated', type: 'error', text: 'Log in to continue.' }] });
  });

  it('refused(): 403 with the message of its code', () => {
    const e = refused('session_required', 'this route needs a session');
    expect(e).to.be.instanceOf(Forbidden);
    expect(bodyOf(e)).to.deep.eq({ error: 'session_required', message: 'this route needs a session', messages: [{ id: 4000003, code: 'session_required', type: 'error', text: 'This action needs a login session.' }] });
  });

  it('notFound(): 404 with the message of its code', () => {
    const e = notFound('not_found', 'role switch is off: no RoleSource is registered');
    expect(e).to.be.instanceOf(ResourceNotFound);
    expect((bodyOf(e) as { messages: unknown }).messages).to.deep.eq([{ id: 4000011, code: 'not_found', type: 'error', text: 'This feature is not available.' }]);
  });

  it('authnFailed() answers the A02 body and is still recognised', () => {
    const e = authnFailed();
    expect(isAuthnFailed(e)).to.eq(true);
    expect(bodyOf(e)).to.deep.eq(JSON.parse(JSON.stringify(AUTHN_FAILURE_BODY)));
  });

  it('AUTHN_FAILURE_BODY carries E_AUTH_FAILED as message 4000001 next to the old fields', () => {
    expect(JSON.parse(JSON.stringify(AUTHN_FAILURE_BODY))).to.deep.eq({ error: { code: 'E_AUTH_FAILED', message: 'login or password incorrect' }, message: 'login or password incorrect', messages: [E_AUTH_FAILED] });
    expect(AUTHN_FAILURE_BODY.error).to.eq(AUTHN_FAILURE);
  });

  it('a throttled failure answers the same body; only Retry-After tells (A02, A06)', () => {
    const plain = authnFailureResponse();
    const throttled = authnFailureResponse(7);
    expect(dataOf(throttled)).to.deep.eq(dataOf(plain));
    expect(dataOf(plain)).to.deep.eq(JSON.parse(JSON.stringify(AUTHN_FAILURE_BODY)));
    expect(headersOf(throttled)).to.deep.include({ Name: 'Retry-After', Value: '7' });
    expect(headersOf(plain).some((h) => h.Name === 'Retry-After')).to.eq(false);
  });

  it('errorBody() gives a returned refusal the same three fields, with context', () => {
    expect(JSON.parse(JSON.stringify(errorBody('invalid_role', 'role must be a non-empty string of at most 256 characters', { maxLength: 256 })))).to.deep.eq({
      error: 'invalid_role',
      message: 'role must be a non-empty string of at most 256 characters',
      messages: [{ id: 4000013, code: 'invalid_role', type: 'error', text: 'The role must be a non-empty name of at most 256 characters.', context: { maxLength: 256 } }],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/v3/messages.test.ts`
Expected: FAIL at compile time, `Module '"../../src/policies/v3/errors.js"' has no exported member 'errorBody'` (TS2305).

- [ ] **Step 3: Implement the helpers**

Replace `packages/authn-http/src/policies/v3/errors.ts` with:

```ts
import { AuthenticationFailed, Forbidden, ResourceNotFound } from '@spinajs/exceptions';
import { authnMessage } from '@spinajs/authn/messages';
import type { AuthnErrorCode, AuthnMessage, AuthnMessageContextValue } from '@spinajs/authn/messages';

/** The body of a failed authentication (A02); a failed inline re-authentication answers it too. */
export const AUTHN_FAILURE = Object.freeze({ code: 'E_AUTH_FAILED', message: 'login or password incorrect' });

/** The `messages` of the A02 answer: one for every failure, throttled included. */
export const AUTHN_FAILURE_MESSAGES: readonly AuthnMessage[] = Object.freeze([authnMessage('E_AUTH_FAILED')]);

export interface ErrorBody {
  readonly error: AuthnErrorCode;
  readonly message: string;
  readonly messages: readonly AuthnMessage[];
}

/** The body of a refusal a controller returns instead of throwing: the fields a thrown refusal answers. */
export function errorBody(code: AuthnErrorCode, message: string, context?: Readonly<Record<string, AuthnMessageContextValue>>): ErrorBody {
  return { error: code, message, messages: [authnMessage(code, context)] };
}

// @spinajs/http spreads an error's own enumerable props into the response body: these give { error, message, messages }.

/** 401: no authenticated principal. */
export function unauthenticated(message: string): AuthenticationFailed {
  return Object.assign(new AuthenticationFailed(message), { error: 'unauthenticated', messages: [authnMessage('unauthenticated')] });
}

/** 403: an authenticated caller (or a pending session) that the policy refuses; `code` is stable for clients. */
export function refused(code: AuthnErrorCode, message: string): Forbidden {
  return Object.assign(new Forbidden(message), { error: code, messages: [authnMessage(code)] });
}

/** 404 with a stable code. */
export function notFound(code: AuthnErrorCode, message: string): ResourceNotFound {
  return Object.assign(new ResourceNotFound(message), { error: code, messages: [authnMessage(code)] });
}

/** 401 with the A02 body. Never carries retry information (N3: no Retry-After on a throttled re-authentication). */
export function authnFailed(): AuthenticationFailed {
  return Object.assign(new AuthenticationFailed(AUTHN_FAILURE.message), { error: AUTHN_FAILURE, messages: AUTHN_FAILURE_MESSAGES });
}

/** True for the error authnFailed() makes. */
export const isAuthnFailed = (err: unknown): boolean => err instanceof AuthenticationFailed && (err as { error?: unknown }).error === AUTHN_FAILURE;
```

In `packages/authn-http/src/v3/responses.ts`, replace line 8 with:

```ts
import type { AuthnMessage } from '@spinajs/authn/messages';

import { AUTHN_FAILURE, AUTHN_FAILURE_MESSAGES } from '../policies/v3/errors.js';
```

(Delete the blank line 7 above the old import, so the new type import sits with the other package imports.) Replace line 14 with:

```ts
export const AUTHN_FAILURE_BODY: Readonly<{ error: typeof AUTHN_FAILURE; message: string; messages: readonly AuthnMessage[] }> = Object.freeze({ error: AUTHN_FAILURE, message: AUTHN_FAILURE.message, messages: AUTHN_FAILURE_MESSAGES });
```

and line 26 with:

```ts
  return new Unauthorized({ error: { ...AUTHN_FAILURE_BODY.error }, message: AUTHN_FAILURE_BODY.message, messages: [...AUTHN_FAILURE_BODY.messages] }, { Headers: headers, Coockies: [...cookies] });
```

- [ ] **Step 4: Route the literal bodies through `errorBody`**

`AuthnActiveRoleController.ts` line 8:

```ts
import { errorBody, isAuthnFailed, refused, unauthenticated } from '../../policies/v3/errors.js';
```

line 52:

```ts
    if (role === null) return new BadRequestResponse(errorBody('invalid_role', `role must be a non-empty string of at most ${ROLE_CAP} characters`, { maxLength: ROLE_CAP }));
```

`AuthnImpersonationController.ts` line 9:

```ts
import { errorBody, isAuthnFailed, refused } from '../../policies/v3/errors.js';
```

line 67:

```ts
    if (!target) return new BadRequestResponse(errorBody('invalid_target', 'target must be a user id or { type, id }'));
```

line 101:

```ts
      return new BadRequestResponse(errorBody('not_impersonating', 'no impersonation is active'));
```

`AuthnSessionsController.ts` line 7:

```ts
import { errorBody, refused } from '../../policies/v3/errors.js';
```

line 58:

```ts
    if (!ended) return new NotFound(errorBody('session_not_found', 'No such session'));
```

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/v3/messages.test.ts`
Expected: PASS, 7 passing.

- [ ] **Step 6: Update the tests that pin bodies**

`test/v3/inert.test.ts` line 57: the messages subpath is pure data and may load with the package:

```ts
  const loadedAuthnRoot = typeof require === 'function' ? Object.keys(require.cache).filter((f) => /[\\\\/]authn[\\\\/]lib[\\\\/]cjs[\\\\/]/.test(f) && !/[\\\\/]contracts[\\\\/]/.test(f) && !/[\\\\/]messages[\\\\/]/.test(f) && !/[\\\\/]boot[\\\\/]env\.js$/.test(f)) : null;
```

line 143:

```ts
      expect(n10.body, 'N10: the one 401 body, from the barrel').to.deep.eq({ error: { code: 'E_AUTH_FAILED', message: 'login or password incorrect' }, message: 'login or password incorrect', messages: [{ id: 4000001, code: 'E_AUTH_FAILED', type: 'error', text: 'The login or password is incorrect.' }] });
```

`test/v3/authn-policies.test.ts`, after line 630 (`expect(none.body.error).to.eq('unauthenticated');`):

```ts
      expect(none.body.messages).to.deep.eq([{ id: 4000002, code: 'unauthenticated', type: 'error', text: 'Log in to continue.' }]);
```

`test/v3-app/suites/login.ts` line 118:

```ts
          expect(res.body).to.deep.eq({ error: { code: 'E_AUTH_FAILED', message: 'login or password incorrect' }, message: 'login or password incorrect', messages: [{ id: 4000001, code: 'E_AUTH_FAILED', type: 'error', text: 'The login or password is incorrect.' }] });
```

and after line 172 (`expect(res.body.error).to.eq('unauthenticated');`):

```ts
      expect(res.body.messages.map((m: { id: number }) => m.id)).to.deep.eq([4000002]);
```

`test/v3-app/suites/sessions.ts`, after line 47 (`expect(res.body.error).to.eq('session_not_found');`):

```ts
    expect(res.body.messages).to.deep.eq([{ id: 4000012, code: 'session_not_found', type: 'error', text: 'No such session.' }]);
```

`test/v3-app/suites/active-role.ts`, replace lines 107-112 with:

```ts
  it('a role that is not a non-empty string is 400 invalid_role, message 4000013 with the cap', async () => {
    const { c } = await withRoles();
    for (const role of [undefined, '', 42, ['editor'], 'r'.repeat(257)]) {
      const res = await c.post('/auth/active-role', { role });
      expect(res.status, JSON.stringify(role)).to.eq(400);
      expect(res.body.messages, JSON.stringify(role)).to.deep.eq([{ id: 4000013, code: 'invalid_role', type: 'error', text: 'The role must be a non-empty name of at most 256 characters.', context: { maxLength: 256 } }]);
    }
  });
```

`test/v3-app/suites/impersonation.ts`, after line 90 (`expect(res.body.error).to.eq('not_impersonating');`):

```ts
    expect(res.body.messages.map((m: { id: number }) => m.id)).to.deep.eq([4000017]);
```

- [ ] **Step 7: Run the package suite**

Run: `cd packages/authn-http && npm test`
Expected: both mocha runs (default and `.mocharc.v3-app.json`) pass with 0 failing. The inert test passes for ESM and CJS. The A02/http and A09 SR-07 behaviour cases still pass, because the A02 body is the same for every failure and pending answers are unchanged.

- [ ] **Step 8: Commit**

```bash
git add packages/authn-http/src/policies/v3/errors.ts packages/authn-http/src/v3/responses.ts packages/authn-http/src/v3/controllers/AuthnActiveRoleController.ts packages/authn-http/src/v3/controllers/AuthnImpersonationController.ts packages/authn-http/src/v3/controllers/AuthnSessionsController.ts packages/authn-http/test/v3/messages.test.ts packages/authn-http/test/v3/inert.test.ts packages/authn-http/test/v3/authn-policies.test.ts packages/authn-http/test/v3-app/suites/login.ts packages/authn-http/test/v3-app/suites/sessions.ts packages/authn-http/test/v3-app/suites/active-role.ts packages/authn-http/test/v3-app/suites/impersonation.ts
git commit -m "feat(authn-http): 3.0 refusals and failures carry catalogued messages"
```

---

### Task 4: authn-oidc bodies and the failure redirect name their message

**Files:**
- Modify: `packages/authn-oidc/src/login.ts:1-11,72,213-218`
- Create: `packages/authn-oidc/test/messages.test.ts`
- Modify tests: `test/strategy.test.ts:318`, `test/linking.test.ts:153`, `test/login-hardening.test.ts:84`, `test/acceptance.test.ts:320`
- Modify: `docs/authn/oidc.md:127-129`

**Interfaces:**
- Consumes: `authnMessage` from `@spinajs/authn/messages` (Task 1, built).
- Produces: `OIDC_FAILURE_BODY.messages` and the link refusal body's `messages`. Failure redirects end in `error_id=4000001`. No new export: `test/contracts.test.ts` pins the barrel's names.

- [ ] **Step 1: Write the failing test**

Create `packages/authn-oidc/test/messages.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { OIDC_FAILURE_BODY, OidcLogin } from '../src/login.js';
import type { OidcLoginDeps } from '../src/login.js';
import type { OidcAppPath } from '../src/contracts.js';

const E_AUTH_FAILED = { id: 4000001, code: 'E_AUTH_FAILED', type: 'error', text: 'The login or password is incorrect.' };

// failure() reads only the redirects and the env.
const loginWith = (failure: OidcAppPath) => new OidcLogin({ strategies: new Map(), redirects: { success: '/', failure }, env: 'production', callbackPath: (p: string) => `/auth/oidc/${p}/callback` } as unknown as OidcLoginDeps);

describe('authn-oidc messages', () => {
  it('the 401 body names E_AUTH_FAILED as message 4000001', () => {
    expect(JSON.parse(JSON.stringify(OIDC_FAILURE_BODY.messages))).to.deep.eq([E_AUTH_FAILED]);
  });

  it('a browser failure goes to the failure page with error_id, the same for every reason (D3)', () => {
    expect(loginWith('/login').failure({ navigation: true })).to.deep.include({ status: 303, location: '/login?error_id=4000001' });
    expect(loginWith('/login').failure({ navigation: true }, 30)).to.deep.include({ status: 303, location: '/login?error_id=4000001' });
  });

  it('error_id joins a query the failure path already has and stays before its fragment', () => {
    expect(loginWith('/login?from=sso#top').failure({ navigation: true }).location).to.eq('/login?from=sso&error_id=4000001#top');
    expect(loginWith('/#signin').failure({ navigation: true }).location).to.eq('/?error_id=4000001#signin');
  });

  it('any other client gets 401 with the body, and Retry-After only when throttled', () => {
    const plain = loginWith('/login').failure({ navigation: false });
    const throttled = loginWith('/login').failure({ navigation: false }, 30);
    expect(plain).to.deep.include({ status: 401, body: OIDC_FAILURE_BODY });
    expect(plain).to.not.have.property('headers');
    expect(throttled).to.deep.include({ status: 401, body: OIDC_FAILURE_BODY, headers: { 'retry-after': '30' } });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/authn-oidc && npx ts-mocha -p tsconfig.json test/messages.test.ts`
Expected: FAIL, 3 failing. The body has no `messages`, the location is `'/login'` without `error_id`, and the fragment case gives `'/login?from=sso#top'`. The last test passes already.

- [ ] **Step 3: Implement**

Line numbers below are those of today, before this step's edits. In `packages/authn-oidc/src/login.ts`, add after line 1:

```ts
import { authnMessage } from '@spinajs/authn/messages';
```

Replace line 11 with:

```ts
const AUTHN_FAILED = authnMessage('E_AUTH_FAILED');

/** The A02 answer, byte-equal to the login route's 401 body. */
export const OIDC_FAILURE_BODY = Object.freeze({ error: Object.freeze({ code: 'E_AUTH_FAILED', message: 'login or password incorrect' }), messages: Object.freeze([AUTHN_FAILED]) });
```

(The doc comment on the old line 10 stays as it is. Delete that line, because the replacement carries it.)

Replace line 72 with:

```ts
const REFUSED_BODY = Object.freeze({ error: Object.freeze({ code: 'E_LINK_REFUSED' }), messages: Object.freeze([authnMessage('E_LINK_REFUSED')]) });
```

Add after `const errorName = ...` (line 89):

```ts
/** Appends `error_id` to an app path, joining its query and keeping its fragment last. */
function withErrorId(path: OidcAppPath, id: number): OidcAppPath {
  const hash = path.indexOf('#');
  const base = hash < 0 ? path : path.slice(0, hash);
  const fragment = hash < 0 ? '' : path.slice(hash);
  return `${base}${base.includes('?') ? '&' : '?'}error_id=${id}${fragment}` as OidcAppPath;
}
```

Replace the body of `failure` (lines 214-218) with:

```ts
  public failure(req: Pick<OidcRequest, 'navigation'>, retryAfterSeconds?: number): OidcAnswer {
    const cookies = [clearFlowCookie(this.d.env)];
    const headers = retryAfterSeconds !== undefined ? { headers: { 'retry-after': String(retryAfterSeconds) } } : {};
    // One id for every reason, so the URL still tells nothing (D3).
    return req.navigation ? { status: 303, location: withErrorId(this.d.redirects.failure, AUTHN_FAILED.id), cookies, ...headers } : { status: 401, cookies, body: OIDC_FAILURE_BODY, ...headers };
  }
```

`OidcAppPath` is already imported at line 3 as a type.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/authn-oidc && npx ts-mocha -p tsconfig.json test/messages.test.ts`
Expected: PASS, 4 passing.

- [ ] **Step 5: Update the tests that pin the old location**

- `test/strategy.test.ts:318`: `expect(done).to.deep.include({ status: 303, location: '/login?error_id=4000001' });`
- `test/linking.test.ts:153`: `expect(second).to.deep.include({ status: 303, location: '/login?error_id=4000001' });`
- `test/login-hardening.test.ts:84`: `expect(forged).to.deep.include({ status: 303, location: '/login?error_id=4000001' });`
- `test/acceptance.test.ts:320`: `expect(done.headers.get('location')).to.eq('/?error_id=4000001');`

In `docs/authn/oidc.md`, replace lines 128-129 (`plus \`Retry-After\` when throttled. ... instead (303), with` / `no reason in the URL. On success a browser gets ... to the return`) with:

```markdown
plus `Retry-After` when throttled. A browser navigation goes to `redirects.failure` instead (303), with
`error_id=4000001` added to its query: the same id for every failure, so the URL still tells no reason
([message ids](./messages.md)). On success a browser gets a small same-site page that moves it on to the return
```

Keep the rest of the paragraph unchanged.

- [ ] **Step 6: Run the package suite**

Run: `cd packages/authn-oidc && npm test`
Expected: 0 failing. `test/contracts.test.ts` still passes, because no export was added.

- [ ] **Step 7: Commit**

```bash
git add packages/authn-oidc/src/login.ts packages/authn-oidc/test/messages.test.ts packages/authn-oidc/test/strategy.test.ts packages/authn-oidc/test/linking.test.ts packages/authn-oidc/test/login-hardening.test.ts packages/authn-oidc/test/acceptance.test.ts docs/authn/oidc.md
git commit -m "feat(authn-oidc): messages in failure bodies and a constant error_id on the failure redirect"
```

---

### Task 5: Behaviour rule A33, every answer names its messages by a catalogued id

**Files:**
- Create: `packages/authn-testing/src/behaviour/A33-message-ids.spec.ts`
- Modify: `packages/authn-testing/src/behaviour/types.ts:8`, `src/behaviour/index.ts:30,40`
- Modify: `packages/authn-testing/test/registry.test.ts:7,48-53` (and a new `it`)
- Modify: `packages/authn-testing/README.md` (the N8a rows of "Lane → facets" and "Per lane, today")
- Modify: `packages/authn-http/test/v3-app/behaviour/behaviour.test.ts:11,13`
- Modify: `docs/plans/2026-10-01-authz-v3-design.md` (a row after 4202), `docs/authn/README.md:73,687`

**Interfaces:**
- Consumes: `AUTHN_MESSAGES`, `AuthnMessage` from `@spinajs/authn/messages`. From `./steps.js`: `NOBODY`, `WRONG`, `routes`, `send`. From `./types.js`: `defineCase`, `defineRule`. Also the Task 3 answers.
- Produces: `A33: AuthnRule`, the rule id `'A33'`, and the facet `'A33/http'`.

- [ ] **Step 1: Write the failing test**

In `packages/authn-testing/test/registry.test.ts`, append `'A33/http'` to the end of the `FACET_MAP` array on line 7 (after `'A32/http'`). Replace lines 48-49 with:

```ts
  it('RULE_IDS are A01–A27 and A30–A33 in order', () => {
    const expected = [...Array.from({ length: 27 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`), 'A30', 'A31', 'A32', 'A33'];
```

and add after the `'batch 5 transcribed ...'` test:

```ts
  it('plan 03 added A33 (message ids) with two http cases', () => {
    const rule = AUTHN_RULES.get('A33')!;
    assert.strictEqual(rule.cases.length, 2);
    assert.deepStrictEqual([...new Set(rule.cases.map((c) => c.facet))], ['A33/http']);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/authn-testing && npx ts-mocha -p tsconfig.json test/registry.test.ts`
Expected: FAIL. The compiler reports that `'A33'` is not assignable to `RuleId` (TS2345), or at run time `RULE_IDS ... in order` fails on the missing `'A33'`.

- [ ] **Step 3: Implement the rule**

Create `packages/authn-testing/src/behaviour/A33-message-ids.spec.ts`:

```ts
import assert from 'node:assert/strict';
import { AUTHN_MESSAGES } from '@spinajs/authn/messages';
import type { AuthnMessage, AuthnMessageDefinition } from '@spinajs/authn/messages';
import { NOBODY, WRONG, routes, send } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule } from './types.js';

/** The messages of `body`, each checked against the catalogue entry of its code. */
function catalogued(body: unknown): AuthnMessage[] {
  const messages = (body as { messages?: unknown } | null)?.messages;
  assert.ok(Array.isArray(messages) && messages.length > 0, `messages in ${JSON.stringify(body)}`);
  const catalogue = AUTHN_MESSAGES as Readonly<Record<string, AuthnMessageDefinition>>;
  for (const m of messages as AuthnMessage[]) {
    const def = Object.prototype.hasOwnProperty.call(catalogue, m.code) ? catalogue[m.code] : undefined;
    assert.ok(def, `catalogued code ${m.code}`);
    assert.strictEqual(m.id, def.id, m.code);
    assert.strictEqual(m.type, def.type, m.code);
    assert.strictEqual(typeof m.text, 'string', m.code);
  }
  return messages as AuthnMessage[];
}

const idsOf = (body: unknown) => catalogued(body).map((m) => [m.id, m.code]);

export const A33: AuthnRule = defineRule('A33', 'every answer names its messages by a stable catalogued id', [
  defineCase({
    name: 'A33 a failed login names E_AUTH_FAILED as message 4000001',
    facet: 'A33/http',
    needs: ['http', 'http.routes.login'],
    async run(h) {
      const res = await send(h, routes(h).login(NOBODY, WRONG));
      assert.strictEqual(res.status, 401);
      assert.deepStrictEqual(idsOf(res.body), [[4000001, 'E_AUTH_FAILED']]);
    },
  }),
  defineCase({
    name: 'A33 a logout without a session names unauthenticated as message 4000002',
    facet: 'A33/http',
    needs: ['http', 'http.routes.logout'],
    async run(h) {
      const res = await send(h, routes(h).logout());
      assert.strictEqual(res.status, 401);
      assert.deepStrictEqual(idsOf(res.body), [[4000002, 'unauthenticated']]);
    },
  }),
]);
```

In `packages/authn-testing/src/behaviour/types.ts` line 8, append `'A33'` after `'A32'` in `RULE_IDS`.

In `packages/authn-testing/src/behaviour/index.ts`, add after line 30:

```ts
import { A33 } from './A33-message-ids.spec.js';
```

and on line 40, append `A33` after `A32` in `ALL`.

In `packages/authn-testing/README.md`, in the "Lane → facets" table, the N8a row's facet list ends with `A31/http, A31/config`. Append `, A33/http` to it. In the "Per lane, today" table, the N8a row's "Runs today" cell becomes `A02, A07, A09 (the force row needs \`routes.mfaEnrol\`), A20/http, A22, A23, A26, A31, A33`.

- [ ] **Step 4: Run the kit's suite and rebuild it**

Run: `cd packages/authn-testing && npm test`
Expected: 0 failing. The registry tests pass: the ids are in order, A33 has 2 cases on `A33/http`, the facet map includes it, and the needs are known.

Run: `cd packages/authn-testing && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`
Expected: no output.

- [ ] **Step 5: Claim A33 in the authn-http lane**

In `packages/authn-http/test/v3-app/behaviour/behaviour.test.ts`, line 11: append `'A33/http'` to `CLAIM`. Line 13: append `'A33'` to `RULES`.

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json`
Expected: 0 failing. The two A33 cases run and pass, and `EXPECTED_PENDING` is unchanged, because both routes exist.

- [ ] **Step 6: Record the rule**

In `docs/plans/2026-10-01-authz-v3-design.md`, add after line 4202 (the A32 row):

```markdown
| A33 | (plan 03) Every refusal and failure of the 3.0 HTTP layer names its message in `messages`: `{ id, code, type, text, context? }` from the `@spinajs/authn/messages` catalogue, with the catalogue's `id` and `type` for that `code`. A released `id` never changes meaning. A failed login names `E_AUTH_FAILED` (4000001) whatever the reason, throttled included (A02). `context` carries only the keys the catalogue declares for the code, as plain values, never a secret or personal data. |
```

In `docs/authn/README.md`, change `A01-A32` to `A01-A33` on lines 73 and 687.

- [ ] **Step 7: Commit**

```bash
git add packages/authn-testing/src/behaviour/A33-message-ids.spec.ts packages/authn-testing/src/behaviour/types.ts packages/authn-testing/src/behaviour/index.ts packages/authn-testing/test/registry.test.ts packages/authn-testing/README.md packages/authn-http/test/v3-app/behaviour/behaviour.test.ts docs/plans/2026-10-01-authz-v3-design.md docs/authn/README.md
git commit -m "test(authn-testing): A33, every answer names its messages by a catalogued id"
```

---

## Self-review

**Spec coverage**

| Requirement | Where |
|---|---|
| `AuthnMessage { id, code, type, text, context? }`, a frozen catalogue keyed by code, the factory, exported constants | Task 1 (`AUTHN_MESSAGES`, `authnMessage`, `PASSWORD_VIOLATION_CODES`) |
| A subpath or contracts export, following the `package.json` pattern | Task 1 (`./messages` + `typesVersions`), Decision 6 |
| Ranges 1000000–1000999 / 4000000–4000999 for 03, password violations in 4001000–4001999 | Task 1 (range test, `PASSWORD_MESSAGES`) |
| A test that pins every id↔code pair, and a uniqueness test | Task 1 (`PINNED`, uniqueness, `assertDistinctMessages`) |
| HTTP answers gain `messages`, additive, `code` kept | Task 3 (`error` and `message` unchanged), Decision 1 |
| No secrets or PII in context; throttle and password-policy context | Task 1 (allow-list, denylist test, `throttled`, `password_too_short/long`), Decisions 3 and 7 |
| A generated docs table checked against the catalogue | Task 2 |
| OIDC redirect `?error_id=` | Task 4 |
| The intl decision | Decision 5 |
| An A-series rule for the new behaviour | Task 5 |

**Gaps on purpose:** reset, change and invite have no 3.0 route to wire (Decision 9). `E_CSRF_ORIGIN` belongs to plan 04 (Decision 10). Pending MFA answers stay as they are (Decision 4).

**Placeholder scan:** no TBD or TODO is left, and every code step shows its code. "The next free A-number" is a rule for Task 5, not a gap: A33 is the number when no other plan has landed first.

**Type consistency:** these names are used the same way in every task: `AuthnErrorCode`, `AuthnMessageCode`, `AuthnMessage`, `AuthnMessageContextValue`, `AuthnMessageDefinition`, `AUTHN_MESSAGES`, `authnMessage`, `passwordViolationMessages`, `PASSWORD_VIOLATION_CODES`, `AUTHN_FAILURE_MESSAGES`, `errorBody`, `ErrorBody`, `withErrorId`, `A33`. Ids are the same in the catalogue, the pin table, the docs page and the HTTP, OIDC and A33 assertions: 4000001 `E_AUTH_FAILED`, 4000002 `unauthenticated`, 4000003 `session_required`, 4000011 `not_found`, 4000012 `session_not_found`, 4000013 `invalid_role`, 4000017 `not_impersonating`, 4000018 `throttled`, 4001001–4001004 the password violations.

**Interplay with plan 02:** if plan 02 lands first and `PasswordViolation` has gained members, Task 1 does not compile until they are in `PASSWORD_VIOLATION_CODES`. Number them 4001005 onward in the order plan 02 added them, and add them to `PINNED` and to the expected `PASSWORD_VIOLATION_CODES` keys.
