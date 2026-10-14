# Lane L7: rbac removal

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `00-overview.md` first (Global Constraints apply to every task).

**Goal:** Remove the RBAC SQL compiler (`packages/authz-rbac/src/orm/**`), its benchmark and tests, and the SQL form of DB rules, so `authz-rbac` keeps check-only rules and no longer depends on the old `@spinajs/authz-orm` at runtime.

**Architecture:** Pure deletion plus three small moves: `AUTHZ_ASSIGNMENT_TABLE` moves into `src/stores/assignment-row.ts`; `src/stores/rule-sql-form.ts` becomes `src/stores/rule-rows.ts` (the `definition` JSON row plus the `authz_rule_subject` rows `scope.forget` needs); `DbRuleStore` stores any rule the admin handler accepted. The list-filterability refusal of rules comes back in L8 (ListSupportGuard), not here.

**Tech Stack:** TypeScript, mocha/chai, `@spinajs/orm` (SQLite, PostgreSQL in tests).

**Depends on:** nothing (wave 1).

**Blocks:** L6 and L8 (merge L7 first; both edit `authz-rbac`).

## Global Constraints

- English everywhere; comments only where a reader would ask "why?".
- 3.0 is unreleased: `AuthzRbac_2026_10_01_00_00_00` is edited in place.
- Every task ends with `cd packages/authz-rbac && npm test` green (Postgres suites skip themselves without the server on `127.0.0.1:15432`).
- Do not touch `packages/authz-rbac/src/contracts.ts` (L0 owns it), `src/model/native.ts` logic, `src/model/rules/native.ts`, ABAC `scopeResiduals` or `native:condition.scope` (L8/L10 own them).
- Commit after each task.

## Files

| Action | Path |
|---|---|
| Delete | `packages/authz-rbac/src/orm/**` (20 files: `index.ts`, `scope-path.ts`, `role-graph.ts`, `rbac-orm-compiler.ts`, `condition-scope-compiler.ts`, `orm-sources.ts`, `compile/{attributes,boot,classes,db-rules,dialect,index,kleene,path,route,rules,scope-leaf,sql,sqlite-depth,stored-rule}.ts`) |
| Delete | `packages/authz-rbac/bench/**` (`.gitignore`, `BASELINE.md`, `RESULTS.md`, `lib.ts`, `run.ts`, `scenarios/01-canvas-file-list.ts`, `tsconfig.json`) |
| Delete | `packages/authz-rbac/test/orm/**` (`compiler.test.ts`, `execution.test.ts`, `fixture.ts`, `intersect.ts`, `orm-world.ts`, `root-orm.ts`) |
| Delete | `packages/authz-rbac/test/orm-compile/**` (31 files) |
| Delete | `packages/authz-rbac/test/ported/active-role-orm.test.ts` (tests `OrmScope` list scoping) |
| Delete | `packages/authz-rbac/test/stores/rule-sql-form.test.ts` |
| Delete | `packages/authz-testing/test/canvas-c6/**` (see Task 5 for the list) |
| Rename+rewrite | `packages/authz-rbac/src/stores/rule-sql-form.ts` → `src/stores/rule-rows.ts` |
| Modify | `packages/authz-rbac/src/stores/assignment-row.ts:6`, `src/stores/index.ts:7`, `src/stores/db-rule-store.ts`, `src/index.ts:7`, `src/admin/ports.ts:44-45`, `src/model/native.ts:150-153`, `src/model/rules/args.ts:7-11`, `src/migrations/AuthzRbac_2026_10_01_00_00_00.ts:3-6,29-69`, `package.json` |
| Modify (tests) | `test/cli/check-config.test.ts:15-16,208-216`, `test/integration/stores.db.test.ts`, `test/stores/db-rule-store.test.ts`, `test/migrations/authz-rbac-initial.test.ts`, `test/admin/behaviour.test.ts:7` |
| Modify | `packages/authz-testing/src/behaviour/B43-authz-admin.spec.ts:110-111,167`, `packages/users/test/support/users-db.ts:75` |

---

### Task 1: Own `AUTHZ_ASSIGNMENT_TABLE` in the stores

**Files:**
- Modify: `packages/authz-rbac/src/stores/assignment-row.ts:6`
- Modify: `packages/authz-rbac/src/orm/rbac-orm-compiler.ts:30` (deleted in Task 3; this keeps the build green until then)

**Interfaces:**
- Produces: `AUTHZ_ASSIGNMENT_TABLE = 'authz_assignment'` exported from `src/stores/assignment-row.ts` (and so from `src/index.ts`). `test/integration/db-harness.ts:10` and `users`/`users-http` already import it from the package root; they need no change.

- [ ] **Step 1: Move the constant**

In `src/stores/assignment-row.ts` replace line 6

```ts
export { AUTHZ_ASSIGNMENT_TABLE } from '../orm/rbac-orm-compiler.js';
```

with

```ts
export const AUTHZ_ASSIGNMENT_TABLE = 'authz_assignment';
```

In `src/orm/rbac-orm-compiler.ts` replace line 30 `export const AUTHZ_ASSIGNMENT_TABLE = 'authz_assignment';` with an import added to the import block:

```ts
import { AUTHZ_ASSIGNMENT_TABLE } from '../stores/assignment-row.js';
```

(Two modules exporting the same name through `src/index.ts` would be a TS2308 error.)

- [ ] **Step 2: Run the package tests**

Run: `cd packages/authz-rbac && npm test`
Expected: compile succeeds, `N passing`, `0 failing`.

- [ ] **Step 3: Commit**

```bash
git add packages/authz-rbac/src/stores/assignment-row.ts packages/authz-rbac/src/orm/rbac-orm-compiler.ts
git commit -m "refactor(authz-rbac): AUTHZ_ASSIGNMENT_TABLE lives in stores/assignment-row"
```

---

### Task 2: Cut the test dependencies on the compiler fixtures

**Files:**
- Modify: `packages/authz-rbac/test/cli/check-config.test.ts`
- Modify: `packages/authz-rbac/test/integration/stores.db.test.ts`

**Interfaces:**
- Consumes: `bootDb(ctx, 'sqlite', suite, { migrate: false })` and `TestDb` from `test/support/db.ts` (existing: `driver`, `dispose()`).

- [ ] **Step 1: Replace `bootSqlite` in check-config.test.ts**

Replace lines 15-16

```ts
import { bootSqlite } from '../orm/fixture.js';
import type { BootedDb } from '../orm/fixture.js';
```

with

```ts
import { bootDb } from '../support/db.js';
import type { TestDb } from '../support/db.js';
```

Replace the `--unattended` setup (lines 208-216)

```ts
  describe('--unattended', function () {
    this.timeout(30000);
    let db: BootedDb;
    before(async () => {
      db = await bootSqlite();
    });
    after(async () => {
      await db.close();
    });
```

with

```ts
  describe('--unattended', function () {
    this.timeout(30000);
    let db: TestDb;
    before(async function () {
      // No migrations: the case "table absent" needs a database without authz_audit.
      db = await bootDb(this, 'sqlite', 'check_config', { migrate: false });
    });
    after(async () => {
      await db?.dispose();
    });
```

`withOrm` keeps `db.driver`; nothing else in the file changes.

- [ ] **Step 2: Drop the SQL parity step from stores.db.test.ts**

Edit `test/integration/stores.db.test.ts`:

1. Imports (lines 5-21) become:

```ts
import { AuthzConfigError, CORE_FILTER_OPS, GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AuthzService, Permission } from '@spinajs/authz';
import { BEHAVIOUR_FIXTURES, fixtureDsl, modelSteps, runBehaviour, userPrincipal } from '@spinajs/authz-testing';
import type { DecisionExpectation, HostSetup, Step, World } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AssignCommand, RevokeCommand } from '../../src/cli/index.js';
import { AuthzAdminIdempotency_2026_10_02_00_01_00, AuthzRbac_2026_10_01_00_00_00, DbAssignmentStore, DbAuthzAdminBackend, RBAC_ASSIGNMENT_OP, rbacAssignmentExtension, readVersion } from '../../src/index.js';
import { capture } from '../cli/fixture.js';
import { bootDb, DB_KINDS, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { activeDb, dbHarness } from './db-harness.js';
import type { DbHarnessStores } from './db-harness.js';
```

2. Delete `sqlDocs` (the doc comment at line 82 through the end of the function, line 100) and `parity` (lines 102-119).

3. Replace `const e2eFixture = (dbOf: () => TestDb | undefined) =>` with `const e2eFixture =` and, in its case, delete `, parity(dbOf)` at the end of `steps`. Change the case `name` to `'config roles and DB rows decide at GLOBAL and at scopes'` and the part `note` to `'ConfigRoleStore (roles in the configuration) and DbAssignmentStore rows under the RbacModel: checks at GLOBAL and at scopes.'`.

4. In the `for (const kind of DB_KINDS)` block delete the `doc` table creation and seeding in `before` (keep `db = await bootDb(this, kind, 'e2e');`) and change the runner to `fixtures: [...BEHAVIOUR_FIXTURES, e2eFixture]`.

5. If `HostSetup` or `StepContext` is now unused, drop it from the type import (`tsc` reports it under `noUnusedLocals` if enabled; otherwise lint does).

- [ ] **Step 3: Run the package tests**

Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing`; the e2e case title is the new one.

- [ ] **Step 4: Commit**

```bash
git add packages/authz-rbac/test/cli/check-config.test.ts packages/authz-rbac/test/integration/stores.db.test.ts
git commit -m "test(authz-rbac): no test outside test/orm uses the compiler fixtures"
```

---

### Task 3: Delete the compiler, its tests and the benchmark

**Files:**
- Delete: `packages/authz-rbac/src/orm/`, `packages/authz-rbac/test/orm/`, `packages/authz-rbac/test/orm-compile/`, `packages/authz-rbac/test/ported/active-role-orm.test.ts`, `packages/authz-rbac/bench/`
- Modify: `packages/authz-rbac/src/index.ts:7`, `src/model/native.ts:150-153`, `src/model/rules/args.ts:7-11`, `packages/authz-rbac/package.json`, `packages/users/test/support/users-db.ts:75`

- [ ] **Step 1: Delete**

```bash
git rm -r -q packages/authz-rbac/src/orm packages/authz-rbac/test/orm packages/authz-rbac/test/orm-compile packages/authz-rbac/bench packages/authz-rbac/test/ported/active-role-orm.test.ts
```

- [ ] **Step 2: Remove the export and the stale comments**

`src/index.ts`: delete the line `export * from './orm/index.js';`.

`src/model/native.ts` lines 150-153: replace

```ts
 * `under` over the assignment scopes, and registers its in-memory filter. Use it for types whose
 * adapters compile the op (authz-orm's RbacOrmCompiler). `types` limits the native term to those
```

with

```ts
 * `under` over the assignment scopes, and registers its in-memory filter. Use it for types whose
 * adapters compile the op. `types` limits the native term to those
```

`src/model/rules/args.ts` line 10: replace `` * NativeFilters of rbacAssignmentExtension with `rules: true` and the SQL of RbacOrmCompiler. `` with `` * NativeFilters of rbacAssignmentExtension with `rules: true`. ``

- [ ] **Step 3: Verify nothing else imports the removed code**

Run: `cd packages/authz-rbac && grep -rnE "orm/index|rbac-orm-compiler|orm-compile|test/orm/|RbacOrmCompiler|RbacScopePathSource|RbacRoleGraphSource|RbacModelRoleGraphSource|ConditionScopeCompiler|@spinajs/authz-orm" src test`
Expected: only `test/admin/db/backend.test.ts:10: import { DbScopeAttributeStore } from '@spinajs/authz-orm';` (kept: scope attributes stay in the new authz-orm, design §9) and `src/cli/commands/check-config.ts:111` (message text only).

- [ ] **Step 4: package.json**

In `packages/authz-rbac/package.json`:
- delete the script line `"bench": "node --no-warnings --loader ts-node/esm --experimental-specifier-resolution=node bench/run.ts",`;
- move `"@spinajs/authz-orm": "3.0.0-alpha.0"` from `dependencies` to `devDependencies` (no file under `src/` imports it any more; only `test/admin/db/backend.test.ts` does). Keep the `../authz-orm/tsconfig.json` reference in `tsconfig.json`: the tests still compile against it.

- [ ] **Step 5: users test registry**

`packages/users/test/support/users-db.ts` line 75: delete `'RbacOrmCompiler',`. Leave `'OrmNativeCompiler'` (L5 owns the authz-orm names).

- [ ] **Step 6: Run the package tests**

Run: `cd packages/authz-rbac && npm test`
Expected: compile succeeds, `0 failing`. The pass count drops (the orm and orm-compile suites are gone).

Note for the merger: `users`, `configuration-http` and `authz-queue` tests that list `@AccessResource` models through the old authz-orm middleware with `native:rbac.assignment` residuals lose their compiler here. L3/L5 replace that path; do not gate L7 on those packages.

- [ ] **Step 7: Commit**

```bash
git add -A packages/authz-rbac packages/users/test/support/users-db.ts
git commit -m "chore(authz-rbac): delete the RBAC SQL compiler, its tests and the bench (design §9)"
```

---

### Task 4: Rules are check-only: `rule-rows.ts`, `DbRuleStore`, the `authz_rule` table

**Files:**
- Rename + rewrite: `packages/authz-rbac/src/stores/rule-sql-form.ts` → `src/stores/rule-rows.ts`
- Modify: `src/stores/index.ts:7`, `src/stores/db-rule-store.ts`, `src/admin/ports.ts:44-45`, `src/migrations/AuthzRbac_2026_10_01_00_00_00.ts`
- Modify: `packages/authz-testing/src/behaviour/B43-authz-admin.spec.ts:110-111,167`
- Delete: `test/stores/rule-sql-form.test.ts`
- Test: `test/stores/db-rule-store.test.ts`, `test/migrations/authz-rbac-initial.test.ts`, `test/admin/behaviour.test.ts`

**Interfaces:**
- Produces: `toRuleRows(rule: Omit<RuleDef, 'source'>): RuleRows`, `RuleColumns`, `RuleRow`, `RuleSubjectRow`, `RuleSubjectList`, `AUTHZ_RULE_TABLE`, `AUTHZ_RULE_SUBJECT_TABLE` (all from `src/stores/rule-rows.ts`, re-exported by the package). `DbRuleStore.put(rule, actor, tx)` and `DbRuleStore.assertStorable(rule)` keep their signatures; `putWithLadders`, `toSqlForm`, `fromSqlForm`, `likeToGlob`, `escapeLike`, `SQL_WHEN_OPS`, `SqlWhenOp`, `SqlFormRule`, `RuleSqlForm`, `RuleSubjectRowLike` are removed.
- `authz_rule` columns after this task: `id, kind, scope_type, scope_id, definition, expires_at, created_by, created_at`.

- [ ] **Step 1: Write the failing store tests**

In `test/stores/db-rule-store.test.ts`:

1. Import line 12 becomes

```ts
import { AdminRuleStore, AuthzRbac_2026_10_01_00_00_00, DbRuleStore, readVersion, RoleStore, RULE_LIST_MAX_LIMIT, RuleStore, toDate, toRuleRows } from '../../src/index.js';
```

and drop `import type { LadderDef } ...` (line 13) and the unused `matchGlob, matchWildcard` from line 5 once the "patterns" block is gone.

2. The `put` helper (line 55) becomes

```ts
    const put = (r: Rule) => inTx((tx) => store.put(r, root, tx));
```

3. Replace every `store.putWithLadders(X, KIT_LADDERS, root, tx)` / `s.putWithLadders(...)` / `new Blind(db.container).putWithLadders(...)` (lines 237, 264, 282, 429, 569, 570, 581) with `.put(X, root, tx)` on the same receiver. Calls `put(r, ladders)` with a second argument become `put(r)`.

4. Delete these `it` blocks: line 117 ("put reads the ladders…"), 138 ("put refuses without a RoleStore…"), 149 ("put refuses a ladder that two RoleStores define…"), 157, 169, 174 (the three `assertStorable` cases), 200 ("stores every kit and §8.5 rule as toSqlForm says…"), 247 ("refuses a rule outside SQL form…"), and the whole `describe('patterns on this database', …)` block (lines 354-397).

5. Add in `describe('AdminRuleStore port', …)`:

```ts
      it('put needs no RoleStore: a stored rule is its definition, read back as written', async () => {
        const bare = new DbRuleStore(db.container.child());
        await inTx((tx) => bare.put(restrict('r1', F1), root, tx));
        expect(await store.byId('r1')).to.deep.eq(stored(restrict('r1', F1)));
      });

      it('assertStorable refuses only what the columns cannot hold, as invalid_command', () => {
        const long = (n: number) => 'x'.repeat(n);
        const refused = (rule: Rule, field: string) => {
          let err: unknown;
          try {
            store.assertStorable(rule);
          } catch (e) {
            err = e;
          }
          expect(err, field).to.be.instanceOf(AuthzAdminFailure);
          expect(err, field).to.include({ code: 'invalid_command', field });
        };
        refused(restrict(long(161), F1), 'rule.id');
        refused(restrict('r1', { type: 'file', id: long(65) }), 'rule.scope');
        refused(restrict('r1', F1, { allow: [{ type: 'user', id: long(65) }] }), 'rule.allow');
        refused({ id: 'c', kind: 'cap', scope: P1, stripTags: true, subjects: { refs: [{ type: long(33), id: 'a' }] } }, 'rule.subjects.refs');
        expect(() => store.assertStorable({ id: 't', kind: 'threshold', scope: P1, permissions: ['file:*'], minRole: 'ghost', resource: { attr: 'resource.name', glob: 'a*b*' } })).to.not.throw();
      });
```

6. In `describe('put', …)` add:

```ts
      it('stores every kit and §8.5 rule as its definition and reads it back unchanged', async () => {
        for (const rule of [...kitRuleSets().flatMap((s) => s.rules), ...CANVAS_RULES]) {
          await put(rule);
          expect(await store.byId(rule.id), rule.id).to.deep.eq(stored(rule));
          const [row] = (await db.driver.select().from('authz_rule').where('id', rule.id)) as Row[];
          expect(Object.keys(row).sort(), rule.id).to.deep.eq(['created_at', 'created_by', 'definition', 'expires_at', 'id', 'kind', 'scope_id', 'scope_type']);
        }
      });

      it('stores a rule the old SQL form refused (a resource glob with two stars)', async () => {
        const rule: Rule = { id: 'g', kind: 'threshold', scope: P1, permissions: ['file:edit'], minRole: 'maintainer', resource: { attr: 'resource.name', glob: 'a*b*' } };
        await put(rule);
        expect(await store.byId('g')).to.deep.eq(stored(rule));
      });

      it('toRuleRows writes the allow and refs lists as subject rows, deduplicated and sorted', () => {
        const rows = toRuleRows({ id: 'r', kind: 'restrict', scope: P1, allow: [alice, g1Members, alice] });
        expect(rows.subjects).to.deep.eq([
          { rule_id: 'r', list: 'allow', subject_type: 'group', subject_id: 'g1', subject_role: 'group.member' },
          { rule_id: 'r', list: 'allow', subject_type: 'user', subject_id: 'alice', subject_role: '' },
        ]);
        expect(rows.rule).to.deep.include({ id: 'r', kind: 'restrict', scope_type: 'project', scope_id: 'p1', expires_at: null });
        expect(JSON.parse(rows.rule.definition)).to.deep.eq({ kind: 'restrict', allow: [alice, g1Members, alice] });
      });
```

If `CANVAS_LADDERS`, `KIT_LADDERS` become unused imports, remove them from line 15.

7. In `test/migrations/authz-rbac-initial.test.ts` replace the `authz_rule` entry of `SCHEMA` (lines 36-73) with

```ts
  authz_rule: [
    ['id', 'string', 160, false],
    ['kind', 'string', 16, false],
    ['scope_type', 'string', 64, false],
    ['scope_id', 'string', 64, false],
    ['definition', 'text', null, false],
    ['expires_at', 'datetime', null, true],
    ['created_by', 'string', 100, true],
    ['created_at', 'datetime', null, false],
  ],
```

replace the test `'authz_rule defaults drops and strip_tags to false and the scope to $global'` with

```ts
    it('authz_rule defaults the scope to $global', async () => {
      await insert(db.driver, 'authz_rule', { id: 'r1', kind: 'restrict', definition: '{}', created_at: NOW });

      const r = await row(db.driver, 'authz_rule', { id: 'r1' });
      expect(r.scope_type).to.eq('$global');
      expect(r.scope_id).to.eq('');
      expect(r.expires_at).to.eq(null);
      expect(r.created_by).to.eq(null);
    });
```

and delete the test `'authz_rule stores the SQL form columns'`. Line 18's comment becomes `/** [name, kind, varchar length, nullable] in design §9.1 order. */`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/authz-rbac && npm test`
Expected: compile FAILS with `Module '"../../src/index.js"' has no exported member 'toRuleRows'`.

- [ ] **Step 3: Write `src/stores/rule-rows.ts`**

```bash
git mv packages/authz-rbac/src/stores/rule-sql-form.ts packages/authz-rbac/src/stores/rule-rows.ts
```

Replace the whole file with:

```ts
import { AuthzAdminFailure } from '@spinajs/authz';
import type { AssignmentSubject, PrincipalRef, RuleDef } from '@spinajs/authz';

import { scopeToColumns, subjectToColumns } from './columns.js';
import type { SubjectColumns } from './columns.js';

export const AUTHZ_RULE_TABLE = 'authz_rule';
export const AUTHZ_RULE_SUBJECT_TABLE = 'authz_rule_subject';

export type RuleSubjectList = 'allow' | 'refs';

/** The `authz_rule` values of one rule, except `created_*`. */
export interface RuleColumns {
  readonly id: string;
  readonly kind: RuleDef['kind'];
  readonly scope_type: string;
  readonly scope_id: string;
  /** The rule as JSON without `id`, `scope` and `expiresAt` (their columns hold them). */
  readonly definition: string;
  readonly expires_at: Date | null;
}

export interface RuleSubjectRow extends SubjectColumns {
  readonly rule_id: string;
  readonly list: RuleSubjectList;
}

/** An `authz_rule` row as a driver returns it (datetimes as text on SQLite). */
export type RuleRow = { readonly [K in keyof RuleColumns]: unknown } & { readonly created_by?: unknown; readonly created_at?: unknown };

export interface RuleRows {
  readonly rule: RuleColumns;
  /** `allow` and `subjects.refs`, deduplicated, sorted by (list, type, id, role). */
  readonly subjects: readonly RuleSubjectRow[];
}

/** varchar lengths of design §9.1 (Postgres enforces them; SQLite does not). */
const LEN = { id: 160, scopeType: 64, scopeId: 64, subjectType: 32, subjectId: 64, subjectRole: 128 } as const;

/**
 * The `authz_rule` row and the `authz_rule_subject` rows of a rule. The subject rows exist so that
 * `scope.forget` can drop the list entries naming a forgotten subject set without parsing `definition`.
 * Only what the columns cannot hold is refused (`invalid_command`); the admin handler validated the rest.
 */
export function toRuleRows(rule: Omit<RuleDef, 'source'>): RuleRows {
  const refuse = (field: string, why: string): never => {
    throw new AuthzAdminFailure('invalid_command', `rule ${JSON.stringify(rule.id)}: ${why}`, `rule.${field}`);
  };

  if (typeof rule.id !== 'string' || rule.id === '' || rule.id.length > LEN.id) refuse('id', `the id must be a string of 1 to ${LEN.id} characters`);
  const scope = scopeToColumns(rule.scope);
  if (scope.scope_type.length > LEN.scopeType || scope.scope_id.length > LEN.scopeId) refuse('scope', `the scope type and id hold at most ${LEN.scopeType} characters each`);

  const { id: _id, scope: _scope, expiresAt: _expiresAt, source: _source, ...definition } = rule as Omit<RuleDef, 'source'> & { source?: unknown };

  const rows = new Map<string, RuleSubjectRow>();
  const add = (list: RuleSubjectList, field: string, s: AssignmentSubject) => {
    const c = subjectToColumns(s);
    if (c.subject_type.length > LEN.subjectType || c.subject_id.length > LEN.subjectId || c.subject_role.length > LEN.subjectRole) {
      refuse(field, `${field} holds ${JSON.stringify([c.subject_type, c.subject_id, c.subject_role])}, longer than authz_rule_subject holds (${LEN.subjectType}, ${LEN.subjectId}, ${LEN.subjectRole})`);
    }
    rows.set(JSON.stringify([list, c.subject_type, c.subject_id, c.subject_role]), { rule_id: rule.id, list, ...c });
  };
  for (const s of rule.allow ?? []) add('allow', 'allow', s);
  for (const p of (rule.subjects?.refs ?? []) as readonly PrincipalRef[]) add('refs', 'subjects.refs', { type: p.type, id: p.id });

  return {
    rule: { id: rule.id, kind: rule.kind, ...scope, definition: JSON.stringify(definition), expires_at: rule.expiresAt ?? null },
    subjects: [...rows.values()].sort(compareRows),
  };
}

function compareRows(a: RuleSubjectRow, b: RuleSubjectRow): number {
  for (const k of ['list', 'subject_type', 'subject_id', 'subject_role'] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  return 0;
}
```

`src/stores/index.ts` line 7: `export * from './rule-sql-form.js';` → `export * from './rule-rows.js';`.

- [ ] **Step 4: Simplify `DbRuleStore`**

In `src/stores/db-rule-store.ts`:

1. Imports: drop `AuthzConfigError` from line 1, drop lines 9-10 (`RoleStore`, `LadderDef`), and replace lines 15-16 with

```ts
import { AUTHZ_RULE_SUBJECT_TABLE, AUTHZ_RULE_TABLE, toRuleRows } from './rule-rows.js';
import type { RuleRow, RuleSubjectList, RuleSubjectRow } from './rule-rows.js';
```

2. Class doc (lines 47-52): replace `scoped DB rules with their\n * SQL form (D24).` by `scoped DB rules, check-only:\n * the rule is its \`definition\` JSON.`

3. Replace `put`, `assertStorable` and `putWithLadders` (lines 99-152) with:

```ts
  /** Inserts the rule, or replaces the one with its id (row and subject rows; the first `created_at` and `created_by` stay). */
  async put(rule: Omit<RuleDef, 'source'>, actor: PrincipalRef, tx: AuthzTx): Promise<void> {
    const driver = await this.writeDriver(tx, `${this.name}.put`);
    const rows = toRuleRows(rule);
    const { id, ...columns } = rows.rule;

    if (await this.existingRule(driver, id)) {
      await driver.update().in(AUTHZ_RULE_TABLE).update(columns).where('id', id);
      await driver.del().from(AUTHZ_RULE_SUBJECT_TABLE).where('rule_id', id);
    } else {
      try {
        await driver.insert().into(AUTHZ_RULE_TABLE).values({ ...rows.rule, created_by: principalKey(actor), created_at: this.now() });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        throw new AuthzAdminFailure('conflict', `${this.name}.put: another transaction wrote rule ${JSON.stringify(id)}; retry`, 'id', { cause: err });
      }
    }

    for (let i = 0; i < rows.subjects.length; i += INSERT_BATCH) {
      await driver
        .insert()
        .into(AUTHZ_RULE_SUBJECT_TABLE)
        .values(rows.subjects.slice(i, i + INSERT_BATCH));
    }

    await bumpVersion(driver, this.domain());
  }

  /** What the columns cannot hold, refused before the batch transaction ({@link toRuleRows}). */
  assertStorable(rule: Omit<RuleDef, 'source'>): void {
    toRuleRows(rule);
  }
```

4. Delete `ladders()` (lines 228-239), `PROBE_LADDER` and `probeLadders` (lines 319-339).

5. `StoredRuleRow` (line 45) becomes `type StoredRuleRow = RuleRow & { readonly id: string; readonly definition: string; readonly created_by: string | null; readonly created_at: Date | string };` (unchanged text; it now refers to the smaller `RuleRow`). `rowToRule` (line 297-317) keeps its body; replace its doc's last sentence `so what \`forgetScope\`\n * removed is gone for single checks as it is for SQL.` with `so what \`forgetScope\`\n * removed is gone.`

In `src/admin/ports.ts` lines 44-45 replace the doc with:

```ts
  /** Throws AuthzAdminFailure when the store cannot hold the rule (DB: a value longer than its column). */
  abstract assertStorable(rule: Omit<RuleDef, 'source'>): void;
```

- [ ] **Step 5: Drop the SQL columns from the migration**

In `src/migrations/AuthzRbac_2026_10_01_00_00_00.ts` replace the class doc (lines 3-6) with

```ts
/**
 * The authz-rbac tables of design §9.1: assignments, scoped check-only rules with their subject
 * lists, share links and the per-domain version counter.
 */
```

and the `authz_rule` table (lines 29-69) with

```ts
    await connection.schema().createTable('authz_rule', (table) => {
      table.string('id', 160).notNull().primaryKey();
      table.string('kind', 16).notNull();
      table.string('scope_type', 64).notNull().default().value('$global');
      table.string('scope_id', 64).notNull().default().value('');
      table.text('definition').notNull();
      table.dateTime('expires_at');
      table.string('created_by', 100);
      table.dateTime('created_at').notNull();
    });
```

- [ ] **Step 6: Update B43.rules (authz-testing) and the comment in behaviour.test.ts**

`packages/authz-testing/src/behaviour/B43-authz-admin.spec.ts` lines 110-111 become

```ts
  { name: 'a DB rule is stored whatever its resource pattern (rules are check-only)', world: ruleWorld(), steps: [exec(SYSTEM, [rule({ resource: { attr: 'resource.name', glob: 'a*b*' } })], 'ok')] },
  { name: 'a rule with a resource wildcard is accepted', world: ruleWorld(), steps: [exec(SYSTEM, [rule({ resource: { attr: 'resource.name', wildcard: 'release/*' } })], 'ok')] },
```

and in line 167 replace the note `'rule.put validation: ladders, roles and the SQL form of DB rules (D24, L2 toSqlForm). A threshold…'` with `'rule.put validation: ladders and roles. DB rules are check-only, so any rule the handler accepts is stored. A threshold…'` (keep the rest of the sentence).

`packages/authz-rbac/test/admin/behaviour.test.ts` line 7: replace `// B43.rules waits on L2: its "DB rule outside SQL form" case needs DbRuleStore and toSqlForm.` with `// B43.rules runs on DbRuleStore in test/integration/behaviour.db.test.ts.`

Delete the old SQL-form tests:

```bash
git rm -q packages/authz-rbac/test/stores/rule-sql-form.test.ts
```

- [ ] **Step 7: Run the tests**

Run: `cd packages/authz-testing && npm run compile && cd ../authz-rbac && npm test`
Expected: `0 failing`. Then `cd packages/authz-testing && npm test` — Expected: `0 failing` (`test/behaviour/models.test.ts` checks case structure only; B44 is untouched, L9 retires it).

Run: `grep -rnE "toSqlForm|fromSqlForm|likeToGlob|putWithLadders|rule-sql-form|SQL_WHEN_OPS" packages/authz-rbac/src packages/authz-rbac/test`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add -A packages/authz-rbac packages/authz-testing/src/behaviour/B43-authz-admin.spec.ts
git commit -m "refactor(authz-rbac): DB rules are check-only; drop the rule SQL form and its columns (design §4.4)"
```

---

### Task 5: Delete the canvas-c6 ORM suite of authz-testing

`test/canvas-c6/harness.ts` and `sql-harness.ts` import the old authz-orm (`lib/mjs/compile/compiler.js`, `registry.js`, `adapter.js`) and the authz-rbac compiler sources; every other file of the directory imports `harness.ts`, `facade.ts` or `fixtures.ts`, so the directory goes as a whole (design §9). The vendored fixtures in `packages/authz-testing/fixtures/canvas-c6/` stay for L9.

**Files:**
- Delete: `packages/authz-testing/test/canvas-c6/` — `checkmany.test.ts`, `checkmany.ts`, `config.test.ts`, `config.ts`, `conformance.memory.test.ts`, `conformance.sqlite.test.ts`, `conformance.ts`, `db.ts`, `facade.test.ts`, `facade.ts`, `fixtures.test.ts`, `fixtures.ts`, `harness.ts`, `list.test.ts`, `list.ts`, `load.test.ts`, `load.ts`, `mismatches.ts`, `mutation.test.ts`, `scope.test.ts`, `scope.ts`, `sql-harness.ts`, `c6/access.ts`, `c6/authz.ts`, `c6/reference.ts`, `c6/state.ts`

- [ ] **Step 1: Delete and check for importers**

```bash
git rm -r -q packages/authz-testing/test/canvas-c6
grep -rn "canvas-c6" packages --include=*.ts | grep -v node_modules | grep -v "/lib/"
```

Expected: only `packages/authz-testing/src/behaviour/B40-canvas.spec.ts` (comments and notes; B40 stays a stub until L9).

- [ ] **Step 2: Run the authz-testing and authz-rbac tests**

Run: `cd packages/authz-testing && npm test`
Expected: `0 failing`.
Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing`.

- [ ] **Step 3: Commit**

```bash
git add -A packages/authz-testing/test
git commit -m "test(authz-testing): delete the canvas-c6 ORM suite (design §9)"
```

---

## Notes for reviewers and the next lanes

- **`rule_not_compilable` stays** in the core codes comment (`packages/authz/src/contracts/admin.ts:47`, no snapshot change, no RFC RA7-1) and in authz-http-admin (`test/helpers.test.ts:88`, `src/schemas/bodies.ts:39`). L7 removes only its use by the rule SQL form. Other code still throws it after L7:
  - `authz-rbac/src/admin/rules.ts:55,72,200,209,220`: a rule condition that does not parse or compile;
  - `authz-rbac/src/admin/conditions.ts:17`;
  - `authz-abac/src/admin/handler.ts:69`: `policy.when`.

  Check with `grep -rn "rule_not_compilable" packages/*/src` after Task 4. Expected: only those sites plus the docs of `AdminRuleStore.assertStorable` (`src/admin/ports.ts:44`, which Task 4 rewrites without the code).

- `packages/authz-testing/fixtures/canvas-c6/SOURCE.md` still mentions `test/canvas-c6/`; L9 rewrites or removes it when it rebuilds the canvas conformance over `.accessible()`.
- `B44-rules-sql.spec.ts` and `B06.rulesSql` in authz-testing no longer have a runner in authz-rbac; L9 deletes or rewrites them.
- The non-ORM canvas checks (facade, checkmany, conformance.memory) are lost with the directory; `archive/authz-orm-query-scoping` keeps them for L9 to cherry-pick.
- `test/support/db.ts:88` still turns `jit` off for Postgres; harmless, L3 drops `authz.orm.allowJit`.
