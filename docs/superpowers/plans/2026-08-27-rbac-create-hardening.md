# rbac `create()` Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every invariant of "a usable account" into the rbac `create()` action so no caller — route, CLI, migration or fixture — can mint a broken account, and replace rbac's `ErrorCode`/`E_CODES` idiom with semantic exceptions from `@spinajs/exceptions`.

**Architecture:** `create()` becomes the single gate: it validates and normalises roles, checks them against the live `AccessControl` grants, validates a caller-supplied password against the configured rule, generates a compliant one when none is given, refuses duplicates and protected metadata, and wraps every database write plus both middleware hooks in one transaction. Queue emits happen after commit. Refusals throw the exception class the HTTP layer already dispatches on, so controllers stop translating error codes.

**Tech Stack:** TypeScript (ESM, NodeNext), `@spinajs/di`, `@spinajs/orm`, `@spinajs/exceptions`, `@spinajs/validation` (ajv), `@spinajs/queue`, `accesscontrol`, `mocha` + `chai` + `sinon` via `ts-mocha`, sqlite in-memory for tests.

## Global Constraints

- All code comments, docstrings, commit messages and identifiers in English. No exceptions.
- Three repositories are touched. `Spinajs/main` is the source of truth; `yourscreen-backend` consumes `@spinajs/rbac` through a workspace link, so rebuild rbac (`npm run build` in `packages/rbac`) before typechecking the backend.
- `yourscreen-frontend` maps the 409 body's `parameter` array (`instancePath`, `keyword: 'duplicate'`, `params.field`) to form-field errors in `src/lib/api/base.ts` and `src/components/form/Form.tsx`. **The 409 wire shape and its message strings must not change.** `${clashes.join(' and ')} already in use` and the per-field `${field} already in use` stay byte-identical.
- Exception → HTTP status mapping, already wired in `@spinajs/http/src/response-methods`:
  - `ResourceDuplicated` → 409
  - `InvalidArgument`, `BadRequest`, `ExpectedResponseUnacceptable` → 400
  - `ValidationFailed` → 400
  - `Forbidden` → 403
  - `ResourceNotFound` → 404
  - `AuthenticationFailed` → 401
  - `MethodNotImplemented`, `IOFail`, `UnexpectedServerError` → 500
  - Anything unmapped → 500
- `AthenticationErrorCodes` (in `packages/rbac/src/interfaces.ts`, thrown by `auth.ts`, read by `LoginController` for a log label) is **out of scope** and stays on `ErrorCode`.
- Run the full suite of every package you touched before committing that package's task.

---

## File Structure

**`packages/rbac`** (the bulk of the work)
- `src/config/rbac.ts` — add `password.generator`; `password.validation.rule` keeps its current meaning (user input only).
- `src/password.ts` — `BasicPasswordProvider.generate()` reads the generator config and asserts its output against the validation rule.
- `src/actions.ts` — `create()` gains role hygiene, the grants check, password validation, `isActive`, `sendPasswordReset`, and a transaction; `_user_update` gains the uniqueness check; `E_CODES` is deleted and every throw site re-idiomed; `confirmPasswordReset` collapses every rejection into one exception at its boundary.
- `src/cli/CreateUser.ts` — follows the `create()` signature.
- `test/actions.test.ts`, `test/password.test.ts` (new) — coverage.

**`packages/rbac-http-admin`**
- `src/controllers/Users/Users.ts` — delete `asDuplicateResponse` and `roleList`, drop the `E_CODES` import.
- `test/users-controller.test.ts` — follows.

**`packages/rbac-http-user`**
- `src/controllers/PasswordResetController.ts` — narrow the redemption guard now that only one exception type arrives.

**`packages/rbac-http-token`**
- `src/actions.ts` — update the `E_TOKEN_CODES` naming comment.

**`yourscreen-backend`**
- `packages/features/src/users/actions/User.ts` — drop the local grants check, use `options.isActive`.

**`yourscreen-frontend`**
- No source changes expected. Task 15 verifies that.

---

### Task 1: Password generator configuration and compliant `generate()`

Today `generate()` draws 12 characters from `entropy-string`'s `charset32` (`2346789bdfghjmnpqrtBDFGHJLMNPQRT`). Against the shipped default rule `^(?=.*\d).{8,}$` roughly 5% of generated passwords contain no digit and are invalid — silently, because nothing validates a generated password.

**Files:**
- Modify: `packages/rbac/src/config/rbac.ts` (the `password` block, around line 177)
- Modify: `packages/rbac/src/password.ts`
- Modify: `packages/rbac/src/interfaces.ts` (`PasswordProvider` docstring only)
- Test: `packages/rbac/test/password.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `rbac.password.generator: { length: number; characters: string[] }`. `BasicPasswordProvider.generate(): string` keeps its synchronous signature and now throws `UnexpectedServerError` when it cannot produce a password satisfying `rbac.password.validation.rule`.

**Implementation note — bounded retry.** The generator config says *which characters and how many*, not *which classes are mandatory*, so a uniform draw can still miss a required class: with a 62-character alphanumeric pool and length 16, about 6% of draws contain no digit. Drawing once and asserting would therefore fail 6% of the time, which is a broken generator rather than a misconfiguration signal. `generate()` draws, asserts, and retries up to `GENERATE_ATTEMPTS` (10) before throwing — at 6% per draw that is a 6e-13 chance of a spurious failure, while a genuinely incompatible pair (a rule demanding a symbol, a pool with none) still exhausts and throws. The retry is an implementation detail of the assertion, not a substitute for the config.

- [ ] **Step 1: Write the failing test**

Create `packages/rbac/test/password.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { join, normalize, resolve } from 'path';

import { BasicPasswordProvider, BasicPasswordValidationProvider } from '../src/password.js';
import { PasswordProvider, PasswordValidationProvider } from '../src/interfaces.js';
import { TestConfiguration } from './common.test.js';

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

describe('BasicPasswordProvider.generate', function () {
  this.timeout(15000);

  let provider: PasswordProvider;
  let config: Configuration;

  beforeEach(async () => {
    DI.register(TestConfiguration).as(Configuration);
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(BasicPasswordValidationProvider).as(PasswordValidationProvider);

    config = await DI.resolve(Configuration, [null, null, [dir('./config')]]);
    provider = await DI.resolve(PasswordProvider);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('generates a password of the configured length from the configured characters', () => {
    config.set('rbac.password.generator', { length: 24, characters: ['abc', '123'] });

    const password = provider.generate();

    expect(password).to.have.lengthOf(24);
    expect(password.split('').every((c) => 'abc123'.includes(c)), `unexpected character in ${password}`).to.eq(true);
  });

  /**
   * The shipped default rule demands a digit. A uniform draw from an
   * alphanumeric pool misses one often enough (~6% at length 16) that the
   * generator must retry rather than hand back an invalid password.
   */
  it('always returns a password satisfying the validation rule', () => {
    config.set('rbac.password.generator', { length: 16, characters: ['abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'] });
    config.set('rbac.password.validation.rule', { type: 'string', pattern: '^(?=.*\\d).{8,}$' });

    for (let i = 0; i < 200; i++) {
      expect(/^(?=.*\d).{8,}$/.test(provider.generate()), 'generated password must satisfy the configured rule').to.eq(true);
    }
  });

  /**
   * A pool that cannot satisfy the rule is a misconfiguration the caller cannot
   * fix, so it must surface as a server error - never as a 400 on whoever
   * happened to create an account.
   */
  it('throws a server error when the pool cannot satisfy the rule', () => {
    config.set('rbac.password.generator', { length: 16, characters: ['abcdef'] });
    config.set('rbac.password.validation.rule', { type: 'string', pattern: '^(?=.*\\d).{8,}$' });

    expect(() => provider.generate()).to.throw(UnexpectedServerError);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 50 }, () => provider.generate()));
    expect(seen.size, 'generated passwords must not collide').to.eq(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rbac && npx ts-mocha -p tsconfig.json test/password.test.ts`
Expected: FAIL — the length test fails because `generate()` ignores the config and returns 12 characters from `charset32`.

- [ ] **Step 3: Add the generator config**

In `packages/rbac/src/config/rbac.ts`, inside the `password` block, immediately **before** the `validation` key:

```ts
    password: {
      service: 'BasicPasswordProvider',

      /**
       * How auto-generated passwords are built. Separate from `validation.rule`
       * on purpose: the rule is a JSON schema describing what a HUMAN may
       * choose, and a schema is not something you can generate from. This says
       * which characters to draw and how many.
       *
       * `characters` entries are concatenated into one pool, so both
       * `['abc', 'def']` and `['a', 'b', 'c']` mean the same thing.
       *
       * Keep this pool able to satisfy `validation.rule` — the default rule
       * demands a digit, so the default pool contains digits. `generate()`
       * asserts the result against the rule and throws if the two disagree.
       */
      generator: {
        length: 16,
        characters: ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'],
      },

      validation: {
```

- [ ] **Step 4: Rewrite `generate()`**

Replace the whole of `BasicPasswordProvider` in `packages/rbac/src/password.ts`. Note the import changes at the top of the file: `entropy-string` goes, `crypto.randomInt` and `UnexpectedServerError` arrive.

```ts
import { PasswordProvider, PasswordValidationProvider } from './interfaces.js';
import * as argon from 'argon2';
import { Autoinject, Injectable } from '@spinajs/di';
import { AutoinjectService, Config } from '@spinajs/configuration';
import { DataValidator } from '@spinajs/validation';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { randomInt } from 'crypto';

/**
 * How many draws `generate()` makes before declaring the generator pool and the
 * validation rule incompatible.
 *
 * The pool says which characters may appear, not which classes are MANDATORY, so
 * a uniform draw can legitimately miss a class the rule demands - with a
 * 62-character alphanumeric pool at length 16, about 6% of draws contain no
 * digit. One draw plus an assertion would therefore fail 6% of the time, which
 * is a broken generator rather than a misconfiguration signal. Ten draws bring a
 * spurious failure to roughly 6e-13, while a pool that genuinely cannot satisfy
 * the rule still exhausts every attempt and throws.
 */
const GENERATE_ATTEMPTS = 10;

/**
 * Simple password service that use argon2 hash alghoritm
 */
@Injectable(PasswordProvider)
export class BasicPasswordProvider implements PasswordProvider {
  @Config('rbac.password.generator')
  protected GeneratorOptions: { length: number; characters: string[] };

  @AutoinjectService('rbac.password.validation')
  protected Validation: PasswordValidationProvider;

  public async hash(input: string): Promise<string> {
    // uses default argon settings, no need to tweak
    return await argon.hash(input);
  }

  /**
   *
   * Checks if hash is valid for given password
   *
   * @param hash - hash to validate
   * @param password - password to validate
   */
  public async verify(hash: string, password: string): Promise<boolean> {
    return await argon.verify(hash, password);
  }

  /**
   * A random password drawn from `rbac.password.generator` and guaranteed to
   * satisfy `rbac.password.validation.rule`.
   *
   * The guarantee matters: a generated password is what a freshly created
   * account holds, and one that fails the application's own rule is a password
   * the account can never legitimately return to.
   *
   * @throws UnexpectedServerError when the configured pool cannot produce a
   *   password the rule accepts. That is a configuration fault nobody calling
   *   this can fix, so it must never reach a client as a 400.
   */
  public generate(): string {
    const length = this.GeneratorOptions?.length ?? 16;
    const pool = (this.GeneratorOptions?.characters ?? []).join('');

    if (length < 1 || pool.length === 0) {
      throw new UnexpectedServerError('rbac.password.generator must define a positive length and a non-empty character pool');
    }

    for (let attempt = 0; attempt < GENERATE_ATTEMPTS; attempt++) {
      // randomInt is the CSPRNG - Math.random is predictable from a handful of
      // outputs, and this value guards an account.
      const candidate = Array.from({ length }, () => pool[randomInt(pool.length)]).join('');

      if (this.Validation.check(candidate)) {
        return candidate;
      }
    }

    throw new UnexpectedServerError(`Could not generate a password satisfying rbac.password.validation.rule in ${GENERATE_ATTEMPTS} attempts. The generator character pool and the validation rule disagree - check rbac.password.generator.`);
  }
}
```

Leave `BasicPasswordValidationProvider` in the file unchanged.

- [ ] **Step 5: Update the `PasswordProvider` docstring**

In `packages/rbac/src/interfaces.ts`, replace the `generate` docstring:

```ts
  /**
   * Generates a random password drawn from `rbac.password.generator` and
   * satisfying `rbac.password.validation.rule`.
   */
  public abstract generate(): string;
```

- [ ] **Step 6: Run the tests**

Run: `cd packages/rbac && npx ts-mocha -p tsconfig.json test/password.test.ts`
Expected: PASS, 4 passing.

Run: `cd packages/rbac && npm test`
Expected: PASS. `entropy-string` is now unreferenced in `src/`; leave it in `package.json` — removing a dependency is a separate concern.

- [ ] **Step 7: Commit**

```bash
git add packages/rbac/src/config/rbac.ts packages/rbac/src/password.ts packages/rbac/src/interfaces.ts packages/rbac/test/password.test.ts
git commit -m "feat(rbac): generate passwords from config and guarantee they satisfy the validation rule"
```

---

### Task 2: `create()` validates a caller-supplied password

`changePassword()` runs its input through `PasswordValidationProvider` and refuses a password that fails the rule. `create()` does not — so a caller can plant a password the account may never legitimately return to.

**Files:**
- Modify: `packages/rbac/src/actions.ts` (`create`, around line 464)
- Test: `packages/rbac/test/actions.test.ts`

**Interfaces:**
- Consumes: `BasicPasswordProvider.generate()` from Task 1 (generated passwords are asserted there, so `create()` validates only the caller-supplied branch — no double check).
- Produces: `create()` throws `InvalidArgument(message, 'password')` for a non-compliant supplied password.

- [ ] **Step 1: Write the failing test**

Append inside the main `describe` in `packages/rbac/test/actions.test.ts`:

```ts
  /**
   * `changePassword` has always refused a password that fails the configured
   * rule. Creation accepting one plants a password the account can never
   * legitimately return to.
   */
  it('Should refuse a supplied password that does not meet requirements', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expect(create('weak@wp.pl', 'weakling', ['admin'], { password: 'short' })).to.be.rejectedWith(InvalidArgument, /does not meet requirements/);

    expect(await User.query().whereAnything('weak@wp.pl').first(), 'nothing may be written for a refused creation').to.not.exist;
  });

  it('Should accept a supplied password that meets requirements', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const { User: u } = await create('strong@wp.pl', 'strongman', ['admin'], { password: 'passw0rd123' });

    expect(u).to.be.instanceOf(User);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rbac && npx ts-mocha -p tsconfig.json test/actions.test.ts -g "does not meet requirements"`
Expected: FAIL — `'short'` is accepted and the account is created.

- [ ] **Step 3: Implement**

In `packages/rbac/src/actions.ts`, inside `create()`, replace the password block:

```ts
  // Whether the CALLER supplied a password decides who hands the account to its
  // owner, so it is read before `_default` fills a generated one in and the two
  // cases become indistinguishable.
  const generated = _check_arg(_trim(), _default(''))(options?.password, 'password') === '';

  email = _check_arg(_trim(), _non_empty(), _is_email(), _max_length(64))(email, 'email');
  login = _check_arg(_trim(), _non_empty(), _max_length(32))(login, 'login');

  const password = _check_arg(
    _trim(),
    _default(() => sPassword.generate()),
  )(options?.password, 'password');

  // Only the SUPPLIED branch is checked. A generated password is asserted
  // against the same rule inside `generate()`, and re-checking it here would
  // only re-report a configuration fault as a caller mistake.
  if (!generated) {
    const validator = await _service<PasswordValidationProvider>('rbac.password.validation', PasswordValidationProvider)();

    if (!validator.check(password)) {
      throw new InvalidArgument('Password does not meet requirements', 'password');
    }
  }
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/rbac && npm test`
Expected: PASS. If a pre-existing test creates an account with a password failing the default rule (`^(?=.*\d).{8,}$` — eight or more characters including a digit), fix the fixture password rather than the rule; `'bbbb'` fixtures must become e.g. `'bbbb1234'`.

- [ ] **Step 5: Commit**

```bash
git add packages/rbac/src/actions.ts packages/rbac/test/actions.test.ts
git commit -m "feat(rbac): validate a caller-supplied password in create()"
```

---

### Task 3: Role hygiene inside `create()`

`grant()` trims and rejects a blank role. `create()` does neither: `create(e, l, [])` writes an account with zero roles (the `User` constructor only defaults `Role` when it is nullish, and `[]` is not), and `['user', ' user ']` charges every downstream guard twice. `rbac-http-admin` has a private `roleList()` doing exactly this, which exists only to compensate.

**Files:**
- Modify: `packages/rbac/src/actions.ts`
- Test: `packages/rbac/test/actions.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export function roleList(role?: string | string[]): string[]` — trims, drops blanks, de-duplicates, preserves order. `create()` refuses an empty result with `InvalidArgument`.

- [ ] **Step 1: Write the failing test**

```ts
  it('Should trim and de-duplicate the role list', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const { User: u } = await create('roles@wp.pl', 'roleuser', ['admin', ' admin ', 'guest'], { password: 'passw0rd123' });

    expect(u.Role).to.have.members(['admin', 'guest']);
    expect(u.Role, 'a duplicate would be checked twice by every downstream guard').to.have.lengthOf(2);
  });

  /**
   * An account holding no role at all can do nothing and can only be repaired by
   * another administrator, so an empty list is refused rather than applied.
   */
  it('Should refuse a role list that names no role', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expect(create('noroles@wp.pl', 'noroles', [], { password: 'passw0rd123' })).to.be.rejectedWith(InvalidArgument, /At least one role/);
    await expect(create('blankroles@wp.pl', 'blankroles', ['  ', ''], { password: 'passw0rd123' })).to.be.rejectedWith(InvalidArgument, /At least one role/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rbac && npx ts-mocha -p tsconfig.json test/actions.test.ts -g "role list"`
Expected: FAIL — both accounts are created, the first with three roles.

- [ ] **Step 3: Implement**

Add to `packages/rbac/src/actions.ts`, immediately above `assertNoProtectedMetadata`:

```ts
/**
 * The roles a request denotes, whether it arrives as one name or a list.
 *
 * Trimmed, stripped of blanks and de-duplicated. Order is preserved so a caller
 * that treats the first entry as the primary role keeps that meaning.
 *
 * De-duplication is not cosmetic: every downstream guard is charged per entry,
 * so `['user', ' user ']` costs two checks for one role.
 *
 * @param role - a single role name or a list of them
 */
export function roleList(role?: string | string[]): string[] {
  if (role === undefined || role === null) {
    return [];
  }

  const wanted = (Array.isArray(role) ? role : [role]).map((r) => String(r ?? '').trim()).filter((r) => r.length > 0);

  return [...new Set(wanted)];
}
```

In `create()`, immediately after the `login` check and before the password block:

```ts
  const roleNames = roleList(roles);

  if (roleNames.length === 0) {
    throw new InvalidArgument('At least one role must be given', 'roles');
  }
```

Then use `roleNames` in place of `roles` in the `new User({ ... Role: roleNames ... })` literal.

- [ ] **Step 4: Run the tests**

Run: `cd packages/rbac && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rbac/src/actions.ts packages/rbac/test/actions.test.ts
git commit -m "feat(rbac): normalise and require the role list in create()"
```

---

### Task 4: Grants check in `create()` and `grant()`

Nothing in rbac checks a role against the configured grants. An account holding a bogus role inserts fine and fails later inside `accesscontrol`, far from whoever typed it. `yourscreen-backend`'s `addUserWithRole` implements the check locally — the right check in the wrong place.

`ac.hasRole()` resolves `$extend`-only roles correctly (verified: `system: { $extend: ['admin'] }` returns `true`), and `system` is present in both the shipped default grants and the backend's, so the system account is safe.

**Files:**
- Modify: `packages/rbac/src/actions.ts`
- Test: `packages/rbac/test/actions.test.ts`

**Interfaces:**
- Consumes: `roleList()` from Task 3.
- Produces: `export function assertRolesExist(roles: string[]): void`, throwing `InvalidArgument(message, 'roles')`. Used by `create()` and `grant()`.

- [ ] **Step 1: Write the failing test**

```ts
  /**
   * A role absent from the grants map inserts fine and then fails inside
   * accesscontrol, far from whoever typed it.
   */
  it('Should refuse a role that is not configured in grants', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expect(create('bogus@wp.pl', 'bogususer', ['not-a-role'], { password: 'passw0rd123' })).to.be.rejectedWith(InvalidArgument, /not configured in rbac.grants: not-a-role/);

    expect(await User.query().whereAnything('bogus@wp.pl').first()).to.not.exist;
  });

  it('Should refuse granting a role that is not configured in grants', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expect(grant('test@spinajs.pl', 'not-a-role')).to.be.rejectedWith(InvalidArgument, /not configured in rbac.grants/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rbac && npx ts-mocha -p tsconfig.json test/actions.test.ts -g "configured in grants"`
Expected: FAIL — both operations succeed.

- [ ] **Step 3: Implement**

Add to `packages/rbac/src/actions.ts`, next to `assertRolesExist`'s siblings:

```ts
/**
 * Refuses a role the application has not configured.
 *
 * Asked of the resolved {@link AccessControl} instance rather than of the raw
 * `rbac.grants` config, because AccessControl is what will reject the role
 * later - anything else can still diverge from it. `hasRole` resolves roles
 * defined only through `$extend`, so an inheritance-only role such as `system`
 * is recognised.
 *
 * @param roles - role names to check; every unknown name is reported at once
 */
export function assertRolesExist(roles: string[]): void {
  const ac = DI.get<AccessControl>('AccessControl');

  if (!ac) {
    // No grants loaded at all means the application has not configured rbac, not
    // that every role is invalid - refusing here would break bootstrap ordering.
    return;
  }

  const unknown = roles.filter((r) => !ac.hasRole(r));

  if (unknown.length > 0) {
    throw new InvalidArgument(`Role(s) not configured in rbac.grants: ${unknown.join(', ')}`, 'roles');
  }
}
```

Add `AccessControl` to the imports at the top of `actions.ts`:

```ts
import { AccessControl } from 'accesscontrol';
```

In `create()`, immediately after the empty-role check:

```ts
  assertRolesExist(roleNames);
```

In `grant()`, after the existing `_check_arg` on `role`:

```ts
export async function grant(identifier: number | string | User, role: string): Promise<User> {
  role = _check_arg(_trim(), _non_empty())(role, 'role');

  // A role you cannot create an account with must not be one you can add
  // afterwards - otherwise grant is a way around the creation check.
  assertRolesExist([role]);

  return _chain(
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/rbac && npm test`
Expected: PASS. Fixture roles in the test config must exist in `test/config`'s grants; if a test grants an ad-hoc role name, add it to the test grants rather than weakening the check.

- [ ] **Step 5: Commit**

```bash
git add packages/rbac/src/actions.ts packages/rbac/test/actions.test.ts
git commit -m "feat(rbac): refuse roles absent from the grants map in create() and grant()"
```

---

### Task 5: `options.isActive`

`yourscreen-backend`'s `addUserWithRole` sets `IsActive = true` and calls `update()` straight after `create()`. That is a second write, emits a `UserChanged`, and **skips `activate()`** — so no `UserActivated` event fires for any account created that way.

**Files:**
- Modify: `packages/rbac/src/actions.ts`
- Test: `packages/rbac/test/actions.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ICreateUserOptions.isActive?: boolean` (default `false`). When `true`, the row is inserted active and `UserActivated` is emitted. No `activated` email is sent — that mail is a transition notice and is wrong for an account 200ms old; the `created` mail already covers the moment.

- [ ] **Step 1: Write the failing test**

```ts
  /**
   * Callers that create an already-usable account used to flip `IsActive` with a
   * second update, which skipped `activate()` entirely - so no `UserActivated`
   * ever fired for those accounts.
   */
  it('Should create an active account and emit UserActivated', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const { User: u } = await create('live@wp.pl', 'liveuser', ['admin'], { password: 'passw0rd123', isActive: true });

    expect(u.IsActive).to.eq(true);
    expect((await User.query().whereAnything('live@wp.pl').firstOrFail()).IsActive, 'the active flag must be persisted by the insert, not a second write').to.eq(true);

    const events = eStub.args.map((a) => a[0] as any);
    expect(events.some((e) => e instanceof UserActivated), 'subscribers must hear about an account that is created active').to.eq(true);
  });

  it('Should create an inactive account by default', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const { User: u } = await create('dormant@wp.pl', 'dormant', ['admin'], { password: 'passw0rd123' });

    expect(u.IsActive).to.eq(false);
    expect(eStub.args.map((a) => a[0] as any).some((e) => e instanceof UserActivated)).to.eq(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rbac && npx ts-mocha -p tsconfig.json test/actions.test.ts -g "UserActivated"`
Expected: FAIL — `isActive` is not a recognised option, the account is inactive.

- [ ] **Step 3: Implement**

Add to `ICreateUserOptions` in `packages/rbac/src/actions.ts`:

```ts
  /**
   * Create the account already active. Defaults to false.
   *
   * The row is inserted active and {@link UserActivated} is emitted, so
   * subscribers hear about it exactly as they would for a later `activate()`.
   * No `activated` email is sent: that mail is a TRANSITION notice - "your
   * account was activated" to somebody who has been waiting - and is wrong for
   * an account that has existed for 200ms. The `created` mail covers this.
   */
  isActive?: boolean;
```

In `create()`, read it alongside the other options:

```ts
  const id = options?.id;
  const metadata = options?.metadata;
  const isActive = options?.isActive ?? false;
```

Use it in the model literal: `IsActive: isActive,`.

Then, in the chain, immediately after `_user_ev(UserCreated, ...)`:

```ts
    // An account created active never passes through `activate()`, so this is
    // the only place its subscribers can hear about it. After `UserCreated` so
    // the two arrive in the order a subscriber can act on.
    _either(
      () => isActive,
      _user_ev(UserActivated),
      async (u: User) => u,
    ),
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/rbac && npm test`
Expected: PASS. Existing tests asserting an exact `emit` call count for creation (`expect(eStub.callCount).to.eq(2)`) are unaffected — they do not pass `isActive`.

- [ ] **Step 5: Commit**

```bash
git add packages/rbac/src/actions.ts packages/rbac/test/actions.test.ts
git commit -m "feat(rbac): add isActive option to create() and emit UserActivated"
```

---

### Task 6: Suppress `UserMetadataChange` on the initial metadata write

`_set_user_meta` emits `UserMetadataChange`, and `create()` calls it right after the insert — two steps **before** `UserCreated`. A subscriber therefore receives a metadata-change event for a user it has never been told exists, and with a real transport may process it first.

**Files:**
- Modify: `packages/rbac/src/actions.ts`
- Test: `packages/rbac/test/actions.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `_set_user_meta(meta, value?, options?: { emitEvent?: boolean })` — `emitEvent` defaults to `true`, so every existing call site is unchanged. `create()` passes `false`.

- [ ] **Step 1: Write the failing test**

```ts
  /**
   * Initial metadata is part of the creation, not a change to it. Emitted as a
   * change it reaches subscribers BEFORE `UserCreated` - a modification to a
   * user they have never been told exists.
   */
  it('Should not emit UserMetadataChange for the metadata a user is created with', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await create('quiet@wp.pl', 'quietuser', ['admin'], {
      password: 'passw0rd123',
      metadata: { 'user:niceName': 'Quiet User' },
    });

    const events = eStub.args.map((a) => a[0] as any);
    expect(events.some((e) => e instanceof UserMetadataChange), 'creation metadata is not a metadata CHANGE').to.eq(false);
    expect(events.some((e) => e instanceof UserCreated)).to.eq(true);

    const stored = await User.query().whereAnything('quiet@wp.pl').populate('Metadata').firstOrFail();
    expect(stored.Metadata['user:niceName'], 'suppressing the event must not suppress the write').to.eq('Quiet User');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rbac && npx ts-mocha -p tsconfig.json test/actions.test.ts -g "UserMetadataChange for the metadata"`
Expected: FAIL — a `UserMetadataChange` is emitted.

- [ ] **Step 3: Implement**

Replace `_set_user_meta` in `packages/rbac/src/actions.ts`:

```ts
/**
 * Sets metadata key-value pairs on a user.
 * Accepts either an array of `{ key, value }` objects or a single metadata key string with a separate value.
 * Emits a {@link UserMetadataChange} event after the metadata is persisted.
 *
 * @param meta - metadata key (string) or array of `{ key, value }` entries to set
 * @param value - value to assign when `meta` is a single key string (default: `null`)
 * @param options - `emitEvent: false` writes silently. Used by `create()`: the
 *   metadata an account is created WITH is part of the creation, and emitted as
 *   a change it reaches subscribers before `UserCreated` - a modification to a
 *   user they have never been told exists.
 * @returns a function that receives a {@link User} and returns the updated user
 */
export function _set_user_meta(meta: string | { key: string; value: any }[], value: any = null, options?: { emitEvent?: boolean }) {
  return async (u: User) => {
    const mArgs = _check_arg(_non_nil(new UnexpectedServerError('User metadata not loaded')), _to_array())(meta, 'Metadata');

    mArgs.forEach((m: string | { key: string; value: any }) => {
      _.isString(m) ? (u.Metadata[m] = value) : (u.Metadata[m.key] = m.value);
    });

    await u.Metadata.update();

    if (options?.emitEvent ?? true) {
      await _user_ev(UserMetadataChange, () => {
        return mArgs.map((m: string | { key: string; value: any }) => {
          return _.isString(m) ? { key: m, value } : m;
        });
      })(u);
    }

    return u;
  };
}
```

In `create()`, pass the flag:

```ts
    _either(
      () => metadata !== undefined,
      _set_user_meta(metadata ? Object.entries(metadata).map(([key, value]) => ({ key, value })) : [], null, { emitEvent: false }),
      async (u: User) => u,
    ),
```

Note: the `UnexpectedServerError` above anticipates Task 10. If Task 10 has not run yet, keep `new ErrorCode(E_CODES.E_METADATA_NOT_POPULATED, 'User metadata not loaded', { user: u })` here and let Task 10 replace it.

- [ ] **Step 4: Run the tests**

Run: `cd packages/rbac && npm test`
Expected: PASS. The `Should create user with metadata` test asserts an `emit` count — re-check it: creation with metadata now emits one fewer message.

- [ ] **Step 5: Commit**

```bash
git add packages/rbac/src/actions.ts packages/rbac/test/actions.test.ts
git commit -m "fix(rbac): do not emit UserMetadataChange for metadata a user is created with"
```

---

### Task 7: Wrap the creation in a transaction

Any failure after `_insert()` currently leaves a persisted account plus a thrown error. The live case is `afterCreate`: `yourscreen-backend` mirrors into `SnClientUser` there, so a failed mirror leaves a half-created account.

**Files:**
- Modify: `packages/rbac/src/actions.ts`
- Test: `packages/rbac/test/actions.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6.
- Produces: `create()` runs `beforeCreate` → insert → metadata → `afterCreate` inside one transaction via `User.transaction(...)` (the static is installed by `Orm` from `MODEL_STATIC_MIXINS` and delegates to `OrmDriver.transaction`). Every queue emit happens **after** commit.

**Behaviour change to document:** `afterCreate` can now veto a creation. A middleware that throws rolls the whole account back, and it holds a transaction open for its full duration.

- [ ] **Step 1: Write the failing test**

```ts
  /**
   * `afterCreate` middleware writes to other systems - the legacy-user mirror is
   * one - so a failure there must not leave a half-created account standing.
   */
  it('Should roll the account back when afterCreate middleware throws', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const config = DI.get(Configuration)!;
    config.set('rbac.actions.create.afterCreate', [
      (() => {
        throw new Error('mirror is down');
      }) as unknown as CreateMiddleware,
    ]);

    try {
      await expect(create('rollback@wp.pl', 'rollback', ['admin'], { password: 'passw0rd123' })).to.be.rejectedWith(/mirror is down/);

      expect(await User.query().withDeleted().whereAnything('rollback@wp.pl').first(), 'a failed afterCreate must not leave an account behind').to.not.exist;
    } finally {
      config.set('rbac.actions.create.afterCreate', []);
    }
  });

  /**
   * Emits must happen after COMMIT: a message emitted inside a transaction that
   * later aborts announces an account that does not exist.
   */
  it('Should emit nothing when the creation rolls back', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const config = DI.get(Configuration)!;
    config.set('rbac.actions.create.afterCreate', [
      (() => {
        throw new Error('mirror is down');
      }) as unknown as CreateMiddleware,
    ]);

    try {
      await expect(create('silent@wp.pl', 'silent', ['admin'], { password: 'passw0rd123' })).to.be.rejected;

      expect(eStub.args.map((a) => a[0] as any).some((e) => e instanceof UserCreated), 'no UserCreated for an account that was rolled back').to.eq(false);
    } finally {
      config.set('rbac.actions.create.afterCreate', []);
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rbac && npx ts-mocha -p tsconfig.json test/actions.test.ts -g "roll the account back"`
Expected: FAIL — the account survives and `UserCreated` was emitted.

- [ ] **Step 3: Implement**

Restructure the tail of `create()`. The transaction covers the model construction through `afterCreate`; the emits follow it.

```ts
  // Everything that writes to the database happens in one transaction, both
  // middleware hooks included. `afterCreate` mirrors into other systems, and a
  // mirror row surviving a failed creation is exactly the corruption a
  // transaction exists to prevent - which also means an `afterCreate` that
  // throws now VETOES the creation, and holds the transaction open for as long
  // as it runs.
  //
  // The queue emits are deliberately outside: a message emitted inside a
  // transaction that later aborts announces an account that does not exist.
  const user = await User.transaction(async () => {
    return _chain<User>(
      // Ahead of everything else, and ahead of `beforeCreate` in particular: a
      // request that is about to be refused must not first run middleware that
      // writes to another system.
      _tap(() => assertNoProtectedMetadata(metadata)),
      _tap(() => assertUserUnique(login, email)),

      () =>
        Promise.resolve(
          new User({
            Id: id,
            Email: email,
            Login: login,
            Password: hPassword,
            Role: roleNames,
            RegisteredAt: DateTime.now(),
            CreatedAt: DateTime.now(),
            IsActive: isActive,
            Uuid: uuidv4(),
          }),
        ),

      (u: User) => _chain(u, ..._create_middleware('rbac.actions.create.beforeCreate')),

      _insert(),

      _either(
        () => metadata !== undefined,
        _set_user_meta(metadata ? Object.entries(metadata).map(([key, value]) => ({ key, value })) : [], null, { emitEvent: false }),
        async (u: User) => u,
      ),

      (u: User) => _chain(u, ..._create_middleware('rbac.actions.create.afterCreate')),
    );
  });

  return _chain<{ User: User; Password: string }>(
    () => Promise.resolve(user),

    _user_ev(UserCreated, (u: User) => u.toJSON()),

    _either(
      () => isActive,
      _user_ev(UserActivated),
      async (u: User) => u,
    ),

    _tap(_user_email('created')),

    _tap(async (u: User) => {
      if (!shouldSendReset) {
        return;
      }

      await _catch(
        () => passwordChangeRequest(u.Uuid),
        (err: Error) => {
          DI.resolve(Log, ['rbac']).error(err, `Could not issue the initial password reset for ${u.Uuid}. The account exists but its owner has no way in yet.`);
        },
      )();
    }),

    (u: User) => {
      return { User: u, Password: password };
    },
  );
```

`shouldSendReset` is introduced in Task 8; until then use `generated` in its place.

- [ ] **Step 4: Run the tests**

Run: `cd packages/rbac && npm test`
Expected: PASS.

- [ ] **Step 5: Document the veto in the config comment**

In `packages/rbac/src/config/rbac.ts`, extend the `actions` comment:

```ts
    /**
     * Middleware functions for user actions.
     * Each action can have before and after middleware arrays.
     * Middleware functions receive the User and should return the User.
     * eg. beforeCreate: [(u: User) => { u.Metadata['custom:key'] = 'value'; return u; }]
     *
     * Both hooks run INSIDE the creation transaction: a middleware that throws
     * rolls the whole account back, and one that does slow external work holds a
     * database transaction open for its full duration.
     */
```

- [ ] **Step 6: Commit**

```bash
git add packages/rbac/src/actions.ts packages/rbac/src/config/rbac.ts packages/rbac/test/actions.test.ts
git commit -m "feat(rbac): run create() database work and middleware in one transaction"
```

---

### Task 8: `options.sendPasswordReset`

The reset link currently fires whenever the password was generated, with no escape hatch — a fixture or seed script wanting a generated password and no mail has to supply a dummy password to silence it, which is how the generated-password path stops being used at all.

**Files:**
- Modify: `packages/rbac/src/actions.ts`
- Test: `packages/rbac/test/actions.test.ts`

**Interfaces:**
- Consumes: the restructured `create()` from Task 7.
- Produces: `ICreateUserOptions.sendPasswordReset?: boolean`. Unset → "when the password was generated". Explicit `true` sends the link even alongside a supplied password. Explicit `false` never sends.

- [ ] **Step 1: Write the failing test**

```ts
  it('Should not issue a reset link when explicitly told not to', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await create('nolink2@wp.pl', 'nolink2', ['admin'], { sendPasswordReset: false });

    const u = await User.query().whereAnything('nolink2@wp.pl').populate('Metadata').firstOrFail();
    expect(u.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN]).to.not.exist;
  });

  /**
   * Seeding an account with a temporary password AND inviting its owner to
   * replace it is a real case. An explicit flag must not be silently ignored.
   */
  it('Should issue a reset link alongside a supplied password when explicitly asked', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await create('bothways@wp.pl', 'bothways', ['admin'], { password: 'passw0rd123', sendPasswordReset: true });

    const u = await User.query().whereAnything('bothways@wp.pl').populate('Metadata').firstOrFail();
    expect(u.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN]).to.be.a('string');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rbac && npx ts-mocha -p tsconfig.json test/actions.test.ts -g "reset link"`
Expected: FAIL — the option is ignored in both directions.

- [ ] **Step 3: Implement**

Add to `ICreateUserOptions`:

```ts
  /**
   * Whether to mail the password-reset link that hands the account to its owner.
   *
   * Unset means "when the password was generated" - an account whose password
   * was invented here is unreachable without the link, and one whose password
   * the caller chose is the caller's to deliver.
   *
   * Explicit `true` sends the link even when a password was supplied: seeding an
   * account with a temporary password and inviting its owner to replace it is a
   * real case. Explicit `false` never sends - for fixtures and seed scripts that
   * want a generated password and no mail.
   */
  sendPasswordReset?: boolean;
```

In `create()`, next to `generated`:

```ts
  const shouldSendReset = options?.sendPasswordReset ?? generated;
```

The chain already reads `shouldSendReset` (Task 7, Step 3).

- [ ] **Step 4: Run the tests**

Run: `cd packages/rbac && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rbac/src/actions.ts packages/rbac/test/actions.test.ts
git commit -m "feat(rbac): add sendPasswordReset option to create()"
```

---

### Task 9: `_user_update` asserts uniqueness on rename

`assertUserUnique` guards `create()` and the admin PATCH route, but `_user_update` is exported and generic — any caller renaming an account through it skips the check and hits the unique index as a driver error.

**Files:**
- Modify: `packages/rbac/src/actions.ts` (`_user_update`, around line 221)
- Test: `packages/rbac/test/actions.test.ts`

**Interfaces:**
- Consumes: `assertUserUnique` (already exported).
- Produces: `_user_update(data?)` queries only when `data` carries `Email` or `Login`, so every other call site pays nothing.

- [ ] **Step 1: Write the failing test**

```ts
  it('Should refuse a rename onto a login another account already holds', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const u = await User.query().whereAnything('test-notactive@spinajs.pl').firstOrFail();

    await expect(_user_update({ Login: 'test' })(u)).to.be.rejectedWith(ResourceDuplicated, /already in use/);
  });

  it('Should let an account keep its own login on update', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const u = await User.query().whereAnything('test@spinajs.pl').firstOrFail();

    await expect(_user_update({ Login: u.Login })(u), 'an account must not clash with itself').to.be.fulfilled;
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rbac && npx ts-mocha -p tsconfig.json test/actions.test.ts -g "rename onto a login"`
Expected: FAIL — either it succeeds or it fails with a driver error rather than `ResourceDuplicated`.

- [ ] **Step 3: Implement**

Replace `_user_update`:

```ts
/**
 * Persists partial changes to a user record and emits a {@link UserChanged} event.
 *
 * A patch touching `Login` or `Email` goes through {@link assertUserUnique}
 * first: this function is exported and generic, so a caller renaming an account
 * through it would otherwise reach the unique index as a driver error rather
 * than a clean refusal. The query only runs when one of those keys is present,
 * so every other update pays nothing.
 *
 * @param data - optional partial user fields to merge into the existing record
 * @returns a function that receives a {@link User}, applies the update, and returns the user
 */
export function _user_update(data?: Partial<User>) {
  return async (u: User) => {
    if (data && (data.Login !== undefined || data.Email !== undefined)) {
      await assertUserUnique(data.Login !== u.Login ? data.Login : undefined, data.Email !== u.Email ? data.Email : undefined, u.Id);
    }

    await _chain(u, _update<User>(data), _user_ev(UserChanged));
    return u;
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/rbac && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rbac/src/actions.ts packages/rbac/test/actions.test.ts
git commit -m "feat(rbac): assert uniqueness when _user_update renames an account"
```

---

### Task 10: Delete `E_CODES`, throw semantic exceptions

**Files:**
- Modify: `packages/rbac/src/actions.ts`
- Modify: `packages/rbac/test/actions.test.ts`
- Modify: `packages/rbac-http-token/src/actions.ts` (comment only, around line 18)

**Interfaces:**
- Consumes: nothing.
- Produces: `E_CODES` no longer exists. Mapping, applied at every throw site in `actions.ts`:

| Old | New | Status |
|---|---|---|
| `E_USER_ALREADY_EXISTS` (`assertUserUnique`) | `ResourceDuplicated` + `parameter` array | 409 |
| `E_METADATA_NOT_POPULATED` (`_set_user_meta`, `_get_user_meta`) | `UnexpectedServerError` | 500 |
| `E_METADATA_NOT_FOUND` (`_get_user_meta`) | `UnexpectedServerError` | 500 |
| `E_NO_EMAIL_TEMPLATE` (`_user_email`) | `UnexpectedServerError` | 500 |
| `E_USER_BANNED` (`ban` / `unban`, already-in-state) | `InvalidArgument` | 400 |
| `E_PASSWORD_DOES_NOT_MEET_REQUIREMENTS` (`changePassword`) | `InvalidArgument(msg, 'password')` | 400 |
| Every throw inside `confirmPasswordReset` | collapsed at the boundary — Task 11 | 400 |
| `E_TOKEN_EXPIRED`, `E_TOKEN_INVALID`, `E_USER_NOT_ACTIVE`, `E_USER_NOT_FOUND`, `E_NOT_LOGGED`, `E_EMAIL_NOT_CONFIGURED` | unused or subsumed above; removed with the enum | — |

`AthenticationErrorCodes` is untouched: `E_LOGIN_ATTEMPTS_EXCEEDED` in `actions.ts:1025` and the three throws in `auth.ts` keep `ErrorCode`.

**`assertUserUnique` now carries the wire shape.** rbac attaches the ajv-shaped `parameter` array itself, so the admin controller's translation disappears (Task 12). The strings must stay byte-identical — `yourscreen-frontend` renders them.

- [ ] **Step 1: Write the failing test**

Replace the existing `Should name the clashing field when refusing a duplicate` test:

```ts
  /**
   * The refusal has to name WHICH field clashed, not only that something did.
   * `parameter` is ajv's own error shape, which the frontend already maps to a
   * form field - the same code path it uses for a 400.
   */
  it('Should name the clashing field when refusing a duplicate', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await create('clash@wp.pl', 'clashing', ['admin'], { password: 'passw0rd123' });

    const err = await create('clash@wp.pl', 'other-login', ['admin'], { password: 'passw0rd123' }).catch((e) => e);

    expect(err).to.be.instanceOf(ResourceDuplicated);
    expect(err.message).to.eq('Email already in use');
    expect(err.parameter).to.be.an('array').with.lengthOf(1);
    expect(err.parameter[0]).to.include({ instancePath: '/Email', keyword: 'duplicate' });
    expect(err.parameter[0].params).to.deep.eq({ field: 'Email' });

    const both = await create('clash@wp.pl', 'clashing', ['admin'], { password: 'passw0rd123' }).catch((e) => e);
    expect(both.message).to.eq('Login and Email already in use');
    expect(both.parameter.map((p: any) => p.instancePath)).to.have.members(['/Login', '/Email']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rbac && npx ts-mocha -p tsconfig.json test/actions.test.ts -g "clashing field"`
Expected: FAIL — an `ErrorCode` arrives, with no `parameter`.

- [ ] **Step 3: Rewrite `assertUserUnique`'s throw**

```ts
  if (clashes.length > 0) {
    const error = new ResourceDuplicated(`${clashes.join(' and ')} already in use`);

    // ajv's own error shape, attached here rather than by each http caller so
    // every route answering 409 reports the offending field the same way. A
    // client maps it with the same code path it already uses for a 400.
    //
    // A plain ResourceDuplicated on purpose: `__handle_error__` looks the
    // response up by `err.constructor.name`, so a subclass would miss the 409
    // mapping entirely and answer 500.
    Object.assign(error, {
      parameter: clashes.map((field) => ({
        instancePath: `/${field}`,
        keyword: 'duplicate',
        params: { field },
        message: `${field} already in use`,
      })),
    });

    throw error;
  }
```

- [ ] **Step 4: Replace the remaining throw sites**

Delete the `E_CODES` enum (lines 22–46) and apply the mapping table. Concretely:

```ts
// _set_user_meta
const mArgs = _check_arg(_non_nil(new UnexpectedServerError('User metadata not loaded')), _to_array())(meta, 'Metadata');

// _get_user_meta
_check_arg(_non_nil(new UnexpectedServerError('User metadata not loaded')))(u.Metadata, 'Metadata');
_check_arg(_non_nil(new UnexpectedServerError(`Metadata ${key} not found in user data`)))(u.Metadata[key], `Metadata.${key}`);

// _user_email
_check_arg(_non_nil(new UnexpectedServerError(`Email template ${cfgTemplate} not configured. Check rbac.email in config`)))(template, 'template');

// ban
throw new InvalidArgument('User is already banned');

// unban
throw new InvalidArgument('User is already unbanned');

// changePassword
throw new InvalidArgument('Password does not meet requirements', 'password');
```

Update the import line so `ErrorCode` is still imported (`auth.ts` codes and `E_LOGIN_ATTEMPTS_EXCEEDED` keep it) and `ResourceDuplicated`, `UnexpectedServerError` are added:

```ts
import { ErrorCode, InvalidArgument, ResourceDuplicated, UnexpectedServerError } from '@spinajs/exceptions';
```

- [ ] **Step 5: Update the `E_TOKEN_CODES` comment**

In `packages/rbac-http-token/src/actions.ts`, the comment at line 18 explains the name as avoiding a collision with rbac's `E_CODES`. Replace that reasoning:

```ts
/**
 * Failure codes carried by every {@link ErrorCode} this module throws.
 *
 * Named `E_TOKEN_CODES` because these are the TOKEN module's codes and nothing
 * else's — an `E_CODES` in a package re-exported alongside others invites an
 * `err.code === E_CODES.X` comparison against a code from a different enum,
 * which answers the wrong question while typechecking cleanly.
 */
```

- [ ] **Step 6: Run the tests**

Run: `cd packages/rbac && npm test`
Expected: PASS. `test/actions.test.ts` line 23 imports `E_CODES` — remove it from the import. `test/actions.test.ts` line 302's `err.code` assertion is replaced by Step 1's test.

Run: `cd packages/rbac-http-token && npm test`
Expected: PASS, 119 passing.

- [ ] **Step 7: Commit**

```bash
git add packages/rbac/src/actions.ts packages/rbac/test/actions.test.ts packages/rbac-http-token/src/actions.ts
git commit -m "refactor(rbac): replace E_CODES with semantic exceptions"
```

---

### Task 11: `confirmPasswordReset` collapses every rejection into one exception

`PasswordResetController.confirmReset` flattens every rejection into one opaque 400 because *"Distinguishing them would tell a caller which addresses exist and let them probe tokens by the error they get back."* Its guard is `err instanceof ErrorCode || err instanceof InvalidArgument`. Task 10 stops rbac throwing `ErrorCode` on that path, and `_get_user_meta` now throws `UnexpectedServerError` — which is **not** caught by that guard and would map to 500, and worse, a future throw-site change could map to 403/404 and turn an unauthenticated endpoint into an account-state oracle.

The fix is to collapse at the **action boundary** rather than at each throw site, so the guarantee survives any later change to what the inner steps throw.

`InvalidArgument` is the collapsed type: it maps to 400, matches the response the controller already returns, and is **already** matched by the existing guard — so there is no window in which the oracle is live, whatever order these commits land in.

**Files:**
- Modify: `packages/rbac/src/actions.ts` (`confirmPasswordReset`)
- Modify: `packages/rbac-http-user/src/controllers/PasswordResetController.ts` (around line 78)
- Test: `packages/rbac/test/actions.test.ts`, `packages/rbac-http-user/test/password-reset.test.ts`

**Interfaces:**
- Consumes: Task 10's exception mapping.
- Produces: `confirmPasswordReset` rejects with `InvalidArgument('Password reset token is invalid or has expired')` for **every** rejection reason. The real reason is logged at warn level with the user uuid.

- [ ] **Step 1: Write the failing test**

In `packages/rbac/test/actions.test.ts`:

```ts
  /**
   * The public reset endpoint must not become an account-state oracle. Every
   * rejection reason - unknown account, banned, deactivated, expired token,
   * wrong token - has to be indistinguishable from outside, and collapsing at
   * the ACTION boundary keeps that true however the inner steps change.
   */
  describe('password reset rejections are indistinguishable', () => {
    const reasons: Array<[string, () => Promise<unknown>]> = [];

    it('reports the same exception type and message for every rejection reason', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      const banned = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
      await passwordChangeRequest(banned.Uuid);
      await ban(banned.Uuid, 'reason', 100);

      const noToken = await User.query().whereAnything('test-notactive@spinajs.pl').firstOrFail();

      reasons.push(['banned', () => confirmPasswordReset(banned.Uuid, 'passw0rd123', 'whatever')]);
      reasons.push(['no token issued', () => confirmPasswordReset(noToken.Uuid, 'passw0rd123', 'whatever')]);

      for (const [label, run] of reasons) {
        const err = await run().catch((e) => e);

        expect(err, `${label} must reject`).to.be.instanceOf(InvalidArgument);
        expect(err.message, `${label} must not be distinguishable by message`).to.eq('Password reset token is invalid or has expired');
      }
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rbac && npx ts-mocha -p tsconfig.json test/actions.test.ts -g "indistinguishable"`
Expected: FAIL — the messages differ per reason.

- [ ] **Step 3: Implement the boundary collapse**

Rename the existing body to a private function and wrap it:

```ts
/**
 * Confirms a password reset by validating the token and expiration, then changing the password.
 *
 * EVERY rejection reason - unknown account, banned, deactivated, deleted,
 * expired token, wrong token, no token issued - rejects with the SAME exception
 * and the same message. Distinguishing them would tell an unauthenticated caller
 * which addresses exist and let them probe tokens by the error they get back.
 *
 * The collapse happens here, at the action boundary, rather than at each throw
 * site: the inner steps go through `_get_user_meta` and `changePassword`, whose
 * exception types are not this function's to control, and a future change to one
 * of them must not be able to reopen the oracle.
 *
 * The real reason is logged at warn level so an operator can still diagnose it.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User} instance
 * @param newPassword - the new plain-text password to set
 * @param token - the reset token that was issued by {@link passwordChangeRequest}
 */
export async function confirmPasswordReset(identifier: number | string | User, newPassword: string, token: string) {
  try {
    return await _confirm_password_reset(identifier, newPassword, token);
  } catch (err) {
    DI.resolve(Log, ['rbac']).warn(err as Error, `Password reset rejected`);

    throw new InvalidArgument('Password reset token is invalid or has expired');
  }
}

async function _confirm_password_reset(identifier: number | string | User, newPassword: string, token: string) {
  // ... the existing body, unchanged except that its ErrorCode throws become
  // InvalidArgument with their original messages - they are swallowed by the
  // wrapper above and exist only for the log line.
}
```

Inside `_confirm_password_reset`, the four `ErrorCode` throws become:

```ts
        throw new InvalidArgument(`Password reset refused: user is banned`);
        throw new InvalidArgument(`Password reset refused: user is not active`);
        throw new InvalidArgument(`Password change token expired, token expiration date is: ${dueDate.toISO()}`);
        throw new InvalidArgument(`Password change token invalid, operation not permitted`);
```

- [ ] **Step 4: Narrow the controller guard**

In `packages/rbac-http-user/src/controllers/PasswordResetController.ts`:

```ts
    } catch (err) {
      // One opaque failure for every rejection reason: unknown account, wrong
      // token, expired token. Distinguishing them would tell a caller which
      // addresses exist and let them probe tokens by the error they get back.
      //
      // `confirmPasswordReset` already collapses every rejection into a single
      // InvalidArgument at its own boundary, so this only has to recognise that
      // one type. Anything else is a genuine fault and is rethrown.
      const isRedemptionFailure = err instanceof InvalidArgument;
```

Drop the now-unused `ErrorCode` import if nothing else in the file uses it.

- [ ] **Step 5: Run the tests**

Run: `cd packages/rbac && npm test`
Expected: PASS.

Run: `cd packages/rbac-http-user && npm test`
Expected: PASS. `test/password-reset.test.ts:101` asserts the response body's `error.code === 'E_RESET_TOKEN_INVALID'` — that is the controller's own constant and is unaffected.

- [ ] **Step 6: Commit**

Both changes go in **one commit**: split apart, there is a window in which the reset endpoint distinguishes its rejection reasons.

```bash
git add packages/rbac/src/actions.ts packages/rbac/test/actions.test.ts packages/rbac-http-user/src/controllers/PasswordResetController.ts
git commit -m "fix(rbac): collapse every password-reset rejection into one exception at the action boundary"
```

---

### Task 12: `rbac-http-admin` drops its compensating code

**Files:**
- Modify: `packages/rbac-http-admin/src/controllers/Users/Users.ts`
- Test: `packages/rbac-http-admin/test/users-controller.test.ts`

**Interfaces:**
- Consumes: `roleList` (Task 3, now exported from rbac), `assertUserUnique` attaching `parameter` (Task 10).
- Produces: `asDuplicateResponse` and the private `roleList` are gone; `E_CODES` and `ErrorCode` are no longer imported.

- [ ] **Step 1: Run the existing suite to establish the baseline**

Run: `cd packages/rbac-http-admin && npm test`
Expected: PASS, 104 passing. Rebuild rbac first (`cd packages/rbac && npm run build`) or the new exports will not resolve.

- [ ] **Step 2: Delete `asDuplicateResponse` and unwrap its call sites**

Remove the whole `asDuplicateResponse` method. In `addUser`:

```ts
    const { User: created } = await create(data.Email, data.Login, roles, { metadata: data.Metadata });
```

In `updateUser`:

```ts
    if ((data.Login && data.Login !== user.Login) || (data.Email && data.Email !== user.Email)) {
      await assertUserUnique(data.Login !== user.Login ? data.Login : undefined, data.Email !== user.Email ? data.Email : undefined, user.Id);
    }
```

- [ ] **Step 3: Delete the private `roleList` and import rbac's**

Remove the local `function roleList(...)` and its docstring. Update the import:

```ts
import { assertUserUnique, create, deleteUser, roleList, User, _user_update, userModel } from '@spinajs/rbac';
```

Drop `ErrorCode` from the `@spinajs/exceptions` import if nothing else in the file uses it.

- [ ] **Step 4: Run the tests**

Run: `cd packages/rbac-http-admin && npx tsc --noEmit -p tsconfig.json`
Expected: no output.

Run: `cd packages/rbac-http-admin && npm test`
Expected: PASS, 104 passing. The 409 tests (`test/users-controller.test.ts` around lines 504–529) must pass **unchanged** — that is the proof the wire shape survived the move.

- [ ] **Step 5: Commit**

```bash
git add packages/rbac-http-admin/src/controllers/Users/Users.ts
git commit -m "refactor(rbac-http-admin): drop the duplicate rewrap and role normalisation now owned by rbac"
```

---

### Task 13: `rbac-http-admin` route documentation

The `addUser` docblock still describes behaviour that has moved, and the new refusals need documenting for the generated OpenAPI the frontend builds its client from.

**Files:**
- Modify: `packages/rbac-http-admin/src/controllers/Users/Users.ts` (the `addUser` and `updateUser` docblocks)

**Interfaces:**
- Consumes: everything above.
- Produces: no behaviour change; documentation only.

- [ ] **Step 1: Update the `addUser` docblock**

```ts
  /**
   * Create user (admin)
   * Creates a new user account with a system-generated password. The account is
   * created inactive and the password is never returned: a single-use password-reset
   * link is mailed to the address instead, so the owner sets their own password and nothing
   * has to travel back through an administrator. Activate the account once they have.
   * `Role` takes one role name or a list of them; every entry must exist in the configured
   * grants and is checked by the role guard, and one refused entry refuses the whole request.
   * @security cookieAuth
   * @returns {User} Created user account
   * @response 400 Validation error — missing required fields, invalid format, an empty role list, a role that is not configured, or a protected metadata key
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — createAny permission required, or a requested role grants more than the caller holds
   * @response 409 Login or email already in use, naming the clashing field in `parameter`
   */
```

- [ ] **Step 2: Update the `updateUser` `@response 409` line**

It already reads correctly; confirm the `@response 400` line mentions an unconfigured role is **not** possible here (PATCH does not create) and leave it otherwise.

- [ ] **Step 3: Run the tests**

Run: `cd packages/rbac-http-admin && npm test`
Expected: PASS, 104 passing.

- [ ] **Step 4: Commit**

```bash
git add packages/rbac-http-admin/src/controllers/Users/Users.ts
git commit -m "docs(rbac-http-admin): describe the create refusals rbac now owns"
```

---

### Task 14: `yourscreen-backend` follows

Two changes: `addUserWithRole` loses its local grants check (rbac does it now) and stops hand-patching `IsActive`, which restores the `UserActivated` event it currently skips.

**Files:**
- Modify: `yourscreen-backend/packages/features/src/users/actions/User.ts` (`addUserWithRole`)
- Verify: `yourscreen-backend/packages/backend/src/cli/MigrateLegacyUsers.ts`, `.../migrations/prod/DefaultSystemUser_2024_12_10_13_03_00.prod.ts`, `.../migrations/prod/PrimespotUser_2026_04_01_10_00_00.prod.ts` — already on the options-object signature, no edit expected.

**Interfaces:**
- Consumes: `ICreateUserOptions.isActive` (Task 5), `assertRolesExist` inside `create()` (Task 4).
- Produces: `addUserWithRole` unchanged in signature and return type.

- [ ] **Step 1: Rebuild rbac so the workspace link carries the new API**

Run: `cd c:/Users/grzch/SourceCodes/Spinajs/main/packages/rbac && npm run build`
Expected: compiles clean.

- [ ] **Step 2: Rewrite `addUserWithRole`'s body**

Delete the grants block:

```ts
  // roles must exist in rbac grants configuration - assigning an unknown role
  // would create a user that accesscontrol later rejects with "Role not found"
  const grants = DI.get(Configuration)?.get<{ [key: string]: unknown }>('rbac.grants', {}) ?? {};
  const unknownRoles = roles.filter((r) => !(r in grants));
  if (unknownRoles.length) {
    throw new InvalidArgument(`Role(s) not configured in rbac.grants: ${unknownRoles.join(', ')}`);
  }
```

and replace the create-then-activate pair:

```ts
  // `isActive` rather than a second write: patching the flag afterwards skipped
  // `activate()` entirely, so no UserActivated ever fired for an account created
  // through here. An omitted password makes create() generate one AND mail the
  // reset link that hands the account to its owner; a caller that passed one owns
  // delivery itself and gets no link.
  //
  // The role check that used to live here is `create()`'s now - it asks the
  // resolved AccessControl instance, which is what rejects the role later, so
  // the two can no longer disagree.
  const result = await create(email, login, roles, {
    password,
    isActive: true,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  });

  let otpAuthUrl: string | undefined;
  if (options?.enable2Fa) {
    otpAuthUrl = (await enableUser2Fa(result.User)) as string;
  }

  return { User: result.User, Password: result.Password, OtpAuthUrl: otpAuthUrl };
```

Drop the now-unused `Configuration`, `DI` and `InvalidArgument` imports if nothing else in the file uses them.

- [ ] **Step 3: Typecheck**

Run: `cd yourscreen-backend/packages/features && npx tsc --noEmit -p tsconfig.json`
Expected: no output.

Run: `cd yourscreen-backend/packages/backend && npx tsc --noEmit -p tsconfig.json`
Expected: only the pre-existing `@types/luxon` identity errors in `src/migrations/prod/InitialYourscreen_2023_08_09_01_13_00.prod.ts`. Any other error is yours.

- [ ] **Step 4: Run the backend tests**

Run: `cd yourscreen-backend && npm test`
Expected: PASS. A test asserting that `addUserWithRole` throws for an unknown role now gets the message from rbac — the text is identical (`Role(s) not configured in rbac.grants: ...`), so the assertion should hold; the exception type changes from the locally-thrown `InvalidArgument` to rbac's, which is also `InvalidArgument`.

- [ ] **Step 5: Commit**

```bash
git add packages/features/src/users/actions/User.ts
git commit -m "refactor(users): let rbac own the role check and activate on create"
```

---

### Task 15: `yourscreen-frontend` verification

No source change is expected. The 409 body keeps its shape (`parameter` with `instancePath`, `keyword: 'duplicate'`, `params.field`) and its message strings byte-for-byte; only the layer that attaches it moved. This task proves that rather than assuming it.

**Files:**
- Verify: `yourscreen-frontend/src/lib/api/base.ts` (around line 202), `src/components/form/Form.tsx`
- Verify: `src/app/(dashboard)/admin/users/forms/__tests__/user.test.tsx` (around line 308), `src/components/form/__tests__/Form.test.tsx` (around line 113)

**Interfaces:**
- Consumes: the 409 body produced by `assertUserUnique` (Task 10).
- Produces: nothing.

- [ ] **Step 1: Confirm the fixtures still describe the real payload**

Read `src/components/form/__tests__/Form.test.tsx` around line 113 and `src/app/(dashboard)/admin/users/forms/__tests__/user.test.tsx` around line 308. Both build a 409 fixture with `message: 'Email already in use'` / `'Login and Email already in use'` and `parameter` entries `{ instancePath: '/Email', keyword: 'duplicate', params: { field: 'Email' } }`.

Compare against Task 10's `assertUserUnique`. They must match exactly. If they do not, the backend change is wrong — fix rbac, not the fixture.

- [ ] **Step 2: Run the frontend test suite**

Run: `cd yourscreen-frontend && npm test`
Expected: PASS with no changes. A failure here means the wire contract moved and Task 10 needs correcting.

- [ ] **Step 3: Check the generated API client is still accurate**

The admin API's request and response schemas are unchanged — no new field, no removed field, no changed status code. Regeneration is therefore expected to be a no-op. Confirm by running:

Run: `cd yourscreen-frontend && npm run openapi`
Then: `git status --short src/openapi-client`
Expected: no modified files. If files change, inspect the diff before committing — a changed schema means the backend contract moved after all.

Note this regenerates from a running backend's OpenAPI document, so it needs the backend up. If that is inconvenient, skipping this step is acceptable: Steps 1–2 already prove the response contract the frontend actually parses, and the request schema is untouched by this plan.

- [ ] **Step 4: Commit only if something changed**

If Steps 1–3 produced no diff, there is nothing to commit and the task is complete. Record that in the PR description: *"frontend verified unchanged — 409 contract preserved."*

---

## Verification

After every task:

```bash
cd c:/Users/grzch/SourceCodes/Spinajs/main/packages/rbac            && npm run build && npm test
cd c:/Users/grzch/SourceCodes/Spinajs/main/packages/rbac-http       && npx tsc --noEmit -p tsconfig.json
cd c:/Users/grzch/SourceCodes/Spinajs/main/packages/rbac-http-user  && npm test
cd c:/Users/grzch/SourceCodes/Spinajs/main/packages/rbac-http-admin && npm test
cd c:/Users/grzch/SourceCodes/Spinajs/main/packages/rbac-http-token && npm test
cd c:/Users/grzch/SourceCodes/Screennetwork/agentic_development/agent-3/yourscreen-backend  && npm test
cd c:/Users/grzch/SourceCodes/Screennetwork/agentic_development/agent-3/yourscreen-frontend && npm test
```

Expected baselines before any change: rbac 245 passing, rbac-http-admin 104 passing, rbac-http-token 119 passing.

## Not in scope

- Publishing rbac or bumping the dependency in `yourscreen-backend`. The workspace link carries the change locally; a release is a separate decision.
- `AthenticationErrorCodes` and the `LoginController` guard.
- Removing `entropy-string` from `packages/rbac/package.json`.
- `deleteUser`'s delete semantics — `User.DeletedAt` carries `@SoftDelete()`, so `destroy()` already soft-deletes and both delete paths already agree.
