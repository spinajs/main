# Breached-password and similarity checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A password that appears in the HaveIBeenPwned corpus is refused as `breached`, and a password that contains or resembles the login, the email local part or the name of its identity is refused as `similar`, wherever a password is set.

**Architecture:** `HibpPasswordBlocklist` is a new `PasswordBlocklist` (the existing hook, `packages/authn-local/src/policy.ts:28`) that asks the k-anonymity range API for the 5-hex SHA-1 prefix and compares the suffix in-process. A blocklist now names the violation it reports, so this one reports `breached`. The similarity check is a pure function (`similarity.ts`) that `LocalPasswordPolicy` runs when `check` gets an optional `PasswordCheckContext { identifiers }`. `LocalPasswordService` and `users.create()` pass the identifiers they can know without leaking them.

**Tech Stack:** TypeScript (ESM + CJS builds), Node global `fetch` and `AbortSignal.timeout`, `node:crypto` SHA-1, mocha + chai via ts-mocha, `node:http` for a local test server. No new dependency.

## Global Constraints

- Code comments, identifiers and commit messages are in English. Comment only what the code cannot say.
- Work on branch `authz-v3-refactor`, one commit per task, and run the package suites before each commit.
- Every test command runs from the package directory: `npx ts-mocha -p tsconfig.json <file>`. A package's full suite is `npm test`.
- A package that consumes a changed package reads it from `lib/`. Rebuild before testing dependents: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json` in the changed package.
- Working-copy files use CRLF. Keep them CRLF.
- A value check moves into the module's JSON schema (`AUTHN_CONFIGURATION_SCHEMA`). Code keeps only checks a schema cannot make (DI lookups, compiling, cross-domain merges, and here the env-dependent https rule).
- Defaults go into the schema (`default`, applied by `useDefaults`), and the `@Config` `defaultValue` repeats the same value: authn-local's tests build instances without the schema.
- Never add a schema default that loosens an effective security value (`.superpowers/sdd/mechanism-notes.md`).
- Secrets are secret references, never inline values. This plan adds no secret.
- Each new behaviour rule gets a row in `packages/authn-testing`, continuing the A-series. This plan takes **A33**.
- HTTP work targets the 3.0 layer. This plan changes no route.
- Never log, audit or put into an error message the password, its SHA-1 or the 5-hex prefix.

---

## Current state

- `PasswordBlocklist` is an abstract class with one method, `isBlocked(password): Promise<boolean>` (`packages/authn-local/src/policy.ts:27-30`). `LocalPasswordPolicy` finds it by class name from `authn.local.policy.blocklist` (`policy.ts:95-96`, `204-221`) and resolves it lazily on the first `check` (`187-202`). A hit always pushes `'blocklisted'` (`policy.ts:120-123`).
- `LocalPasswordPolicy.check(password)` (`policy.ts:114-125`): hard cap, then length and rule (`checkSync`, `169-185`), then the blocklist. `Options` given to the constructor means the configuration is never read (`policy.ts:102-105`).
- `PasswordViolation = 'too_short' | 'too_long' | 'rule' | 'blocklisted'` and `PasswordService.check(password)` (`packages/authn/src/contracts/password.ts:16`, `86-87`).
- `LocalPasswordService` calls `policyComponent().check(newPassword)` in `change` (`packages/authn-local/src/service.ts:112`), `set` (`164`), `check` (`177-179`) and `redeemReset` (`209`). An invite is redeemed through `redeemReset` (`purpose: 'invite'`, `service.ts:224-247`): there is no separate invite-redeem method.
- `IdentityStore.display(id)` answers `{ email?, name? }` (`packages/authn/src/contracts/identity.ts:17`). The users implementation answers `name: u.Login` (`packages/users/src/identity/identity-store.ts:59-65`), so the login is knowable from `display`.
- `users.create()` checks a supplied password with `passwords.check(password)` before any write (`packages/users/src/actions.ts:666-669`).
- The `authn.local.policy` schema has `minLength`, `maxLength`, `rule`, `blocklist` (`packages/authn/src/schemas/authn.configuration.ts:126-134`). authn-local has no schema of its own.
- authn-local has no HTTP client. authn-oidc has one (`packages/authn-oidc/src/http/client.ts:32-103`: global fetch, https-only outside dev/test, `redirect: 'manual'`, `AbortSignal.timeout`, a body cap); this plan copies that pattern and does not import authn-oidc.
- `@spinajs/authn/env` exports `authnAppEnv` and `isLenientAuthnEnv` (`packages/authn/package.json` `exports["./env"]`, `packages/authn/src/service/boot/env.ts:27-36`).
- `engines.node` of authn-local is `>=16.11` (`packages/authn-local/package.json:21`); global `fetch` needs Node 18. The workspace runs Node v24.14.1; `@types/node` is 22.20.0; the root `tsconfig.json` has `lib: ["esnext", "dom"]`, so `fetch`, `Response` and `RequestInit` are typed.

## Decisions (confirm before Task 1)

1. **HIBP is a `PasswordBlocklist`.** It is selected by the existing key: `authn.local.policy.blocklist: 'HibpPasswordBlocklist'`. Its own keys live under `authn.local.policy.hibp`. Reason: the hook already exists, and an app keeps one switch.
2. **A blocklist names its violation.** `PasswordBlocklist.violation` defaults to `'blocklisted'`, and `HibpPasswordBlocklist` sets `'breached'`. Reason: "seen in a breach" is a different message to the user than "not allowed here".
3. **`onError` defaults to `'allow'` (fail open).** If the range lookup fails (transport error, timeout, non-200, redirect or malformed answer), each failure is logged as a warning naming only the error class, and the password is not blocked. With `'deny'`, `isBlocked` throws `IOFail`, which becomes a 500. It never answers a fake `breached`. Reason: an outage at a third party must not stop every password reset and change, because that would lock users out of account recovery. The breach check is defence in depth on top of the length and similarity rules.
4. **Defaults:** `maxBreaches: 0` (any non-padding hit is refused), `timeoutMs: 1500`, `cacheSize: 64` prefixes, `cacheTtlSeconds: 3600`, `baseUrl: 'https://api.pwnedpasswords.com/range/'`, and `Add-Padding: true` always. Padding entries have count 0, so they never count as hits.
5. **Self-hosted mirror:** `baseUrl` is any URL that ends in `/`, and the prefix is appended to it. `http:` is allowed only when `isLenientAuthnEnv(authnAppEnv(config))` is true, which is the same rule as authn-oidc. The code checks this rule on first use, because the schema cannot know the env. A bad `baseUrl` throws `InvalidOption` whatever `onError` says. Redirects are never followed.
6. **The HTTP client is the global `fetch` with an `Options.fetch` seam for tests.** authn-local's `engines.node` goes to `>=18.17`. Reason: there is no shared HTTP abstraction outside authn-oidc, and a 30-line client does not justify a new package.
7. **Similarity rule** (`isSimilar` in `packages/authn-local/src/similarity.ts`). Identifiers and password are folded with NFKC and lower case. Look-alike characters are also folded (`0→o 1→i 3→e 4→a 5→s 7→t @→a $→s !→i`). From each identifier the candidates are: the whole identifier (an email is cut to its local part), the identifier without separators, and each word. Candidates shorter than `minOverlap` (default 4) are ignored. A password is `similar` when any of these holds:
   - it contains a candidate,
   - it lies inside one,
   - its edit distance to a candidate is at most a quarter of the longer of the two strings.

   Reason: this catches `Alice2026!`, `@l1ce-Spring` and `margarette` for `margaretta`. It ignores `bob`, so 3-letter names do not refuse half of the dictionary. The email domain is never a candidate, because it identifies nobody.
8. **Similarity is on by default** (`authn.local.policy.similarity.enabled: true`). This tightens policy on purpose, and it never loosens anything. Existing stored passwords keep working, because similarity applies only where a password is set.
9. **Backward-compatible contract:** `check(password, context?: PasswordCheckContext)`. An implementation that declares only `check(password)` still compiles, and `users`' and `users-http`' test doubles do.
10. **Where the identifiers come from, without leaking them:**
    - `set`: `display(id)` (email and name; users' name is the login). The caller is an admin, the CLI or `users.create()`.
    - `change`: `display(id)`, checked only after the session is validated and an impersonator is refused. A caller with another identity's session gets `invalid`, never `similar`. The top-of-method policy check stays context-free.
    - `redeemReset`, including the invite redeem: only the `login` as typed, before the secret. Reading `display` there would let someone without the secret probe the account's email or name. The contract also says the policy check comes before the secret and does not use it up. A name that differs from the typed login is not compared on this path. Task 4 has a test for that limit.
    - `users.create()`: `[Login, Email]`.
    - The deprecated `changeUserPassword` (`actions.ts:973-1001`) is unchanged.
11. **Message IDs** for `breached` and `similar` (range 4001000–4001999) depend on plan 03. Until 03 lands, the violation `kind` strings are the stable API. If 03 lands first, its owner adds two catalogue rows. If this plan lands first, 03 numbers all six kinds.
12. **Rule id A33** for the behaviour rule.

## Security notes

- k-anonymity: only the first 5 hex digits of the SHA-1 leave the process. Padding hides the answer size. The suffix comparison happens in memory.
- Nothing logs the password, the SHA-1 or the prefix. A failed lookup logs only `err.name`, because a fetch error message carries the URL, and the URL carries the prefix. Tests assert this.
- The cache holds prefix → suffix counts, which are public data. It is bounded (LRU, `cacheSize`) and expires (`cacheTtlSeconds`).
- Fail open is a deliberate availability choice (Decision 3). An app that needs fail closed sets `onError: 'deny'`.
- Similarity is judged only against identifiers the caller already knows, or that belong to the caller's own validated session (Decision 10), so `similar` is never an oracle.
- `generate()` still skips the blocklist (it is synchronous); a generated 16-character random password is not in a breach corpus in practice.

## Facts verified (2026-10-06)

- `packages/authn-local/src/policy.ts`: imports 1-7; `PasswordBlocklist` 27-30; `LocalPasswordPolicyOptions` 38-46; `PolicySettings` 48-54; `@Config` fields 77-96; `check` 114-125; `checkSync` 169-185; `blocklist()` 187-202; `settings` 223-227; `buildSettings` 229-269.
- `packages/authn-local/src/service.ts`: `change` 111-160 (policy check 112-116, impersonator refusal 128-132, throttle 134-140); `set` 163-175; `check` 177-179; `redeemReset` 202-248 (policy check 209-212); `identities()` 383-385.
- `packages/authn/src/contracts/password.ts`: `PasswordViolation` 15-16; `check` 86-87. `packages/authn/test/contracts/password.test.ts`: `MemoryPasswords.check` 63-69; shape row for `check` 158; union assertion 169-171; doc assertions 173-198 (`check` doc must keep `A04`; `PasswordViolation` doc must keep `says nothing about the account`).
- `packages/authn/src/schemas/authn.configuration.ts`: `local.policy` 126-134. `packages/authn/test/boot/config-defaults.test.ts`: `check()` helper 30-34 (app Ajv options, `instancePath` list).
- `packages/authn-local/test/policy.test.ts`: `ListBlocklist` 11-20, `policy()` 22-26, `policyConfiguration()` 263-278, config wiring describe 280-365. `test/service.test.ts`: `setup()` 52-83 (alice has only a login), `verifies` 126-128, `facts` 21. `test/reset.test.ts`: `setup()` 66-98 (alice: `login = email = 'alice@example.com'`, `name: 'Alice'`), `requestAndTake` 114-120, the "policy violation ... leaves the secret usable" test 316-321.
- `packages/authn-testing/src/fakes/identity.ts:79-85`: `FakeIdentityStore.display` answers `email` and `name` only when they were given to `add`.
- `packages/authn-testing/src/behaviour/types.ts:8` (`RULE_IDS`), `behaviour/index.ts:30` and `40` (`ALL`), `behaviour/steps.ts:17` (`ALICE = { login: 'alice@example.test', password: 'Alice-Pass-1234' }`), `:23` (`NEW_PW`). `packages/authn-local/test/kit.test.ts:8` (`N3_FACETS`) and `:17` (rule list). Kit seeds hash directly (`kit-harness.ts:346-351`), so a seeded `ALICE.password` is never policy-checked.
- `packages/users/src/actions.ts:655-669` (`createUser`, the check at 667); `packages/users/test/support/password-service.ts` (`TestPasswordService.check`, `resetPasswordCalls`); `packages/users/test/create.test.ts:120-127` (the "is checked, then set" test).
- `@spinajs/exceptions` exports `IOFail` and `InvalidOption` (`packages/exceptions/src/index.ts:38`, `64`).
- `sha1('Breached-Pass-1') = DC50E5788A246D7CEC3BEBEFAE065227F1B8F874` (computed with Node).

## File structure

| File | Responsibility |
|---|---|
| `packages/authn/src/contracts/password.ts` (modify) | `PasswordCheckContext`, `check(password, context?)`, violations `breached` and `similar` |
| `packages/authn/src/schemas/authn.configuration.ts` (modify) | `authn.local.policy.similarity` and `authn.local.policy.hibp` |
| `packages/authn-local/src/similarity.ts` (create) | `similarityCandidates`, `editDistance`, `isSimilar`: pure functions |
| `packages/authn-local/src/policy.ts` (modify) | `PasswordBlocklist.violation`, `similarTo`, `check(password, context?)` |
| `packages/authn-local/src/lru.ts` (create) | `LruCache<V>`: a size- and TTL-bounded map |
| `packages/authn-local/src/hibp.ts` (create) | `HibpPasswordBlocklist`, `parseRange` |
| `packages/authn-local/src/service.ts` (modify) | passes identifiers in `change`, `set`, `redeemReset`, `check` |
| `packages/authn-local/src/index.ts`, `package.json` (modify) | exports; `engines.node >=18.17` |
| `packages/users/src/actions.ts` (modify) | `create()` passes `[Login, Email]` |
| `packages/authn-testing/src/behaviour/A33-password-similarity.spec.ts` (create) | rule A33 |

Task order: 1 → 2 → 3 → 4 → 5, then 6 (needs 3), then 7 (needs 4).

---

### Task 1: The contract takes a check context and two new violations

**Files:**
- Modify: `packages/authn/src/contracts/password.ts:15-16`, `:86-87`
- Test: `packages/authn/test/contracts/password.test.ts:4-5`, `:63-69`, `:158`, `:169-171`, plus a new `it` in `describe('runtime')`

**Interfaces:**
- Consumes: nothing.
- Produces (from `@spinajs/authn/contracts`):
  - `type PasswordViolation = 'too_short' | 'too_long' | 'rule' | 'blocklisted' | 'breached' | 'similar'`
  - `interface PasswordCheckContext { readonly identifiers: readonly string[] }`
  - `PasswordService.check(password: string, context?: PasswordCheckContext): Promise<readonly PasswordViolation[]>`

- [ ] **Step 1: Write the failing test**

In `password.test.ts`, add `PasswordCheckContext` to the type import on line 5:

```ts
import type { PasswordChangeResult, PasswordCheckContext, PasswordExpiry, PasswordPolicy, PasswordRefusal, PasswordResetRequestResult, PasswordResetResult, PasswordSetResult, PasswordViolation } from '../../src/contracts/password.js';
```

Replace `MemoryPasswords.check` (lines 63-69) with:

```ts
  async check(password: string, context?: PasswordCheckContext): Promise<readonly PasswordViolation[]> {
    const out: PasswordViolation[] = [];
    if (password.length < 8) out.push('too_short');
    if (password.length > 128) out.push('too_long');
    if (context?.identifiers.some((i) => password.toLowerCase().includes(i.toLowerCase()))) out.push('similar');
    if (password === 'password1') out.push('blocklisted');
    return out;
  }
```

Add to `describe('runtime')`, after the `'policy, check, set and expire'` test:

```ts
    it('check takes an optional context of identifiers', async () => {
      const p = new MemoryPasswords();
      expect(await p.check('alice-spring-26', { identifiers: ['alice'] })).to.deep.eq(['similar']);
      expect(await p.check('alice-spring-26')).to.deep.eq([]);
    });
```

Change the `check` row of the source-shape test (line 158) to:

```ts
            { name: 'check', modifiers: ['abstract'], optional: false, params: ['password', 'context'] },
```

Replace the union assertion (lines 169-171) with:

```ts
    it('PasswordViolation lists its codes in order', () => {
      expect(unionLiterals('password.ts', 'PasswordViolation')).to.deep.eq(['too_short', 'too_long', 'rule', 'blocklisted', 'breached', 'similar']);
    });

    it('PasswordCheckContext carries the identifiers a password must not resemble', () => {
      expect(Object.keys(memberDocs('password.ts', 'PasswordCheckContext'))).to.deep.eq(['identifiers']);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/password.test.ts`
Expected: FAIL. `PasswordViolation lists its codes in order` fails with a deep-equal diff (the 4 old codes against the 6 expected codes), the `check` shape row fails (`params: ['password']`), and `PasswordCheckContext carries ...` fails.

- [ ] **Step 3: Write minimal implementation**

In `password.ts` replace lines 15-16 with:

```ts
/** A policy violation says nothing about the account, so the caller may show it. 'similar' judges only identifiers the caller knows. */
export type PasswordViolation = 'too_short' | 'too_long' | 'rule' | 'blocklisted' | 'breached' | 'similar';

/** What `check` compares a password with besides the policy. */
export interface PasswordCheckContext {
  /** Login, email or name of the identity the password is for: the password must not contain or resemble them. */
  readonly identifiers: readonly string[];
}
```

Replace lines 86-87 with:

```ts
  /**
   * Length, rule, blocklist and, given `context`, similarity to the identity's identifiers, as every method that sets a password
   * applies them (A04); empty: acceptable. Lets users check before it creates an identity.
   */
  abstract check(password: string, context?: PasswordCheckContext): Promise<readonly PasswordViolation[]>;
```

- [ ] **Step 4: Run tests to verify they pass, then rebuild**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/password.test.ts`
Expected: PASS, 0 failing.

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json "test/contracts/*.test.ts"`
Expected: PASS, 0 failing. `boundary.test.ts` reads `lib/`, so run it once more after the rebuild.

Run: `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npx ts-mocha -p tsconfig.json test/contracts/boundary.test.ts`
Expected: no compiler output, then PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/authn/src/contracts/password.ts packages/authn/test/contracts/password.test.ts
git commit -m "feat(authn): password check context and the breached and similar violations"
```

---

### Task 2: The similarity function

**Files:**
- Create: `packages/authn-local/src/similarity.ts`
- Test: `packages/authn-local/test/similarity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `similarityCandidates(identifiers: readonly string[], minOverlap: number): string[]`
  - `editDistance(a: string, b: string): number`
  - `isSimilar(password: string, identifiers: readonly string[], minOverlap: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `packages/authn-local/test/similarity.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { editDistance, isSimilar, similarityCandidates } from '../src/similarity.js';

describe('password similarity', () => {
  describe('similarityCandidates', () => {
    it('cuts an email to its local part and adds it without separators and word by word', () => {
      expect(similarityCandidates(['John.Smith@Example.com'], 4)).to.deep.equal(['john.smith', 'johnsmith', 'john', 'smith']);
    });

    it('drops parts shorter than minOverlap and blank identifiers', () => {
      expect(similarityCandidates(['bob@example.com', '   ', 'Ann Lee'], 4)).to.deep.equal(['ann lee', 'annlee']);
      expect(similarityCandidates(['bob@example.com'], 3)).to.deep.equal(['bob']);
    });

    it('folds full-width and case with NFKC', () => {
      expect(similarityCandidates(['ＡＬＩＣＥ'], 4)).to.deep.equal(['alice']);
    });
  });

  describe('editDistance', () => {
    it('counts code points', () => {
      expect(editDistance('kitten', 'sitting')).to.equal(3);
      expect(editDistance('', 'abc')).to.equal(3);
      expect(editDistance('😀a', '😀b')).to.equal(1);
    });
  });

  describe('isSimilar', () => {
    for (const [password, identifiers, label] of [
      ['Alice-2026-Spring', ['alice@example.com'], 'holds the email local part, any case'],
      ['@l1ce-Spring-26', ['alice@example.com'], 'holds it in look-alike characters'],
      ['SmithFamily-9', ['John Smith'], 'holds one word of the name'],
      ['JohnSmith!', ['john.smith'], 'holds the login without its separator'],
      ['margarette', ['margaretta'], 'is one edit away from the login'],
      ['johnsmith', ['johnsmith1980'], 'lies inside the login'],
    ] as const) {
      it(`refuses a password that ${label}`, () => {
        expect(isSimilar(password, identifiers, 4)).to.equal(true);
      });
    }

    for (const [password, identifiers, label] of [
      ['Bob-Pass-2345x', ['bob@example.com'], 'holds only a part shorter than minOverlap'],
      ['Correct-Horse-9', ['alice@example.com', 'Alice'], 'shares nothing'],
      ['Example-Pass-77', ['alice@example.com'], 'holds only the email domain'],
      ['Unrelated-Pass-77', ['margaretta'], 'is many edits away'],
      ['Alice-2026-Spring', [], 'has no identifiers to compare'],
    ] as const) {
      it(`accepts a password that ${label}`, () => {
        expect(isSimilar(password, identifiers, 4)).to.equal(false);
      });
    }

    it('minOverlap decides how short a part still counts', () => {
      expect(isSimilar('Bob-Pass-2345x', ['bob@example.com'], 3)).to.equal(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/similarity.test.ts`
Expected: FAIL with `Cannot find module '.../src/similarity.js'` (ERR_MODULE_NOT_FOUND).

- [ ] **Step 3: Write minimal implementation**

Create `packages/authn-local/src/similarity.ts`:

```ts
/** Look-alike characters folded before comparing, so '@l1ce' meets 'alice'. */
const LOOK_ALIKE: Readonly<Record<string, string>> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };

/** Identifiers are a handful of short strings; this bounds the edit-distance work for a hostile caller. */
const MAX_CANDIDATES = 32;

const fold = (s: string): string => s.normalize('NFKC').toLowerCase();
const plain = (s: string): string => Array.from(s, (c) => LOOK_ALIKE[c] ?? c).join('');
const codePoints = (s: string): number => Array.from(s).length;

/**
 * The strings a password must not contain or resemble: each identifier (an email cut to its local part), the same without
 * separators, and each of its words; parts shorter than `minOverlap` code points are dropped.
 */
export function similarityCandidates(identifiers: readonly string[], minOverlap: number): string[] {
  const out = new Set<string>();
  for (const raw of identifiers) {
    if (typeof raw !== 'string') continue;
    const folded = fold(raw).trim();
    const at = folded.lastIndexOf('@');
    const base = at > 0 ? folded.slice(0, at) : folded;
    for (const candidate of [base, base.replace(/[^\p{L}\p{N}]+/gu, ''), ...base.split(/[^\p{L}\p{N}]+/u)]) {
      if (codePoints(candidate) >= minOverlap) out.add(candidate);
    }
  }
  return [...out].slice(0, MAX_CANDIDATES);
}

/** Levenshtein distance over code points. */
export function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    for (let j = 1; j <= y.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[y.length];
}

/**
 * True when the password, case and look-alike characters folded, contains a candidate, lies inside one, or is within a quarter of
 * the longer length in edits of one.
 */
export function isSimilar(password: string, identifiers: readonly string[], minOverlap: number): boolean {
  const candidates = similarityCandidates(identifiers, minOverlap);
  if (candidates.length === 0) {
    return false;
  }
  const folded = fold(password);
  const unmasked = plain(folded);
  return candidates.some((candidate) => {
    const target = plain(candidate);
    return (
      folded.includes(candidate) ||
      unmasked.includes(target) ||
      candidate.includes(folded) ||
      4 * editDistance(unmasked, target) <= Math.max(codePoints(unmasked), codePoints(target))
    );
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/similarity.test.ts`
Expected: PASS, 16 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-local/src/similarity.ts packages/authn-local/test/similarity.test.ts
git commit -m "feat(authn-local): a similarity check of a password against identifiers"
```

---

### Task 3: The policy judges similarity, and a blocklist names its violation

**Files:**
- Modify: `packages/authn-local/src/policy.ts:1-7` (imports), `:27-30` (`PasswordBlocklist`), `:38-54` (options, settings), `:77-96` (`@Config`), `:114-125` (`check`), `:223-269` (`settings`, `buildSettings`)
- Modify: `packages/authn/src/schemas/authn.configuration.ts:126-134` (`local.policy`)
- Test: `packages/authn-local/test/policy.test.ts` (a new `describe('similarity')` after the `blocklist` describe ending at line 160, and one `it` in the config wiring describe), `packages/authn/test/boot/config-defaults.test.ts` (a new `it`)

**Interfaces:**
- Consumes: `isSimilar` (Task 2); `PasswordCheckContext`, `PasswordViolation` (Task 1, from `@spinajs/authn/contracts`, rebuilt).
- Produces:
  - `PasswordBlocklist.violation: PasswordViolation` (default `'blocklisted'`)
  - `interface SimilarityConfig { readonly enabled: boolean; readonly minOverlap: number }`, `DEFAULT_SIMILARITY: SimilarityConfig`
  - `LocalPasswordPolicyOptions.similarity?: Partial<SimilarityConfig>`
  - `LocalPasswordPolicy.check(password: string, context?: PasswordCheckContext): Promise<PasswordViolation[]>`
  - `LocalPasswordPolicy.similarTo(password: string, identifiers: readonly string[]): boolean`
  - config keys `authn.local.policy.similarity.enabled` (default `true`), `authn.local.policy.similarity.minOverlap` (default `4`, 3–16)

- [ ] **Step 1: Write the failing tests**

In `policy.test.ts`, import `PasswordViolation` as a type:

```ts
import type { PasswordViolation } from '@spinajs/authn/contracts';
```

and add after the `blocklist` describe (after line 160):

```ts
  describe('similarity (A33)', () => {
    const ALICE = { identifiers: ['alice@example.com'] };

    it('with identifiers refuses a password resembling them, after the rule and before the blocklist', async () => {
      const p = policy({ rule: DIGIT_RULE, blocklist: new ListBlocklist(['Alice-Spring-x']) });
      expect(await p.check('Alice-Spring-x', ALICE)).to.deep.equal(['rule', 'similar', 'blocklisted']);
    });

    it('without a context similarity is not judged', async () => {
      expect(await policy().check('Alice-Spring-26')).to.deep.equal([]);
    });

    it('enabled false turns it off', async () => {
      expect(await policy({ similarity: { enabled: false } }).check('Alice-Spring-26', ALICE)).to.deep.equal([]);
    });

    it('minOverlap decides how short a part still counts', async () => {
      expect(await policy().check('Bob-Pass-2345x', { identifiers: ['bob@example.com'] })).to.deep.equal([]);
      expect(await policy({ similarity: { minOverlap: 3 } }).check('Bob-Pass-2345x', { identifiers: ['bob@example.com'] })).to.deep.equal(['similar']);
    });

    it('similarTo answers without running the blocklist', () => {
      const hook = new ListBlocklist([]);
      const p = policy({ blocklist: hook });
      expect(p.similarTo('Alice-Spring-26', ALICE.identifiers)).to.equal(true);
      expect(p.similarTo('Correct-Horse-9', ALICE.identifiers)).to.equal(false);
      expect(hook.calls).to.equal(0);
    });

    it('above the hard cap only too_long comes back, without the similarity work', async () => {
      expect(await policy().check('alice'.repeat(PASSWORD_HARD_CAP), ALICE)).to.deep.equal(['too_long']);
    });
  });

  describe('blocklist violation', () => {
    class BreachList extends ListBlocklist {
      public readonly violation: PasswordViolation = 'breached';
    }

    it('reports the violation its blocklist names', async () => {
      expect(await policy({ blocklist: new BreachList(['Pwned-Pass-1']) }).check('Pwned-Pass-1')).to.deep.equal(['breached']);
      expect(await policy({ blocklist: new ListBlocklist(['Pwned-Pass-1']) }).check('Pwned-Pass-1')).to.deep.equal(['blocklisted']);
    });
  });
```

In the config wiring describe, after `'with blocklist null nothing is blocklisted'`:

```ts
  it('reads authn.local.policy.similarity, on with minOverlap 4 when unset', async () => {
    const on = await boot({ policy: { blocklist: null } });
    expect(await on.check('Alice-Spring-26', { identifiers: ['alice@example.com'] })).to.deep.equal(['similar']);
    DI.uncache(LocalPasswordPolicy);
    DI.unregister(registered!);
    DI.uncache(registered!);
    DI.uncache(Configuration);
    const off = await boot({ policy: { blocklist: null, similarity: { enabled: false } } });
    expect(await off.check('Alice-Spring-26', { identifiers: ['alice@example.com'] })).to.deep.equal([]);
  });
```

In `packages/authn/test/boot/config-defaults.test.ts`, add inside `describe('authn shipped config')`, after the pepper tests:

```ts
  it('gives authn.local.policy.similarity its defaults and bounds minOverlap to 3..16', () => {
    expect(check({ local: { policy: {} } }).config.local.policy.similarity).to.deep.eq({ enabled: true, minOverlap: 4 });
    expect(check({ local: { policy: { similarity: { minOverlap: 16 } } } }).ok).to.eq(true);
    for (const bad of [2, 17]) expect(check({ local: { policy: { similarity: { minOverlap: bad } } } }).paths, String(bad)).to.include('/local/policy/similarity/minOverlap');
    expect(check({ local: { policy: { similarity: { typo: true } } } }).ok).to.eq(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/policy.test.ts`
Expected: FAIL. The similarity cases fail on deep-equal (`[]` instead of `['similar']`, `['rule','blocklisted']` instead of `['rule','similar','blocklisted']`). `similarTo` fails with `p.similarTo is not a function`. `reports the violation its blocklist names` fails (`blocklisted` instead of `breached`).

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/boot/config-defaults.test.ts`
Expected: FAIL in `gives authn.local.policy.similarity its defaults ...` (`undefined` instead of the defaults).

- [ ] **Step 3: Write minimal implementation**

Schema: in `authn.configuration.ts`, replace the `policy` block (lines 126-134) with:

```ts
        policy: {
          type: 'object',
          properties: {
            minLength: { type: 'integer', minimum: 8, maximum: 128, default: 8, description: 'Passwords are 8–128 characters everywhere (A04).' },
            maxLength: { type: 'integer', minimum: 8, maximum: 128, default: 128 },
            rule: { type: ['object', 'null'], description: 'A JSON schema the password must match.' },
            blocklist: { type: ['string', 'null'], description: 'PasswordBlocklist service.' },
            similarity: {
              type: 'object',
              default: {},
              description: 'Refuse a password that contains or resembles the login, the email local part or the name of its identity.',
              propertyNames: { enum: ['enabled', 'minOverlap'] },
              properties: {
                enabled: { type: 'boolean', default: true },
                minOverlap: { type: 'integer', minimum: 3, maximum: 16, default: 4, description: 'Identifier parts shorter than this many characters are ignored.' },
              },
            },
          },
        },
```

`policy.ts`: change the contracts import (line 7) and add the similarity import:

```ts
import type { PasswordCheckContext, PasswordPolicy, PasswordViolation } from '@spinajs/authn/contracts';

import { isSimilar } from './similarity.js';
```

Replace `PasswordBlocklist` (lines 27-30) with:

```ts
/** Optional hook (e.g. a k-anonymity breach check), named by `authn.local.policy.blocklist`. */
export abstract class PasswordBlocklist {
  /** What `check` reports for a password this blocklist blocks. */
  public readonly violation: PasswordViolation = 'blocklisted';

  public abstract isBlocked(password: string): Promise<boolean>;
}

export interface SimilarityConfig {
  readonly enabled: boolean;
  /** Identifier parts shorter than this many code points are ignored. */
  readonly minOverlap: number;
}

export const DEFAULT_SIMILARITY: SimilarityConfig = Object.freeze<SimilarityConfig>({ enabled: true, minOverlap: 4 });
```

In `LocalPasswordPolicyOptions` (lines 38-46) add the last member:

```ts
  readonly similarity?: Partial<SimilarityConfig>;
```

In `PolicySettings` (lines 48-54) add:

```ts
  readonly similarity: SimilarityConfig;
```

After the `BlocklistName` field (line 96) add:

```ts
  @Config('authn.local.policy.similarity.enabled', { defaultValue: DEFAULT_SIMILARITY.enabled })
  protected SimilarityEnabled: boolean;

  @Config('authn.local.policy.similarity.minOverlap', { defaultValue: DEFAULT_SIMILARITY.minOverlap })
  protected SimilarityMinOverlap: number;
```

Replace `check` (lines 114-125) with:

```ts
  public async check(password: string, context?: PasswordCheckContext): Promise<PasswordViolation[]> {
    if (codePointLength(password) > PASSWORD_HARD_CAP) {
      return ['too_long'];
    }

    const violations = this.checkSync(password);
    if (context && this.similarTo(password, context.identifiers)) {
      violations.push('similar');
    }
    const blocklist = await this.blocklist();
    if (blocklist && (await blocklist.isBlocked(password))) {
      violations.push(blocklist.violation);
    }
    return violations;
  }

  /** Whether `password` contains or resembles one of `identifiers` (A33); false while similarity is off. */
  public similarTo(password: string, identifiers: readonly string[]): boolean {
    const { enabled, minOverlap } = this.settings.similarity;
    return enabled && isSimilar(password, identifiers, minOverlap);
  }
```

Replace the `settings` getter (lines 223-227) with:

```ts
  protected get settings(): PolicySettings {
    return (this._settings ??= this.buildSettings(
      this.Options ?? {
        minLength: this.MinLength,
        maxLength: this.MaxLength,
        rule: this.Rule,
        description: this.Description,
        similarity: { enabled: this.SimilarityEnabled, minOverlap: this.SimilarityMinOverlap },
      },
    ));
  }
```

In `buildSettings`, change the returned object (lines 262-268) to:

```ts
    return {
      minLength,
      maxLength,
      rule,
      similarity: { ...DEFAULT_SIMILARITY, ...options.similarity },
      ...(typeof pattern === 'string' ? { pattern } : {}),
      ...(typeof description === 'string' && description.trim() !== '' ? { description } : {}),
    };
```

- [ ] **Step 4: Run tests to verify they pass, then rebuild authn**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/policy.test.ts test/similarity.test.ts`
Expected: PASS, 0 failing.

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/boot/config-defaults.test.ts && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`
Expected: PASS, 0 failing; no compiler output.

Run: `cd packages/authn-local && npm test`
Expected: PASS, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-local/src/policy.ts packages/authn-local/test/policy.test.ts packages/authn/src/schemas/authn.configuration.ts packages/authn/test/boot/config-defaults.test.ts
git commit -m "feat(authn-local): the password policy refuses passwords similar to the identity"
```

---

### Task 4: `LocalPasswordService` passes the identifiers it may know

**Files:**
- Modify: `packages/authn-local/src/service.ts:128-134` (`change`), `:164` (`set`), `:177-179` (`check`), `:209` (`redeemReset`), a new `identifiersOf` after `identities()` (line 385)
- Test: `packages/authn-local/test/service.test.ts` (a new describe before the `check and policy` describe at line 545), `packages/authn-local/test/reset.test.ts` (two `it`s in `describe('redeemReset ...')` after line 321)

**Interfaces:**
- Consumes: `LocalPasswordPolicy.check(password, context?)`, `LocalPasswordPolicy.similarTo` (Task 3).
- Produces: `LocalPasswordService.check(password: string, context?: PasswordCheckContext)`; `protected identifiersOf(id: IdentityRef): Promise<string[]>`.

- [ ] **Step 1: Write the failing tests**

In `service.test.ts`, add before `describe('check and policy', ...)`:

```ts
  describe('similarity to the identity (A33)', () => {
    async function dora(x: Awaited<ReturnType<typeof setup>>) {
      const id = x.identities.add({ login: 'dora@example.com', email: 'dora@example.com', name: 'Dora Explorer' });
      await x.passwords.set(id, await x.hasher.hash(OLD));
      return { id, session: await x.sessions.issue(id, facts()) };
    }

    it('change refuses a password holding the email local part, after the session check and without counting', async () => {
      const x = await setup();
      const d = await dora(x);
      expect(await x.service.change(d.id, OLD, 'Dora-Spring-2026', d.session, ctx())).to.deep.equal({ status: 'rejected', violations: ['similar'] });
      expect(x.throttle.attempts).to.equal(0);
      expect(await verifies(x.hasher, x.passwords, d.id, OLD)).to.equal(true);
      const [e] = x.events.ofType('password.change');
      expect(e).to.include({ outcome: 'failure', reason: 'policy' });
    });

    it('change refuses a password holding a word of the name', async () => {
      const x = await setup();
      const d = await dora(x);
      expect(await x.service.change(d.id, OLD, 'Explorer-2026!', d.session, ctx())).to.deep.equal({ status: 'rejected', violations: ['similar'] });
    });

    it("change with another identity's session answers invalid, never similar", async () => {
      const x = await setup();
      const d = await dora(x);
      expect(await x.service.change(d.id, OLD, 'Dora-Spring-2026', x.session, ctx())).to.deep.equal({ status: 'invalid' });
    });

    it('set refuses a password resembling the identity and stores nothing', async () => {
      const x = await setup();
      const d = await dora(x);
      expect(await x.service.set(d.id, 'Explorer-2026', ctx())).to.deep.equal({ status: 'rejected', violations: ['similar'] });
      expect(await verifies(x.hasher, x.passwords, d.id, OLD)).to.equal(true);
    });

    it('check passes its context to the policy', async () => {
      const { service } = await setup();
      expect(await service.check('Dora-Spring-2026', { identifiers: ['dora@example.com'] })).to.deep.equal(['similar']);
      expect(await service.check('Dora-Spring-2026')).to.deep.equal([]);
    });
  });
```

In `reset.test.ts`, inside `describe('redeemReset (D12, A11)')` after the test that ends at line 321:

```ts
    it('refuses a password holding the login as typed, before the secret, and leaves the secret usable (A33)', async () => {
      const x = await setup();
      const secret = await requestAndTake(x);
      expect(await x.service.redeemReset(LOGIN, secret, 'Alice-Spring-2026', later(1))).to.deep.equal({ status: 'rejected', violations: ['similar'] });
      expect(x.secrets.redeems).to.have.length(0);
      expect(await x.service.redeemReset(LOGIN, secret, NEW, later(2))).to.deep.equal({ status: 'reset', purpose: 'reset' });
    });

    it('compares only the login as typed: the name is never read before the secret (A33)', async () => {
      const x = await setup();
      const zed = x.identities.add({ login: 'zed@example.com', email: 'zed@example.com', name: 'Marguerite' });
      await x.passwords.set(zed, await x.hasher.hash(OLD));
      expect(await x.service.requestReset('zed@example.com', ctx())).to.deep.equal({ status: 'accepted' });
      await x.service.drain();
      const secret = x.mailer.secretFor(zed, 'reset')!;
      expect(await x.service.redeemReset('zed@example.com', secret, 'Marguerite-2026', later(1))).to.deep.equal({ status: 'reset', purpose: 'reset' });
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/service.test.ts test/reset.test.ts`
Expected: FAIL. The change and set cases answer `{ status: 'changed', ... }` and `{ status: 'set' }` instead of `rejected`. `check passes its context` answers `[]`. The first reset case answers `{ status: 'reset' ... }`. The "name is never read" case passes already, and that is expected: it pins the limit.

- [ ] **Step 3: Write minimal implementation**

In `service.ts`, extend the type import on lines 7-22 with `PasswordCheckContext`.

In `change`, insert after the impersonator refusal (after line 132), before `const throttle = this.throttle();`:

```ts
    // After the session check: a caller holding another identity's session must not learn this one's identifiers.
    if (this.policyComponent().similarTo(newPassword, await this.identifiersOf(id))) {
      await this.audit(ctx, { type: 'password.change', outcome: 'failure', identity: id, reason: 'policy', session: handle });
      return { status: 'rejected', violations: ['similar'] };
    }
```

In `set`, replace line 164 with:

```ts
    const violations = await this.policyComponent().check(newPassword, { identifiers: await this.identifiersOf(id) });
```

Replace `check` (lines 177-179) with:

```ts
  public check(password: string, context?: PasswordCheckContext): Promise<readonly PasswordViolation[]> {
    return this.policyComponent().check(password, context);
  }
```

In `redeemReset`, replace line 209 with:

```ts
    // Only the login as typed: the account's email or name would tell a caller without the secret what they are (A33).
    const violations = await this.policyComponent().check(newPassword, { identifiers: [login] });
```

After `identities()` (line 385) add:

```ts
  /** What a new password of `id` must not resemble: its email and name (users: the login). */
  protected async identifiersOf(id: IdentityRef): Promise<string[]> {
    const shown = await this.identities().display(id);
    return [shown.email, shown.name].filter((v): v is string => typeof v === 'string' && v !== '');
  }
```

- [ ] **Step 4: Run tests to verify they pass; rebuild; run the dependants**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/service.test.ts test/reset.test.ts`
Expected: PASS, 0 failing.

Run: `cd packages/authn-local && npm test`
Expected: PASS, 0 failing (`npm test` compiles first through `pretest`).

Run: `cd packages/authn-local && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`, then `npm test` in `packages/users` and in `packages/authn-http`, one after the other.
Expected: 0 failing. A failure whose answer carries `violations: ['similar']` means a test sets a password that contains its own login or email (for example `admin1234` for `admin`). Change the TEST password, not the rule, and list each fix in the commit body.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-local/src/service.ts packages/authn-local/test/service.test.ts packages/authn-local/test/reset.test.ts
git commit -m "feat(authn-local): change, set and reset refuse a password similar to the identity"
```

Add any dependant test file fixed in Step 4 to the same `git add`.

---

### Task 5: `users.create()` passes the login and email

**Files:**
- Modify: `packages/users/src/actions.ts:667`
- Modify: `packages/users/test/support/password-service.ts` (record the check context)
- Test: `packages/users/test/create.test.ts` (one `it` in `describe('a supplied password')`, after line 127)

**Interfaces:**
- Consumes: `PasswordService.check(password, context?)` (Task 1).
- Produces: `checkContexts: (PasswordCheckContext | undefined)[]` in the users test support, cleared by `resetPasswordCalls()`.

- [ ] **Step 1: Write the failing test**

In `packages/users/test/support/password-service.ts`, add `PasswordCheckContext` to the type import from `@spinajs/authn/contracts`. Below `passwordCalls`, add:

```ts
/** The context of every `check` since the last {@link resetPasswordCalls}. */
export const checkContexts: (PasswordCheckContext | undefined)[] = [];
```

Make `resetPasswordCalls` clear it:

```ts
export function resetPasswordCalls(): void {
  passwordCalls.length = 0;
  checkContexts.length = 0;
}
```

and replace `TestPasswordService.check` with:

```ts
  public async check(password: string, context?: PasswordCheckContext): Promise<readonly PasswordViolation[]> {
    checkContexts.push(context);
    return /^(?=.*\d).{8,}$/.test(password) ? [] : ['rule'];
  }
```

In `create.test.ts`, import `checkContexts` with the other support names (line 22). Add after the `'is checked, then set through PasswordService ...'` test:

```ts
    it('is checked against the login and the email (A33)', async () => {
      await create({ Email: 'Dora.Explorer@spinajs.pl', Login: 'dora', Password: 'passw0rd123' });

      expect(checkContexts[0]).to.deep.eq({ identifiers: ['dora', 'Dora.Explorer@spinajs.pl'] });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/users && npx ts-mocha -p tsconfig.json test/create.test.ts`
Expected: FAIL in `is checked against the login and the email`: `expected undefined to deeply equal { identifiers: [...] }`.

- [ ] **Step 3: Write minimal implementation**

In `actions.ts` replace line 667 with:

```ts
  if (password !== undefined && (await passwords.check(password, { identifiers: [login, email] })).length > 0) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/users && npx ts-mocha -p tsconfig.json test/create.test.ts`
Expected: PASS, 0 failing.

Run: `cd packages/users && npm test`
Expected: PASS, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add packages/users/src/actions.ts packages/users/test/support/password-service.ts packages/users/test/create.test.ts
git commit -m "feat(users): create checks a password against the new login and email"
```

---

### Task 6: `HibpPasswordBlocklist`

**Files:**
- Create: `packages/authn-local/src/lru.ts`, `packages/authn-local/src/hibp.ts`
- Modify: `packages/authn-local/src/index.ts` (exports), `packages/authn-local/package.json:21` (`engines.node`)
- Modify: `packages/authn/src/schemas/authn.configuration.ts` (`local.policy.properties`, the block Task 3 wrote)
- Test: `packages/authn-local/test/hibp.test.ts`, `packages/authn/test/boot/config-defaults.test.ts` (a new `it`)

**Interfaces:**
- Consumes: `PasswordBlocklist` and its `violation` (Task 3); `authnAppEnv`, `isLenientAuthnEnv` from `@spinajs/authn/env`.
- Produces:
  - `class LruCache<V> { constructor(size: number, ttlMs: number); get(key, now): V | undefined; set(key, value, now): void; readonly count: number }`
  - `HIBP_RANGE_URL`, `HIBP_DEFAULTS`, `type HibpErrorMode = 'allow' | 'deny'`, `interface HibpPasswordBlocklistOptions`, `interface HibpSettings`
  - `@Injectable(PasswordBlocklist) class HibpPasswordBlocklist` with `violation = 'breached'`
  - `parseRange(text: string): ReadonlyMap<string, number>`
  - config keys `authn.local.policy.hibp.{baseUrl,maxBreaches,timeoutMs,onError,cacheSize,cacheTtlSeconds}`

- [ ] **Step 1: Write the failing tests**

Create `packages/authn-local/test/hibp.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { InvalidOption, IOFail } from '@spinajs/exceptions';

import { HIBP_RANGE_URL, HibpPasswordBlocklist, HibpPasswordBlocklistOptions, parseRange } from '../src/hibp.js';
import { LruCache } from '../src/lru.js';
import { LocalPasswordPolicy } from '../src/policy.js';

const BREACHED = 'Breached-Pass-1';
const sha1 = (s: string) => createHash('sha1').update(s, 'utf8').digest('hex').toUpperCase();
const PREFIX = sha1(BREACHED).slice(0, 5);
const SUFFIX = sha1(BREACHED).slice(5);
const PADDING = `${'0'.repeat(35)}:0`;

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly redirect: RequestRedirect | undefined;
}

function stubFetch(answer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect });
    return answer();
  }) as typeof fetch;
  return { fetch: fetchStub, calls };
}

const range = (...lines: string[]) => () => new Response(lines.join('\r\n'), { status: 200, headers: { 'content-type': 'text/plain' } });

function blocklist(options: HibpPasswordBlocklistOptions) {
  const warnings: string[] = [];
  const b = new HibpPasswordBlocklist({ log: { warn: (m: string) => warnings.push(m) }, ...options });
  return { b, warnings };
}

async function failure(f: () => Promise<unknown>): Promise<unknown> {
  try {
    await f();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('HibpPasswordBlocklist', function () {
  this.timeout(30_000);

  it('sends only the five-character prefix, padded, and blocks a listed suffix', async () => {
    const s = stubFetch(range(PADDING, `${SUFFIX}:42`));
    const { b } = blocklist({ fetch: s.fetch });
    expect(await b.isBlocked(BREACHED)).to.equal(true);
    expect(s.calls).to.have.length(1);
    expect(s.calls[0].url).to.equal(`${HIBP_RANGE_URL}${PREFIX}`);
    expect(s.calls[0].headers['add-padding']).to.equal('true');
    expect(s.calls[0].redirect).to.equal('manual');
    expect(s.calls[0].url).to.not.contain(SUFFIX);
  });

  it('reports breached through the policy', async () => {
    const s = stubFetch(range(`${SUFFIX}:1`));
    const p = new LocalPasswordPolicy({ blocklist: new HibpPasswordBlocklist({ fetch: s.fetch }) });
    p.resolve();
    expect(await p.check(BREACHED)).to.deep.equal(['breached']);
  });

  it('a suffix not listed, or a padding entry, is not blocked', async () => {
    expect(await blocklist({ fetch: stubFetch(range(PADDING)).fetch }).b.isBlocked(BREACHED)).to.equal(false);
    expect(await blocklist({ fetch: stubFetch(range(`${SUFFIX}:0`)).fetch }).b.isBlocked(BREACHED)).to.equal(false);
  });

  it('maxBreaches raises the bar', async () => {
    expect(await blocklist({ maxBreaches: 5, fetch: stubFetch(range(`${SUFFIX}:5`)).fetch }).b.isBlocked(BREACHED)).to.equal(false);
    expect(await blocklist({ maxBreaches: 5, fetch: stubFetch(range(`${SUFFIX}:6`)).fetch }).b.isBlocked(BREACHED)).to.equal(true);
  });

  it('caches a prefix; cacheSize 0 always asks', async () => {
    const cached = stubFetch(range(`${SUFFIX}:1`));
    const c = blocklist({ fetch: cached.fetch }).b;
    await c.isBlocked(BREACHED);
    await c.isBlocked(BREACHED);
    expect(cached.calls).to.have.length(1);

    const uncached = stubFetch(range(`${SUFFIX}:1`));
    const u = blocklist({ fetch: uncached.fetch, cacheSize: 0 }).b;
    await u.isBlocked(BREACHED);
    await u.isBlocked(BREACHED);
    expect(uncached.calls).to.have.length(2);
  });

  for (const [label, answer] of [
    ['an HTTP 503', () => new Response('busy', { status: 503 })],
    ['a redirect', () => new Response(null, { status: 302, headers: { location: 'http://mirror.example/' } })],
    ['a malformed answer', () => new Response('<html>', { status: 200 })],
    [
      'a transport error carrying the URL',
      () => {
        throw new TypeError(`fetch failed: ${HIBP_RANGE_URL}${PREFIX}`);
      },
    ],
  ] as const) {
    it(`onError allow: ${label} is not blocked, and the warning names no password, hash or prefix`, async () => {
      const { b, warnings } = blocklist({ fetch: stubFetch(answer).fetch });
      expect(await b.isBlocked(BREACHED)).to.equal(false);
      expect(warnings).to.have.length(1);
      for (const secret of [BREACHED, PREFIX, SUFFIX]) expect(warnings[0]).to.not.contain(secret);
    });

    it(`onError deny: ${label} throws IOFail`, async () => {
      const { b } = blocklist({ fetch: stubFetch(answer).fetch, onError: 'deny' });
      const error = await failure(() => b.isBlocked(BREACHED));
      expect(error).to.be.instanceOf(IOFail);
      expect((error as Error).message).to.not.contain(PREFIX);
    });
  }

  it('a failed lookup is not cached', async () => {
    let n = 0;
    const s = stubFetch(() => (++n === 1 ? new Response('busy', { status: 503 }) : range(`${SUFFIX}:1`)()));
    const { b } = blocklist({ fetch: s.fetch });
    expect(await b.isBlocked(BREACHED)).to.equal(false);
    expect(await b.isBlocked(BREACHED)).to.equal(true);
  });

  it('refuses an http baseUrl outside development and test, whatever onError says', async () => {
    const { b } = blocklist({ baseUrl: 'http://mirror.example/range/', relaxed: false, fetch: stubFetch(range()).fetch });
    expect(await failure(() => b.isBlocked(BREACHED))).to.be.instanceOf(InvalidOption);
  });

  it('refuses a baseUrl that does not end in a slash', async () => {
    const { b } = blocklist({ baseUrl: 'https://mirror.example/range', fetch: stubFetch(range()).fetch });
    expect(await failure(() => b.isBlocked(BREACHED))).to.be.instanceOf(InvalidOption);
  });

  describe('parseRange', () => {
    it('reads SUFFIX:COUNT lines in either case, CRLF or LF', () => {
      const m = parseRange(`${SUFFIX.toLowerCase()}:7\n${PADDING}\r\n`);
      expect(m.get(SUFFIX)).to.equal(7);
      expect(m.get('0'.repeat(35))).to.equal(0);
    });

    it('throws on any malformed line', () => {
      expect(() => parseRange(`${SUFFIX}:7\r\nnot a line`)).to.throw();
    });
  });

  describe('over a real connection', () => {
    let server: Server;
    let base: string;
    let seen: IncomingHttpHeaders[] = [];
    let hang = false;

    before(async () => {
      server = createServer((req, res) => {
        seen.push(req.headers);
        if (!hang) {
          res.writeHead(200, { 'content-type': 'text/plain' }).end(`${SUFFIX}:3\r\n${PADDING}`);
        }
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/range/`;
    });

    after(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });

    beforeEach(() => {
      seen = [];
      hang = false;
    });

    it('asks with the global fetch and the Add-Padding header', async () => {
      expect(await blocklist({ baseUrl: base, relaxed: true }).b.isBlocked(BREACHED)).to.equal(true);
      expect(seen[0]['add-padding']).to.equal('true');
    });

    it('gives up after timeoutMs', async () => {
      hang = true;
      const started = Date.now();
      expect(await blocklist({ baseUrl: base, relaxed: true, timeoutMs: 200 }).b.isBlocked(BREACHED)).to.equal(false);
      expect(Date.now() - started).to.be.below(5_000);
      expect(await failure(() => blocklist({ baseUrl: base, relaxed: true, timeoutMs: 200, onError: 'deny' }).b.isBlocked(BREACHED))).to.be.instanceOf(IOFail);
    });
  });

  describe('LruCache', () => {
    it('evicts the least recently used entry', () => {
      const c = new LruCache<number>(2, 1_000);
      c.set('a', 1, 0);
      c.set('b', 2, 0);
      c.get('a', 0);
      c.set('c', 3, 0);
      expect(c.get('b', 0)).to.equal(undefined);
      expect(c.get('a', 0)).to.equal(1);
      expect(c.get('c', 0)).to.equal(3);
    });

    it('drops an entry at its time to live; size 0 keeps nothing', () => {
      const c = new LruCache<number>(2, 1_000);
      c.set('a', 1, 0);
      expect(c.get('a', 999)).to.equal(1);
      expect(c.get('a', 1_000)).to.equal(undefined);
      expect(c.count).to.equal(0);
      const none = new LruCache<number>(0, 1_000);
      none.set('a', 1, 0);
      expect(none.count).to.equal(0);
    });
  });

  describe('config wiring', () => {
    class ProbeHibp extends HibpPasswordBlocklist {
      public view() {
        return this.settings;
      }
    }

    class ProbePolicy extends LocalPasswordPolicy {
      public type() {
        return this.blocklistType;
      }
    }

    class HibpTestConfiguration extends FrameworkConfiguration {
      protected onLoad(): unknown {
        return {
          logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
          authn: { local: { policy: { blocklist: 'HibpPasswordBlocklist', hibp: { maxBreaches: 3, timeoutMs: 900, onError: 'deny', cacheSize: 8, cacheTtlSeconds: 60 } } } },
        };
      }
    }

    before(async () => {
      DI.setESMModuleSupport();
      DI.register(HibpTestConfiguration).as(Configuration);
      await DI.resolve(Configuration);
    });

    after(() => {
      DI.unregister(HibpTestConfiguration);
      DI.uncache(HibpTestConfiguration);
      DI.uncache(Configuration);
    });

    it('reads authn.local.policy.hibp, the default base URL included', () => {
      expect(new ProbeHibp().view()).to.deep.equal({ baseUrl: HIBP_RANGE_URL, maxBreaches: 3, timeoutMs: 900, onError: 'deny', cacheSize: 8, cacheTtlSeconds: 60 });
    });

    it('is the PasswordBlocklist the policy finds under the name HibpPasswordBlocklist', () => {
      expect(new ProbePolicy().type()).to.equal(HibpPasswordBlocklist);
    });
  });
});
```

In `packages/authn/test/boot/config-defaults.test.ts` add after the similarity `it` (Task 3):

```ts
  it('gives authn.local.policy.hibp its defaults and refuses a bad value', () => {
    expect(check({ local: { policy: {} } }).config.local.policy.hibp).to.deep.eq({
      baseUrl: 'https://api.pwnedpasswords.com/range/',
      maxBreaches: 0,
      timeoutMs: 1500,
      onError: 'allow',
      cacheSize: 64,
      cacheTtlSeconds: 3600,
    });
    expect(check({ local: { policy: { hibp: { baseUrl: 'https://pwned.internal.example/range/' } } } }).ok).to.eq(true);
    for (const [key, bad] of [
      ['baseUrl', 'ftp://pwned.example/range/'],
      ['baseUrl', 'https://pwned.example/range'],
      ['onError', 'maybe'],
      ['timeoutMs', 50],
      ['maxBreaches', -1],
      ['cacheSize', 5000],
    ] as const) {
      expect(check({ local: { policy: { hibp: { [key]: bad } } } }).paths, `${key} ${bad}`).to.include(`/local/policy/hibp/${key}`);
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/hibp.test.ts`
Expected: FAIL with `Cannot find module '.../src/hibp.js'` (ERR_MODULE_NOT_FOUND).

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/boot/config-defaults.test.ts`
Expected: FAIL in `gives authn.local.policy.hibp its defaults ...` (`undefined` instead of the defaults).

- [ ] **Step 3: Write minimal implementation**

Create `packages/authn-local/src/lru.ts`:

```ts
/** A small least-recently-used map whose entries also expire; size 0 keeps nothing. */
export class LruCache<V> {
  private readonly entries = new Map<string, { readonly value: V; readonly expiresAt: number }>();

  constructor(
    public readonly size: number,
    private readonly ttlMs: number,
  ) {}

  public get count(): number {
    return this.entries.size;
  }

  public get(key: string, now: number): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    this.entries.delete(key);
    if (entry.expiresAt <= now) {
      return undefined;
    }
    this.entries.set(key, entry);
    return entry.value;
  }

  public set(key: string, value: V, now: number): void {
    if (this.size < 1) {
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.size) break;
      this.entries.delete(oldest);
    }
  }
}
```

Create `packages/authn-local/src/hibp.ts`:

```ts
import { createHash } from 'node:crypto';
import { DI, Injectable } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { InvalidOption, IOFail } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { authnAppEnv, isLenientAuthnEnv } from '@spinajs/authn/env';
import type { PasswordViolation } from '@spinajs/authn/contracts';

import { LruCache } from './lru.js';
import { PasswordBlocklist } from './policy.js';

export const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';

/** A padded answer is about 40 KiB. */
export const HIBP_MAX_RANGE_BYTES = 1024 * 1024;

export type HibpErrorMode = 'allow' | 'deny';

export interface HibpSettings {
  /** The range endpoint, ending in '/'; the 5-hex prefix is appended. */
  readonly baseUrl: string;
  /** A suffix seen more often than this is blocked. */
  readonly maxBreaches: number;
  readonly timeoutMs: number;
  readonly onError: HibpErrorMode;
  /** Prefixes kept in memory. */
  readonly cacheSize: number;
  readonly cacheTtlSeconds: number;
}

export const HIBP_DEFAULTS: HibpSettings = Object.freeze<HibpSettings>({ baseUrl: HIBP_RANGE_URL, maxBreaches: 0, timeoutMs: 1500, onError: 'allow', cacheSize: 64, cacheTtlSeconds: 3600 });

export interface HibpPasswordBlocklistOptions extends Partial<HibpSettings> {
  /** Allow an http baseUrl; default: only when the app env is development or test. */
  readonly relaxed?: boolean;
  readonly fetch?: typeof fetch;
  readonly log?: { warn(message: string): void };
}

class HibpLookupError extends Error {
  public name = 'HibpLookupError';
}

const RANGE_LINE = /^([0-9A-Fa-f]{35}):(\d{1,10})$/;

/** SUFFIX:COUNT lines; any other line fails the whole answer. */
export function parseRange(text: string): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue;
    const m = RANGE_LINE.exec(line);
    if (!m) {
      throw new HibpLookupError('the range answer is malformed');
    }
    out.set(m[1].toUpperCase(), Number(m[2]));
  }
  return out;
}

async function readCapped(response: Response, max: number): Promise<string> {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new HibpLookupError('the range answer is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * HaveIBeenPwned's k-anonymity range API: only the first 5 hex digits of the password's SHA-1 leave the process, with
 * Add-Padding; the suffix is compared here. Selected with `authn.local.policy.blocklist: 'HibpPasswordBlocklist'`, configured by
 * `authn.local.policy.hibp`. A failed lookup is not blocked with onError 'allow', and throws IOFail with 'deny'.
 */
@Injectable(PasswordBlocklist)
export class HibpPasswordBlocklist extends PasswordBlocklist {
  public readonly violation: PasswordViolation = 'breached';

  @Config('authn.local.policy.hibp.baseUrl', { defaultValue: HIBP_DEFAULTS.baseUrl })
  protected BaseUrl: string;

  @Config('authn.local.policy.hibp.maxBreaches', { defaultValue: HIBP_DEFAULTS.maxBreaches })
  protected MaxBreaches: number;

  @Config('authn.local.policy.hibp.timeoutMs', { defaultValue: HIBP_DEFAULTS.timeoutMs })
  protected TimeoutMs: number;

  @Config('authn.local.policy.hibp.onError', { defaultValue: HIBP_DEFAULTS.onError })
  protected OnError: HibpErrorMode;

  @Config('authn.local.policy.hibp.cacheSize', { defaultValue: HIBP_DEFAULTS.cacheSize })
  protected CacheSize: number;

  @Config('authn.local.policy.hibp.cacheTtlSeconds', { defaultValue: HIBP_DEFAULTS.cacheTtlSeconds })
  protected CacheTtlSeconds: number;

  @Logger('authn-local')
  protected Log: Log;

  private _settings?: HibpSettings;
  private _cache?: LruCache<ReadonlyMap<string, number>>;

  /** With `options` the configuration is not read at all, so a test can build one without a container. */
  constructor(protected readonly Options?: HibpPasswordBlocklistOptions) {
    super();
  }

  public async isBlocked(password: string): Promise<boolean> {
    // Read before the lookup: a configuration fault throws whatever onError says.
    const settings = this.settings;
    const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();

    let found: ReadonlyMap<string, number>;
    try {
      found = await this.range(digest.slice(0, 5));
    } catch (err) {
      // The class name only: a fetch error message carries the URL, and the URL the hash prefix.
      this.log().warn(`The breached-password lookup failed (${(err as Error)?.name ?? typeof err}); authn.local.policy.hibp.onError is ${settings.onError}`);
      if (settings.onError === 'deny') {
        throw new IOFail('The breached-password check is unavailable; try again later');
      }
      return false;
    }
    return (found.get(digest.slice(5)) ?? 0) > settings.maxBreaches;
  }

  protected get settings(): HibpSettings {
    return (this._settings ??= this.buildSettings());
  }

  protected get cache(): LruCache<ReadonlyMap<string, number>> {
    return (this._cache ??= new LruCache(this.settings.cacheSize, this.settings.cacheTtlSeconds * 1000));
  }

  protected async range(prefix: string): Promise<ReadonlyMap<string, number>> {
    const now = Date.now();
    const cached = this.cache.get(prefix, now);
    if (cached) {
      return cached;
    }

    const { baseUrl, timeoutMs } = this.settings;
    const response = await this.fetcher()(`${baseUrl}${prefix}`, {
      headers: { 'add-padding': 'true', 'user-agent': 'spinajs-authn-local' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new HibpLookupError(`the range answer is HTTP ${response.status}`);
    }

    const found = parseRange(await readCapped(response, HIBP_MAX_RANGE_BYTES));
    this.cache.set(prefix, found, now);
    return found;
  }

  protected fetcher(): typeof fetch {
    return this.Options?.fetch ?? fetch;
  }

  protected log(): { warn(message: string): void } {
    return this.Options ? (this.Options.log ?? { warn: () => undefined }) : this.Log;
  }

  /** Development and test only, as authn-oidc's client. */
  protected lenientEnv(): boolean {
    const config = DI.get(Configuration);
    return config ? isLenientAuthnEnv(authnAppEnv(config)) : false;
  }

  private buildSettings(): HibpSettings {
    const o = this.Options;
    const settings: HibpSettings = o
      ? {
          baseUrl: o.baseUrl ?? HIBP_DEFAULTS.baseUrl,
          maxBreaches: o.maxBreaches ?? HIBP_DEFAULTS.maxBreaches,
          timeoutMs: o.timeoutMs ?? HIBP_DEFAULTS.timeoutMs,
          onError: o.onError ?? HIBP_DEFAULTS.onError,
          cacheSize: o.cacheSize ?? HIBP_DEFAULTS.cacheSize,
          cacheTtlSeconds: o.cacheTtlSeconds ?? HIBP_DEFAULTS.cacheTtlSeconds,
        }
      : { baseUrl: this.BaseUrl, maxBreaches: this.MaxBreaches, timeoutMs: this.TimeoutMs, onError: this.OnError, cacheSize: this.CacheSize, cacheTtlSeconds: this.CacheTtlSeconds };

    let url: URL;
    try {
      url = new URL(settings.baseUrl);
    } catch {
      throw new InvalidOption('authn.local.policy.hibp.baseUrl is not a URL');
    }
    const relaxed = o?.relaxed ?? this.lenientEnv();
    if (!settings.baseUrl.endsWith('/') || !(url.protocol === 'https:' || (url.protocol === 'http:' && relaxed))) {
      throw new InvalidOption('authn.local.policy.hibp.baseUrl must be an https URL ending in / (http only in development and test)');
    }
    return settings;
  }
}
```

Append to `packages/authn-local/src/index.ts`:

```ts
export * from './similarity.js';
export * from './hibp.js';
```

In `packages/authn-local/package.json` change `"node": ">=16.11"` to `"node": ">=18.17"`.

Schema: in `authn.configuration.ts`, add after the `similarity` property of `local.policy`:

```ts
            hibp: {
              type: 'object',
              default: {},
              description: "HibpPasswordBlocklist, selected with blocklist: 'HibpPasswordBlocklist'.",
              propertyNames: { enum: ['baseUrl', 'maxBreaches', 'timeoutMs', 'onError', 'cacheSize', 'cacheTtlSeconds'] },
              properties: {
                baseUrl: {
                  type: 'string',
                  pattern: '^https?://[^\\s?#]+/$',
                  default: 'https://api.pwnedpasswords.com/range/',
                  description: 'The range endpoint (a self-hosted mirror too), ending in /. http only in development and test.',
                },
                maxBreaches: { type: 'integer', minimum: 0, default: 0, description: 'A password seen more often than this is refused as breached.' },
                timeoutMs: { type: 'integer', minimum: 100, maximum: 10000, default: 1500 },
                onError: { enum: ['allow', 'deny'], default: 'allow', description: "A failed lookup: 'allow' accepts the password (logged), 'deny' fails the request." },
                cacheSize: { type: 'integer', minimum: 0, maximum: 4096, default: 64, description: 'Prefixes kept in memory; 0: none.' },
                cacheTtlSeconds: { type: 'integer', minimum: 1, maximum: 86400, default: 3600 },
              },
            },
```

- [ ] **Step 4: Run tests to verify they pass; rebuild**

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/hibp.test.ts`
Expected: PASS, 24 passing, 0 failing.

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/boot/config-defaults.test.ts && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`
Expected: PASS, 0 failing; no compiler output.

Run: `cd packages/authn-local && npm test && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`
Expected: PASS, 0 failing; no compiler output.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-local/src/lru.ts packages/authn-local/src/hibp.ts packages/authn-local/src/index.ts packages/authn-local/package.json packages/authn-local/test/hibp.test.ts packages/authn/src/schemas/authn.configuration.ts packages/authn/test/boot/config-defaults.test.ts
git commit -m "feat(authn-local): HibpPasswordBlocklist, a k-anonymity breached-password check"
```

---

### Task 7: Behaviour rule A33

**Files:**
- Create: `packages/authn-testing/src/behaviour/A33-password-similarity.spec.ts`
- Modify: `packages/authn-testing/src/behaviour/types.ts:8` (`RULE_IDS`), `packages/authn-testing/src/behaviour/index.ts:30`, `:40`
- Modify: `packages/authn-local/test/kit.test.ts:8`, `:17`

**Interfaces:**
- Consumes: the `password`, `seed`, `sessions`, `outbox`, `service` ports; `ALICE`, `NEW_PW`, `auth`, `expectSuccess`, `factsAal1`, `pw` from `steps.ts`.
- Produces: rule `A33` with facet `A33/local`.

- [ ] **Step 1: Write the failing test**

Create `packages/authn-testing/src/behaviour/A33-password-similarity.spec.ts`:

```ts
import assert from 'node:assert/strict';
import type { PasswordViolation } from '@spinajs/authn/contracts';
import { ALICE, NEW_PW, auth, expectSuccess, factsAal1, pw } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule } from './types.js';

/** Holds 'alice', the local part of ALICE's email, which the identity store knows. */
const SIMILAR = 'Alice-Spring-2026';

function assertSimilar(r: { status: string; violations?: readonly PasswordViolation[] }): void {
  assert.strictEqual(r.status, 'rejected', `result ${JSON.stringify(r)}`);
  assert.deepStrictEqual([...(r.violations ?? [])], ['similar']);
}

export const A33: AuthnRule = defineRule('A33', 'a password that contains or resembles its identity is refused wherever it is set', [
  defineCase({
    name: 'A33 check judges similarity only against the identifiers it is given',
    facet: 'A33/local',
    needs: ['password'],
    async run(h) {
      assert.deepStrictEqual([...(await h.password.check(SIMILAR))], []);
      assert.ok((await h.password.check(SIMILAR, { identifiers: [ALICE.login] })).includes('similar'));
    },
  }),
  defineCase({
    name: 'A33 set refuses a password holding the email local part',
    facet: 'A33/local',
    needs: ['password', 'seed'],
    async run(h, k) {
      const a = await h.seed.user({ login: ALICE.login, email: ALICE.login, password: ALICE.password });
      assertSimilar(await h.password.set(a, SIMILAR, k.ctx()));
    },
  }),
  defineCase({
    name: 'A33 change refuses it and keeps the old password',
    facet: 'A33/local',
    needs: ['password', 'seed', 'sessions', 'service'],
    async run(h, k) {
      const a = await h.seed.user({ login: ALICE.login, email: ALICE.login, password: ALICE.password });
      const s = await h.sessions.issue(a, factsAal1(k));
      assertSimilar(await h.password.change(a, ALICE.password, SIMILAR, s, k.ctx({ purpose: 'reauth' })));
      expectSuccess(await auth(h, k, pw(ALICE.login, ALICE.password)));
    },
  }),
  defineCase({
    name: 'A33 a reset refuses a password holding the login as typed and leaves the secret usable',
    facet: 'A33/local',
    needs: ['password', 'seed', 'outbox'],
    async run(h, k) {
      const a = await h.seed.user({ login: ALICE.login, email: ALICE.login, password: ALICE.password });
      await h.password.requestReset(ALICE.login, k.ctx());
      const x = await h.outbox.secretFor(a, 'reset');
      assert.ok(x, 'the reset mail holds a secret');
      assertSimilar(await h.password.redeemReset(ALICE.login, x, SIMILAR, k.ctx()));
      assert.deepStrictEqual({ ...(await h.password.redeemReset(ALICE.login, x, NEW_PW, k.ctx())) }, { status: 'reset', purpose: 'reset' });
    },
  }),
]);
```

In `packages/authn-local/test/kit.test.ts` change line 8 and the rule list on line 17:

```ts
const N3_FACETS: Facet[] = ['A02/local', 'A03/argon2', 'A04/local', 'A11/local', 'A13/local', 'A30/local', 'A33/local'];
```

```ts
  runAuthnBehaviour(['A02', 'A03', 'A04', 'A11', 'A13', 'A30', 'A33'], localHarness, {
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authn-testing && npx tsc -b tsconfig.mjs.json`
Expected: FAIL with `Argument of type '"A33"' is not assignable to parameter of type 'RuleId'` in `A33-password-similarity.spec.ts`.

- [ ] **Step 3: Write minimal implementation**

In `types.ts:8` append `'A33'` after `'A32'`:

```ts
export const RULE_IDS = ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'A19', 'A20', 'A21', 'A22', 'A23', 'A24', 'A25', 'A26', 'A27', 'A30', 'A31', 'A32', 'A33'] as const;
```

In `behaviour/index.ts` add after line 30:

```ts
import { A33 } from './A33-password-similarity.spec.js';
```

and append `A33` to `ALL` (line 40):

```ts
const ALL: readonly AuthnRule[] = [A01, A02, A03, A04, A05, A06, A07, A08, A09, A10, A11, A12, A13, A14, A15, A16, A17, A18, A19, A20, A21, A22, A23, A24, A25, A26, A27, A30, A31, A32, A33];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/authn-testing && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npm test`
Expected: no compiler output; PASS, 0 failing.

Run: `cd packages/authn-local && npx ts-mocha -p tsconfig.json test/kit.test.ts`
Expected: PASS, 0 failing, 0 pending under `A33`, with 4 passing A33 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-testing/src/behaviour/A33-password-similarity.spec.ts packages/authn-testing/src/behaviour/types.ts packages/authn-testing/src/behaviour/index.ts packages/authn-local/test/kit.test.ts
git commit -m "test(authn-testing): A33, a password similar to its identity is refused wherever set"
```

---

## Self-review

- **Spec coverage:**
  - SHA-1 range API, `Add-Padding`, suffix compared in-process: Task 6.
  - `maxBreaches` (default 0), timeout (1500 ms), `onError` with its justified default, mirror `baseUrl` (https outside dev/test), LRU prefix cache, Node global fetch with no OIDC import, no password or hash in logs: Task 6.
  - Identifier similarity (equal, containing, Levenshtein, case-insensitive, min overlap 4): Tasks 2-3.
  - Backward-compatible contract: Task 1. Wiring in change, set, redeemReset and invite redeem (through redeemReset), and users create: Tasks 4-5.
  - New kinds `breached` and `similar`: Task 1. The message-ID dependency on 03 is stated in Decision 11.
  - Stub fetch and a local HTTP server, with no real network: Task 6.
  - The A-series row: Task 7.
- **Placeholder scan:** none. Every code step shows the code. The message IDs are a stated dependency, not a gap.
- **Type consistency:**
  - `PasswordCheckContext.identifiers` is used in Tasks 1, 3, 4, 5 and 7.
  - `similarTo(password, identifiers)` is defined in Task 3 and used in Task 4.
  - `PasswordBlocklist.violation` is defined in Task 3 and set in Task 6.
  - `HibpSettings` keys match the schema keys and the config test.
  - `isSimilar(password, identifiers, minOverlap)` is the same signature in Tasks 2 and 3.
