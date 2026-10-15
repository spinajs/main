# Lane L9: integration and docs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `00-overview.md` first: its Global Constraints, frozen contracts and names table bind every task here.

**Goal:** Prove the whole design end to end on SQLite and PostgreSQL (real RBAC + ABAC + authz-orm + `DbAuthzAdminBackend` + authz-http), and rewrite the user docs so they describe what was built.

**Architecture:** One test stack in `packages/authz-testing/test/e2e`: a `BehaviourHarness` built on authz-testing's `hostHarness` over a copy of authz-orm's `TestDb` (overview decision 12: the suite lives in authz-testing, which already depends on authz-orm, authz-rbac and authz-abac, so no test-only cycle appears), with the real migrations, `registerRbac`, the ABAC model with a DB policy store, the DB admin backend, and the `orm` lane of L5 (models from `OrmModelSpec`, rows inserted through the ORM as SYSTEM so `authz_resource_ancestor` is maintained by L3's middleware). The kit fixtures (`B06.accessible`, `B20.orm`, `B21.orm`, `B09.orm`), hand-written scenarios, a fast-check property and the client access conformance all run on it. The docs tasks rewrite `docs/authz/README.md` (ORM, RBAC, ABAC, Adapters, AuthzAdmin), write `packages/authz-orm/README.md` from scratch, add a migration-guide section, flip the design status, and hand ckit its share.

**Tech Stack:** mocha + chai, fast-check, `@spinajs/orm-sqlite`, `@spinajs/orm-postgres` (docker Postgres on `127.0.0.1:15432`), authz-testing.

**Depends on:** every other lane (L0-L8, L10-L13), L5 in particular (orm lane contract, `ListStaticModel`, `accessibleAgree`, `arb.accessWorld`, `runClientAccessConformance`).

**Blocks:** release.

## Global Constraints

- Everything in `00-overview.md` "Global Constraints" applies.
- PostgreSQL suites skip when the server is unreachable unless `L2_REQUIRE_PG=1` (authz-rbac's `requirePostgres`); the lane's verification runs with `L2_REQUIRE_PG=1`, because the definition of done requires both databases.
- Docs: English, short sentences, no history narration in the reference docs (the migration guide is where history goes), no claims the code does not back: every doc step below ends with a grep that ties the text to the code.

## Files

| File | Task |
|---|---|
| `packages/authz-testing/package.json` | 0 (devDependencies) |
| `packages/authz-testing/test/e2e/support/db.ts` | 1 |
| `packages/authz-testing/test/e2e/support/stack.ts` | 1 |
| `packages/authz-testing/test/e2e/support/world.ts` | 2 |
| `packages/authz-testing/test/e2e/kit.test.ts` | 1 |
| `packages/authz-testing/test/e2e/scenarios.test.ts` | 2, 3 |
| `packages/authz-testing/test/e2e/property.test.ts` | 4 |
| `packages/authz-testing/test/e2e/boot.test.ts` | 5 |
| `packages/authz-testing/test/e2e/client-access.test.ts` | 6 |
| `docs/authz/README.md` | 7 |
| `packages/authz-orm/README.md` | 8 |
| `docs/authz/migration-guide.md` | 9 |
| `docs/plans/2026-10-14-authz-resource-access-design.md` (status line), `docs/plans/2026-10-14-ckit-handoff.md` | 10 |

---

### Task 0: Names and dependencies

**Files:**
- Modify: `packages/authz-testing/package.json` (`devDependencies`)

- [ ] **Step 1: Record the names the e2e code uses**

Run (repo root):

```bash
grep -rnE "export (function|const|class) (AccessResource|Parent|Owner|Self|registerAccessResource|unregisterResource)\b" packages/authz-orm/src
grep -rnE "class \w+_20\d\d_\d\d_\d\d_\d\d_\d\d_\d\d" packages/authz-orm/src packages/authz-rbac/src packages/authz-abac/src
grep -rnE "export (function|const) (subjectKeyOf|subjectToColumns|scopeToColumns|normaliseTags)\b|AUTHZ_SUBJECT_MEMBERSHIP_TABLE" packages/authz-rbac/src
grep -rnE "\.env|'env'|NODE_ENV" packages/authz-orm/src --include=*.ts
grep -rnE "accessField|'\\\$access'" packages/authz-orm/src --include=*.ts
grep -rnE "events|authz\.changed|text/event-stream" packages/authz-http/src --include=*.ts -l
```

Expected: the ancestor migration class (this file calls it `AuthzResourceAncestor_2026_10_14_00_00_00`; use the real name everywhere below), `subjectKeyOf` exported from `@spinajs/authz-rbac`, the configuration key the runtime guard reads for the env (this file assumes `env`, set with `host.setConfig(['env'], 'test')`; use the real key), the `$access` default, and authz-http's SSE route. Write the real names into the steps below before running them; do not add aliases.

- [ ] **Step 2: devDependencies**

In `packages/authz-testing/package.json` `devDependencies` add (keep alphabetical order; `authz-abac`, `authz-orm`, `authz-rbac`, `orm-postgres`, `orm-sqlite` are there already, `fast-check` is a dependency):

```json
    "@spinajs/authz-http": "3.0.0-alpha.0",
    "@spinajs/fs": "2.0.549",
    "@spinajs/http": "2.0.549",
    "chai-http": "^4.4.0",
```

(`chai-http`: use the version `packages/authz-http/package.json` pins, if it differs.) Test-only: authz-http is built before the tests run (root build order: authz-testing, …, authz-http; `npm test` runs on the built libs).

Run: `npm install` (repo root)
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/authz-testing/package.json package-lock.json
git commit -m "chore(authz-testing): test dependencies for the end-to-end suite"
```

---

### Task 1: The e2e stack and the kit fixtures on it

**Files:**
- Create: `packages/authz-testing/test/e2e/support/db.ts` (copy of authz-orm's `TestDb`)
- Create: `packages/authz-testing/test/e2e/support/stack.ts`
- Create: `packages/authz-testing/test/e2e/kit.test.ts`

**Interfaces:**
- Consumes: `TestDb` (copied from `packages/authz-orm/test/support/db.ts`: `open({ postgres?, database? })`, `define(spec, dialect)`, `rows(model)`, `raw(sql, params, dialect)`, `driver(dialect)`, `clear()`, `close()`), authz-rbac's `createPgDatabase`, `dropPgDatabase`, `requirePostgres` (`packages/authz-rbac/test/support/db.ts`), `hostHarness`, `registerRbac`, `DbAuthzAdminBackend`, `AbacModel`, `DbPolicyStore`, L5's `OrmHandle`/`OrmQuery`/`OrmResult`.
- Produces: `e2eHarness(kind: 'sqlite' | 'postgres'): E2eHarness` with `E2eHarness = BehaviourHarness & { model(name: string): typeof ModelBase; db(): TestDb }`; `E2E_DIALECTS`; `withPostgres(kind)` (a `before` hook body that skips the suite).

- [ ] **Step 1: Write the kit run (the failing test)**

`packages/authz-testing/test/e2e/kit.test.ts`:

```ts
import 'mocha';

import { runBehaviour } from '@spinajs/authz-testing';

import { E2E_DIALECTS, e2eHarness, withPostgres } from './support/stack.js';

// The kit parts that need real list SQL: B06 over .accessible() (RBAC, ancestors, owner, wildcard, deny, expiry),
// B20/B21 (.accessible, .withAccess, the guard, bulk writes), B09.orm (unattended, runAs(SYSTEM)).
for (const kind of E2E_DIALECTS) {
  describe(`e2e kit fixtures (${kind})`, function () {
    this.timeout(120_000);
    before(async function () {
      await withPostgres(this, kind);
    });
    runBehaviour(['B06.accessible', 'B20.orm', 'B21.orm', 'B09.orm'], () => e2eHarness(kind), { strict: true });
  });
}
```

Run: `cd packages/authz-testing && npx ts-mocha -p tsconfig.json test/e2e/kit.test.ts`
Expected: FAIL, `Cannot find module './support/stack.js'`.

- [ ] **Step 2: The test database**

Copy `packages/authz-orm/test/support/db.ts` to `packages/authz-testing/test/e2e/support/db.ts` and change only its two package-internal imports, so the suite loads one copy of each package (the built libs, as every other import here):

```ts
import { testHost } from '@spinajs/authz-testing';

// The built authz-orm, which '@spinajs/authz-orm' resolves to: its registry is the one the decorators fill.
import { unregisterResource } from '../../../../authz-orm/lib/mjs/registry.js';
```

(replacing `import { unregisterResource } from '../../src/registry.js';`; the `testHost` import line is the same text, keep it). Nothing else in the file changes.

- [ ] **Step 3: The stack**

`packages/authz-testing/test/e2e/support/stack.ts`:

```ts
import { AuthorizationModel, AuthzAdminBackend, AuthzContributor, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { Assignment, AuthzService } from '@spinajs/authz';
import { AbacContributor, AbacModel, AuthzAbac_2026_10_01_00_00_00, ConfigPolicyStore, DbPolicyStore, PolicyStore } from '@spinajs/authz-abac';
import { AUTHZ_ASSIGNMENT_TABLE, AuthzAdminIdempotency_2026_10_02_00_01_00, AuthzRbac_2026_10_01_00_00_00, DbAuthzAdminBackend, normaliseTags, registerRbac, scopeToColumns, subjectKeyOf, subjectToColumns } from '@spinajs/authz-rbac';
import { hostHarness, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness, HarnessSession, HostSetup, OrmHandle, OrmModelSpec, OrmQuery, OrmResult, World } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { ModelBase, Orm } from '@spinajs/orm';

import { AccessResource, AuthzAudit_2026_10_01_00_00_00, AuthzResourceAncestor_2026_10_14_00_00_00, AuthzScopeAttribute_2026_10_02_00_00_00, Owner, Parent } from '@spinajs/authz-orm';
import { TestDb } from './db.js';
import type { Dialect } from './db.js';
// authz-rbac's test database helpers import only libraries.
import { createPgDatabase, dropPgDatabase, requirePostgres } from '../../../../authz-rbac/test/support/db.js';

export const E2E_DIALECTS: readonly Dialect[] = ['sqlite', 'postgres'];

export async function withPostgres(ctx: Mocha.Context, kind: Dialect): Promise<void> {
  if (kind === 'postgres') await requirePostgres(ctx);
}

const LINK_SECRET = 'authz-orm-e2e-link-secret-of-at-least-32-chars';
const ADMIN_PERMISSIONS = ['authz:assignments.manage', 'authz:links.manage', 'authz:rules.manage', 'authz:policies.manage', 'authz:scope.manage', 'authz:scope.forget'];
const GUARD = { service: 'DefaultAdminGuard', privilegedPermission: 'authz:assignments.manage', protectSystemRole: true, preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: true };
// Children first, so a DELETE never trips a foreign key.
const AUTHZ_TABLES = ['authz_rule_subject', 'authz_rule', 'authz_link', 'authz_subject_membership', 'authz_assignment', 'authz_policy', 'authz_scope_attribute', 'authz_resource_ancestor', 'authz_admin_idempotency', 'authz_version'];

type ModelClass = typeof ModelBase & (new () => ModelBase);
const pk = (row: unknown): string => String((row as { id: unknown }).id);

let activeDb: TestDb | undefined;

/** DbAuthzAdminBackend over the DI root, where TestDb's Orm lives. */
export class E2eAdminBackend extends DbAuthzAdminBackend {
  constructor() {
    super({ container: DI.RootContainer });
  }
}

/** The `orm` lane of authz-testing (L5) over TestDb: one class per spec per case, rows inserted through the ORM as SYSTEM. */
export class E2eOrm implements OrmHandle {
  private models = new Map<string, ModelClass>();

  constructor(
    private readonly db: TestDb,
    private readonly kind: Dialect,
  ) {}

  model(name: string): ModelClass {
    const m = this.models.get(name);
    if (!m) throw new Error(`e2e: no model ${name} in this case`);
    return m;
  }

  async use(specs: readonly OrmModelSpec[]): Promise<void> {
    await this.db.clear();
    this.models = new Map();
    for (const s of specs) {
      const cls = await this.db.define(
        {
          name: s.name,
          columns: Object.fromEntries(s.columns.map((c) => [c, 'TEXT'])),
          decorate: (model, proto) => {
            if (s.type === undefined) return;
            AccessResource(s.type)(model);
            if (s.owner !== undefined) Owner()(proto, s.owner);
            for (const p of s.parents ?? []) Parent(p.type, p.nullable ? { nullable: true } : undefined)(proto, p.column);
          },
        },
        this.kind,
      );
      this.models.set(s.name, cls);
    }
    for (const s of specs) {
      for (const row of s.rows ?? []) await runWithPrincipal(SYSTEM, async () => void (await (this.model(s.name) as unknown as { insert(r: unknown): Promise<unknown> }).insert(row)));
    }
  }

  async run(q: OrmQuery): Promise<OrmResult> {
    const M = this.model(q.model) as unknown as { query(): any; insert(v: unknown): any; update(v: unknown): any; destroy(): any };
    const where = (b: any, w: Readonly<Record<string, unknown>> | undefined) => Object.entries(w ?? {}).reduce((acc, [k, v]) => acc.where(k, v), b);
    switch (q.op) {
      case 'select': {
        let b = where(M.query(), q.where);
        if (q.accessible) b = b.accessible(q.accessible);
        if (q.withAccess) b = b.withAccess(q.withAccess);
        const rows = (await b) as Record<string, unknown>[];
        const access = q.withAccess ? Object.fromEntries(rows.map((r) => [pk(r), r['$access'] as Record<string, boolean>])) : undefined;
        return { ids: rows.map(pk), count: rows.length, sql: [], ...(access ? { access } : {}) };
      }
      case 'insert':
        await M.insert(q.values);
        return { sql: [] };
      case 'update': {
        let b = where(M.update(q.values), q.where);
        if (q.accessible) b = b.accessible(q.accessible);
        const r = (await b) as { RowsAffected?: number } | undefined;
        return { count: r?.RowsAffected, sql: [] };
      }
      case 'delete': {
        let b = where(M.destroy(), q.where);
        if (q.accessible) b = b.accessible(q.accessible);
        const r = (await b) as { RowsAffected?: number } | undefined;
        return { count: r?.RowsAffected, sql: [] };
      }
    }
  }

  async rows(model: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
    return this.db.rows(this.model(model));
  }
}

const roleConfig = (roles: readonly { name: string; source?: string }[]): Record<string, unknown> => Object.fromEntries(roles.map(({ name, source: _source, ...def }) => [name, def]));

/** A world assignment as a row; raw, so an expiry in the past is kept (AuthzAdmin refuses one). */
export async function insertAssignment(db: TestDb, kind: Dialect, a: Assignment): Promise<void> {
  await db
    .driver(kind)
    .insert()
    .into(AUTHZ_ASSIGNMENT_TABLE)
    .values({ id: a.id, ...subjectToColumns(a.subject), subject_key: subjectKeyOf(a.subject), role: a.role, ...scopeToColumns(a.scope), tags: normaliseTags(a.tags), expires_at: a.expiresAt ?? null, granted_by: null, source: a.source ?? 'db', created_at: new Date() });
}

export interface E2eHarness extends BehaviourHarness {
  db(): TestDb;
  model(name: string): ModelClass;
}

/**
 * hostHarness over TestDb (`kind`): the real authz migrations, the world's ORM models, RBAC from `world.rbac` (roles in
 * config, assignments as rows, `registerRbac`), ABAC from `world.abac` (config policies plus a DbPolicyStore that
 * AuthzAdmin writes), the DB admin backend, and the app env `test` (the runtime guard throws).
 */
export function e2eHarness(kind: Dialect): E2eHarness {
  let db: TestDb | undefined;
  let database: string | undefined;
  let lane: E2eOrm | undefined;
  const need = <T>(v: T | undefined, what: string): T => v ?? (() => { throw new Error(`e2eHarness: ${what} (beforeAll did not run)`); })();

  const base = hostHarness({
    facets: ['rbac', 'abac', 'orm', 'admin', 'store', 'list'],
    async register(host: HostSetup) {
      const test = need(db, 'no database');
      const orm = need(lane, 'no orm lane');
      const world: World = host.world;
      const c = host.container;
      for (const t of AUTHZ_TABLES) await test.raw(`DELETE FROM ${t}`, [], kind);

      host.setConfig(['env'], 'test');
      c.register(testHost.instance(test.orm)).as(Orm);
      host.setConfig(['authz', 'rbac', 'stores'], { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'], links: ['DbLinkStore'] });
      host.setConfig(['authz', 'rbac', 'connection'], kind);
      host.setConfig(['authz', 'rbac', 'links', 'secret'], LINK_SECRET);
      host.setConfig(['authz', 'rbac', 'roles'], roleConfig((world.rbac?.roles ?? []) as readonly { name: string; source?: string }[]));
      host.setConfig(['authz', 'admin'], { connection: kind, backend: 'E2eAdminBackend', guard: GUARD });
      const declared = new Set(world.permissions.map((p) => (typeof p === 'string' ? p : p.name)));
      for (const p of ADMIN_PERMISSIONS) if (!declared.has(p)) host.setConfig(['authz', 'domains', host.domain, 'permissions', p], {});
      c.register(E2eAdminBackend).as(AuthzAdminBackend);

      await orm.use(world.lane?.orm?.models ?? []);

      if (world.rbac) {
        await registerRbac(c, (await c.resolve(Configuration)) as Configuration, { clock: host.kit.clock });
        for (const a of world.rbac.assignments ?? []) await insertAssignment(test, kind, a);
      }
      if (world.abac) {
        const written = new DbPolicyStore(() => test.driver(kind));
        const abac = new AbacModel({ stores: [new ConfigPolicyStore(world.abac.policies), written] });
        c.register(testHost.instance(abac)).as(AuthorizationModel);
        c.register(testHost.instance(new AbacContributor(abac))).as(AuthzContributor);
        c.register(testHost.instance(written)).as(PolicyStore);
      }
    },
    extend(_host: HostSetup, session: HarnessSession) {
      return { admin: (session.authz as unknown as AuthzService).admin(), lane: { orm: need(lane, 'no orm lane') } } as Partial<HarnessSession>;
    },
  });

  async function afterAll(): Promise<void> {
    try {
      await base.afterAll?.();
    } finally {
      const open = db;
      db = undefined;
      lane = undefined;
      activeDb = undefined;
      try {
        await open?.close();
      } finally {
        if (database) await dropPgDatabase(database);
        database = undefined;
      }
    }
  }

  return {
    ...base,
    db: () => need(db, 'no database'),
    model: (name) => need(lane, 'no orm lane').model(name),
    async beforeAll() {
      try {
        if (kind === 'postgres') database = await createPgDatabase('authz_orm_e2e');
        db = await TestDb.open({ postgres: kind === 'postgres', ...(database ? { database } : {}) });
        activeDb = db;
        const driver = db.driver(kind);
        for (const m of [new AuthzRbac_2026_10_01_00_00_00(), new AuthzAdminIdempotency_2026_10_02_00_01_00(), new AuthzAbac_2026_10_01_00_00_00(), new AuthzScopeAttribute_2026_10_02_00_00_00(), new AuthzAudit_2026_10_01_00_00_00(), new AuthzResourceAncestor_2026_10_14_00_00_00()]) await m.up(driver);
        lane = new E2eOrm(db, kind);
        await base.beforeAll?.();
      } catch (e) {
        await afterAll();
        throw e;
      }
    },
    afterAll,
  };
}

/** The database of the running e2e harness, for raw assertions. */
export function e2eDb(): TestDb {
  if (!activeDb) throw new Error('e2e: no database is open');
  return activeDb;
}
```

If `AuthzAudit_…` is not a root export of `@spinajs/authz-orm`, import it from `@spinajs/authz-orm/audit` (the package's subpath export).

- [ ] **Step 4: Run the kit parts**

Run: `cd packages/authz-testing && npm run compile && L2_REQUIRE_PG=1 npx ts-mocha -p tsconfig.json test/e2e/kit.test.ts`
Expected: all cases of `B06.accessible`, `B20.orm`, `B21.orm`, `B09.orm` pass on `sqlite` and `postgres`; `0 failing`. A failure in `B06.accessible` names principal, permission and the differing ids: that is a real disagreement between the list SQL (L4/L8 compilers) and `checkAll` (L2/L8), and goes back to the owning lane with the case, not into a relaxed expectation.

- [ ] **Step 5: Commit**

```bash
git add packages/authz-testing/test/e2e/support/db.ts packages/authz-testing/test/e2e/support/stack.ts packages/authz-testing/test/e2e/kit.test.ts
git commit -m "test(authz-testing): end-to-end stack; kit fixtures B06.accessible, B20, B21, B09 on SQLite and Postgres"
```

---

### Task 2: Scenarios: grants, teams, wildcard, deny, expiry, owner, ceilings

**Files:**
- Create: `packages/authz-testing/test/e2e/support/world.ts`
- Create: `packages/authz-testing/test/e2e/scenarios.test.ts`

**Interfaces:**
- Consumes: Task 1 (`e2eHarness`, `E2E_DIALECTS`, `withPostgres`), `fixtureDsl.role`, `fixtureDsl.assignment`, `userPrincipal`, `anonymousPrincipal`.
- Produces: `stackWorld(opts)`, `MODELS`, `ROLES`, helpers `open`, `agrees`, `listed`.

- [ ] **Step 1: The scenario world**

`packages/authz-testing/test/e2e/support/world.ts`:

```ts
import { AccessDenied } from '@spinajs/authz';
import type { Assignment, AuthzService, Permission, Principal, ResourceType } from '@spinajs/authz';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, OrmModelSpec, SetupContext, World } from '@spinajs/authz-testing';
import { expect } from 'chai';

import type { E2eHarness } from './stack.js';

const { combine, role } = fixtureDsl;

export const NOW = new Date('2026-10-14T12:00:00.000Z');

/**
 * org o1 > projects p1, p2 > folders (f1 > f2 > f3 under p1, f4 under p2) > tasks.
 * Tasks: t1 in f1 (alice), t2 in f2 (bob), t3 in f3 (carol), t4 in f4 (bob), t5 in f3 (alice).
 */
export const MODELS: readonly OrmModelSpec[] = [
  { name: 'Org', type: 'org', columns: [], rows: [{ id: 'o1' }] },
  { name: 'Project', type: 'project', parents: [{ column: 'org_id', type: 'org' }], columns: ['org_id'], rows: [{ id: 'p1', org_id: 'o1' }, { id: 'p2', org_id: 'o1' }] },
  {
    name: 'Folder',
    type: 'folder',
    parents: [
      { column: 'parent_id', type: 'folder', nullable: true },
      { column: 'project_id', type: 'project' },
    ],
    columns: ['parent_id', 'project_id'],
    rows: [
      { id: 'f1', parent_id: null, project_id: 'p1' },
      { id: 'f2', parent_id: 'f1', project_id: 'p1' },
      { id: 'f3', parent_id: 'f2', project_id: 'p1' },
      { id: 'f4', parent_id: null, project_id: 'p2' },
    ],
  },
  {
    name: 'Task',
    type: 'task',
    owner: 'owner_id',
    parents: [{ column: 'folder_id', type: 'folder' }],
    columns: ['folder_id', 'owner_id', 'title'],
    rows: [
      { id: 't1', folder_id: 'f1', owner_id: 'alice', title: 'a' },
      { id: 't2', folder_id: 'f2', owner_id: 'bob', title: 'b' },
      { id: 't3', folder_id: 'f3', owner_id: 'carol', title: 'c' },
      { id: 't4', folder_id: 'f4', owner_id: 'bob', title: 'd' },
      { id: 't5', folder_id: 'f3', owner_id: 'alice', title: 'e' },
    ],
  },
];

export const ROLES = [
  role('viewer', ['task:read', 'folder:read', 'project:read']),
  role('editor', ['task:read', 'task:update', 'folder:read', 'project:read']),
  role('author', [{ permission: 'task:read', relation: 'owner' }, { permission: 'task:update', relation: 'owner' }]),
  role('blocked', ['task:read', 'task:update'], { deny: true }),
  role('team.member', [], { subjectSet: true, scopeTypes: ['team'] }),
];

export const PERMISSIONS = [
  { name: 'task:read', list: true },
  { name: 'task:update', list: true },
  { name: 'folder:read', list: true },
  { name: 'project:read', list: true },
  'team:read',
];

export const USERS = ['alice', 'bob', 'carol', 'dave'];

export function stackWorld(assignments: readonly Assignment[] = [], extra: Partial<World> = {}): World {
  return {
    now: NOW,
    permissions: PERMISSIONS,
    principals: Object.fromEntries(USERS.map((u) => [u, userPrincipal(u)])),
    combine: combine('deny-overrides', 'rbac'),
    rbac: { roles: ROLES, assignments },
    lane: { orm: { models: MODELS } },
    ...extra,
  };
}

export async function open(harness: E2eHarness, world: World, title: string): Promise<HarnessSession> {
  return harness.setup(world, { id: 'B06', part: 'e2e', case: title, title, facets: ['engine', 'host', 'rbac', 'orm', 'admin'] } as SetupContext);
}

export const authzOf = (s: HarnessSession): AuthzService => s.authz as unknown as AuthzService;

/** `.accessible(permission)` ids as `who`, sorted; an AccessDenied is the empty list (a 403, H16). */
export async function listed(s: HarnessSession, who: Principal, permission: Permission, model = 'Task'): Promise<string[]> {
  try {
    const r = await authzOf(s).runAs(who, 'e2e', () => s.lane!.orm!.run({ op: 'select', model, accessible: permission }));
    return [...(r.ids ?? [])].sort();
  } catch (e) {
    if (e instanceof AccessDenied) return [];
    throw e;
  }
}

/** Asserts `.accessible()` returns `expected` and that `checkAll` definitely allows exactly those rows. */
export async function agrees(s: HarnessSession, who: Principal, permission: Permission, expected: readonly string[], model = 'Task', type: ResourceType = 'task'): Promise<void> {
  const ids = (await s.lane!.orm!.rows(model)).map((r) => String(r.id));
  const decisions = await authzOf(s).checkAll(who, ids.map((id) => ({ permission, resource: { type, id } })));
  const allowed = ids.filter((_, i) => decisions[i].allowed && decisions[i].residual.op === 'true').sort();
  const label = `${who.type}:${who.id} ${permission}`;
  expect(await listed(s, who, permission, model), `${label}: .accessible()`).to.deep.equal([...expected].sort());
  expect(allowed, `${label}: checkAll`).to.deep.equal([...expected].sort());
}
```

- [ ] **Step 2: Write the scenarios (failing until the stack and the lanes behave)**

`packages/authz-testing/test/e2e/scenarios.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { GLOBAL, SYSTEM } from '@spinajs/authz';
import { anonymousPrincipal, fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession } from '@spinajs/authz-testing';

import { E2E_DIALECTS, e2eHarness, withPostgres } from './support/stack.js';
import { NOW, agrees, authzOf, open, stackWorld } from './support/world.js';

const { assignment, ref } = fixtureDsl;
const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const dave = userPrincipal('dave');
const ALL = ['t1', 't2', 't3', 't4', 't5'];
const P1_TASKS = ['t1', 't2', 't3', 't5'];
const HOUR = 3_600_000;

for (const kind of E2E_DIALECTS) {
  describe(`e2e scenarios (${kind})`, function () {
    this.timeout(120_000);
    const harness = e2eHarness(kind);
    let s: HarnessSession | undefined;

    before(async function () {
      await withPostgres(this, kind);
      await harness.beforeAll?.();
    });
    after(() => harness.afterAll?.());
    afterEach(async () => {
      await s?.dispose();
      s = undefined;
    });

    it('a direct grant on a row lists that row', async () => {
      s = await open(harness, stackWorld([assignment('a1', alice, 'viewer', ref('task', 't2'))]), 'direct');
      await agrees(s, alice, 'task:read', ['t2']);
      await agrees(s, alice, 'task:update', []);
    });

    it('a grant on an ancestor lists its subtree, through nested folders', async () => {
      s = await open(harness, stackWorld([assignment('a1', alice, 'viewer', ref('folder', 'f2')), assignment('a2', bob, 'viewer', ref('project', 'p1')), assignment('a3', carol, 'viewer', ref('org', 'o1'))]), 'ancestor');
      await agrees(s, alice, 'task:read', ['t2', 't3', 't5']);
      await agrees(s, alice, 'folder:read', ['f2', 'f3'], 'Folder', 'folder');
      await agrees(s, bob, 'task:read', P1_TASKS);
      await agrees(s, carol, 'task:read', ALL);
      await agrees(s, carol, 'project:read', ['p1', 'p2'], 'Project', 'project');
    });

    it('a team grant reaches a member through three nested sets, and leaves with the membership', async () => {
      s = await open(harness, stackWorld(), 'teams');
      const admin = authzOf(s).admin();
      const team = (id: string) => ({ role: 'team.member', scope: { type: 'team', id } });
      const results = await admin.execute(SYSTEM, [
        { kind: 'assignment.grant', subject: { set: team('t2') }, role: 'team.member', scope: { type: 'team', id: 't1' } },
        { kind: 'assignment.grant', subject: { set: team('t3') }, role: 'team.member', scope: { type: 'team', id: 't2' } },
        { kind: 'set.addMember', set: team('t3'), member: { type: 'user', id: 'alice' } },
        { kind: 'assignment.grant', subject: { set: team('t1') }, role: 'editor', scope: { type: 'project', id: 'p2' } },
      ]);
      expect(results.every((r) => r.ok), JSON.stringify(results)).to.equal(true);
      await agrees(s, alice, 'task:read', ['t4']);
      await agrees(s, alice, 'task:update', ['t4']);
      await agrees(s, bob, 'task:read', []);

      const [removed] = await admin.execute(SYSTEM, [{ kind: 'set.removeMember', set: team('t3'), member: { type: 'user', id: 'alice' } }]);
      expect(removed.ok).to.equal(true);
      await agrees(s, alice, 'task:read', []);
    });

    it('user:* reaches every user, and not an anonymous caller', async () => {
      s = await open(harness, stackWorld([assignment('a1', { type: 'user', id: '*' }, 'viewer', ref('folder', 'f4'))]), 'wildcard');
      for (const who of [alice, bob, dave]) await agrees(s, who, 'task:read', ['t4']);
      await agrees(s, anonymousPrincipal(), 'task:read', []);
    });

    it('a deny role at a folder overrides an editor role at its project, there and below', async () => {
      s = await open(harness, stackWorld([assignment('a1', carol, 'editor', ref('project', 'p1')), assignment('a2', carol, 'blocked', ref('folder', 'f2'))]), 'deny');
      await agrees(s, carol, 'task:read', ['t1']);
      await agrees(s, carol, 'task:update', ['t1']);
      const [d] = await authzOf(s).checkAll(carol, [{ permission: 'task:update', resource: ref('task', 't3') }]);
      expect(d.reason?.code).to.equal('role_denied');
    });

    it('an expired assignment grants nothing; a live one with an expiry grants until then', async () => {
      s = await open(
        harness,
        stackWorld([assignment('a1', alice, 'viewer', ref('project', 'p1'), { expiresAt: new Date(NOW.getTime() - HOUR) }), assignment('a2', bob, 'viewer', ref('project', 'p2'), { expiresAt: new Date(NOW.getTime() + HOUR) })]),
        'expiry',
      );
      await agrees(s, alice, 'task:read', []);
      await agrees(s, bob, 'task:read', ['t4']);
    });

    it('owner: a grant on the owner relation lists the rows whose @Owner column holds the principal; a deny still wins', async () => {
      s = await open(harness, stackWorld([assignment('a1', bob, 'author', GLOBAL), assignment('a2', alice, 'author', GLOBAL), assignment('a3', alice, 'blocked', ref('folder', 'f3'))]), 'owner');
      await agrees(s, bob, 'task:read', ['t2', 't4']);
      await agrees(s, alice, 'task:read', ['t1']);
    });

    it('ceilings narrow: token roles drop a role, a resource ceiling keeps one subtree', async () => {
      s = await open(harness, stackWorld([assignment('a1', alice, 'viewer', ref('org', 'o1')), assignment('a2', alice, 'editor', ref('org', 'o1'))]), 'ceiling');
      await agrees(s, alice, 'task:update', ALL);
      const viewerOnly = userPrincipal('alice', { ceiling: { roles: ['viewer'] } });
      await agrees(s, viewerOnly, 'task:read', ALL);
      await agrees(s, viewerOnly, 'task:update', []);
      const withinF2 = userPrincipal('alice', { ceiling: { resources: [ref('folder', 'f2')] } });
      await agrees(s, withinF2, 'task:read', ['t2', 't3', 't5']);
      await agrees(s, withinF2, 'task:update', ['t2', 't3', 't5']);
    });
  });
}
```

- [ ] **Step 3: Run**

Run: `cd packages/authz-testing && L2_REQUIRE_PG=1 npx ts-mocha -p tsconfig.json test/e2e/scenarios.test.ts`
Expected: `16 passing` (8 scenarios × 2 databases). A mismatch between `.accessible()` and `checkAll` is a lane bug (L4 SQL shape, L6 membership, L8 plan terms, L2 combination); report it to that lane with the scenario name. If `assignment.grant` with a set subject at a `team` scope fails with `wrong_scope_type`, the world's `team.member` role is wrong, not the lane.

- [ ] **Step 4: Commit**

```bash
git add packages/authz-testing/test/e2e/support/world.ts packages/authz-testing/test/e2e/scenarios.test.ts
git commit -m "test(authz-testing): e2e scenarios for grants, teams, wildcards, deny roles, expiry, owner, ceilings"
```

---

### Task 3: Scenarios: moves and deletes

**Files:**
- Modify: `packages/authz-testing/test/e2e/scenarios.test.ts` (two more `it` inside the `describe`)

- [ ] **Step 1: Write the tests**

Add inside the `describe` of `scenarios.test.ts`, after the ceiling test (add `e2eDb` to the `./support/stack.js` import and `runWithPrincipal` to the `@spinajs/authz` import):

```ts
    it('a move (reparent) changes access at once, for the moved subtree', async () => {
      s = await open(harness, stackWorld([assignment('a1', alice, 'viewer', ref('folder', 'f1'))]), 'move');
      await agrees(s, alice, 'task:read', P1_TASKS);
      const Folder = harness.model('Folder') as unknown as { update(v: unknown): any };
      const Task = harness.model('Task') as unknown as { update(v: unknown): any };
      await runWithPrincipal(SYSTEM, async () => {
        await Folder.update({ parent_id: null }).where('id', 'f2');
        await Task.update({ folder_id: 'f1' }).where('id', 't4');
      });
      await agrees(s, alice, 'task:read', ['t1', 't4']);
      const ancestors = await e2eDb().raw(`SELECT ancestor_type, ancestor_id FROM authz_resource_ancestor WHERE resource_type = 'task' AND resource_id = 't3' ORDER BY depth`, [], kind);
      expect(ancestors.map((r: { ancestor_type: string; ancestor_id: string }) => `${r.ancestor_type}:${r.ancestor_id}`)).to.deep.equal(['folder:f3', 'folder:f2', 'project:p1', 'org:o1']);
    });

    it('deleting a resource drops its grants and ancestor links, so a reused id inherits nothing', async () => {
      s = await open(harness, stackWorld(), 'delete');
      const [granted] = await authzOf(s).admin().execute(SYSTEM, [{ kind: 'assignment.grant', subject: { type: 'user', id: 'bob' }, role: 'editor', scope: ref('project', 'p2') }]);
      expect(granted.ok).to.equal(true);
      await agrees(s, bob, 'task:read', ['t4']);

      const Project = harness.model('Project') as unknown as { destroy(): any; insert(v: unknown): any };
      await runWithPrincipal(SYSTEM, async () => void (await Project.destroy().where('id', 'p2')));

      const count = async (sql: string) => Number(((await e2eDb().raw(sql, [], kind)) as { n: number | string }[])[0].n);
      expect(await count(`SELECT COUNT(*) AS n FROM authz_assignment WHERE scope_type = 'project' AND scope_id = 'p2'`)).to.equal(0);
      expect(await count(`SELECT COUNT(*) AS n FROM authz_resource_ancestor WHERE ancestor_type = 'project' AND ancestor_id = 'p2'`)).to.equal(0);
      expect(await count(`SELECT COUNT(*) AS n FROM authz_resource_ancestor WHERE resource_type = 'project' AND resource_id = 'p2'`)).to.equal(0);
      await agrees(s, bob, 'task:read', []);

      await runWithPrincipal(SYSTEM, async () => void (await Project.insert({ id: 'p2', org_id: 'o1' })));
      await agrees(s, bob, 'task:read', []);
    });
```

The folder `f4` stays (no foreign key cascade); design §6.4 step 2 makes it a root, which the second ancestor count checks.

- [ ] **Step 2: Run**

Run: `cd packages/authz-testing && L2_REQUIRE_PG=1 npx ts-mocha -p tsconfig.json test/e2e/scenarios.test.ts`
Expected: `20 passing`.

- [ ] **Step 3: Commit**

```bash
git add packages/authz-testing/test/e2e/scenarios.test.ts
git commit -m "test(authz-testing): e2e reparent and delete clean-up"
```

---

### Task 4: Property: `.accessible()` and `.withAccess` equal `checkAll` for random data

The rewrite of the old B06 property test (`authz-orm/test/b06.property.test.ts`, removed by L3): for random org > project > doc data and random assignments (`arb.accessWorld`, L5), every principal's list is exactly the rows `checkAll` definitely allows, and every `$access` entry equals `checkAll`.

**Files:**
- Create: `packages/authz-testing/test/e2e/property.test.ts`

- [ ] **Step 1: Write the test**

```ts
import 'mocha';
import * as fc from 'fast-check';

import { arb, laneSteps } from '@spinajs/authz-testing';
import type { HarnessSession, SetupContext, StepContext } from '@spinajs/authz-testing';

import { E2E_DIALECTS, e2eHarness, withPostgres } from './support/stack.js';

const NUM_RUNS = Number(process.env.E2E_PROPERTY_RUNS ?? 25);

for (const kind of E2E_DIALECTS) {
  describe(`e2e property: .accessible() and .withAccess ⇔ checkAll (${kind})`, function () {
    this.timeout(600_000);
    const harness = e2eHarness(kind);

    before(async function () {
      await withPostgres(this, kind);
      await harness.beforeAll?.();
    });
    after(() => harness.afterAll?.());

    it('holds for random worlds', async () => {
      let n = 0;
      await fc.assert(
        fc.asyncProperty(arb.accessWorld(), async ({ world, users }) => {
          const title = `property ${++n}`;
          const session: HarnessSession = await harness.setup(world, { id: 'B06', part: 'accessible', case: title, title, facets: ['engine', 'rbac', 'orm'] } as SetupContext);
          try {
            const ctx = {
              session,
              world,
              domain: session.domain ?? 'root',
              authz: () => session.authz,
              principal: (who: unknown) => (typeof who === 'string' ? world.principals![who] : who),
            } as unknown as StepContext;
            for (const [model, type, permissions] of [
              ['Doc', 'doc', ['doc:read', 'doc:update']],
              ['Project', 'project', ['project:read']],
            ] as const) {
              await laneSteps.accessibleAgree({ as: users, permissions, model, type }).do(ctx);
            }
          } finally {
            await session.dispose();
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
}
```

(`StepContext` has more members; `accessibleAgree` uses only `authz`, `principal` and `session`, so the cast is safe. If L5 named the step differently, use its name.)

- [ ] **Step 2: Run**

Run: `cd packages/authz-testing && L2_REQUIRE_PG=1 npx ts-mocha -p tsconfig.json test/e2e/property.test.ts`
Expected: `2 passing`. On failure fast-check prints the shrunk world and the seed; re-run with that seed (`fc.assert(..., { seed, path })`) and turn the shrunk world into a scenario of Task 2 before handing it to the owning lane.

- [ ] **Step 3: Commit**

```bash
git add packages/authz-testing/test/e2e/property.test.ts
git commit -m "test(authz-testing): property test, lists and per-row access agree with checkAll"
```

---

### Task 5: The guard, boot rule 12, `not_list_filterable`

**Files:**
- Create: `packages/authz-testing/test/e2e/boot.test.ts`

- [ ] **Step 1: Write the tests**

```ts
import 'mocha';
import { expect } from 'chai';

import { AuthzConfigError, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, World } from '@spinajs/authz-testing';

import { E2E_DIALECTS, e2eHarness, withPostgres } from './support/stack.js';
import { MODELS, PERMISSIONS, ROLES, authzOf, open, stackWorld } from './support/world.js';

const { assignment, combine, role } = fixtureDsl;
const alice = userPrincipal('alice');

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

for (const kind of E2E_DIALECTS) {
  describe(`e2e guard and list-filterability (${kind})`, function () {
    this.timeout(120_000);
    const harness = e2eHarness(kind);
    let s: HarnessSession | undefined;

    before(async function () {
      await withPostgres(this, kind);
      await harness.beforeAll?.();
    });
    after(() => harness.afterAll?.());
    afterEach(async () => {
      await s?.dispose();
      s = undefined;
    });

    describe('runtime guard (env test)', () => {
      it('a select on an @AccessResource model without .accessible() throws AuthzConfigError', async () => {
        s = await open(harness, stackWorld([assignment('a1', alice, 'viewer')]), 'guard');
        const Task = harness.model('Task') as unknown as { query(): any };
        const e = await rejection(authzOf(s).runAs(alice, 'e2e', async () => Task.query()));
        expect(e).to.be.instanceOf(AuthzConfigError);
      });

      it('.unscoped(reason) and runAs(SYSTEM) pass; a model without @AccessResource is not guarded', async () => {
        s = await open(harness, stackWorld([assignment('a1', alice, 'viewer')], { lane: { orm: { models: [...MODELS, { name: 'Note', columns: ['text'], rows: [{ id: 'n1', text: 'x' }] }] } } }), 'guard-bypass');
        const Task = harness.model('Task') as unknown as { query(): any };
        const Note = harness.model('Note') as unknown as { query(): any };
        expect(await authzOf(s).runAs(alice, 'e2e', async () => (await Task.query().unscoped('report')).length)).to.equal(5);
        expect(await runWithPrincipal(SYSTEM, async () => (await Task.query()).length)).to.equal(5);
        expect(await authzOf(s).runAs(alice, 'e2e', async () => (await Note.query()).length)).to.equal(1);
      });
    });

    describe('boot rule 12', () => {
      const refused = async (world: World, title: string, ...fragments: string[]) => {
        const e = await rejection(open(harness, world, title));
        expect(e).to.be.instanceOf(AuthzConfigError);
        expect(e.message).to.match(/\[6\.5\/12\]/);
        for (const f of fragments) expect(e.message).to.contain(f);
      };

      it('refuses a list permission routed with permit-overrides', async () => {
        await refused({ ...stackWorld(), combine: combine('permit-overrides', 'rbac') }, 'permit-overrides', 'task:read');
      });

      it('refuses a list permission with an RBAC grant on a relation other than owner or self', async () => {
        await refused({ ...stackWorld(), rbac: { roles: [...ROLES, role('teamlead', [{ permission: 'task:read', relation: 'team' }])], assignments: [] }, relations: [{ type: 'task', relation: 'team', holds: () => false }] } as World, 'relation', 'task:read');
      });

      it('refuses a list permission an ABAC policy grants on resource.*', async () => {
        await refused(
          { ...stackWorld(), combine: combine('deny-overrides', 'rbac', 'abac'), abac: { policies: [{ id: 'by-title', effect: 'permit', permissions: ['task:read'], when: { attr: 'resource.title', eq: 'a' }, source: 'config' }] } },
          'abac-resource',
          'task:read',
          'by-title',
        );
      });

      it('refuses a list permission on a type with no @AccessResource model', async () => {
        await refused({ ...stackWorld(), permissions: [...PERMISSIONS, { name: 'note:read', list: true }] }, 'no-model', 'note:read');
      });
    });

    describe('AuthzAdmin', () => {
      it('refuses a stored policy that would make a list permission unlistable (not_list_filterable)', async () => {
        s = await open(harness, { ...stackWorld(), combine: combine('deny-overrides', 'rbac', 'abac'), abac: { policies: [] } }, 'admin-policy');
        const [r] = await authzOf(s).admin().execute(SYSTEM, [{ kind: 'policy.put', policy: { id: 'by-title', effect: 'permit', permissions: ['task:read'], when: { attr: 'resource.title', eq: 'a' } } }]);
        expect(r.ok).to.equal(false);
        expect(r.ok === false && r.error.code).to.equal('not_list_filterable');
      });

      it('accepts a policy that reads no row', async () => {
        s = await open(harness, { ...stackWorld(), combine: combine('deny-overrides', 'rbac', 'abac'), abac: { policies: [] } }, 'admin-policy-ok');
        const [r] = await authzOf(s).admin().execute(SYSTEM, [{ kind: 'policy.put', policy: { id: 'mfa', effect: 'deny', permissions: ['task:update'], when: { not: { attr: 'principal.authn.assurance', eq: 'aal2' } }, reason: 'mfa_required' } }]);
        expect(r.ok, JSON.stringify(r)).to.equal(true);
      });
    });
  });
}
```

(`World.relations` is the kit's `RelationSpec` list; check its shape with `grep -n "export interface RelationSpec" -A6 packages/authz-testing/src/behaviour/types.ts` and adapt the literal; it only has to keep boot rule 8 quiet so rule 12's line is the one under test.)

- [ ] **Step 2: Run**

Run: `cd packages/authz-testing && L2_REQUIRE_PG=1 npx ts-mocha -p tsconfig.json test/e2e/boot.test.ts`
Expected: `16 passing`.

- [ ] **Step 3: Commit**

```bash
git add packages/authz-testing/test/e2e/boot.test.ts
git commit -m "test(authz-testing): e2e runtime guard, boot rule 12 and not_list_filterable"
```

---

### Task 6: Client access conformance against the real stack

Runs L5's `runClientAccessConformance` against an HTTP app built from authz-http (`/user/access/checks`, `/user/access/events`, `X-Access-Epoch`), authz-orm (`/docs` with `.withAccess`) and real RBAC on SQLite (one database is enough: the SQL paths are covered above).

**Files:**
- Create: `packages/authz-testing/test/e2e/client-access.test.ts`

- [ ] **Step 1: Write the test**

```ts
import 'mocha';

import { AccessController, Access } from '@spinajs/authz-http';
import { AuthorizationModel, AuthzAdminBackend, AuthzService, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import { AuthzAdminIdempotency_2026_10_02_00_01_00, AuthzRbac_2026_10_01_00_00_00, registerRbac } from '@spinajs/authz-rbac';
import { CLIENT_ACCESS_FIXTURE, runClientAccessConformance, testHost } from '@spinajs/authz-testing';
import type { ClientAccessApp } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { Orm } from '@spinajs/orm';

import { AccessResource, AuthzResourceAncestor_2026_10_14_00_00_00 } from '@spinajs/authz-orm';
import { TestDb } from './support/db.js';
// authz-http's own test app and header principal source (x-user: <id>).
import { startApp, stopApp } from '../../../authz-http/test/support/app.js';
import { registerHeaderSource } from '../../../authz-http/test/support/principals.js';
import { E2eAdminBackend } from './support/stack.js';

let Doc: { query(): any; insert(v: unknown): any };

@BasePath('docs')
class DocsController extends BaseController {
  @Get('/')
  @Access('doc:view')
  public async list() {
    const rows = (await Doc.query().accessible('doc:view').withAccess(['doc:edit', 'doc:view'])) as { id: string; $access: unknown }[];
    return new Ok(rows.map((r) => ({ id: r.id, $access: r.$access })));
  }
}

async function startClientApp(): Promise<ClientAccessApp> {
  const db = await TestDb.open();
  const driver = db.driver('sqlite');
  for (const m of [new AuthzRbac_2026_10_01_00_00_00(), new AuthzAdminIdempotency_2026_10_02_00_01_00(), new AuthzResourceAncestor_2026_10_14_00_00_00()]) await m.up(driver);
  Doc = (await db.define({ name: 'Doc', columns: {}, decorate: (m) => AccessResource('doc')(m) })) as never;
  for (const id of CLIENT_ACCESS_FIXTURE.ids) await runWithPrincipal(SYSTEM, async () => void (await Doc.insert({ id })));

  const unregisterSource = registerHeaderSource();
  const app = await startApp({
    controllers: [AccessController, DocsController],
    config: {
      env: 'test',
      'authz.permissions': { ...CLIENT_ACCESS_FIXTURE.permissions, 'authz:assignments.manage': {} },
      'authz.rbac.roles': CLIENT_ACCESS_FIXTURE.roles,
      'authz.rbac.stores': { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'] },
      'authz.rbac.connection': 'sqlite',
      'authz.admin': { connection: 'sqlite', backend: 'E2eAdminBackend', guard: { service: 'DefaultAdminGuard', privilegedPermission: 'authz:assignments.manage' } },
      'authz.combine': { default: { algorithm: 'deny-overrides', models: ['rbac'] } },
    },
  });
  DI.register(E2eAdminBackend).as(AuthzAdminBackend);
  await registerRbac(DI.RootContainer, (await DI.resolve(Configuration)) as Configuration);
  const authz = (await DI.resolve(AuthzService)) as AuthzService;
  const grants = CLIENT_ACCESS_FIXTURE.assignments.map((a) => ({ kind: 'assignment.grant' as const, subject: a.subject, role: a.role, scope: a.scope }));
  const results = await authz.admin().execute(SYSTEM, grants);
  if (!results.every((r) => r.ok)) throw new Error(`client app: seeding failed ${JSON.stringify(results)}`);

  const port = (app.server as unknown as { Server: { address(): { port: number } } }).Server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    headers: (id) => (id ? { 'x-user': id } : {}),
    async assign(id, role, scope) {
      const [r] = await authz.admin().execute(SYSTEM, [{ kind: 'assignment.grant', subject: { type: 'user', id }, role, scope }]);
      if (!r.ok) throw new Error(`assign: ${JSON.stringify(r)}`);
    },
    async stop() {
      try {
        await stopApp();
      } finally {
        unregisterSource();
        DI.uncache(AuthorizationModel);
        await db.close();
      }
    },
  };
}

runClientAccessConformance('client access conformance: authz-http + authz-orm + RBAC (sqlite)', startClientApp);
```

Before running, check four things against the code and adjust the literal names, not the checks:
- how `startApp` exposes the port (`grep -n "port" packages/authz-http/test/support/app.ts`; it keeps it in its module state: if `TestApp` has no `port`, add `readonly port: number` to `TestApp` there, which is a test-support change in authz-http and goes in this commit);
- `registerHeaderSource()` reads `x-user` and yields `user:<id>`, and with no header the request runs as authz-http's anonymous principal (`grep -n "x-user\|anonymous" packages/authz-http/test/support/principals.ts`);
- the registration order `startApp` → `registerRbac` matches what authz-http's own tests do with real models (if the root `AuthzService` boots inside `startApp`, move `registerRbac` and the backend registration before `startApp` and pass the configuration through `testHost.config()` the way `startApp` seeds it);
- the SSE route path and event name L11 shipped (`/user/access/events`, `authz.changed`).

- [ ] **Step 2: Run**

Run: `cd packages/authz-testing && npx ts-mocha -p tsconfig.json test/e2e/client-access.test.ts`
Expected: `10 passing`. A failure here is a client-visible contract break; fix it in L11 (HTTP shapes, epoch, SSE) or L4 (`$access`), never by skipping a check.

- [ ] **Step 3: Whole package**

Run: `cd packages/authz-testing && L2_REQUIRE_PG=1 npm test`
Expected: `0 failing`.

- [ ] **Step 4: Commit**

```bash
git add packages/authz-testing/test/e2e/client-access.test.ts packages/authz-http/test/support/app.ts
git commit -m "test(authz-testing): client access conformance over authz-http, authz-orm and RBAC"
```

---

### Task 7: `docs/authz/README.md`

**Files:**
- Modify: `docs/authz/README.md` (Packages L35, RBAC L230-252 and L330-367, ABAC L441-467, Adapters L503-588, AuthzAdmin L626-702, Testing kit L704-718)

Every replacement below is literal text. Line numbers are from `86791cf25`; find each block by its first words if they moved.

- [ ] **Step 1: Packages table**

Replace the `authz-orm` row with:

```md
| `@spinajs/authz-orm` | ORM adapter: resource declarations, the ancestor table, `.accessible()` lists, per-row `$access`, the audit and scope attribute stores. |
```

- [ ] **Step 2: RBAC: relations, deny roles, wildcards, teams**

Replace the `**`relation`**` bullet and the paragraph after it (L230-239) with:

```md
- **`relation`** turns the grant into a condition on the row. `owner` means the row's `@Owner()`
  column holds the principal's id. `self` means the row is the principal's own account. Several
  relations on one grant are OR-ed (B15). Each relation needs a `RelationResolver` for the type, or
  boot fails (boot rule 8). `@spinajs/authz-orm` supplies `owner` for every `@AccessResource` model
  with an `@Owner()` column; `@spinajs/users` supplies `self` on `user`.

  Every other relation is a role assigned on the resource. "Team editor of task 7" is the role
  `editor` assigned on `task:7` to the subject set `team:42#member`. A grant with another relation
  still works for single objects through your own `RelationResolver`, but its permission cannot be
  `list: true` (boot rule 12).
```

After the `**Subjects.**` bullet (L251-252) add:

```md
- **Deny roles.** A role with `deny: true` subtracts its permissions from its subject on its scope
  and every descendant. It wins over every permit (other roles, `owner`, `self`, `$global`, ABAC), and
  the reason is `role_denied`. It takes plain permissions or globs only: no `relation`, `fields`,
  `requiresTag`, `grantedAt`, and no `extends` to or from a permit role. Ceilings (role switch, token
  roles, links) never drop a deny assignment. `SYSTEM` is not subject to assignments.

  ```ts
  authz: { rbac: { roles: { blocked: { deny: true, grants: ['invoice:edit', 'invoice:delete'] } } } }
  ```

- **Wildcard subjects.** `{ type: 'user', id: '*' }` (stored as `user:*`) stands for every principal of
  type `user`; `anonymous:*` covers anonymous callers; `*:*` is refused. A wildcard may be a set member.
- **Teams.** `authz_subject_membership` holds the transitive closure of subject sets, so nested teams
  cost one indexed read. `AuthzAdmin` recomputes it in the batch's transaction for `set.addMember`,
  `set.removeMember` and grants, revokes and expiry changes of `subjectSet` roles. A chain deeper than
  `authz.rbac.maxSetDepth` (default 8) or a cycle is refused (`set_cycle`). A membership lives while
  any path to the set lives.
```

- [ ] **Step 3: RBAC: rule store, tables, CLI**

Replace the `DbRuleStore` bullet (L336-339) with:

```md
- `DbRuleStore` keeps scoped rules in `authz_rule` as their `definition`. Rules are check-only; a rule
  that would make a `list: true` permission unlistable is refused at write (`not_list_filterable`).
```

Replace the **Tables.** paragraph (L353-357) with:

```md
**Tables.** The migration `AuthzRbac_2026_10_01_00_00_00` creates `authz_assignment` (with
`subject_key`, `type:id` or `type:id#role`, indexed with `role`), `authz_subject_membership`,
`authz_rule`, `authz_rule_subject`, `authz_link` and `authz_version`. 3.0 is unreleased, so an rc.1
database is recreated, not upgraded. The `users.Role` copy and drop are two more migrations, described
in [the migration guide](./migration-guide.md#7-data-migration).
```

Add two rows to the CLI table:

```md
| `authz:membership-verify` | Recomputes `authz_subject_membership` from the assignments and reports missing and extra rows; exit code 1 on any difference. |
| `authz:membership-rebuild` | Rewrites `authz_subject_membership` from the assignments. |
```

- [ ] **Step 4: ABAC**

Replace the first "Rules that matter" bullet (L443-444) with:

```md
- `principal.*`, `actor.*`, `env.*` and `scope.*` are bound at once. `resource.*` becomes a residual on
  the row, decided once the row is loaded. A policy that reads `resource.*` keeps working for single
  objects, but its permissions cannot be `list: true`: boot refuses one from config, and `policy.put`
  refuses one with `not_list_filterable` (boot rule 12).
```

Replace the config-keys paragraph and the whole **`scopeResiduals`.** paragraph (L455-467) with:

```md
Config keys: `authz.abac.policies`, `authz.abac.stores` (`ConfigPolicyStore`, `DbPolicyStore`) and
`authz.abac.connection` (default `default`). Policy writes go through `AuthzAdmin` (`policy.put`,
`policy.delete`). The app registers the model itself ([Wiring the models](#wiring-the-models)).

**Lists.** For a `list: true` permission the ABAC model decides its policies before the query, from
the principal, the actor and the request env (MFA, time, IP): a permit that holds lists every row, a
deny that holds lists none. Which condition roots a list can use is the model's `listSupport`;
`packages/authz-abac/README.md` lists them.
```

Run: `grep -n "listSupport" packages/authz-abac/src -r | head -3` and `test -f packages/authz-abac/README.md`. If the README holds no list of roots, replace the last sentence with the roots `listSupport` accepts, read from the code.

- [ ] **Step 5: Adapters: HTTP**

Replace the `@Unscoped` bullet (L503-504) with:

```md
- `@Unscoped(reason)` marks a route whose ORM selects run without `.accessible()`; the call is audited
  once. A route with `@Unscoped` and no `@Access` fails registration.
```

and the access-routes bullet (L509-511) with:

```md
- `GET /user/access` returns the access summary. `POST /user/access/checks` answers a batch of up to
  100 checks for the caller: `{ checks: [{ object: { type, id }, permission, subject?, context? }] }`
  answers `{ results: boolean[], reasons: (string | null)[] }`. A permission without `:` becomes
  `<type>:<permission>`; `id: '*'` asks at the type level; only a definite allow is `true`; a bad entry
  is `false` and never fails the batch; a `subject` other than the caller is `false` with
  `subject_mismatch`; `context.field` and `fieldMode` narrow to one field, and nothing else of
  `context` is read. `GET /user/access/events` streams `authz.changed` (`{ objects? }`, absent means
  "refetch everything") over SSE; `@spinajs/http-socket` pushes the same event. Every answer carries
  `X-Access-Epoch`, which changes on login, role switch, MFA elevation and impersonation: a client
  that sees a new value drops its cached answers. `GET /authz/explain` exists only when
  `authz.http.explainRoute.enabled` is true and never in production (H19, B41); `format=tree`
  answers `{ label, allowed, children }`.
```

- [ ] **Step 6: Adapters: ORM (whole subsection)**

Replace everything from `### ORM (`@spinajs/authz-orm`)` up to `### Queue` with:

````md
### ORM (`@spinajs/authz-orm`)

```ts
import { AccessResource, Owner, Parent } from '@spinajs/authz-orm';

@AccessResource('task')
export class Task extends ModelBase {
  @Parent('folder') public folder_id: number;   // ancestors: task > folder > ... > project > org
  @Owner()          public owner_id: string;    // the 'owner' relation
}

@AccessResource('folder')
export class Folder extends ModelBase {
  @Parent('folder', { nullable: true }) public parent_id: number;   // any depth
  @Parent('project')                    public project_id: number;
}
```

- **Single objects are checked before access.** Load the row, then `authz().assert(me, 'Task:update',
  row)`, or put `@Access('Task:update', { resource: fromModel(Task, 'task') })` on the route. No query
  is rewritten. A create is checked against the parent: `assert(me, 'Task:create', { type: 'folder',
  id })`. Moving a row (writing a `@Parent` column) needs a check of the new parent too.
- **Lists use one helper.** `Task.where(...).accessible('Task:read')` adds one fixed `EXISTS` filter
  over `authz_assignment`, `authz_subject_membership` and `authz_resource_ancestor`. The permission
  must be declared `list: true` (`authz.permissions['Task:read'] = { list: true }`); boot refuses one
  that something can grant only by reading the row (boot rule 12). A principal that nothing could ever
  grant it to gets `AccessDenied`, not an empty list (H16). The same helper works on update and delete
  builders. `.withAccess(['Task:update', 'Task:delete'])` adds `$access` to every row (key:
  `authz.orm.accessField`), equal to what `POST /user/access/checks` answers for that row.
- **Every multi-row select on an `@AccessResource` model** calls `.accessible()`, `.unscoped(reason)`,
  or runs in `runAs(SYSTEM, reason)`. A select on exactly one primary-key value (`@FromModel`,
  `findOrFail(id)`) is a single-object load and is not flagged. In the `test` env anything else throws `AuthzConfigError`; in
  `development` it warns once per call site; in production it is off. The ESLint rule
  `@spinajs/authz/require-accessible` (`@spinajs/eslint-plugin-authz`) flags the same at edit time.
- **Relations, `populate()`, joins and sub-queries are not filtered.** Authorize the aggregate root;
  load a child type that is its own resource with the helper:
  `project.populate('tasks', (q) => q.accessible('Task:read'))`.
- **The ancestor table** follows every ORM insert, `@Parent` update and delete, in the same
  transaction. A delete also forgets the scope: its assignments, links, rules, policies and scope
  attributes, then one audit entry as `SYSTEM` (`resource-deleted`). Writes outside the ORM need
  `authz:ancestors-rebuild`; `authz:ancestors-verify` reports drift with exit code 1.
- `registerAccessResource(model, type, { parents, owner })` declares a model a package does not own.
  Register models before the authz domain boots.
- `filterFields(decision, data, mode)` keeps the fields a decision allows. `DbDecisionAudit`
  (`@spinajs/authz-orm/audit`) writes `authz_audit`; `DbScopeAttributeStore` keeps
  `authz_scope_attribute`.

Full reference: `packages/authz-orm/README.md`.
````

- [ ] **Step 7: Adapters: Queue**

In the Queue subsection replace "registers `JobModel` as the `job` resource with the relation `initiator`, and grants `job:read` (relation `initiator`) to the `user` role" with "registers `JobModel` as the `job` resource whose `owner` is the principal that emitted it, and grants `job:read` (relation `owner`) to the `user` role".

- [ ] **Step 8: AuthzAdmin**

After the guard's bullet list (after the `protected_role` bullet, L659) add:

```md
- granting a deny role needs the same command permission as any grant and is never an escalation;
  `last_holder` and `self_lockout` treat a deny of the privileged permission like a revoke.

**List permissions.** A built-in validator refuses `policy.put` and `rule.put` with
`not_list_filterable` when the stored policy or rule would make a `list: true` permission depend on
the row, so `.accessible()` never meets data it cannot honour.

**Teams and deletes.** The DB backend recomputes `authz_subject_membership` in the batch's transaction
for every member a command touches. Deleting a resource row through the ORM runs the `scope.forget`
store writes in the caller's transaction (the one write of `authz_*` outside `AuthzAdmin`), bumps
`authz_version` and, after the commit, publishes the change and audits it as `SYSTEM` with the reason
`resource-deleted`.

**Push.** After a commit, `AccessChangeRouter` asks the registered `ChangeAudience`s whom a change
affects (an assignment: its subject, or the members of a set; a role, policy or rule: everyone) and
pushes `authz.changed` over every `AccessPushTransport` (SSE in authz-http, the socket in http-socket).
```

Replace "`scope.replaceAttributes`, `scope.forget`." in the **Commands.** paragraph by the same text (no change of commands) only if L2 added any command; otherwise leave it.

- [ ] **Step 9: Testing kit**

Add a bullet:

```md
- `runClientAccessConformance(name, harness)`: drives a running app's `/user/access/checks`, `$access`,
  `X-Access-Epoch` and access events with the request shapes of ckit's HTTP checker.
```

and in the intro (L10-12) keep the sentence about package READMEs.

- [ ] **Step 10: Grep the page against the code**

Run:

```bash
grep -nE "OrmScope|ScopeColumn|relationScope|scopeResiduals|allowJit|native:|/user/access/check\b|jit = on|RESULTS.md|B44" docs/authz/README.md
grep -rn "ownsBy" packages/authz-orm/src | head -1
```

Expected: the first prints nothing. If `ownsBy` no longer exists in authz-orm, also remove it from the README (it appears only in the removed ORM text and the RBAC relation paragraph you replaced; `grep -n ownsBy docs/authz/README.md` must print nothing then).

- [ ] **Step 11: Commit**

```bash
git add docs/authz/README.md
git commit -m "docs(authz): README for resource access without query rewriting"
```

---

### Task 8: `packages/authz-orm/README.md` from scratch

**Files:**
- Replace: `packages/authz-orm/README.md`

- [ ] **Step 1: Write the README**

````md
# @spinajs/authz-orm

The ORM adapter of SpinaJS authorization. It declares which models are access resources, keeps their
ancestors in a closure table, filters lists with one helper, adds per-row access to list responses, and
holds the decision audit and scope attribute stores.

It never rewrites a query. Single objects are checked before access; lists ask for filtering
explicitly.

## Install

```ts
import '@spinajs/authz-orm';   // registers the adapter, the write middleware and the list compilers
```

Migrations: `AuthzResourceAncestor_2026_10_14_00_00_00` (`authz_resource_ancestor`),
`AuthzScopeAttribute_2026_10_02_00_00_00` (`authz_scope_attribute`), `AuthzAudit_2026_10_01_00_00_00`
(`authz_audit`). The ancestor table lives on the connection of the authz stores
(`authz.rbac.connection`), which must be the database of the resource tables: the list filter joins
them.

## Declaring resources

```ts
import { AccessResource, Owner, Parent, Self, registerAccessResource } from '@spinajs/authz-orm';

@AccessResource('task')
export class Task extends ModelBase {
  @Parent('project') public project_id: number;
  @Parent('sprint')  public sprint_id: number;    // a second parent: both chains are ancestors
  @Owner()           public owner_id: string;     // relation 'owner'
}

@AccessResource('folder')
export class Folder extends ModelBase {
  @Parent('folder', { nullable: true }) public parent_id: number;   // self-reference: any depth
  @Parent('project')                    public project_id: number;
}

// a model your package does not own
registerAccessResource(DbConfig, 'configuration');
// the initiator can be any principal type: the owner holds when type and id both match
registerAccessResource(JobModel, 'job', { owner: { column: 'InitiatorId', typeColumn: 'InitiatorType' } });
```

- `@Parent(type)` names the parent's resource type; the column holds the parent's id. Int and uuid
  keys share one table (ids are stored as text).
- `@Owner()` is read from the row whenever it is needed; it is never copied, so it cannot go stale.
  Without options it matches `user` principals only; `@Owner({ typeColumn: 'owner_type' })` compares
  the principal's type with that column too, for rows owned by any principal type.
- `@Self()` marks the column that equals the principal id (`self`); `@spinajs/users` uses its own
  resolver for `user`.
- Register every model before the authz domain boots (at import or in a `Bootstrapper`).

## Single objects

```ts
const task = await authz().runAs(SYSTEM, 'load task', () => Task.where('id', id).first());
await authz().assert(me, 'task:update', task);
```

Routes keep `@Access('task:update', { resource: fromModel(Task, 'task') })`. The adapter answers
`ancestors(ref)` with one indexed read, `load(ref)` by primary key as `SYSTEM`, and `owner` from the
`@Owner` column. `checkAll` (and `POST /user/access/checks`) loads a page of rows with one query per
type (`loadMany`, `ancestorsMany`).

A **create** is checked against the parent; a **move** (writing a `@Parent` column) needs a check of
the new parent. The ORM checks neither.

## Lists

```ts
authz: { permissions: { 'task:read': { list: true } } }

const tasks = await Task.where('status', 'open').accessible('task:read');
await Task.update({ archived: true }).where('done', true).accessible('task:update');
```

- `.accessible(permission)` asks `authz().accessPlan(principal, permission, type)` and adds one
  `EXISTS` filter: a grant on the row, a grant on any ancestor, the owner column, minus deny roles,
  inside the principal's ceiling. It works on SQLite, PostgreSQL, MySQL and MSSQL, with no recursion.
- A plan with no permit at all throws `AccessDenied` (a 403, never an empty list). A permission
  without `list: true` throws `AuthzConfigError`.
- **Boot rule 12** refuses a `list: true` permission when anything that can grant it on the type needs
  the row: an RBAC grant with a relation other than `owner` or `self`, an ABAC policy on `resource.*`,
  an RBAC `cap`, `restrict` or `threshold` rule, a type with no `@AccessResource` model or on another
  database, or a route other than `deny-overrides`. `AuthzAdmin` refuses the same at write time
  (`not_list_filterable`).

## Per-row access

```ts
const rows = await Task.query().accessible('task:read').withAccess(['task:update', 'task:delete']);
// rows[i].$access = { 'task:update': true, 'task:delete': false }
```

Each permission is one boolean column built from the same filter, so a page with its access is one
query. Each permission must be `list: true`. `$access` is serialized with the row; rename it with
`authz.orm.accessField`. A client may seed its cache from it: it equals what
`POST /user/access/checks` answers.

## The runtime guard

A multi-row select on an `@AccessResource` model must call `.accessible()`, `.unscoped(reason)`, or run
in `runAs(SYSTEM, reason)`. A select on exactly one primary-key value (`@FromModel`, `findOrFail(id)`)
is a single-object load: the route's `@Access` or your `assert` covers it, and the guard leaves it alone.

| env | without one of them |
|---|---|
| `test` | `AuthzConfigError`, so CI fails |
| `development` | a warning once per call site |
| production, unset | nothing |

The guard only reads the builder. A `populate()` of an `@AccessResource` type needs the helper like any
other select. Add `@spinajs/eslint-plugin-authz` (`@spinajs/authz/require-accessible`) to catch the
same at edit time.

## Nested data

`populate()`, relations, joins and sub-queries are not filtered. Authorize the aggregate root: the
comments of a task you may read are part of it. A child type that is its own resource is loaded with
the helper: `project.populate('tasks', (q) => q.accessible('task:read'))`.

## Keeping the ancestor table right

| Write through the ORM | What happens |
|---|---|
| insert of a model with `@Parent` | its rows: the parent's rows one level deeper, plus the parent |
| update of a `@Parent` column | the subtree's links above the row are replaced by the new chain |
| delete | its rows and its descendants' links above it go; the scope is forgotten |

A `@Parent` update or a delete and its table writes run in one transaction: the caller's, or one the
middleware opens. Where neither is possible the write is refused with `AuthzConfigError`.

**Deleting** a resource also deletes, in the same transaction, the assignments (recomputing the team
memberships they fed), links, rules, policies and scope attributes at its scope, bumps
`authz_version`, and after the commit publishes the change and writes one audit entry as `SYSTEM`
(`resource-deleted`). An id reused later inherits nothing.

Bulk moves: `authz().ancestors.reparent(type, ids, newParent)`. Writes outside the ORM (raw SQL,
imports) are not tracked: run the CLI afterwards.

| Command | Does |
|---|---|
| `authz:ancestors-verify [type]` | recomputes from the `@Parent` columns, prints missing and extra rows, exit code 1 on any |
| `authz:ancestors-rebuild [type]` | rewrites the table in batches |

## Audit and scope attributes

- `DbDecisionAudit` (`@spinajs/authz-orm/audit`) writes decision records to `authz_audit` on the
  connection `authz-audit`.
- `DbScopeAttributeStore` keeps `authz_scope_attribute`, written through `AuthzAdmin`
  (`scope.setAttributes`, `scope.replaceAttributes`).
- `filterFields(decision, data, mode)` keeps the fields a decision allows.

## Config

| Key | Default | Meaning |
|---|---|---|
| `authz.orm.accessField` | `'$access'` | the per-row access key of `.withAccess()` |

## From 3.0.0-rc.1

`@ScopeColumn` is `@Parent`; `@OrmScope` relations become role assignments on the resource;
`relationScope`, `authz.orm.allowJit` and the native compiler exports are gone; selects call
`.accessible()`. Step by step:
[the migration guide, section 12](../../docs/authz/migration-guide.md#12-from-query-scoping-2x-and-300-rc1).
````

- [ ] **Step 2: Tie it to the code**

Run:

```bash
grep -nE "export (function|const|class) (AccessResource|Parent|Owner|Self|registerAccessResource|filterFields|DbDecisionAudit|DbScopeAttributeStore)\b" -r packages/authz-orm/src
grep -rn "accessField" packages/authz-orm/src/schema.ts
grep -rn "ancestors-verify\|ancestors-rebuild\|reparent" packages/authz-orm/src packages/authz/src -l
grep -rn "class AuthzResourceAncestor_\|class AuthzAudit_\|class AuthzScopeAttribute_" packages/authz-orm/src
```

Expected: every name the README uses is found. For each that is not: if L3/L4 named it differently, use the real name; if it does not exist (for example `@Self()` or `ancestors.reparent`), delete the sentence or table row that names it. The JobModel example must match L5 Task 6 (`owner: { column: 'InitiatorId', typeColumn: 'InitiatorType' }`), and `Owner(opts?: { typeColumn })` must exist.

- [ ] **Step 3: Commit**

```bash
git add packages/authz-orm/README.md
git commit -m "docs(authz-orm): README for the new package"
```

---

### Task 9: Migration guide: section 12 and the stale advice

**Files:**
- Modify: `docs/authz/migration-guide.md` (Contents L17-29, §1 table row L50, §4 L242-243, §5.1 L354-359, §6.3 L458-475, §6.5 L494-502, Step 4 L714-716, §11 L1615, new §12 at the end)

- [ ] **Step 1: Contents and §1**

Add to Contents: `12. [From query scoping (2.x and 3.0.0-rc.1)](#12-from-query-scoping-2x-and-300-rc1)`.

Delete the §1 table row `| **PostgreSQL needs `jit = off`** | … |` (L50): nothing refuses JIT any more.

- [ ] **Step 2: §4, §5.1, §6, Step 4, §11**

§4 (L242-243): replace "to say which models need `@Owner` or an `@OrmScope` class." with "to say which models need `@Owner` and which relations become role assignments on the resource."

§5.1 rows:

```md
| `@OrmResource`, `@ResourceOwner` | `@AccessResource`, `@Owner` (`authz-orm`); lists call `.accessible(permission)`, single objects are checked before access (section 12) |
| `@OrmPermission(M, 'x') class P extends OrmPermissionPolicy` | no ORM form: assign a role on each resource row to the subjects the policy selected (section 12); a `RelationResolver` keeps single-object checks of relation `x` working meanwhile |
| `GET /grants`, `/user/grants`, `Grants` in login | `GET /user/access`, `POST /user/access/checks`, and `Access` in the login, MFA, role switch, impersonation and whoami answers (users' `AccessResponseExtension`) |
```

§6.3: replace the heading's body (from "```ts // 3.0 (@spinajs/authz-orm)" through "More rules: `packages/authz-orm/README.md`.") with:

````md
3.0 has no query policy. The partner relation becomes a role on each campaign, and the list asks for
it:

```ts
// authz.rbac.roles: { 'campaign.partner': { scopeTypes: ['ArrowCampaign'], grants: ['ArrowCampaign:read', 'ArrowCampaign:update'] } }
// authz.permissions: { 'ArrowCampaign:read': { list: true } }

// when a campaign is created or its management company changes (one batch, as SYSTEM or an admin)
await authz().admin().execute(actor, [
  { kind: 'assignment.revokeWhere', scope: { type: 'ArrowCampaign', id: campaign.Id }, role: 'campaign.partner' },
  { kind: 'assignment.grant', subject: { set: { role: 'pool.member', scope: { type: 'pool', id: campaign.Pool } } }, role: 'campaign.partner', scope: { type: 'ArrowCampaign', id: campaign.Id } },
]);

// the list
const rows = await ArrowCampaign.where(filters).accessible('ArrowCampaign:read');
```

The update guard is a check before the write: `await authz().assert(me, 'ArrowCampaign:update',
campaign)` on the stored row, and a check of the new pool when the request moves the campaign.
````

§6.5: replace the last two sentences ("`ownsBy` (from …" through "…when they need one.") with: "Register the resolver in the domain's container before the domain boots. A relation from a resolver works for single objects only; for lists of that type, make the relation a role assignment (section 12)." If `ownsBy` was removed from authz-orm (Task 7 Step 10), also replace "`ownsBy('CampaignComments', 'author', (p, c) => c.addedBy === p.identity.Id)`" with "a `RelationResolver` for `author` on `CampaignComments` that compares `addedBy` with the principal's id".

Step 4 (L714-716): replace the `OrmPermissionPolicy` bullet with:

```md
- Mark resource models with `@AccessResource` and `@Parent` / `@Owner`. Turn every
  `OrmPermissionPolicy` into role assignments on the resource (section 12). Give every list query
  `.accessible(permission)` and every single-object route a check before the write.
```

§11: delete the bullet "**SQLite lists over stored rules** suit tests and small tables only (section 9, L4b)."

- [ ] **Step 3: Section 12**

Append:

````md
## 12. From query scoping (2.x and 3.0.0-rc.1)

3.0.0-rc.1 scoped every select, update and delete of an `@AccessResource` model in a query middleware.
3.0 does not rewrite queries (design: `docs/plans/2026-10-14-authz-resource-access-design.md`). Section
9, lanes L4 and L4b, describes rc.1; this section replaces it. A 2.x app reads it after section 8.

### 12.1 What changed

| rc.1 | 3.0 |
|---|---|
| `@ScopeColumn('project_id', 'project')` | `@Parent('project')` on the column; ancestors live in `authz_resource_ancestor` |
| `@OrmScope(Model, 'team')` with `OrmScopePolicy` | removed: a role assigned on the resource to a user or a subject set (`team:42#member`) |
| `@AccessResource(type, { relationScope, attributes })` | `@AccessResource(type)`; scope attributes come from the scope resolver and `authz_scope_attribute` |
| every select scoped | single objects checked before access; lists call `.accessible(permission)` on a `list: true` permission |
| a select without a principal threw `AccessDenied` | a multi-row select without `.accessible()`, `.unscoped(reason)` or `runAs(SYSTEM)` throws `AuthzConfigError` in the `test` env; a select on one primary key is a single-object load |
| inserts stamped the owner, `authorizeCreate` / `authorizeUpdate` | the app checks the parent before a create and the row before an update |
| `populate()`, junctions and clones scoped | not filtered: authorize the aggregate root |
| rule SQL forms, `rule_not_compilable` | rules are check-only; `not_list_filterable` refuses what lists cannot honour |
| `authz.abac.scopeResiduals`, `native:condition.scope` | removed |
| `authz.orm.allowJit`, the PostgreSQL JIT check | removed |
| `POST /user/access/check` | `POST /user/access/checks` (`{ checks }` → `{ results, reasons }`), `GET /user/access/events`, `X-Access-Epoch` |
| job relation `initiator` | job relation `owner` (the initiator, `@Owner`-style with `typeColumn: 'InitiatorType'`) |
| — | deny roles (`deny: true`), wildcard subjects (`user:*`), nested teams (`authz_subject_membership`) |

### 12.2 Steps

1. **Recreate the database.** 3.0 is unreleased, so the migrations were edited in place
   (`authz_assignment.subject_key`, `authz_subject_membership`, `authz_resource_ancestor`, the rule
   columns). Export what you need from an rc.1 database (`authz_assignment`, `authz_link`, `authz_policy`,
   `authz_rule` definitions), recreate it, and import through `AuthzAdmin` (`assignment.grant`,
   `set.addMember`, `policy.put`, `rule.put`).
2. **Declarations.** Replace `@ScopeColumn(column, type)` with `@Parent(type)` on that column (add
   `{ nullable: true }` for an optional or self parent). Drop `relationScope` and `attributes` from
   `@AccessResource`. `registerAccessResource(model, type, { parents, owner })` replaces the rc.1 form
   for models you do not own.
3. **Relations.** For each `@OrmScope(Model, 'x')`: define a role holding the permissions that relation
   gave, assign it on each row to the subjects the policy selected (a user, a team as
   `{ set: { role, scope } }`, or `user:*`), keep the assignments right where rows are created or
   moved, and delete the policy class. Grants with `relation: 'x'` in config become plain grants of
   that role.
4. **Lists.** Declare each permission a list uses with `list: true`, and give every list query
   `.accessible(permission)`. Boot names every permission that something can grant only by reading the
   row (`[6.5/12]`); for those, keep single-object checks and write the list's own WHERE.
5. **Single objects.** Load as `SYSTEM` (or through `@Access` with `fromModel`), then
   `authz().assert(me, permission, row)`. A create checks the parent; a move checks the new parent.
6. **Run the tests in the `test` env.** The runtime guard fails every multi-row select that forgot
   `.accessible()`; add `@spinajs/eslint-plugin-authz` to catch them in the editor.
7. **Clients.** Move from `POST /user/access/check` to `POST /user/access/checks`; read `$access` from
   lists made with `.withAccess(...)`; drop cached answers when `X-Access-Epoch` changes, and refetch
   on `authz.changed`.
8. **Imports outside the ORM.** After a raw import of rows with `@Parent` columns, run
   `authz:ancestors-rebuild`.

### 12.3 A 2.x app

Follow sections 1 to 8, then 12.2 steps 2 to 7 in place of the `@OrmScope` advice of earlier drafts:
an `OrmPermissionPolicy` becomes role assignments (step 3), never a query policy.
````

- [ ] **Step 4: Grep**

Run: `grep -nE "OrmScopePolicy|@OrmScope|ScopeColumn|allowJit|scopeResiduals|relationScope|/user/access/check\b" docs/authz/migration-guide.md`
Expected: matches only inside section 9 (lane history: L4, L4b, A4, K1) and the 12.1 table's left column. Check each by line number.

- [ ] **Step 5: Commit**

```bash
git add docs/authz/migration-guide.md
git commit -m "docs(authz): migration guide section for apps on query scoping"
```

---

### Task 10: Design status and the ckit hand-off

**Files:**
- Modify: `docs/plans/2026-10-14-authz-resource-access-design.md:3`
- Create: `docs/plans/2026-10-14-ckit-handoff.md`

- [ ] **Step 1: Status line**

Replace line 3 with:

```md
Date: 2026-10-14. Status: built (plan: `docs/superpowers/plans/2026-10-14-authz-resource-access/`; deviations in its overview, "Decisions made while planning").
```

- [ ] **Step 2: The hand-off note**

`docs/plans/2026-10-14-ckit-handoff.md`:

````md
# ckit hand-off: spinajs client access API

Date: 2026-10-14. For: the owner of the ckit repo (`coderush/ckit`, package `ckit-access`).
From: spinajs authz 3.0 (`docs/plans/2026-10-14-authz-resource-access-design.md`, §10).

spinajs now serves a client access API that ckit's `createHttpChecker` talks to with its defaults. Three
pieces belong in ckit and are not built on the spinajs side. spinajs CI runs
`runClientAccessConformance` (`@spinajs/authz-testing`) with the request fixtures of
`packages/access/src/http.test.ts`, so a server change that breaks the defaults fails there first.

## What the server answers

- `POST /user/access/checks`
  - request: `{ checks: [{ object: { type, id }, permission, subject?, context? }] }`, at most 100
    entries (ckit's `DEFAULT_MAX_BATCH_SIZE`);
  - response: `200 { results: boolean[], reasons: (string | null)[] }`, one entry per check, in order;
  - `true` only for a definite allow; a bad entry is `false` and never fails the batch;
  - `subject` must be the session's principal, else `false` with `subject_mismatch`;
  - `context.field` and `context.fieldMode` (`read` | `write`, default `write`) narrow to one field;
    nothing else in `context` is read (an `ip` there is ignored);
  - `permission` without `:` becomes `<object.type>:<permission>`; `object.id === '*'` asks at the type
    level; `object.type === '$global'` is the global scope;
  - anonymous callers may ask; no principal at all is `401`.
- `X-Access-Epoch` on every response of `authn-http` and `authz-http`: 16 hex characters per session,
  changes on login, role switch, MFA elevation and impersonation start and end.
- `GET /user/access/events` (SSE): `event: authz.changed`, `data: { "objects"?: [{ "type", "id" }] }`.
  `objects` is present only when exact; absent means "anything may have changed". The http-socket
  channel pushes the same event name and payload.
- List responses built with `.withAccess([...])` carry `$access: { [permission]: boolean }` per row
  (the key is configurable server-side, `authz.orm.accessField`). Each entry equals what
  `/user/access/checks` answers for `(row, permission)`.
- `authz:export-model [--out file.d.ts]` writes `export type AccessModel = { [type]: action union }`,
  usable as ckit's `AccessRegister` model.
- `format=tree` on the explain route (development only) answers `{ label, allowed, children }`, the
  shape of ckit's `ExplainNode`.

## Work in ckit

1. **Seed API.** `access.seed(entries)`: load `$access` answers into the store as settled answers, for
   example `seed(rows.flatMap((r) => Object.entries(r.$access).map(([permission, allowed]) => ({ object:
   { type, id: r.id }, permission, allowed }))))`. A seeded `(object, permission)` must equal a fetched
   one; a later `invalidate`/`subscribe` notification drops seeded entries like fetched ones.
2. **Epoch hook.** An option on `createHttpChecker`, e.g. `onResponse(response)` or
   `epochHeader: 'X-Access-Epoch'`, that compares the header with the last value and, on a change,
   drops every cached answer (the same as `invalidate()` with no filter). Without it a role switch
   leaves stale answers until the next push.
3. **Docs.** A spinajs section in `docs/access-control.md`: the endpoint and defaults above; the
   subject is taken from the session (send it or not); wire `subscribe` to `GET /user/access/events`
   (or the socket channel) with `changed` = `objects`, and no argument when `objects` is absent; seed
   from `$access`; the epoch hook; fail closed (anything but `true` denies).
4. **Later.** When the file manager moves to `ckit-access`: fs object ids as `<fs>:` +
   `encodeURIComponent(path)` (ckit ids forbid whitespace). Deferred on the spinajs side too
   (`authz-fs` decodes them only once this lands).

## Contact points

- Conformance: `packages/authz-testing/src/conformance/client-access.ts` (`CLIENT_ACCESS_FIXTURE`).
- Server: `packages/authz-http` (`AccessController`, SSE, epoch middleware), `packages/authz-orm`
  (`.withAccess`), `packages/http-socket` (socket transport).
````

- [ ] **Step 3: Commit**

```bash
git add docs/plans/2026-10-14-authz-resource-access-design.md docs/plans/2026-10-14-ckit-handoff.md
git commit -m "docs(plans): resource-access design built; ckit hand-off note"
```

---

### Task 11: Definition of done

**Files:** none (fix-ups only).

- [ ] **Step 1: Build and snapshot**

Run (repo root): `npm run build && node scripts/api-snapshot.mjs --check`
Expected: both succeed.

- [ ] **Step 2: Removed names**

Run (repo root): `grep -rE --exclude='*.md' "OrmScope|OrmNativeCompiler|ScopeColumn|RbacOrmCompiler|authz-orm/native" packages/*/src packages/*/test | grep -v '^packages/authz-convert/test/analyze\.test\.ts:'`
Expected: no output. Markdown history and the negative assertion in `authz-convert/test/analyze.test.ts` are excluded (overview, definition of done).

- [ ] **Step 3: Every package of the definition of done**

```bash
for p in orm authz authz-rbac authz-abac authz-orm authz-http http-socket authz-queue authz-fs authz-testing users configuration-http queue-http-progress eslint-plugin-authz; do
  (cd packages/$p && L2_REQUIRE_PG=1 npm test) || echo "FAILED: $p"
done
```

Expected: no `FAILED:` line; each run ends with `0 failing` (authz runs three mocha configs).

- [ ] **Step 4: The e2e suite on both databases**

Run: `cd packages/authz-testing && L2_REQUIRE_PG=1 npx ts-mocha -p tsconfig.json 'test/e2e/**/*.test.ts'`
Expected: `0 failing`, no pending suite (a pending postgres suite means the server was unreachable).

- [ ] **Step 5: Commit any fix-ups**

```bash
git add -A
git commit -m "chore: resource-access definition of done"
```

(Skip when nothing changed.)

---

## Contract issues found

Resolved in `00-overview.md` (2026-10-14): the e2e suite lives in `packages/authz-testing/test/e2e` (decision 12; no test-only cycle), `.unscoped(reason)` and `authz.orm.domain` are in the names table, the guard skips single primary-key selects (decision 11; the docs say so), the typed owner exists, and raw past-expiry assignment rows are accepted. Still read in Task 0 rather than fixed by the names table:

1. The ancestor migration class name (assumed `AuthzResourceAncestor_2026_10_14_00_00_00`), the configuration key the guard reads for the env (assumed `env`), whether `ownsBy` and `authz().ancestors.reparent` exist, and `subjectKeyOf` exported from `@spinajs/authz-rbac`.
2. authz-http's test `startApp` does not expose the port; Task 6 adds `port` to its `TestApp` (test support only).
