# Password hash import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accounts migrated from another system keep their passwords. Their bcrypt, PBKDF2, scrypt or argon2 hashes are imported as they are. Each verifies at login and is replaced by an argon2id hash (under the current pepper) on the first successful login.

**Architecture:**
- A `LegacyHashVerifier` per foreign format recognises its prefixes, validates structure and cost bounds, normalises the hash to one stored spelling, and verifies.
- A `LegacyHashRegistry` finds the verifier by prefix.
- `Argon2PasswordHasher.verify` falls back to it for a stored value that is not argon2, when its format is allowed. It still spends the dummy argon2 verify alongside, so timing stays equal.
- `needsRehash` already answers true for any non-argon2 value, so the existing compare-and-set rehash in `LocalPasswordStrategy` performs the upgrade.
- The new contract `PasswordHashImporter` (implemented in authn-local) validates and stores a hash over "no password". It is used by a CLI `authn:password-import` (JSONL), by `users.create({ PasswordHash })` and by the admin route `POST /users`. The admin route is gated by the permission `user:password.import`.

**Tech Stack:** TypeScript (ESM + CJS builds), `node:crypto` (`pbkdf2`, `scrypt`, `timingSafeEqual`), `argon2` (already a dependency), `bcryptjs` ^3.0.3 (new, pure JS), mocha + chai via ts-mocha.

## Global Constraints

- Code comments, identifiers and commit messages are in English. Comment only what the code cannot say.
- Work on branch `authz-v3-refactor`, one commit per task, and run the package suites before each commit.
- Every test command runs from the package directory: `npx ts-mocha -p tsconfig.json <file>`. A package's full suite is `npm test`.
- A package that consumes a changed package reads it from `lib/`. Rebuild before testing dependents: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json` in the changed package.
- Working-copy files use CRLF. Keep them CRLF.
- A value check moves into the module's JSON schema (`AUTHN_CONFIGURATION_SCHEMA`). Hash structure and cost bounds are not configuration: they stay in code.
- Defaults go into the schema, and the `@Config` `defaultValue` repeats them (authn-local's tests build instances without the schema).
- Never add a schema default that loosens an effective security value: `authn.local.import.formats` defaults to `[]`.
- Audit event type `password.import` (README table, plan 11). An event never carries a hash (A21).
- Each new behaviour rule gets a row in `packages/authn-testing`. This plan takes **A34** (A33 belongs to plan 02). If plan 02 has not landed, A33 stays free for it.
- HTTP work: the admin user routes live in `packages/users-http` (2.x-style controller over the 3.0 authz). This plan adds one optional body field there and no new route.

---

## Current state

- `Argon2PasswordHasher.verify` (`packages/authn-local/src/hasher.ts:100-120`) parses the stored value with `parseStored` (`packages/authn-local/src/pepper.ts:29-34`). The regex `ARGON2_ENCODED` (`pepper.ts:16`) accepts `$argon2id$`, `$argon2i$` and `$argon2d$` with `v=`. Anything else costs one dummy argon2 verify and answers false (`hasher.ts:104-108`). **argon2i, argon2d and argon2id PHC hashes therefore verify natively today**, unpeppered when they carry no `$sp<v>$` tag (`pepperFor(null)` is `null`, `hasher.ts:140-142`).
- `needsRehash` answers true for anything `parseStored` refuses, for a different pepper version, and for non-argon2id (`hasher.ts:122-133`). `dummyVerify` is `private` (`hasher.ts:152-156`).
- `LocalPasswordStrategy.verify` rehashes after a successful verify when `needsRehash`, writing only over the verified value (`packages/authn-local/src/strategy.ts:99-123`, A30).
- `PasswordCredentialStore.set(id, hash, expected?)`: `expected: null` writes only over "no password" (`packages/authn/src/contracts/identity.ts:23-33`). `UserPasswordStore` implements it with one conditional statement (`packages/users/src/identity/password-store.ts:39-84`).
- The 2.x users stored plain argon2 (`BasicPasswordProvider.hash` = `argon.hash(input)`, `packages/users/src/password.ts:54-57`). Those hashes already verify and rehash. The 2.x migration `AuthnFromUserMetadata_2026_10_02_00_01_00.ts` never touches `users.Password`: it carries MFA secrets and pending reset or invite tokens only.
- authn-local CLI: `authn:password` (`packages/authn-local/src/cli/SetUserPassword.ts:37-93`, actor `{ type: 'service', id: 'cli' }` at line 11, stdin-reading seam `input()`) and `authn:password-expire` (`cli/ExpirePasswords.ts`). Commands are found by a filesystem scan (`src/config/authn-local.ts:13-19`).
- `users.create()` (`packages/users/src/actions.ts:655-745`) takes `ICreateUserData { Email, Login, Password?, Id?, Metadata? }` (`:449-466`). It sets a password through `PasswordService.set`, or marks the account invite-pending and calls `PasswordService.invite`.
- The admin `POST /users` (`packages/users-http/src/admin/controllers/Users/Users.ts:467-485`) creates invite-only accounts: its DTO (`:89-115`) has no password field.
- `UserResourceAdapter.permissions()` declares `user:read`, `user:update` and `user:impersonate` (`packages/users/src/user-resource-adapter.ts:31-38`). Shipped roles grant `users:*`, `user.metadata:*` and `user:impersonate` (`packages/users/src/config/users.ts:146-153`), so none of them grants a new `user:password.import`.
- No `bcrypt` or `bcryptjs` is in the repository (only the unrelated `bcrypt-pbkdf` in the root `node_modules`). The root `package.json` has `workspaces: ['packages/*']`.
- `UserAccountSink` records `PasswordSetAt` for `password.change`, `password.reset` and `invite.redeem` (`packages/users/src/identity/account-sink.ts:35`).

## Decisions (confirm before Task 1)

1. **The formats that ship:**
   - `argon2`: argon2i, argon2d and argon2id PHC with `v=16|19`. Import validation only, because the hasher already verifies these natively.
   - `bcrypt`: `$2a$`, `$2b$`, and `$2y$`, which is stored as `$2b$` because it is the same algorithm.
   - `pbkdf2`: passlib `$pbkdf2-sha256$` and `$pbkdf2-sha512$`, and Django `pbkdf2_sha256$`. Django is stored in passlib's spelling.
   - `scrypt`: passlib PHC `$scrypt$ln=,r=,p=$salt$key`.

   **Out, with reasons:**
   - Firebase scrypt: it needs the project's signer key and salt separator, and is a modified scrypt plus AES. An app adds it as a `LegacyHashVerifier` through the hasher's `legacy` option.
   - MD5, SHA-1, unsalted hashes and md5crypt: these are fast hashes. Importing them keeps a crackable credential alive; force a reset instead.
   - The PHC `$pbkdf2-sha256$i=` spelling, Django `pbkdf2_sha1`, and argon2 without `v=`: no current source emits them by default. YAGNI; each one is a small parser.
2. **Cost bounds are fixed in code.** Each bound is a floor for the format, or a ceiling that stops a cheap login DoS:
   - bcrypt cost 4–14. The brief said 4–31, but bcryptjs runs on the event loop, and cost 15 already takes several seconds of CPU per login attempt.
   - PBKDF2: 1,000–2,000,000 iterations (the floor is RFC 8018's), salt 8–64 bytes, key 16–64 bytes.
   - scrypt: `ln` 10–20, `r` 1–32, `p` 1–4, and 128·r·2^ln ≤ 64 MiB (argon2's per-verify memory).
   - argon2: m 1024–131072 KiB, t 1–10, p 1–16.
3. **`bcryptjs` ^3.0.3, not the native `bcrypt`.** It is pure JS (ESM + UMD, typings bundled), so it adds no second native build next to `argon2`. Legacy verification is transitional, so the slower speed (about 30%) is acceptable.
4. **No extra stored marker.** Each format's own prefix is the marker. The pepper tag `$sp<v>$` only ever wraps an argon2 string (`parseStored`), so an imported hash can never be read as peppered. A legacy verify always gets the raw password. Login verifies a legacy value only when its format is allowed and the value equals its normalised spelling, so only hashes that pass import validation can verify.
5. **One allow-list, `authn.local.import.formats`** (default `[]`), governs both import and legacy login. Removing a format locks out the accounts that have not logged in since the import (they reset). argon2 hashes verify whatever the list says, as they do today.
6. **An import writes only over "no password"** (`set(id, hash, null)`). A stored password answers `conflict`. There is no overwrite flag: overwriting a live credential would also need session and token revocation. YAGNI.
7. **Timing:** a legacy verify runs alongside the dummy argon2 verify, inside one limiter slot. A legacy account takes max(legacy, argon2) time, never less than an unknown account (A02).
8. **The contract is a new file**, `packages/authn/src/contracts/password-import.ts`, because the shape test pins `password.ts` to `PasswordService` alone (`packages/authn/test/contracts/password.test.ts:148-167`).
9. **Permission `user:password.import`.** It is declared by `UserResourceAdapter` and checked at GLOBAL with no residual. No shipped role grants it, and `users:*` does not cover it (different resource). Reason: an importer can set a password whose plaintext they chose.
10. **`UserAccountSink` records `PasswordSetAt` on a successful `password.import`.** Expiry then counts from the import.
11. **Out of scope:** a count of accounts still on legacy hashes. `PasswordCredentialStore` cannot enumerate, so a later users CLI can count with SQL (`Password` not starting with `$argon2` or `$sp`).
12. **Rule id A34.**

## Security notes

- Hashes are never logged, audited or echoed. The CLI reports only line numbers and reasons, and `password.import` events carry `data.format` only.
- A legacy hash is verified unpeppered, then replaced at the first successful login by argon2id under the current pepper. The write is a compare-and-set over the legacy value (A30).
- bcrypt reads only the first 72 UTF-8 bytes. A legacy bcrypt hash therefore also accepts any password that shares those bytes, exactly as the source system did. After the first login the full typed password is what argon2 stores.
- Residual timing: a legacy verify slower than the argon2 dummy (for example bcrypt cost 13 or more) makes a legacy account measurably slower than an unknown one. The cost ceilings bound this, and it disappears as accounts rehash.
- The JSONL file holds credentials. The CLI reads it from a path and never copies it, but the operator deletes it after the import.
- The admin route takes the permission check before anything is written.

## Facts verified (2026-10-06)

- `packages/authn-local/src/hasher.ts`: imports 1-8; `Argon2PasswordHasherOptions` 28-31; `HasherSettings` 46-50; `@Config` fields 60-64; `verify` 100-120; `needsRehash` 122-133; `settings` 135-137; `dummyVerify` 152-156 (private); `buildSettings` 158-191.
- `packages/authn-local/src/pepper.ts:16-17` (`ARGON2_ENCODED`, `PEPPER_TAG`), `:29-34` (`parseStored`).
- `packages/authn-local/src/index.ts:1-10` (barrel), `package.json` dependencies (`argon2 ^0.44.0`, no bcrypt).
- `packages/authn-local/test/cli.test.ts`: DI setup 58-110, `ScriptedSetUserPassword` 135-162, `rejection()` 174-181. `test/strategy.test.ts`: `setup()` 52-60, `pw` 22. `test/argon2-hasher.test.ts:28-32` (`hasher()` helper).
- `packages/authn/src/contracts/audit.ts:21` (`AuthnEventType`). `packages/authn/src/contracts/index.ts:13` (`password.js` export). `packages/authn/test/contracts/audit.test.ts:23` (`EVENT_TYPES`). `packages/authn/test/contracts/boundary.test.ts:18` (`RUNTIME_EXPORTS`, asserted with `include.members`). `test/contracts/source-shape.ts` exports `classMembers`, `shapeOf`, `unionLiterals`, `same`.
- `packages/authn/src/schemas/authn.configuration.ts`: `local.properties` 99-163 (`expiration` 156-162 is the last property).
- `packages/users/src/actions.ts`: contracts imports 23-24; `ICreateUserData` 449-466; `passwordService()` 613-620; `createUser` 655-745 (password 660, check 666-669, the write in `try` 699-712, invite or created mail 732-737, `resendInvite` 740). `packages/users/src/user-resource-adapter.ts:31-38`. `packages/users/src/identity/account-sink.ts:35`. `packages/users/test/shipped-config.test.ts:160-169` (adapter permissions list, deep-equal). `packages/users/test/authn-sinks.test.ts:55-69` (PasswordSetAt rows). `packages/users/test/create.test.ts:46-72` (setup, `rejection`, `nothingWritten`).
- `packages/users-http/src/admin/controllers/Users/Users.ts`: imports 1-16; `CreateUserDto` 89-115; `addUser` 452-485. `test/admin-common.ts:19-30` (`TEST_ROLES`). `test/users-controller.test.ts:1-20` (imports), `:263` (`describe('Users.addUser')`). `test/support/authz-host.ts` (`seedRoles`). `test/support/password-service.ts` (`passwordCalls`, `resetPasswordCalls`). `test/route-contract.test.ts:140-190` (DTO validation).
- `packages/users-http/src/services/AccountGuard.ts:147-152`: the GLOBAL, no-residual check pattern (`authz.check({ principal, permission, resource: GLOBAL })`, `decision.residual.op === 'true'`).
- `packages/authn-testing/src/harness/config.ts:29-35` (`ConfigOverrides.authn.local`), `src/behaviour/types.ts:8`, `src/behaviour/index.ts:30`, `:40`. `packages/authn-local/test/kit-harness.ts:30-42` (`SUPPORTED`), `:272-282` (`applyConfig`). `packages/authn-local/test/kit.test.ts:8`, `:17`.
- Known-answer vectors were checked with Node `crypto`, passlib 1.7.4 and python `bcrypt`:
  - bcrypt `'Legacy-Pass-1'` = `$2b$04$abcdefghijklmnopqrstuuUUEjECGte.vGcak2zFXn9yHIm3JKCxK`, and the `$2a$` and `$2y$` spellings verify too. `'Alice-Pass-1234'` = `$2b$04$abcdefghijklmnopqrstuuCqdtRnvKJAr6sR/GVFRVkoLaoQHy0RC`.
  - passlib pbkdf2-sha256 `'password'` (29000) = `$pbkdf2-sha256$29000$MDEyMzQ1Njc4OWFiY2RlZg$G/O7bynZBig0xpI9OJ2.zH5iXh/vIAuDcj9JVCTUa3k`.
  - pbkdf2-sha512 `'password'` (25000) = `$pbkdf2-sha512$25000$MDEyMzQ1Njc4OWFiY2RlZg$uxdHU.JH8vyHyz/DeXpgS7H6Tjz9A.lBWgSoOvvbH2iwTOWkhoRip9yMdB0AZCvZtIdBg46qUM3yPQkKDTKUSg`.
  - pbkdf2-sha256 `'Legacy-Pass-1'` (1000) = `$pbkdf2-sha256$1000$MDEyMzQ1Njc4OWFiY2RlZg$EMtO/z0XRnKlXfUKqzuWuzYzvtqBP4HPMmG/OdupiGs`.
  - Django `'Legacy-Pass-1'` = `pbkdf2_sha256$1000$seasalt12345$VeT1yEpEx+3lMTnEKAB85ZpS3MPBoYYgZlKanctP4ZY=`, normalised to `$pbkdf2-sha256$1000$c2Vhc2FsdDEyMzQ1$VeT1yEpEx.3lMTnEKAB85ZpS3MPBoYYgZlKanctP4ZY`.
  - Django `'lètmein-Pass-1'` = `pbkdf2_sha256$1000$seasalt12345$HPanmDQlmyzXhC3BJn/ohK+lF9cmUKgNiEX+CNe4iIg=`.
  - passlib scrypt `'password'` = `$scrypt$ln=16,r=8,p=1$aM15713r3Xsvxbi31lqr1Q$nFNh2CVHVjNldFVKDHDlm4CbdRSCdEBsjjJxD+iCs5E`.
  - scrypt `'Legacy-Pass-1'` = `$scrypt$ln=10,r=8,p=1$MDEyMzQ1Njc4OWFiY2RlZg$27WJyzHOOkhXR/Tyhx4ewlVI06UNxQsU4vYvu2Tni7s`.
  - The OpenBSD vector `'U*U'` = `$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW`.
- `bcryptjs@3.0.3` exports `import` (`./index.js`, types `./index.d.ts`) and `require` (`./umd/index.js`). Its README: "The maximum input length is 72 bytes ... not implicitly checked", and it has `compare(password, hash): Promise<boolean>`.

## File structure

| File | Responsibility |
|---|---|
| `packages/authn/src/contracts/password-import.ts` (create) | `PasswordHashFormat`, `ImportedPasswordHash`, `PasswordImportRefusal`, `PasswordImportResult`, `PasswordHashImporter` |
| `packages/authn/src/contracts/audit.ts`, `index.ts` (modify) | `'password.import'`; export |
| `packages/authn/src/schemas/authn.configuration.ts` (modify) | `authn.local.import.formats` |
| `packages/authn-local/src/legacy/verifier.ts` | `LegacyHashVerifier` abstract |
| `packages/authn-local/src/legacy/encoding.ts` | passlib ab64 and unpadded base64 |
| `packages/authn-local/src/legacy/{bcrypt,pbkdf2,scrypt,argon2}.ts` | one verifier per format |
| `packages/authn-local/src/legacy/registry.ts` | `LegacyHashRegistry`, `BUILTIN_LEGACY_VERIFIERS` |
| `packages/authn-local/src/legacy/importer.ts` | `LocalPasswordHashImporter` |
| `packages/authn-local/src/legacy/index.ts` | barrel |
| `packages/authn-local/src/hasher.ts` (modify) | legacy fallback in `verify` |
| `packages/authn-local/src/cli/ImportPasswords.ts` (create) | `authn:password-import` |
| `packages/users/src/actions.ts`, `user-resource-adapter.ts`, `identity/account-sink.ts` (modify) | `PasswordHash` on create; the permission; PasswordSetAt |
| `packages/users-http/src/admin/controllers/Users/Users.ts` (modify) | `PasswordHash` body field, gated |
| `packages/authn-testing/src/behaviour/A34-legacy-hash-login.spec.ts` (create) | rule A34 |

Task order: 1 → 2 → 3 → 4 → 5 → 6 → 7. Task 8 runs after 3.

---

### Task 1: The import contract, the audit type and the allow-list key

**Files:**
- Create: `packages/authn/src/contracts/password-import.ts`
- Modify: `packages/authn/src/contracts/index.ts:13`, `packages/authn/src/contracts/audit.ts:21`, `packages/authn/src/schemas/authn.configuration.ts` (`local.properties`, after `expiration`)
- Test: create `packages/authn/test/contracts/password-import.test.ts`; modify `packages/authn/test/contracts/audit.test.ts:23`, `test/contracts/boundary.test.ts:18`, `test/boot/config-defaults.test.ts` (a new `it`)

**Interfaces:**
- Consumes: `AuthnContext`, `IdentityRef` (`credentials.ts`), `PrincipalRef` (`principal.ts`).
- Produces (from `@spinajs/authn/contracts`):
  - `type PasswordHashFormat = 'argon2' | 'bcrypt' | 'pbkdf2' | 'scrypt'`
  - `interface ImportedPasswordHash { readonly hash: string; readonly format: PasswordHashFormat }`
  - `type PasswordImportRefusal = 'format_disabled' | 'format_mismatch' | 'malformed' | 'cost_out_of_range' | 'conflict'`
  - `type PasswordImportResult = { readonly status: 'imported' } | { readonly status: 'refused'; readonly reason: PasswordImportRefusal }`
  - `abstract class PasswordHashImporter { check(input): PasswordImportRefusal | null; import(id, input, ctx, opts?): Promise<PasswordImportResult> }`
  - `AuthnEventType` gains `'password.import'`; config key `authn.local.import.formats` (default `[]`).

- [ ] **Step 1: Write the failing tests**

Create `packages/authn/test/contracts/password-import.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { PasswordHashImporter } from '../../src/contracts/password-import.js';
import type { ImportedPasswordHash, PasswordHashFormat, PasswordImportRefusal, PasswordImportResult } from '../../src/contracts/password-import.js';
import * as index from '../../src/contracts/index.js';
import { classMembers, same, shapeOf, unionLiterals } from './source-shape.js';

const expect = chai.expect;

describe('password import contract', () => {
  it('exports PasswordHashImporter from the contracts index as a plain abstract class', () => {
    expect(index.PasswordHashImporter).to.eq(PasswordHashImporter);
    expect(Object.getPrototypeOf(PasswordHashImporter)).to.eq(Function.prototype);
  });

  it('password-import.ts holds PasswordHashImporter with check and import', () => {
    expect(shapeOf(classMembers('password-import.ts'))).to.deep.eq({
      PasswordHashImporter: {
        base: null,
        members: [
          { name: 'check', modifiers: ['abstract'], optional: false, params: ['input'] },
          { name: 'import', modifiers: ['abstract'], optional: false, params: ['id', 'input', 'ctx', 'opts'] },
        ],
      },
    });
  });

  it('lists the formats and the refusals', () => {
    expect(unionLiterals('password-import.ts', 'PasswordHashFormat')).to.deep.eq(['argon2', 'bcrypt', 'pbkdf2', 'scrypt']);
    expect(unionLiterals('password-import.ts', 'PasswordImportRefusal')).to.deep.eq(['format_disabled', 'format_mismatch', 'malformed', 'cost_out_of_range', 'conflict']);
  });

  it('re-exports every type from the contracts index', () => {
    same<index.ImportedPasswordHash, ImportedPasswordHash>(true);
    same<index.PasswordHashFormat, PasswordHashFormat>(true);
    same<index.PasswordImportRefusal, PasswordImportRefusal>(true);
    same<index.PasswordImportResult, PasswordImportResult>(true);
  });
});
```

In `audit.test.ts:23` append `'password.import'` as the last member of `EVENT_TYPES`:

```ts
const EVENT_TYPES = ['login', 'logout', 'mfa.challenge', 'mfa.verify', 'mfa.enrol', 'mfa.disable', 'reauth', 'session.issue', 'session.rotate', 'session.revoke', 'session.expire', 'password.change', 'password.reset.request', 'password.reset', 'invite.redeem', 'token.create', 'token.use', 'token.revoke', 'key.register', 'key.use', 'key.revoke', 'identity.link', 'identity.unlink', 'impersonation.start', 'impersonation.end', 'impersonation.expire', 'throttle.block', 'password.import'] as const;
```

In `boundary.test.ts:18` append `'PasswordHashImporter'` to `RUNTIME_EXPORTS`.

In `config-defaults.test.ts` add inside `describe('authn shipped config')`:

```ts
  it('gives authn.local.import.formats an empty default and takes only known, unique formats', () => {
    expect(check({ local: {} }).config.local.import).to.deep.eq({ formats: [] });
    expect(check({ local: { import: { formats: ['bcrypt', 'pbkdf2', 'scrypt', 'argon2'] } } }).ok).to.eq(true);
    expect(check({ local: { import: { formats: ['md5'] } } }).paths).to.include('/local/import/formats/0');
    expect(check({ local: { import: { formats: ['bcrypt', 'bcrypt'] } } }).paths).to.include('/local/import/formats');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/password-import.test.ts test/contracts/audit.test.ts test/boot/config-defaults.test.ts`
Expected: FAIL. `Cannot find module '.../src/contracts/password-import.js'`; then, with that file stubbed out of the run, the `AuthnEventType lists the design members` diff (missing `password.import`) and `gives authn.local.import.formats ...` (`undefined`).

- [ ] **Step 3: Write minimal implementation**

Create `packages/authn/src/contracts/password-import.ts`:

```ts
import type { AuthnContext, IdentityRef } from './credentials.js';
import type { PrincipalRef } from './principal.js';

/** Hash formats an import may name; each must also be listed in authn.local.import.formats. */
export type PasswordHashFormat = 'argon2' | 'bcrypt' | 'pbkdf2' | 'scrypt';

export interface ImportedPasswordHash {
  /** As the source system stored it. Never logged, audited or returned. */
  readonly hash: string;
  readonly format: PasswordHashFormat;
}

/**
 * The format is not in authn.local.import.formats; the hash is of another format than declared; it is not a well-formed hash of
 * its format; its cost is outside the accepted bounds; a password is stored already, or the store holds no such identity.
 */
export type PasswordImportRefusal = 'format_disabled' | 'format_mismatch' | 'malformed' | 'cost_out_of_range' | 'conflict';

export type PasswordImportResult = { readonly status: 'imported' } | { readonly status: 'refused'; readonly reason: PasswordImportRefusal };

/**
 * Stores a password hash made by another system, for a migration (implemented by @spinajs/authn-local). The hash verifies at login,
 * unpeppered, and is replaced by the current hasher's on the first successful one (A03).
 */
export abstract class PasswordHashImporter {
  /** What `import` would answer, without a write or an event; null: acceptable. Never 'conflict', which only the write can tell. */
  abstract check(input: ImportedPasswordHash): PasswordImportRefusal | null;
  /** Writes only over no password (compare-and-set on null) and audits `password.import`. */
  abstract import(id: IdentityRef, input: ImportedPasswordHash, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<PasswordImportResult>;
}
```

In `contracts/index.ts` add after line 13:

```ts
export * from './password-import.js';
```

In `audit.ts:21` append `| 'password.import'` after `'throttle.block'`:

```ts
export type AuthnEventType = 'login' | 'logout' | 'mfa.challenge' | 'mfa.verify' | 'mfa.enrol' | 'mfa.disable' | 'reauth' | 'session.issue' | 'session.rotate' | 'session.revoke' | 'session.expire' | 'password.change' | 'password.reset.request' | 'password.reset' | 'invite.redeem' | 'token.create' | 'token.use' | 'token.revoke' | 'key.register' | 'key.use' | 'key.revoke' | 'identity.link' | 'identity.unlink' | 'impersonation.start' | 'impersonation.end' | 'impersonation.expire' | 'throttle.block' | 'password.import';
```

In `authn.configuration.ts` add to `local.properties`, after the `expiration` block:

```ts
        import: {
          type: 'object',
          default: {},
          propertyNames: { enum: ['formats'] },
          properties: {
            formats: {
              type: 'array',
              uniqueItems: true,
              items: { enum: ['argon2', 'bcrypt', 'pbkdf2', 'scrypt'] },
              default: [],
              description: 'Hash formats PasswordHashImporter accepts and, argon2 aside (always verified), the login verifies. Empty: no import.',
            },
          },
        },
```

- [ ] **Step 4: Run tests to verify they pass, then rebuild**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/password-import.test.ts test/contracts/audit.test.ts test/boot/config-defaults.test.ts`
Expected: PASS, 0 failing.

Run: `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npx ts-mocha -p tsconfig.json test/contracts/boundary.test.ts`
Expected: no compiler output; PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/authn/src/contracts/password-import.ts packages/authn/src/contracts/index.ts packages/authn/src/contracts/audit.ts packages/authn/src/schemas/authn.configuration.ts packages/authn/test/contracts/password-import.test.ts packages/authn/test/contracts/audit.test.ts packages/authn/test/contracts/boundary.test.ts packages/authn/test/boot/config-defaults.test.ts
git commit -m "feat(authn): PasswordHashImporter contract, password.import event and authn.local.import.formats"
```

---

### Task 2: One verifier per legacy format

**Files:**
- Create: `packages/authn-local/src/legacy/verifier.ts`, `encoding.ts`, `bcrypt.ts`, `pbkdf2.ts`, `scrypt.ts`, `argon2.ts`, `registry.ts`, `index.ts`
- Modify: `packages/authn-local/package.json` (dependency `bcryptjs`), `packages/authn-local/src/index.ts` (export), root `package-lock.json` (through npm)
- Test: `packages/authn-local/test/legacy-verifiers.test.ts`

**Interfaces:**
- Consumes: `PasswordHashFormat` (Task 1, rebuilt authn); `parseStored` (`pepper.ts`).
- Produces:
  - `abstract class LegacyHashVerifier { format: PasswordHashFormat; claims(hash): boolean; normalize(hash): string | LegacyNormalizeFailure; verify(stored, password): Promise<boolean> }`, `type LegacyNormalizeFailure = 'malformed' | 'cost_out_of_range'`
  - `BcryptVerifier`, `Pbkdf2Verifier`, `ScryptVerifier`, `Argon2ImportVerifier`; `BCRYPT_COST`, `PBKDF2_ITERATIONS`, `SCRYPT_BOUNDS`, `ARGON2_IMPORT_BOUNDS`
  - `class LegacyHashRegistry { constructor(verifiers?: readonly LegacyHashVerifier[]); detect(hash: string): LegacyHashVerifier | null }`, `BUILTIN_LEGACY_VERIFIERS`

- [ ] **Step 1: Add the dependency**

Run (repository root): `npm install bcryptjs@^3.0.3 --workspace=packages/authn-local`
Expected: `added 1 package`. `packages/authn-local/package.json` now lists `"bcryptjs": "^3.0.3"` under `dependencies`.

- [ ] **Step 2: Write the failing test**

Create `packages/authn-local/test/legacy-verifiers.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import * as argon2 from 'argon2';
import bcrypt from 'bcryptjs';

import { Argon2ImportVerifier, BcryptVerifier, LegacyHashRegistry, Pbkdf2Verifier, ScryptVerifier } from '../src/legacy/index.js';

const PASSWORD = 'Legacy-Pass-1';
const BCRYPT = '$2b$04$abcdefghijklmnopqrstuuUUEjECGte.vGcak2zFXn9yHIm3JKCxK';
const PBKDF2_SHA256 = '$pbkdf2-sha256$1000$MDEyMzQ1Njc4OWFiY2RlZg$EMtO/z0XRnKlXfUKqzuWuzYzvtqBP4HPMmG/OdupiGs';
const DJANGO = 'pbkdf2_sha256$1000$seasalt12345$VeT1yEpEx+3lMTnEKAB85ZpS3MPBoYYgZlKanctP4ZY=';
const DJANGO_STORED = '$pbkdf2-sha256$1000$c2Vhc2FsdDEyMzQ1$VeT1yEpEx.3lMTnEKAB85ZpS3MPBoYYgZlKanctP4ZY';
const SCRYPT = '$scrypt$ln=10,r=8,p=1$MDEyMzQ1Njc4OWFiY2RlZg$27WJyzHOOkhXR/Tyhx4ewlVI06UNxQsU4vYvu2Tni7s';

describe('legacy hash verifiers', function () {
  this.timeout(30_000);

  describe('bcrypt', () => {
    const v = new BcryptVerifier();

    it('verifies the OpenBSD vector and a $2b$ hash, and refuses a wrong password', async () => {
      expect(await v.verify('$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW', 'U*U')).to.equal(true);
      expect(await v.verify(BCRYPT, PASSWORD)).to.equal(true);
      expect(await v.verify(BCRYPT, 'Legacy-Pass-2')).to.equal(false);
    });

    it('stores $2y$ as $2b$ and keeps $2a$ and $2b$', () => {
      expect(v.normalize(BCRYPT.replace('$2b$', '$2y$'))).to.equal(BCRYPT);
      expect(v.normalize(BCRYPT)).to.equal(BCRYPT);
      expect(v.normalize(BCRYPT.replace('$2b$', '$2a$'))).to.equal(BCRYPT.replace('$2b$', '$2a$'));
    });

    it('refuses a cost outside 4..14 and a malformed hash', () => {
      expect(v.normalize(BCRYPT.replace('$04$', '$03$'))).to.equal('cost_out_of_range');
      expect(v.normalize(BCRYPT.replace('$04$', '$15$'))).to.equal('cost_out_of_range');
      expect(v.normalize(BCRYPT.slice(0, -1))).to.equal('malformed');
      expect(v.normalize('$2x$04$abcdefghijklmnopqrstuuUUEjECGte.vGcak2zFXn9yHIm3JKCxK')).to.equal('malformed');
    });

    it('reads only the first 72 bytes of the password, as the source system did', async () => {
      const stored = bcrypt.hashSync('a'.repeat(72), 4);
      expect(await v.verify(stored, `${'a'.repeat(72)}-anything`)).to.equal(true);
    });

    it('never throws on a value it cannot read', async () => {
      expect(await v.verify('$2b$04$short', PASSWORD)).to.equal(false);
    });
  });

  describe('pbkdf2', () => {
    const v = new Pbkdf2Verifier();

    it('verifies passlib sha256 and sha512 vectors', async () => {
      expect(await v.verify('$pbkdf2-sha256$29000$MDEyMzQ1Njc4OWFiY2RlZg$G/O7bynZBig0xpI9OJ2.zH5iXh/vIAuDcj9JVCTUa3k', 'password')).to.equal(true);
      expect(await v.verify('$pbkdf2-sha512$25000$MDEyMzQ1Njc4OWFiY2RlZg$uxdHU.JH8vyHyz/DeXpgS7H6Tjz9A.lBWgSoOvvbH2iwTOWkhoRip9yMdB0AZCvZtIdBg46qUM3yPQkKDTKUSg', 'password')).to.equal(true);
      expect(await v.verify(PBKDF2_SHA256, PASSWORD)).to.equal(true);
      expect(await v.verify(PBKDF2_SHA256, 'Legacy-Pass-2')).to.equal(false);
    });

    it("stores Django's spelling as passlib's, which verifies, a non-ASCII password included", async () => {
      expect(v.normalize(DJANGO)).to.equal(DJANGO_STORED);
      expect(await v.verify(DJANGO_STORED, PASSWORD)).to.equal(true);
      const unicode = v.normalize('pbkdf2_sha256$1000$seasalt12345$HPanmDQlmyzXhC3BJn/ohK+lF9cmUKgNiEX+CNe4iIg=') as string;
      expect(await v.verify(unicode, 'lètmein-Pass-1')).to.equal(true);
    });

    it('keeps a passlib hash as it is', () => {
      expect(v.normalize(PBKDF2_SHA256)).to.equal(PBKDF2_SHA256);
    });

    it('refuses iterations outside 1000..2000000, a salt under 8 bytes and a malformed hash', () => {
      expect(v.normalize(PBKDF2_SHA256.replace('$1000$', '$999$'))).to.equal('cost_out_of_range');
      expect(v.normalize(PBKDF2_SHA256.replace('$1000$', '$2000001$'))).to.equal('cost_out_of_range');
      expect(v.normalize('pbkdf2_sha256$10000$seasalt$CWWFdHOWwPnki7HvkcqN9iA2T3KLW1cf2uZ5kvArtVY=')).to.equal('malformed');
      expect(v.normalize('$pbkdf2-sha1$1000$MDEyMzQ1Njc4OWFiY2RlZg$EMtO/z0XRnKlXfUKqzuWuzYzvtqBP4HPMmG/OdupiGs')).to.equal('malformed');
    });
  });

  describe('scrypt', () => {
    const v = new ScryptVerifier();

    it('verifies the passlib vector (64 MiB) and a cheap one', async () => {
      expect(await v.verify('$scrypt$ln=16,r=8,p=1$aM15713r3Xsvxbi31lqr1Q$nFNh2CVHVjNldFVKDHDlm4CbdRSCdEBsjjJxD+iCs5E', 'password')).to.equal(true);
      expect(await v.verify(SCRYPT, PASSWORD)).to.equal(true);
      expect(await v.verify(SCRYPT, 'Legacy-Pass-2')).to.equal(false);
    });

    it('keeps a canonical hash and refuses costs past the bounds', () => {
      expect(v.normalize(SCRYPT)).to.equal(SCRYPT);
      expect(v.normalize(SCRYPT.replace('ln=10', 'ln=9'))).to.equal('cost_out_of_range');
      expect(v.normalize(SCRYPT.replace('ln=10', 'ln=21'))).to.equal('cost_out_of_range');
      expect(v.normalize(SCRYPT.replace('ln=10,r=8', 'ln=16,r=16'))).to.equal('cost_out_of_range');
      expect(v.normalize(SCRYPT.replace('p=1', 'p=5'))).to.equal('cost_out_of_range');
      expect(v.normalize('$scrypt$ln=10,r=8$MDEyMzQ1Njc4OWFiY2RlZg$27WJyzHOOkhXR')).to.equal('malformed');
    });
  });

  describe('argon2 (import validation only)', () => {
    const v = new Argon2ImportVerifier();

    it('accepts an argon2i hash as it is, and verifies it', async () => {
      const stored = await argon2.hash(PASSWORD, { type: argon2.argon2i, memoryCost: 4096, timeCost: 2, parallelism: 1 });
      expect(v.normalize(stored)).to.equal(stored);
      expect(await v.verify(stored, PASSWORD)).to.equal(true);
    });

    it('refuses memory above 128 MiB and a hash without v=', () => {
      expect(v.normalize('$argon2id$v=19$m=262144,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA')).to.equal('cost_out_of_range');
      expect(v.normalize('$argon2id$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA')).to.equal('malformed');
    });
  });

  describe('LegacyHashRegistry', () => {
    const registry = new LegacyHashRegistry();

    it('detects each format by its prefix', () => {
      expect(registry.detect(BCRYPT)?.format).to.equal('bcrypt');
      expect(registry.detect(DJANGO)?.format).to.equal('pbkdf2');
      expect(registry.detect(PBKDF2_SHA256)?.format).to.equal('pbkdf2');
      expect(registry.detect(SCRYPT)?.format).to.equal('scrypt');
      expect(registry.detect('$argon2i$v=19$m=4096,t=2,p=1$c2FsdA$aGFzaA')?.format).to.equal('argon2');
    });

    it('detects nothing for an unsupported or peppered value', () => {
      for (const value of ['$1$saltsalt$hash', 'md5$abc$def', `$sp1$${BCRYPT}`, '$sp1$$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA', '']) {
        expect(registry.detect(value), value).to.equal(null);
      }
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/legacy-verifiers.test.ts`
Expected: FAIL with `Cannot find module '.../src/legacy/index.js'` (ERR_MODULE_NOT_FOUND).

- [ ] **Step 4: Write minimal implementation**

`packages/authn-local/src/legacy/verifier.ts`:

```ts
import type { PasswordHashFormat } from '@spinajs/authn/contracts';

export type LegacyNormalizeFailure = 'malformed' | 'cost_out_of_range';

/** One foreign hash format: its prefixes, structure and cost bounds, one stored spelling, and verification. Never peppered. */
export abstract class LegacyHashVerifier {
  public abstract readonly format: PasswordHashFormat;

  /** True when `hash` carries one of this format's prefixes; says nothing about validity. */
  public abstract claims(hash: string): boolean;

  /** The stored spelling of a well-formed hash within the cost bounds. */
  public abstract normalize(hash: string): string | LegacyNormalizeFailure;

  /** `stored` is a normalized hash. False on any error; never throws. */
  public abstract verify(stored: string, password: string): Promise<boolean>;
}
```

`packages/authn-local/src/legacy/encoding.ts`:

```ts
/** passlib's adapted base64: '.' for '+', no padding. */
export const ab64Decode = (s: string): Buffer => Buffer.from(s.replace(/\./g, '+'), 'base64');
export const ab64Encode = (b: Buffer): string => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '.');

/** Standard base64 without padding, as PHC strings write it. */
export const b64Encode = (b: Buffer): string => b.toString('base64').replace(/=+$/, '');
```

`packages/authn-local/src/legacy/bcrypt.ts`:

```ts
import bcrypt from 'bcryptjs';

import { LegacyHashVerifier } from './verifier.js';
import type { LegacyNormalizeFailure } from './verifier.js';

const BCRYPT = /^\$2([aby])\$(\d{2})\$[./A-Za-z0-9]{53}$/;

/** 4 is the format's floor. bcryptjs runs on the event loop, and from cost 15 one login attempt costs seconds of CPU. */
export const BCRYPT_COST = Object.freeze({ min: 4, max: 14 });

export class BcryptVerifier extends LegacyHashVerifier {
  public readonly format = 'bcrypt' as const;

  public claims(hash: string): boolean {
    return /^\$2[aby]\$/.test(hash);
  }

  /** PHP's $2y$ is the same algorithm as $2b$ and is stored as $2b$. */
  public normalize(hash: string): string | LegacyNormalizeFailure {
    const m = BCRYPT.exec(hash);
    if (!m) {
      return 'malformed';
    }
    const cost = Number(m[2]);
    if (cost < BCRYPT_COST.min || cost > BCRYPT_COST.max) {
      return 'cost_out_of_range';
    }
    return m[1] === 'y' ? `$2b$${hash.slice(4)}` : hash;
  }

  /** bcrypt reads only the first 72 UTF-8 bytes of the password, as the source system did. */
  public async verify(stored: string, password: string): Promise<boolean> {
    try {
      return await bcrypt.compare(password, stored);
    } catch {
      return false;
    }
  }
}
```

`packages/authn-local/src/legacy/pbkdf2.ts`:

```ts
import { pbkdf2, timingSafeEqual } from 'node:crypto';

import { ab64Decode, ab64Encode } from './encoding.js';
import { LegacyHashVerifier } from './verifier.js';
import type { LegacyNormalizeFailure } from './verifier.js';

const PASSLIB = /^\$pbkdf2-(sha256|sha512)\$(\d{1,10})\$([./A-Za-z0-9]+)\$([./A-Za-z0-9]+)$/;
const DJANGO = /^pbkdf2_sha256\$(\d{1,10})\$([^$]+)\$([A-Za-z0-9+/]+={0,2})$/;

/** RFC 8018 asks for 1000 iterations at least; 2,000,000 SHA-512 iterations take about a second. */
export const PBKDF2_ITERATIONS = Object.freeze({ min: 1_000, max: 2_000_000 });
const SALT_BYTES = { min: 8, max: 64 };
const KEY_BYTES = { min: 16, max: 64 };

interface Pbkdf2Hash {
  readonly digest: 'sha256' | 'sha512';
  readonly iterations: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parse(hash: string): Pbkdf2Hash | null {
  const p = PASSLIB.exec(hash);
  if (p) {
    return { digest: p[1] as Pbkdf2Hash['digest'], iterations: Number(p[2]), salt: ab64Decode(p[3]), key: ab64Decode(p[4]) };
  }
  const d = DJANGO.exec(hash);
  // Django hashes with the salt text itself as the salt bytes.
  return d ? { digest: 'sha256', iterations: Number(d[1]), salt: Buffer.from(d[2], 'utf8'), key: Buffer.from(d[3], 'base64') } : null;
}

function derive(password: string, h: Pbkdf2Hash): Promise<Buffer> {
  return new Promise((resolve, reject) => pbkdf2(password, h.salt, h.iterations, h.key.length, h.digest, (err, key) => (err ? reject(err) : resolve(key))));
}

/** passlib's `$pbkdf2-sha256$` and `$pbkdf2-sha512$`, and Django's `pbkdf2_sha256$`; stored in passlib's spelling. */
export class Pbkdf2Verifier extends LegacyHashVerifier {
  public readonly format = 'pbkdf2' as const;

  public claims(hash: string): boolean {
    return hash.startsWith('$pbkdf2-sha256$') || hash.startsWith('$pbkdf2-sha512$') || hash.startsWith('pbkdf2_sha256$');
  }

  public normalize(hash: string): string | LegacyNormalizeFailure {
    const h = parse(hash);
    if (!h || h.salt.length < SALT_BYTES.min || h.salt.length > SALT_BYTES.max || h.key.length < KEY_BYTES.min || h.key.length > KEY_BYTES.max) {
      return 'malformed';
    }
    if (h.iterations < PBKDF2_ITERATIONS.min || h.iterations > PBKDF2_ITERATIONS.max) {
      return 'cost_out_of_range';
    }
    return `$pbkdf2-${h.digest}$${h.iterations}$${ab64Encode(h.salt)}$${ab64Encode(h.key)}`;
  }

  public async verify(stored: string, password: string): Promise<boolean> {
    const h = parse(stored);
    if (!h) {
      return false;
    }
    try {
      return timingSafeEqual(await derive(password, h), h.key);
    } catch {
      return false;
    }
  }
}
```

`packages/authn-local/src/legacy/scrypt.ts`:

```ts
import { scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

import { b64Encode } from './encoding.js';
import { LegacyHashVerifier } from './verifier.js';
import type { LegacyNormalizeFailure } from './verifier.js';

const SCRYPT = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,3}),p=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** One verify holds 128 × r × 2^ln bytes, capped at argon2's 64 MiB; p multiplies the time. */
export const SCRYPT_BOUNDS = Object.freeze({ minLn: 10, maxLn: 20, maxR: 32, maxP: 4, maxMemoryBytes: 64 * 1024 * 1024 });
const SALT_BYTES = { min: 8, max: 64 };
const KEY_BYTES = { min: 16, max: 64 };

interface ScryptHash {
  readonly ln: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parse(hash: string): ScryptHash | null {
  const m = SCRYPT.exec(hash);
  return m ? { ln: Number(m[1]), r: Number(m[2]), p: Number(m[3]), salt: Buffer.from(m[4], 'base64'), key: Buffer.from(m[5], 'base64') } : null;
}

function derive(password: string, h: ScryptHash): Promise<Buffer> {
  const N = 2 ** h.ln;
  const options: ScryptOptions = { N, r: h.r, p: h.p, maxmem: 128 * N * h.r + 1024 * 1024 };
  return new Promise((resolve, reject) => scrypt(password, h.salt, h.key.length, options, (err, key) => (err ? reject(err) : resolve(key))));
}

/** passlib's `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<key>`, standard base64 without padding. */
export class ScryptVerifier extends LegacyHashVerifier {
  public readonly format = 'scrypt' as const;

  public claims(hash: string): boolean {
    return hash.startsWith('$scrypt$');
  }

  public normalize(hash: string): string | LegacyNormalizeFailure {
    const h = parse(hash);
    if (!h || h.salt.length < SALT_BYTES.min || h.salt.length > SALT_BYTES.max || h.key.length < KEY_BYTES.min || h.key.length > KEY_BYTES.max) {
      return 'malformed';
    }
    const b = SCRYPT_BOUNDS;
    if (h.ln < b.minLn || h.ln > b.maxLn || h.r < 1 || h.r > b.maxR || h.p < 1 || h.p > b.maxP || 128 * h.r * 2 ** h.ln > b.maxMemoryBytes) {
      return 'cost_out_of_range';
    }
    return `$scrypt$ln=${h.ln},r=${h.r},p=${h.p}$${b64Encode(h.salt)}$${b64Encode(h.key)}`;
  }

  public async verify(stored: string, password: string): Promise<boolean> {
    const h = parse(stored);
    if (!h) {
      return false;
    }
    try {
      return timingSafeEqual(await derive(password, h), h.key);
    } catch {
      return false;
    }
  }
}
```

`packages/authn-local/src/legacy/argon2.ts`:

```ts
import * as argon2 from 'argon2';

import { parseStored } from '../pepper.js';
import { LegacyHashVerifier } from './verifier.js';
import type { LegacyNormalizeFailure } from './verifier.js';

const ARGON2 = /^\$argon2(?:id|i|d)\$v=(?:16|19)\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,2})\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

/** Each verify holds `m` KiB, maxConcurrent at a time: at most twice the 64 MiB default. */
export const ARGON2_IMPORT_BOUNDS = Object.freeze({ minMemoryKiB: 1024, maxMemoryKiB: 131072, maxTime: 10, maxParallelism: 16 });

/** argon2i, argon2d and argon2id PHC strings. The hasher verifies them natively, unpeppered; this only checks an import. */
export class Argon2ImportVerifier extends LegacyHashVerifier {
  public readonly format = 'argon2' as const;

  public claims(hash: string): boolean {
    return /^\$argon2(?:id|i|d)\$/.test(hash);
  }

  public normalize(hash: string): string | LegacyNormalizeFailure {
    const m = ARGON2.exec(hash);
    if (!m || parseStored(hash) === null) {
      return 'malformed';
    }
    const [memory, time, parallelism] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const b = ARGON2_IMPORT_BOUNDS;
    if (memory < b.minMemoryKiB || memory > b.maxMemoryKiB || time < 1 || time > b.maxTime || parallelism < 1 || parallelism > b.maxParallelism) {
      return 'cost_out_of_range';
    }
    return hash;
  }

  public async verify(stored: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(stored, password);
    } catch {
      return false;
    }
  }
}
```

`packages/authn-local/src/legacy/registry.ts`:

```ts
import { Argon2ImportVerifier } from './argon2.js';
import { BcryptVerifier } from './bcrypt.js';
import { Pbkdf2Verifier } from './pbkdf2.js';
import { ScryptVerifier } from './scrypt.js';
import type { LegacyHashVerifier } from './verifier.js';

export const BUILTIN_LEGACY_VERIFIERS: readonly LegacyHashVerifier[] = Object.freeze([new Argon2ImportVerifier(), new BcryptVerifier(), new Pbkdf2Verifier(), new ScryptVerifier()]);

/** Finds the verifier whose prefix a hash carries. */
export class LegacyHashRegistry {
  constructor(public readonly verifiers: readonly LegacyHashVerifier[] = BUILTIN_LEGACY_VERIFIERS) {}

  public detect(hash: string): LegacyHashVerifier | null {
    return this.verifiers.find((v) => v.claims(hash)) ?? null;
  }
}
```

`packages/authn-local/src/legacy/index.ts`:

```ts
export * from './verifier.js';
export * from './bcrypt.js';
export * from './pbkdf2.js';
export * from './scrypt.js';
export * from './argon2.js';
export * from './registry.js';
```

Append to `packages/authn-local/src/index.ts`:

```ts
export * from './legacy/index.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/legacy-verifiers.test.ts`
Expected: PASS, 18 passing, 0 failing.

Run: `cd packages/authn-local && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`
Expected: no compiler output. The CJS build resolves `bcryptjs` through its `require` export.

- [ ] **Step 6: Commit**

```bash
git add packages/authn-local/src/legacy packages/authn-local/src/index.ts packages/authn-local/package.json package-lock.json packages/authn-local/test/legacy-verifiers.test.ts
git commit -m "feat(authn-local): legacy hash verifiers for bcrypt, PBKDF2, scrypt and argon2 imports"
```

---

### Task 3: The hasher verifies an allowed legacy hash, and the login upgrades it

**Files:**
- Modify: `packages/authn-local/src/hasher.ts:1-8` (imports), `:28-31` (options), `:46-50` (settings), `:60-64` (`@Config`), `:100-120` (`verify`), `:135-137` (`settings`), `:152-156` (`dummyVerify` becomes protected), `:158-191` (`buildSettings`)
- Test: `packages/authn-local/test/legacy-login.test.ts`

**Interfaces:**
- Consumes: `LegacyHashRegistry`, `LegacyHashVerifier` (Task 2); `PasswordHashFormat` (Task 1).
- Produces:
  - `Argon2PasswordHasherOptions.importFormats?: readonly PasswordHashFormat[]`, `Argon2PasswordHasherOptions.legacy?: LegacyHashRegistry`
  - `protected legacyFor(stored: string): LegacyHashVerifier | null`
  - `protected dummyVerify(dummy: string, password: string): Promise<void>`
  - config read: `authn.local.import.formats`

- [ ] **Step 1: Write the failing test**

Create `packages/authn-local/test/legacy-login.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import type { AuthnContext, Credentials, IdentityRef } from '@spinajs/authn/contracts';
import { FakeIdentityStore, MemoryPasswordCredentialStore } from '@spinajs/authn-testing';

import { Argon2PasswordHasher, Argon2PasswordHasherOptions } from '../src/hasher.js';
import { LocalPasswordStrategy } from '../src/strategy.js';

const LOGIN = 'legacy@example.com';
const PASSWORD = 'Legacy-Pass-1';
const BCRYPT = '$2b$04$abcdefghijklmnopqrstuuUUEjECGte.vGcak2zFXn9yHIm3JKCxK';
const PBKDF2 = '$pbkdf2-sha256$1000$MDEyMzQ1Njc4OWFiY2RlZg$EMtO/z0XRnKlXfUKqzuWuzYzvtqBP4HPMmG/OdupiGs';
const SCRYPT = '$scrypt$ln=10,r=8,p=1$MDEyMzQ1Njc4OWFiY2RlZg$27WJyzHOOkhXR/Tyhx4ewlVI06UNxQsU4vYvu2Tni7s';
const PEPPER = { secret: 'legacy-pepper-0123456789', version: 4 };
const CTX: AuthnContext = { now: new Date('2026-10-06T12:00:00Z'), purpose: 'login', ip: '203.0.113.9' };

const pw = (login: string, password: string): Credentials => ({ kind: 'password', login, password }) as Credentials;

class CountingHasher extends Argon2PasswordHasher {
  public dummies = 0;
  protected async dummyVerify(dummy: string, password: string): Promise<void> {
    this.dummies++;
    return super.dummyVerify(dummy, password);
  }
}

class RecordingPasswordStore extends MemoryPasswordCredentialStore {
  public readonly sets: { hash: string; expected: string | null | undefined }[] = [];
  public async set(id: IdentityRef, hash: string, expected?: string | null): Promise<boolean> {
    this.sets.push({ hash, expected });
    return super.set(id, hash, expected);
  }
}

async function hasher(options: Argon2PasswordHasherOptions): Promise<CountingHasher> {
  const h = new CountingHasher(options);
  await h.resolve();
  return h;
}

describe('legacy hashes at login (A03, A02, A34)', function () {
  this.timeout(60_000);

  for (const [format, stored] of [
    ['bcrypt', BCRYPT],
    ['pbkdf2', PBKDF2],
    ['scrypt', SCRYPT],
  ] as const) {
    it(`verifies an allowed ${format} hash with one dummy argon2 verify alongside, and asks for a rehash`, async () => {
      const h = await hasher({ importFormats: [format] });
      expect(await h.verify(stored, PASSWORD)).to.equal(true);
      expect(await h.verify(stored, 'Legacy-Pass-2')).to.equal(false);
      expect(h.dummies).to.equal(2);
      expect(h.needsRehash(stored)).to.equal(true);
    });

    it(`never verifies a ${format} hash whose format is not allowed`, async () => {
      const h = await hasher({ importFormats: [] });
      expect(await h.verify(stored, PASSWORD)).to.equal(false);
      expect(h.dummies).to.equal(1);
    });
  }

  it('never verifies a value in a spelling the import would have changed, or past the cost bounds', async () => {
    const h = await hasher({ importFormats: ['bcrypt', 'pbkdf2'] });
    expect(await h.verify(BCRYPT.replace('$2b$', '$2y$'), PASSWORD)).to.equal(false);
    expect(await h.verify('pbkdf2_sha256$1000$seasalt12345$VeT1yEpEx+3lMTnEKAB85ZpS3MPBoYYgZlKanctP4ZY=', PASSWORD)).to.equal(false);
    expect(await h.verify(BCRYPT.replace('$04$', '$15$'), PASSWORD)).to.equal(false);
  });

  it('verifies a legacy hash with the raw password under a pepper, and never one behind a pepper tag', async () => {
    const h = await hasher({ importFormats: ['bcrypt'], pepper: PEPPER });
    expect(await h.verify(BCRYPT, PASSWORD)).to.equal(true);
    expect(await h.verify(`$sp4$${BCRYPT}`, PASSWORD)).to.equal(false);
  });

  it('a login with a legacy hash succeeds and stores argon2id under the pepper, over the legacy hash only', async () => {
    const identities = new FakeIdentityStore();
    const passwords = new RecordingPasswordStore();
    const h = new Argon2PasswordHasher({ importFormats: ['bcrypt'], pepper: PEPPER });
    const strategy = new LocalPasswordStrategy({ identities, passwords, hasher: h });
    await strategy.resolve();
    const id = identities.add({ login: LOGIN });
    await passwords.set(id, BCRYPT);

    expect(await strategy.verify(pw(LOGIN, PASSWORD), CTX)).to.deep.equal({ ok: true, identity: id, method: 'password' });

    const stored = (await passwords.get(id))!;
    expect(stored.startsWith('$sp4$$argon2id$'), stored).to.equal(true);
    expect(passwords.sets[passwords.sets.length - 1].expected).to.equal(BCRYPT);
    expect(h.needsRehash(stored)).to.equal(false);
    expect(await strategy.verify(pw(LOGIN, PASSWORD), CTX)).to.deep.equal({ ok: true, identity: id, method: 'password' });
  });

  it('a wrong password against a legacy hash fails and keeps it', async () => {
    const identities = new FakeIdentityStore();
    const passwords = new RecordingPasswordStore();
    const strategy = new LocalPasswordStrategy({ identities, passwords, hasher: new Argon2PasswordHasher({ importFormats: ['bcrypt'] }) });
    await strategy.resolve();
    const id = identities.add({ login: LOGIN });
    await passwords.set(id, BCRYPT);

    expect(await strategy.verify(pw(LOGIN, 'Legacy-Pass-2'), CTX)).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
    expect(await passwords.get(id)).to.equal(BCRYPT);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/legacy-login.test.ts`
Expected: FAIL. Each allowed-format case gets `false` instead of `true`; the strategy case answers `{ ok: false, reason: 'invalid_credentials' }`. `dummies` counts may stay 0, because `dummyVerify` is private and the override is never called.

- [ ] **Step 3: Write minimal implementation**

In `hasher.ts` add to the imports:

```ts
import type { PasswordHashFormat } from '@spinajs/authn/contracts';

import { LegacyHashRegistry } from './legacy/registry.js';
import type { LegacyHashVerifier } from './legacy/verifier.js';
```

Replace `Argon2PasswordHasherOptions` (lines 28-31) with:

```ts
export interface Argon2PasswordHasherOptions {
  readonly maxConcurrent?: number;
  readonly pepper?: PepperConfig;
  /** `authn.local.import.formats`: the foreign formats `verify` accepts. */
  readonly importFormats?: readonly PasswordHashFormat[];
  /** The verifiers by prefix; default the built-in ones. */
  readonly legacy?: LegacyHashRegistry;
}
```

Add to `HasherSettings` (lines 46-50):

```ts
  readonly legacyFormats: ReadonlySet<PasswordHashFormat>;
```

Below the module constant `DEFAULT_MAX_CONCURRENT` (line 52) add:

```ts
const DEFAULT_LEGACY = new LegacyHashRegistry();
```

After the `Pepper` field (line 64) add:

```ts
  @Config('authn.local.import.formats', { defaultValue: [] as PasswordHashFormat[] })
  protected ImportFormats: readonly PasswordHashFormat[];
```

Replace `verify` (lines 100-120) with:

```ts
  public async verify(stored: string | null | undefined, password: string): Promise<boolean> {
    const parsed = typeof stored === 'string' ? parseStored(stored) : null;
    const pepper = parsed ? this.pepperFor(parsed.version) : undefined;

    if (!parsed || pepper === undefined) {
      const legacy = !parsed && typeof stored === 'string' ? this.legacyFor(stored) : null;
      const dummy = await this.dummy();
      if (legacy) {
        // Alongside the dummy argon2 verify, so a legacy account takes at least as long as an unknown one (A02).
        return this.limiter.run(async () => (await Promise.all([legacy.verify(stored as string, password), this.dummyVerify(dummy, password)]))[0]);
      }
      await this.limiter.run(() => this.dummyVerify(dummy, password));
      return false;
    }

    const dummy = await this.dummy();
    return this.limiter.run(async () => {
      try {
        return await argon2.verify(parsed.argon2, pepper ? pepperInput(password, pepper.secret) : password);
      } catch {
        // The PHC string passed the shape check but argon2 still refused it; spend the work a real verify would.
        await this.dummyVerify(dummy, password);
        return false;
      }
    });
  }
```

Replace the `settings` getter (lines 135-137) with:

```ts
  protected get settings(): HasherSettings {
    return (this._settings ??= this.buildSettings(this.Options ?? { maxConcurrent: this.MaxConcurrent, pepper: this.Pepper, importFormats: this.ImportFormats }));
  }

  /**
   * The verifier of a foreign hash whose format is allowed and which is stored exactly as the import stores it (canonical, within
   * the cost bounds); argon2 is verified natively.
   */
  protected legacyFor(stored: string): LegacyHashVerifier | null {
    const verifier = (this.Options?.legacy ?? DEFAULT_LEGACY).detect(stored);
    return verifier && verifier.format !== 'argon2' && this.settings.legacyFormats.has(verifier.format) && verifier.normalize(stored) === stored ? verifier : null;
  }
```

Change `private async dummyVerify` (line 152) to `protected async dummyVerify`.

In `buildSettings`, change the return (line 190) to:

```ts
    return { maxConcurrent, current, peppers, legacyFormats: new Set(options.importFormats ?? []) };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/legacy-login.test.ts test/argon2-hasher.test.ts test/strategy.test.ts`
Expected: PASS, 0 failing (`legacy-login.test.ts`: 10 passing).

Run: `cd packages/authn-local && npm test`
Expected: PASS, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-local/src/hasher.ts packages/authn-local/test/legacy-login.test.ts
git commit -m "feat(authn-local): verify an allowed imported hash at login and rehash it to argon2id"
```

---

### Task 4: `LocalPasswordHashImporter`

**Files:**
- Create: `packages/authn-local/src/legacy/importer.ts`
- Modify: `packages/authn-local/src/legacy/index.ts` (export)
- Test: `packages/authn-local/test/importer.test.ts`

**Interfaces:**
- Consumes: `PasswordHashImporter` and its types (Task 1); `LegacyHashRegistry` (Task 2); `publishAuthnEvent`, `AuditLog` (`src/audit.ts:3-19`).
- Produces:
  - `@Injectable(PasswordHashImporter) class LocalPasswordHashImporter`
  - `interface LocalPasswordHashImporterDeps { passwords; sinks; formats; registry?; log? }`
  - `MAX_IMPORTED_HASH_LENGTH = 512`

- [ ] **Step 1: Write the failing test**

Create `packages/authn-local/test/importer.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import * as argon2 from 'argon2';
import type { AuthnContext, IdentityRef, PasswordHashFormat } from '@spinajs/authn/contracts';
import { MemoryPasswordCredentialStore, RecordingEventSink } from '@spinajs/authn-testing';

import { Argon2PasswordHasher } from '../src/hasher.js';
import { LocalPasswordHashImporter } from '../src/legacy/importer.js';

const PASSWORD = 'Legacy-Pass-1';
const BCRYPT = '$2b$04$abcdefghijklmnopqrstuuUUEjECGte.vGcak2zFXn9yHIm3JKCxK';
const DJANGO = 'pbkdf2_sha256$1000$seasalt12345$VeT1yEpEx+3lMTnEKAB85ZpS3MPBoYYgZlKanctP4ZY=';
const DJANGO_STORED = '$pbkdf2-sha256$1000$c2Vhc2FsdDEyMzQ1$VeT1yEpEx.3lMTnEKAB85ZpS3MPBoYYgZlKanctP4ZY';
const CTX: AuthnContext = { now: new Date('2026-10-06T12:00:00Z'), purpose: 'request' };
const ACTOR = { type: 'user' as const, id: 'admin-1' };
const ann: IdentityRef = { type: 'user', id: 'ann' };

function setup(formats: readonly PasswordHashFormat[] = ['bcrypt', 'pbkdf2', 'argon2']) {
  const passwords = new MemoryPasswordCredentialStore();
  const events = new RecordingEventSink();
  const importer = new LocalPasswordHashImporter({ passwords, sinks: [events], formats });
  return { passwords, events, importer };
}

describe('LocalPasswordHashImporter', function () {
  this.timeout(30_000);

  it('stores an allowed hash in its canonical spelling over no password and audits it without the hash', async () => {
    const x = setup();
    expect(await x.importer.import(ann, { hash: BCRYPT.replace('$2b$', '$2y$'), format: 'bcrypt' }, CTX, { actor: ACTOR })).to.deep.equal({ status: 'imported' });
    expect(await x.passwords.get(ann)).to.equal(BCRYPT);
    const [e] = x.events.ofType('password.import');
    expect(e).to.deep.include({ outcome: 'success', identity: ann, actor: ACTOR, data: { format: 'bcrypt' } });
    expect(JSON.stringify(x.events.all())).to.not.contain('UUEjECGte');
  });

  it("stores Django's PBKDF2 in passlib's spelling", async () => {
    const x = setup();
    expect(await x.importer.import(ann, { hash: DJANGO, format: 'pbkdf2' }, CTX)).to.deep.equal({ status: 'imported' });
    expect(await x.passwords.get(ann)).to.equal(DJANGO_STORED);
  });

  for (const [label, input, reason, formats] of [
    ['a format not in authn.local.import.formats', { hash: BCRYPT, format: 'bcrypt' }, 'format_disabled', ['pbkdf2']],
    ['a hash of another format than declared', { hash: DJANGO, format: 'bcrypt' }, 'format_mismatch', ['bcrypt', 'pbkdf2']],
    ['a value no verifier claims', { hash: '$1$saltsalt$abcdefghijklmnopqrstuv', format: 'bcrypt' }, 'malformed', ['bcrypt']],
    ['a truncated hash', { hash: BCRYPT.slice(0, 40), format: 'bcrypt' }, 'malformed', ['bcrypt']],
    ['an over-long value', { hash: `$2b$04$${'a'.repeat(600)}`, format: 'bcrypt' }, 'malformed', ['bcrypt']],
    ['a cost past the bounds', { hash: BCRYPT.replace('$04$', '$15$'), format: 'bcrypt' }, 'cost_out_of_range', ['bcrypt']],
    ['a peppered argon2 value', { hash: '$sp1$$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA', format: 'argon2' }, 'malformed', ['argon2']],
  ] as const) {
    it(`refuses ${label} as ${reason}, writes nothing and audits the refusal`, async () => {
      const x = setup(formats);
      expect(x.importer.check(input)).to.equal(reason);
      expect(await x.importer.import(ann, input, CTX)).to.deep.equal({ status: 'refused', reason });
      expect(x.passwords.writes).to.deep.equal([]);
      expect(x.events.ofType('password.import').map((e) => [e.outcome, e.reason])).to.deep.equal([['failure', reason]]);
    });
  }

  it('never writes over a stored password: conflict', async () => {
    const x = setup();
    await x.passwords.set(ann, '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA');
    expect(x.importer.check({ hash: BCRYPT, format: 'bcrypt' })).to.equal(null);
    expect(await x.importer.import(ann, { hash: BCRYPT, format: 'bcrypt' }, CTX)).to.deep.equal({ status: 'refused', reason: 'conflict' });
    expect(x.events.ofType('password.import').map((e) => e.reason)).to.deep.equal(['conflict']);
  });

  it('check writes nothing and publishes nothing', () => {
    const x = setup();
    expect(x.importer.check({ hash: BCRYPT, format: 'bcrypt' })).to.equal(null);
    expect(x.passwords.writes).to.deep.equal([]);
    expect(x.events.all()).to.deep.equal([]);
  });

  it('an imported argon2i hash verifies unpeppered under a pepper and is due for a rehash', async () => {
    const x = setup();
    const foreign = await argon2.hash(PASSWORD, { type: argon2.argon2i, memoryCost: 4096, timeCost: 2, parallelism: 1 });
    expect(await x.importer.import(ann, { hash: foreign, format: 'argon2' }, CTX)).to.deep.equal({ status: 'imported' });
    const hasher = new Argon2PasswordHasher({ pepper: { secret: 'import-pepper-0123456789', version: 2 } });
    await hasher.resolve();
    const stored = (await x.passwords.get(ann))!;
    expect(await hasher.verify(stored, PASSWORD)).to.equal(true);
    expect(hasher.needsRehash(stored)).to.equal(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/importer.test.ts`
Expected: FAIL with `Cannot find module '.../src/legacy/importer.js'` (ERR_MODULE_NOT_FOUND).

- [ ] **Step 3: Write minimal implementation**

Create `packages/authn-local/src/legacy/importer.ts`:

```ts
import { DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { AuthnEventSink, PasswordCredentialStore, PasswordHashImporter } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnEvent, IdentityRef, ImportedPasswordHash, PasswordHashFormat, PasswordImportRefusal, PasswordImportResult, PrincipalRef } from '@spinajs/authn/contracts';

import { AuditLog, publishAuthnEvent } from '../audit.js';
import { LegacyHashRegistry } from './registry.js';

const FORMATS: readonly string[] = ['argon2', 'bcrypt', 'pbkdf2', 'scrypt'];

/** Longer than any hash of the supported formats; a longer value is refused before any parsing. */
export const MAX_IMPORTED_HASH_LENGTH = 512;

const isFormat = (f: unknown): f is PasswordHashFormat => typeof f === 'string' && FORMATS.includes(f);

export interface LocalPasswordHashImporterDeps {
  readonly passwords: PasswordCredentialStore;
  readonly sinks: readonly AuthnEventSink[];
  /** `authn.local.import.formats`. */
  readonly formats: readonly PasswordHashFormat[];
  readonly registry?: LegacyHashRegistry;
  readonly log?: AuditLog;
}

type Prepared = { readonly stored: string } | { readonly refusal: PasswordImportRefusal };

/** Checks a foreign hash (format allowed, prefix, structure, cost bounds) and stores its canonical spelling over no password. */
@Injectable(PasswordHashImporter)
export class LocalPasswordHashImporter extends PasswordHashImporter {
  @Config('authn.local.import.formats', { defaultValue: [] as PasswordHashFormat[] })
  protected Formats: readonly PasswordHashFormat[];

  @Logger('authn-local')
  protected Log: Log;

  /** With `deps` nothing is taken from the container or the configuration. */
  constructor(protected readonly Deps?: LocalPasswordHashImporterDeps) {
    super();
  }

  public check(input: ImportedPasswordHash): PasswordImportRefusal | null {
    const prepared = this.prepare(input);
    return 'refusal' in prepared ? prepared.refusal : null;
  }

  public async import(id: IdentityRef, input: ImportedPasswordHash, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<PasswordImportResult> {
    const prepared = this.prepare(input);
    const base = { type: 'password.import' as const, identity: id, ...(opts?.actor ? { actor: opts.actor } : {}), ...(isFormat(input?.format) ? { data: { format: input.format } } : {}) };

    if ('refusal' in prepared) {
      await this.audit(ctx, { ...base, outcome: 'failure', reason: prepared.refusal });
      return { status: 'refused', reason: prepared.refusal };
    }
    if (!(await this.passwords().set(id, prepared.stored, null))) {
      await this.audit(ctx, { ...base, outcome: 'failure', reason: 'conflict' });
      return { status: 'refused', reason: 'conflict' };
    }
    await this.audit(ctx, { ...base, outcome: 'success' });
    return { status: 'imported' };
  }

  protected prepare(input: ImportedPasswordHash): Prepared {
    if (!isFormat(input?.format) || !this.formats().includes(input.format)) {
      return { refusal: 'format_disabled' };
    }
    const hash: unknown = input.hash;
    if (typeof hash !== 'string' || hash.length > MAX_IMPORTED_HASH_LENGTH) {
      return { refusal: 'malformed' };
    }
    const verifier = this.registry().detect(hash);
    if (!verifier) {
      return { refusal: 'malformed' };
    }
    if (verifier.format !== input.format) {
      return { refusal: 'format_mismatch' };
    }
    const stored = verifier.normalize(hash);
    return stored === 'malformed' || stored === 'cost_out_of_range' ? { refusal: stored } : { stored };
  }

  protected async audit(ctx: AuthnContext, e: Omit<AuthnEvent, 'at' | 'ip' | 'userAgent'>): Promise<void> {
    const event: AuthnEvent = {
      ...e,
      at: ctx.now,
      ...(ctx.ip !== undefined ? { ip: ctx.ip } : {}),
      ...(ctx.userAgent !== undefined ? { userAgent: ctx.userAgent } : {}),
    };
    await publishAuthnEvent(await this.sinks(), event, this.log());
  }

  protected formats(): readonly PasswordHashFormat[] {
    return this.Deps ? this.Deps.formats : (this.Formats ?? []);
  }

  protected registry(): LegacyHashRegistry {
    return this.Deps?.registry ?? new LegacyHashRegistry();
  }

  protected passwords(): PasswordCredentialStore {
    return this.Deps ? this.Deps.passwords : DI.resolve(PasswordCredentialStore);
  }

  protected async sinks(): Promise<readonly AuthnEventSink[]> {
    if (this.Deps) {
      return this.Deps.sinks;
    }
    return DI.check(AuthnEventSink) ? await Promise.resolve(DI.resolve(Array.ofType(AuthnEventSink))) : [];
  }

  protected log(): AuditLog {
    return this.Deps ? (this.Deps.log ?? { warn: () => undefined }) : this.Log;
  }
}
```

Append to `packages/authn-local/src/legacy/index.ts`:

```ts
export * from './importer.js';
```

- [ ] **Step 4: Run tests to verify they pass, then rebuild**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/importer.test.ts`
Expected: PASS, 12 passing, 0 failing.

Run: `cd packages/authn-local && npm test && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`
Expected: PASS, 0 failing; no compiler output.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-local/src/legacy/importer.ts packages/authn-local/src/legacy/index.ts packages/authn-local/test/importer.test.ts
git commit -m "feat(authn-local): LocalPasswordHashImporter validates and stores imported hashes"
```

---

### Task 5: CLI `authn:password-import`

**Files:**
- Create: `packages/authn-local/src/cli/ImportPasswords.ts`
- Test: `packages/authn-local/test/password-import-cli.test.ts`

**Interfaces:**
- Consumes: `PasswordHashImporter` and `IdentityStore` from DI; `LocalPasswordHashImporter` (Task 4) is the registered importer.
- Produces:
  - Command `authn:password-import <file> [-n|--dry-run]`
  - `class ImportPasswords extends CliCommand` with `execute(file: string, options: ImportPasswordsOptions): Promise<void>` and `protected input(file: string): NodeJS.ReadableStream`
  - `interface ImportPasswordsOptions { readonly dryRun?: boolean }`

- [ ] **Step 1: Write the failing test**

Create `packages/authn-local/test/password-import-cli.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Readable } from 'node:stream';
import { DI } from '@spinajs/di';
import { META_ARGUMENT, META_COMMAND, META_OPTION } from '@spinajs/cli';
import type { IArgument, ICommand, IOption } from '@spinajs/cli';
import { InvalidArgument } from '@spinajs/exceptions';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { AuthnEventSink, IdentityStore, PasswordCredentialStore, PasswordHashImporter } from '@spinajs/authn/contracts';
import { FakeIdentityStore, MemoryPasswordCredentialStore, RecordingEventSink } from '@spinajs/authn-testing';

import { ImportPasswords } from '../src/cli/ImportPasswords.js';
import { LocalPasswordHashImporter } from '../src/legacy/importer.js';

const BCRYPT = '$2b$04$abcdefghijklmnopqrstuuUUEjECGte.vGcak2zFXn9yHIm3JKCxK';
const DJANGO = 'pbkdf2_sha256$1000$seasalt12345$VeT1yEpEx+3lMTnEKAB85ZpS3MPBoYYgZlKanctP4ZY=';
const DJANGO_STORED = '$pbkdf2-sha256$1000$c2Vhc2FsdDEyMzQ1$VeT1yEpEx.3lMTnEKAB85ZpS3MPBoYYgZlKanctP4ZY';
const SCRYPT = '$scrypt$ln=10,r=8,p=1$MDEyMzQ1Njc4OWFiY2RlZg$27WJyzHOOkhXR/Tyhx4ewlVI06UNxQsU4vYvu2Tni7s';

class ImportCliConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      authn: { local: { import: { formats: ['bcrypt', 'pbkdf2'] } } },
    };
  }
}

// Own class names: the DI cache keys on them, and cli.test.ts registers the base fakes.
class ImportCliIdentityStore extends FakeIdentityStore {}
class ImportCliPasswordStore extends MemoryPasswordCredentialStore {}
class ImportCliSink extends RecordingEventSink {}

class ScriptedImport extends ImportPasswords {
  public readonly logged: string[] = [];
  constructor(private readonly text: string) {
    super();
    const record = (...args: unknown[]) => {
      this.logged.push(args.map(String).join(' '));
    };
    // The @Logger getter lives on the prototype; an own property shadows it.
    Object.defineProperty(this, 'Log', { value: { error: record, success: record, info: record, warn: record, debug: record, trace: record } });
  }
  protected input(): NodeJS.ReadableStream {
    return Readable.from([this.text]);
  }
}

async function rejection(run: () => Promise<void>): Promise<Error> {
  try {
    await run();
  } catch (e) {
    return e as Error;
  }
  throw new Error('the command did not fail');
}

describe('authn:password-import', function () {
  this.timeout(30_000);

  before(async () => {
    DI.setESMModuleSupport();
    DI.register(ImportCliConfiguration).as(Configuration);
    DI.register(ImportCliIdentityStore).as(IdentityStore);
    DI.register(ImportCliPasswordStore).as(PasswordCredentialStore);
    DI.register(ImportCliSink).as(AuthnEventSink);
    await DI.resolve(Configuration);
  });

  after(() => {
    for (const type of [ImportCliConfiguration, ImportCliIdentityStore, ImportCliPasswordStore, ImportCliSink]) {
      DI.unregister(type);
      DI.uncache(type);
    }
    DI.uncache(Configuration);
    DI.uncache(IdentityStore);
    DI.uncache(PasswordCredentialStore);
    DI.uncache(AuthnEventSink);
    DI.uncache(PasswordHashImporter);
    DI.uncache(LocalPasswordHashImporter);
  });

  const identities = () => DI.resolve(IdentityStore) as ImportCliIdentityStore;
  const passwords = () => DI.resolve(PasswordCredentialStore) as ImportCliPasswordStore;
  const sink = () => DI.resolve(Array.ofType(AuthnEventSink))[0] as ImportCliSink;

  it('takes the file as its only argument and a --dry-run option', () => {
    const args = Reflect.getMetadata(META_ARGUMENT, ImportPasswords) as IArgument[];
    const opts = Reflect.getMetadata(META_OPTION, ImportPasswords) as IOption[];
    const command = Reflect.getMetadata(META_COMMAND, ImportPasswords) as ICommand;
    expect(args.map((a) => a.name)).to.deep.equal(['file']);
    expect(opts.map((o) => o.flags)).to.deep.equal(['-n, --dry-run']);
    expect(command.nameAndArgs).to.equal('authn:password-import');
    expect(command.allowExcessArguments).to.equal(false);
  });

  it('imports by login, email and uuid, reports refused lines by number and reason only, and fails when one was refused', async () => {
    const ann = identities().add({ login: 'ann', email: 'ann@example.com' });
    const ben = identities().add({ login: 'ben', email: 'ben@example.com' });
    const cara = identities().add({ login: 'cara' });
    identities().add({ login: 'dan' });
    const events = sink().ofType('password.import').length;
    const command = new ScriptedImport(
      [
        JSON.stringify({ login: 'ann', hash: BCRYPT, format: 'bcrypt' }),
        JSON.stringify({ email: 'ben@example.com', hash: DJANGO, format: 'pbkdf2' }),
        JSON.stringify({ uuid: cara.id, hash: BCRYPT, format: 'bcrypt' }),
        '',
        'not json',
        JSON.stringify({ login: 'nobody', hash: BCRYPT, format: 'bcrypt' }),
        JSON.stringify({ login: 'dan', hash: SCRYPT, format: 'scrypt' }),
        JSON.stringify({ login: 'ann', hash: BCRYPT, format: 'bcrypt' }),
      ].join('\n'),
    );

    const error = await rejection(() => command.execute('passwords.jsonl', {}));

    expect(error).to.be.instanceOf(InvalidArgument);
    expect(error.message).to.equal('4 line(s) refused');
    expect(await passwords().get(ann)).to.equal(BCRYPT);
    expect(await passwords().get(ben)).to.equal(DJANGO_STORED);
    expect(await passwords().get(cara)).to.equal(BCRYPT);
    expect(command.logged).to.deep.equal(['Imported: 3, refused: 4 (malformed_line: lines 5; unknown_identity: lines 6; format_disabled: lines 7; conflict: lines 8)']);
    const audited = sink().ofType('password.import').slice(events);
    expect(audited.map((e) => [e.outcome, e.reason ?? null])).to.deep.equal([
      ['success', null],
      ['success', null],
      ['success', null],
      ['failure', 'format_disabled'],
      ['failure', 'conflict'],
    ]);
    expect(audited.every((e) => e.actor?.type === 'service' && e.actor.id === 'cli')).to.equal(true);
  });

  it('--dry-run checks every line and writes nothing', async () => {
    identities().add({ login: 'eve' });
    const writes = passwords().writes.length;
    const events = sink().all().length;
    const command = new ScriptedImport(
      [JSON.stringify({ login: 'eve', hash: BCRYPT, format: 'bcrypt' }), JSON.stringify({ login: 'eve', hash: BCRYPT.replace('$04$', '$15$'), format: 'bcrypt' })].join('\n'),
    );

    const error = await rejection(() => command.execute('passwords.jsonl', { dryRun: true }));

    expect(error.message).to.equal('1 line(s) refused');
    expect(command.logged).to.deep.equal(['Acceptable: 1, refused: 1 (cost_out_of_range: lines 2)']);
    expect(passwords().writes.length).to.equal(writes);
    expect(sink().all().length).to.equal(events);
  });

  it('finishes without an error when every line is imported', async () => {
    const fay = identities().add({ login: 'fay' });
    const command = new ScriptedImport(`${JSON.stringify({ login: 'fay', hash: BCRYPT, format: 'bcrypt' })}\r\n`);
    await command.execute('passwords.jsonl', {});
    expect(command.logged).to.deep.equal(['Imported: 1, refused: 0']);
    expect(await passwords().get(fay)).to.equal(BCRYPT);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/password-import-cli.test.ts`
Expected: FAIL with `Cannot find module '.../src/cli/ImportPasswords.js'` (ERR_MODULE_NOT_FOUND).

- [ ] **Step 3: Write minimal implementation**

Create `packages/authn-local/src/cli/ImportPasswords.ts`:

```ts
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { IdentityStore, PasswordHashImporter } from '@spinajs/authn/contracts';
import type { IdentityRef, ImportedPasswordHash, PasswordHashFormat, PasswordImportRefusal, PrincipalRef } from '@spinajs/authn/contracts';

const CLI_ACTOR: PrincipalRef = { type: 'service', id: 'cli' };

/** Far above one JSON line of a supported hash; a longer line is refused unparsed. */
const MAX_LINE_LENGTH = 4096;

const KEYS = ['login', 'email', 'uuid'] as const;

export interface ImportPasswordsOptions {
  readonly dryRun?: boolean;
}

type LineOutcome = 'imported' | 'acceptable' | 'malformed_line' | 'unknown_identity' | PasswordImportRefusal;

interface ImportLine {
  readonly key: (typeof KEYS)[number];
  readonly value: string;
  readonly input: ImportedPasswordHash;
}

function parseLine(raw: string): ImportLine | null {
  if (raw.length > MAX_LINE_LENGTH) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  const keys = KEYS.filter((k) => o[k] !== undefined);
  const value = keys.length === 1 ? o[keys[0]] : undefined;
  if (typeof value !== 'string' || value === '' || typeof o.hash !== 'string' || typeof o.format !== 'string') {
    return null;
  }
  return { key: keys[0], value, input: { hash: o.hash, format: o.format as PasswordHashFormat } };
}

/**
 * Imports password hashes through PasswordHashImporter from a JSONL file, one `{ "login" | "email" | "uuid", "hash", "format" }` per
 * line. Logs counts and the numbers of refused lines, never a line's content; fails when a line was refused.
 */
@Command({
  nameAndArgs: 'authn:password-import',
  description: 'Imports password hashes from a JSONL file of { "login" | "email" | "uuid", "hash", "format" } lines',
  allowExcessArguments: false,
})
@Argument('file', true, 'path of the JSONL file')
@Option('-n, --dry-run', false, 'check every line, write nothing')
export class ImportPasswords extends CliCommand {
  @Logger('authn-local')
  protected Log: Log;

  public async execute(file: string, options: ImportPasswordsOptions): Promise<void> {
    const importer = await DI.resolve(PasswordHashImporter);
    const identities = await DI.resolve(IdentityStore);
    const dryRun = options.dryRun === true;
    const refused = new Map<string, number[]>();
    let done = 0;
    let n = 0;

    for await (const raw of createInterface({ input: this.input(file), crlfDelay: Infinity })) {
      n++;
      if (raw.trim() === '') continue;
      const outcome = await this.importLine(raw, importer, identities, dryRun);
      if (outcome === 'imported' || outcome === 'acceptable') {
        done++;
      } else {
        refused.set(outcome, [...(refused.get(outcome) ?? []), n]);
      }
    }

    const total = [...refused.values()].reduce((sum, lines) => sum + lines.length, 0);
    const detail = [...refused].map(([reason, lines]) => `${reason}: lines ${lines.join(', ')}`).join('; ');
    this.Log.info(`${dryRun ? 'Acceptable' : 'Imported'}: ${done}, refused: ${total}${detail ? ` (${detail})` : ''}`);
    if (total > 0) {
      throw new InvalidArgument(`${total} line(s) refused`);
    }
  }

  protected async importLine(raw: string, importer: PasswordHashImporter, identities: IdentityStore, dryRun: boolean): Promise<LineOutcome> {
    const line = parseLine(raw);
    if (!line) {
      return 'malformed_line';
    }
    const id = await this.identityOf(line, identities);
    if (!id) {
      return 'unknown_identity';
    }
    if (dryRun) {
      return importer.check(line.input) ?? 'acceptable';
    }
    const result = await importer.import(id, line.input, { now: new Date(), purpose: 'request' }, { actor: CLI_ACTOR });
    return result.status === 'imported' ? 'imported' : result.reason;
  }

  protected async identityOf(line: ImportLine, identities: IdentityStore): Promise<IdentityRef | null> {
    if (line.key === 'uuid') {
      const id: IdentityRef = { type: 'user', id: line.value };
      return (await identities.status(id)).exists ? id : null;
    }
    return identities.findByLogin(line.value);
  }

  protected input(file: string): NodeJS.ReadableStream {
    return createReadStream(file, { encoding: 'utf8' });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/password-import-cli.test.ts`
Expected: PASS, 4 passing, 0 failing.

Run: `cd packages/authn-local && npm test && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`
Expected: PASS, 0 failing; no compiler output.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-local/src/cli/ImportPasswords.ts packages/authn-local/test/password-import-cli.test.ts
git commit -m "feat(authn-local): authn:password-import CLI for JSONL hash files"
```

---

### Task 6: `users.create({ PasswordHash })`, the permission, and PasswordSetAt on import

**Files:**
- Modify: `packages/users/src/actions.ts:23-24` (imports), `:449-466` (`ICreateUserData`), after `:620` (a new `passwordHashImporter()`), `:655-745` (`createUser`)
- Modify: `packages/users/src/user-resource-adapter.ts:8`, `:31-38`
- Modify: `packages/users/src/identity/account-sink.ts:35`
- Test: `packages/users/test/create.test.ts` (a new describe after `describe('a supplied password')`), `packages/users/test/shipped-config.test.ts:164-168`, `packages/users/test/authn-sinks.test.ts:55-60`

**Interfaces:**
- Consumes: `PasswordHashImporter`, `ImportedPasswordHash` (Task 1); the registered `LocalPasswordHashImporter` (Task 4, via the authn-local `lib`).
- Produces:
  - `ICreateUserData.PasswordHash?: ImportedPasswordHash`
  - `PASSWORD_IMPORT_PERMISSION = 'user:password.import'` (exported from `@spinajs/users`)
  - error codes `E_PASSWORD_AND_HASH` and `E_PASSWORD_HASH_REFUSED`, field `passwordHash`

- [ ] **Step 1: Write the failing tests**

In `create.test.ts`, add after `describe('a supplied password', ...)`:

```ts
  describe('a supplied password hash', () => {
    const BCRYPT = '$2b$04$abcdefghijklmnopqrstuuUUEjECGte.vGcak2zFXn9yHIm3JKCxK';

    beforeEach(() => {
      DI.get(Configuration)!.set('authn.local.import.formats', ['bcrypt']);
    });

    it("is imported after the insert as given, with the 'created' mail and no invite", async () => {
      await create({ Email: 'migrated@spinajs.pl', Login: 'migrated', PasswordHash: { hash: BCRYPT, format: 'bcrypt' } });

      const user = await User.query().whereLogin('migrated').populate('Metadata').firstOrFail();
      expect(user.Password).to.eq(BCRYPT);
      expect(user.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING]).to.not.be.ok;
      expect(passwordCalls).to.deep.eq([]);
      expect(emit.args.map((a) => a[0]).filter((e) => e instanceof EmailSend)).to.have.lengthOf(1);
    });

    it('that the importer refuses refuses the create before anything is written', async () => {
      const err = await rejection(create({ Email: 'refusedhash@spinajs.pl', Login: 'refusedhash', PasswordHash: { hash: BCRYPT, format: 'scrypt' } }));

      expect(err).to.be.instanceOf(InvalidArgument);
      expect((err as InvalidArgument).fieldName).to.eq('passwordHash');
      expect((err as InvalidArgument).errorCode).to.eq('E_PASSWORD_HASH_REFUSED');
      await nothingWritten('refusedhash');
    });

    it('together with a password is refused before anything is written', async () => {
      const err = await rejection(create({ Email: 'both@spinajs.pl', Login: 'both', Password: 'passw0rd123', PasswordHash: { hash: BCRYPT, format: 'bcrypt' } }));

      expect((err as InvalidArgument).errorCode).to.eq('E_PASSWORD_AND_HASH');
      await nothingWritten('both');
    });
  });
```

In `shipped-config.test.ts`, replace the deep-equal list (lines 164-168) with:

```ts
      expect(adapter.permissions!()).to.deep.eq([
        { name: 'user:read', resource: 'user', action: 'read', types: ['user'], fields: true },
        { name: 'user:update', resource: 'user', action: 'update', types: ['user'], fields: true },
        { name: 'user:impersonate', resource: 'user', action: 'impersonate', types: ['user'] },
        { name: 'user:password.import', resource: 'user', action: 'password.import', types: ['user'] },
      ]);
```

and add, in the test `'gives admin user:impersonate through the fragment ...'` right after `expect(await authz.can(admin, 'user:impersonate')).to.eq(true);`:

```ts
      expect(await authz.can(admin, 'user:password.import'), 'no shipped role grants it').to.eq(false);
```

In `authn-sinks.test.ts`, add one row to the "records event.at" table (lines 55-60):

```ts
      ['an import (password.import)', (r: IdentityRef) => event('password.import', r, { data: { format: 'bcrypt' } })],
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/users && npx ts-mocha -p tsconfig.json test/create.test.ts test/shipped-config.test.ts test/authn-sinks.test.ts`
Expected: FAIL.
- The first hash case: `migrated` gets the invite path (`passwordCalls` holds `invite`, `Password` is the no-password marker).
- The refused case: no error, the account is created.
- The adapter list misses `user:password.import`, and `authz.can(admin, 'user:password.import')` throws for an unknown permission.
- The sink row records `null`.

- [ ] **Step 3: Write minimal implementation**

`actions.ts`, imports (lines 23-24):

```ts
import { PasswordHashImporter, PasswordService, SessionIssuer, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, ImportedPasswordHash, PrincipalRef } from '@spinajs/authn/contracts';
```

In `ICreateUserData`, after `Password?: string;` (line 458):

```ts

  /**
   * A password hash from another system, for a migration: stored through `PasswordHashImporter` (authn-local) and replaced by an
   * argon2id hash on the first login. Not together with `Password`; the account gets the 'created' mail, no invite.
   */
  PasswordHash?: ImportedPasswordHash;
```

After `passwordService()` (line 620) add:

```ts
async function passwordHashImporter(): Promise<PasswordHashImporter> {
  if (!DI.RootContainer.hasRegistered(PasswordHashImporter)) {
    throw new InvalidOption('users: create() needs a PasswordHashImporter (register @spinajs/authn-local) to import a password hash');
  }

  return (await DI.resolve(PasswordHashImporter)) as PasswordHashImporter;
}
```

In `createUser`, after `const password = ...` (line 660) add:

```ts
  const passwordHash = data.PasswordHash;
  if (password !== undefined && passwordHash !== undefined) {
    throw new InvalidArgument('Give a password or a password hash, not both', 'passwordHash', 'E_PASSWORD_AND_HASH');
  }
```

After the password check (after line 669) add:

```ts
  const importer = passwordHash !== undefined ? await passwordHashImporter() : undefined;
  const refusal = importer && passwordHash ? importer.check(passwordHash) : null;
  if (refusal !== null) {
    throw new InvalidArgument(`Password hash refused: ${refusal}`, 'passwordHash', 'E_PASSWORD_HASH_REFUSED');
  }
```

In the first `try` block, replace the `if (password !== undefined) { ... } else { ... }` (lines 700-708) with:

```ts
    if (password !== undefined) {
      const set = await passwords.set(ref, password, ctx, { actor: by });
      if (set.status !== 'set') {
        throw new InvalidArgument('Password does not meet requirements', 'password', 'E_PASSWORD_DOES_NOT_MEET_REQUIREMENTS');
      }
    } else if (importer && passwordHash) {
      const imported = await importer.import(ref, passwordHash, ctx, { actor: by });
      if (imported.status !== 'imported') {
        throw new InvalidArgument(`Password hash refused: ${imported.reason}`, 'passwordHash', 'E_PASSWORD_HASH_REFUSED');
      }
    } else {
      // Before the invite: the marker is what lets the redeem activate this still-inactive account.
      u.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING] = true;
      await u.Metadata.update();
    }
```

In the second `try` block, replace `if (password === undefined) {` (line 732) with:

```ts
    if (password === undefined && passwordHash === undefined) {
```

and the `resendInvite` line (line 740) with:

```ts
    const resendInvite = password === undefined && passwordHash === undefined && !invited;
```

`user-resource-adapter.ts`: after `const USER = 'user';` (line 8) add:

```ts

/** Lets an admin route store a foreign password hash (whose plaintext the caller may know); no shipped role grants it. */
export const PASSWORD_IMPORT_PERMISSION = 'user:password.import';
```

and replace `permissions()` (lines 31-38) with:

```ts
  /** The `user` permissions users' shipped roles name, and the password import one no shipped role grants. */
  public permissions(): readonly Omit<PermissionDef, 'source'>[] {
    return [
      { name: 'user:read', resource: USER, action: 'read', types: [USER], fields: true },
      { name: 'user:update', resource: USER, action: 'update', types: [USER], fields: true },
      { name: 'user:impersonate', resource: USER, action: 'impersonate', types: [USER] },
      { name: PASSWORD_IMPORT_PERMISSION, resource: USER, action: 'password.import', types: [USER] },
    ];
  }
```

`account-sink.ts:35`:

```ts
    const setsPassword = (e.type === 'password.change' && e.data?.expired !== true) || e.type === 'password.reset' || e.type === 'invite.redeem' || e.type === 'password.import';
```

and add `password.import` to the class doc list (line 16): `` `password.change` (a change, or an admin `set`) without `data.expired`, `password.reset`, `invite.redeem`, `password.import`. ``

- [ ] **Step 4: Run tests to verify they pass, then rebuild**

Run: `cd packages/users && npx ts-mocha -p tsconfig.json test/create.test.ts test/shipped-config.test.ts test/authn-sinks.test.ts`
Expected: PASS, 0 failing.

Run: `cd packages/users && npm test && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`
Expected: PASS, 0 failing; no compiler output.

- [ ] **Step 5: Commit**

```bash
git add packages/users/src/actions.ts packages/users/src/user-resource-adapter.ts packages/users/src/identity/account-sink.ts packages/users/test/create.test.ts packages/users/test/shipped-config.test.ts packages/users/test/authn-sinks.test.ts
git commit -m "feat(users): create imports a password hash, and the user:password.import permission"
```

---

### Task 7: The admin `POST /users` takes a `PasswordHash`, gated by `user:password.import`

**Files:**
- Modify: `packages/users-http/src/admin/controllers/Users/Users.ts:1-12` (imports), `:89-115` (`CreateUserDto`), `:452-485` (doc and `addUser`), a new protected method after `addUser`
- Modify: `packages/users-http/test/admin-common.ts:19-30` (`TEST_ROLES`)
- Test: `packages/users-http/test/users-controller.test.ts` (imports; a new describe after `describe('Users.addUser')`), `packages/users-http/test/route-contract.test.ts` (one `it` in `describe('body schemas')`)

**Interfaces:**
- Consumes: `create({ PasswordHash })`, `PASSWORD_IMPORT_PERMISSION`, `ICreateUserData` (Task 6); `AuthzService.check` (`packages/authz/src/contracts/service.ts:15`).
- Produces: `CreateUserDto.PasswordHash?: ICreateUserData['PasswordHash']`; `protected assertMayImportPasswordHash(actor: Principal): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

In `admin-common.ts`, add a role to `TEST_ROLES`, after `'role-manager'`:

```ts
  // May import password hashes; holds nothing else.
  'password-importer': { grants: ['user:password.import'] },
```

In `users-controller.test.ts`, add the imports:

```ts
import { Forbidden, InvalidArgument } from '@spinajs/exceptions';
import { seedRoles } from './support/authz-host.js';
import { passwordCalls, resetPasswordCalls } from './support/password-service.js';
```

(`globalRolesOf` stays in the existing `./support/authz-host.js` import, so put `seedRoles` into that same line.) Add after `describe('Users.addUser', ...)`:

```ts
  describe('Users.addUser with a password hash', () => {
    const BCRYPT = '$2b$04$abcdefghijklmnopqrstuuUUEjECGte.vGcak2zFXn9yHIm3JKCxK';
    const body = (format = 'bcrypt') => ({ Login: 'hashed', Email: 'hashed@spinajs.pl', Role: 'user', PasswordHash: { hash: BCRYPT, format } }) as any;

    beforeEach(() => {
      DI.get(Configuration)!.set('authn.local.import.formats', ['bcrypt']);
      resetPasswordCalls();
    });

    it('refuses a caller without user:password.import, before anything is written', async () => {
      await expect(usersController.addUser(await admin(), body())).to.be.rejectedWith(Forbidden);

      expect(await User.query().whereLogin('hashed').first()).to.not.exist;
    });

    it('imports the hash for a caller holding user:password.import and sends no invite', async () => {
      await seedRoles(ADMIN_UUID, ['password-importer']);

      await usersController.addUser(await admin(), body());

      const created = await User.query().whereLogin('hashed').firstOrFail();
      expect(created.Password).to.eq(BCRYPT);
      expect(passwordCalls.filter((c) => c.method === 'invite')).to.deep.eq([]);
    });

    it('answers 400 for a hash the importer refuses', async () => {
      await seedRoles(ADMIN_UUID, ['password-importer']);

      await expect(usersController.addUser(await admin(), body('scrypt'))).to.be.rejectedWith(InvalidArgument);
      expect(await User.query().whereLogin('hashed').first()).to.not.exist;
    });
  });
```

In `route-contract.test.ts`, inside `describe('body schemas')`:

```ts
    it('takes an optional PasswordHash of a known format, and nothing else in it', () => {
      const base = { Login: 'newbie', Email: 'newbie@spinajs.pl', Role: 'user' };
      const hash = '$2b$04$abcdefghijklmnopqrstuuUUEjECGte.vGcak2zFXn9yHIm3JKCxK';
      expect(() => validator.validate(new CreateUserDto({ ...base, PasswordHash: { hash, format: 'bcrypt' } }))).to.not.throw();
      expect(() => validator.validate(new CreateUserDto({ ...base, PasswordHash: { hash, format: 'md5' } } as any))).to.throw();
      expect(() => validator.validate(new CreateUserDto({ ...base, PasswordHash: { hash } } as any))).to.throw();
      expect(() => validator.validate(new CreateUserDto({ ...base, PasswordHash: { hash, format: 'bcrypt', extra: 1 } } as any))).to.throw();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/users-http && npx ts-mocha -p tsconfig.json test/users-controller.test.ts test/route-contract.test.ts`
Expected: FAIL.
- The first hash case resolves (an invite-only account is created) instead of rejecting.
- The import case stores the no-password marker.
- The schema case accepts `md5`, a missing format and an extra member.

- [ ] **Step 3: Write minimal implementation**

`Users.ts` imports, lines 1-12:

```ts
import { Autoinject, DI } from '@spinajs/di';
import { BaseController, BasePath, Body, Del, Get, Ok, Param, Patch, Policy, Post, Query } from '@spinajs/http';
import { Forbidden, InvalidArgument, ResourceDuplicated, ResourceNotFound } from '@spinajs/exceptions';
```

```ts
import { assertLoginNotReserved, assertUserUnique, create, deleteUser, ICreateUserData, PASSWORD_IMPORT_PERMISSION, updateUser, User, UserAlreadyExists, UserCreatedIncomplete, userModel } from '@spinajs/users';
```

```ts
import { AuthzService, GLOBAL } from '@spinajs/authz';
import type { AuthzCommand, Principal } from '@spinajs/authz';
```

In the `CreateUserDto` schema `properties` (after `Metadata`, line 101) add:

```ts
    PasswordHash: {
      type: 'object',
      description: 'A password hash from another system, for a migration (needs user:password.import); the account then gets no invite',
      properties: {
        hash: { type: 'string', minLength: 1, maxLength: 512 },
        format: { type: 'string', enum: ['argon2', 'bcrypt', 'pbkdf2', 'scrypt'] },
      },
      required: ['hash', 'format'],
      additionalProperties: false,
    },
```

and to the class, after `public Metadata?`:

```ts
  public PasswordHash?: ICreateUserData['PasswordHash'];
```

In the `addUser` doc comment, add after the line about `Incomplete: { resendInvite }`:

```ts
   * With `PasswordHash` (caller needs `user:password.import` at GLOBAL) the account gets that hash instead of an invite.
```

and add `@response 403 ... or user:password.import missing for a PasswordHash` to the 403 line. Replace the start of `addUser` (lines 469-474) with:

```ts
  public async addUser(@CurrentUser() actor: User, @Body() data: CreateUserDto) {
    const by = await actorPrincipal(actor);
    const roles = roleList(data.Role);
    if (data.PasswordHash !== undefined) {
      await this.assertMayImportPasswordHash(by);
    }

    try {
      const { User: created } = await this.asDuplicateResponse(() =>
        asHttpRefusal(() => create({ Email: data.Email, Login: data.Login, Metadata: data.Metadata, ...(data.PasswordHash ? { PasswordHash: data.PasswordHash } : {}) }, roles, by)),
      );
```

(the rest of the method is unchanged). After `addUser` add:

```ts
  /** `user:password.import` at GLOBAL without a residual; no shipped role grants it. */
  protected async assertMayImportPasswordHash(actor: Principal): Promise<void> {
    const authz = (await DI.resolve(AuthzService)) as AuthzService;
    const decision = await authz.check({ principal: actor, permission: PASSWORD_IMPORT_PERMISSION, resource: GLOBAL });
    if (!decision.allowed || decision.residual.op !== 'true') {
      throw new Forbidden(`Importing a password hash needs ${PASSWORD_IMPORT_PERMISSION}`);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/users-http && npx ts-mocha -p tsconfig.json test/users-controller.test.ts test/route-contract.test.ts`
Expected: PASS, 0 failing.

Run: `cd packages/users-http && npm test`
Expected: PASS, 0 failing. A suite that enumerates `TEST_ROLES` (for example the admin-roles listing) must now see `password-importer` too. Adjust that expectation, not the role.

- [ ] **Step 5: Commit**

```bash
git add packages/users-http/src/admin/controllers/Users/Users.ts packages/users-http/test/admin-common.ts packages/users-http/test/users-controller.test.ts packages/users-http/test/route-contract.test.ts
git commit -m "feat(users-http): admin create takes a PasswordHash, gated by user:password.import"
```

Add any test file adjusted in Step 4 to the same `git add`.

---

### Task 8: Behaviour rule A34

**Files:**
- Create: `packages/authn-testing/src/behaviour/A34-legacy-hash-login.spec.ts`
- Modify: `packages/authn-testing/src/behaviour/types.ts:8`, `src/behaviour/index.ts:30`, `:40`, `src/harness/config.ts:29-35`
- Modify: `packages/authn-local/test/kit-harness.ts:30-42` (`SUPPORTED`), `packages/authn-local/test/kit.test.ts:8`, `:17`

**Interfaces:**
- Consumes: ports `service`, `seed`, `passwordStore`; `ALICE`, `WRONG`, `auth`, `expectFailure`, `expectSuccess`, `pw` (`steps.ts`); the legacy login of Task 3.
- Produces: rule `A34`, facet `A34/local`; `ConfigOverrides.authn.local.import.formats`; `ALICE_BCRYPT`.

- [ ] **Step 1: Write the failing test**

Create `packages/authn-testing/src/behaviour/A34-legacy-hash-login.spec.ts`:

```ts
import assert from 'node:assert/strict';
import { ALICE, WRONG, auth, expectFailure, expectSuccess, pw } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule } from './types.js';

/** bcrypt, cost 4, of ALICE.password, as another system stored it. */
export const ALICE_BCRYPT = '$2b$04$abcdefghijklmnopqrstuuCqdtRnvKJAr6sR/GVFRVkoLaoQHy0RC';

const BCRYPT_ALLOWED = { authn: { local: { import: { formats: ['bcrypt'] } } } };

export const A34: AuthnRule = defineRule('A34', 'an imported legacy hash verifies until the first login, which replaces it by the current hash', [
  defineCase({
    name: 'A34 a login with an imported bcrypt hash succeeds and stores an argon2id hash over it',
    facet: 'A34/local',
    needs: ['service', 'seed', 'passwordStore'],
    config: BCRYPT_ALLOWED,
    async run(h, k) {
      const a = await h.seed.user({ login: ALICE.login });
      await h.passwordStore.set(a, ALICE_BCRYPT);
      expectSuccess(await auth(h, k, pw(ALICE.login, ALICE.password)));
      const stored = await h.passwordStore.get(a);
      assert.ok(stored !== null && stored !== ALICE_BCRYPT && stored.includes('$argon2id$'), `stored ${stored}`);
      expectSuccess(await auth(h, k, pw(ALICE.login, ALICE.password)));
    },
  }),
  defineCase({
    name: 'A34 a wrong password against an imported hash fails and keeps the hash',
    facet: 'A34/local',
    needs: ['service', 'seed', 'passwordStore'],
    config: BCRYPT_ALLOWED,
    async run(h, k) {
      const a = await h.seed.user({ login: ALICE.login });
      await h.passwordStore.set(a, ALICE_BCRYPT);
      expectFailure(await auth(h, k, pw(ALICE.login, WRONG)), 'invalid_credentials');
      assert.strictEqual(await h.passwordStore.get(a), ALICE_BCRYPT);
    },
  }),
  defineCase({
    name: 'A34 a legacy hash of a format not allowed never verifies',
    facet: 'A34/local',
    needs: ['service', 'seed', 'passwordStore'],
    async run(h, k) {
      const a = await h.seed.user({ login: ALICE.login });
      await h.passwordStore.set(a, ALICE_BCRYPT);
      expectFailure(await auth(h, k, pw(ALICE.login, ALICE.password)), 'invalid_credentials');
      assert.strictEqual(await h.passwordStore.get(a), ALICE_BCRYPT);
    },
  }),
]);
```

In `packages/authn-local/test/kit.test.ts`, add `'A34/local'` to `N3_FACETS` (line 8) and `'A34'` to the `runAuthnBehaviour` list (line 17).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authn-testing && npx tsc -b tsconfig.mjs.json`
Expected: FAIL with `Argument of type '"A34"' is not assignable to parameter of type 'RuleId'`, and `'import' does not exist in type` for `BCRYPT_ALLOWED` against `ConfigOverrides`.

- [ ] **Step 3: Write minimal implementation**

`types.ts:8`: append `'A34'` to `RULE_IDS`, after `'A32'` (and after `'A33'` if plan 02 has landed).

`behaviour/index.ts`: add `import { A34 } from './A34-legacy-hash-login.spec.js';` after the A32 import (line 30), and append `A34` to `ALL` (line 40).

`harness/config.ts`, in `ConfigOverrides.authn.local` (lines 29-35), add after `invite`:

```ts
      import: { formats: readonly ('argon2' | 'bcrypt' | 'pbkdf2' | 'scrypt')[] };
```

`packages/authn-local/test/kit-harness.ts`, add to `SUPPORTED` (lines 30-42), after `'authn.local.invite.ttlSeconds'`:

```ts
  'authn.local.import.formats',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/authn-testing && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npm test`
Expected: no compiler output; PASS, 0 failing.

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/kit.test.ts`
Expected: PASS, 0 failing; 3 passing A34 cases, none pending.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-testing/src/behaviour/A34-legacy-hash-login.spec.ts packages/authn-testing/src/behaviour/types.ts packages/authn-testing/src/behaviour/index.ts packages/authn-testing/src/harness/config.ts packages/authn-local/test/kit-harness.ts packages/authn-local/test/kit.test.ts
git commit -m "test(authn-testing): A34, an imported legacy hash is replaced at the first login"
```

---

## Self-review

- **Spec coverage:**
  - Formats bcrypt (`$2a/$2b/$2y`), PHC scrypt, PBKDF2 (PHC and Django), argon2 (already native, import validation only): Task 2. Firebase, MD5 and SHA-1 are out with a reason (Decision 1).
  - `LegacyHashVerifier` registry keyed by prefix: Task 2. Rehash to argon2id plus pepper via the existing CAS: Task 3, relying on `needsRehash` (`hasher.ts:122-133`) and `strategy.ts:113-123`.
  - Never peppered, timing equalisation, the 72-byte note, and the bcryptjs choice: Decisions 3, 4 and 7, Security notes, Task 3.
  - CLI JSONL: Task 5. Admin route option with a permission: Tasks 6-7. Audit `password.import`: Tasks 1 and 4.
  - `authn.local.import.formats`, and refusing unknown or malformed hashes and out-of-range costs at import: Tasks 1, 2 and 4.
  - The optional legacy count is out (Decision 11). A-series: Task 8.
- **Placeholder scan:** none. The only conditional instruction is the A33/A34 ordering in `RULE_IDS`, which is fully specified.
- **Type consistency:**
  - `PasswordHashFormat`, `ImportedPasswordHash` and `PasswordImportRefusal` come from Task 1 and are used in Tasks 2-7.
  - `LegacyHashRegistry.detect` returns `LegacyHashVerifier | null` (Task 2) and is used in Tasks 3-4.
  - `importFormats` is the hasher option in Task 3. `authn.local.import.formats` is read by both the hasher and the importer.
  - The `PASSWORD_IMPORT_PERMISSION` string is the same in Tasks 6 and 7.
