# Lane L4: authz-orm lists

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `00-overview.md` first: its Global Constraints, frozen contracts and names table bind every step here.

**Goal:** The list helpers of design §6.2 and §10.3 in `@spinajs/authz-orm`: `query.accessible(permission)` on select, update and delete builders, `query.unscoped(reason)`, `query.withAccess(permissions)` with per-row `$access`, rendered from the engine's `AccessPlan` through registered `PlanTermSql` compilers into one SQL shape on SQLite, PostgreSQL, MySQL and MSSQL.

**Architecture:** The builder methods only set marks (`src/marker.ts`, lane L3). `AccessListMiddleware` (`QueryMiddleware`, order 100) reads them at `beforeQueryExecution`: it asks `authz(domain).accessPlan(principal, permission, type, env)` (L2), renders the plan (`permit` terms OR-ed, `NOT (deny terms OR-ed)`, the `within` ceiling over `authz_resource_ancestor`) with the `PlanTermSql` registered for each term's `op`, puts the caller's where in one group and ANDs the rendered fragment. `withAccess` adds one `CASE WHEN … THEN 1 ELSE 0 END` column per permission and moves it to `$access` (`authz.orm.accessField`) after hydration. authz-orm ships the `relation.owner` and `relation.self` compilers (columns from the registry); authz-rbac (L8) registers `rbac.assignment`.

**Tech Stack:** TypeScript (node16 ESM + CJS), `@spinajs/orm`, `@spinajs/authz`, mocha + chai + sinon; SQLite in memory and Docker PostgreSQL (port `ORM_TEST_POSTGRES_PORT`, default 15432).

**Depends on:** G0 (L0: `PlanTermSql`, `SqlRowContext`, `SqlFragment`, `AccessPlan`, `AuthzService.accessPlan(principal, permission, type, env?)`), L3 Task 1 (registry, `marker.ts`, `host.ts`), L3 Task 2 (`AUTHZ_RESOURCE_ANCESTOR_TABLE`, migration). Task 4 also needs L1 merged (decision 19: orm-sql keeps the bindings of raw select columns). Task 5 also needs L2 merged (`accessPlan` implemented by `DefaultAuthzService`, L2 Task 5).

**Blocks:** L8 (registers `rbac.assignment` against `SqlRowContext` as rendered here), L9.

**Serves the teams lanes:** Task 7 (`.within(ref)`) is the list helper the teams lanes L14/L15 use (`docs/plans/2026-10-14-teams-design.md` §9, §10); it needs Tasks 2 and 3 only.

## Global Constraints

- All code, comments, docs, identifiers and commit messages in English. Comments only where a reader would ask "why?".
- Versions: `@spinajs/authz*` `3.0.0-alpha.0`, other `@spinajs/*` `2.0.549`.
- Tests: mocha + chai `expect`, `test/<area>/<name>.test.ts`. One file: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/<path>.test.ts`. Package: `cd packages/authz-orm && npm test`.
- Postgres cases run when `TestDb.postgresReachable()` and skip otherwise (`test/audit.test.ts` pattern).
- `scripts/api-snapshot.json` `augmentationAllowlist` is written only by L4 and L12 (overview, shared-file serialization).
- Commit after every task with a conventional message.

## Files

| File | Responsibility | Task |
|---|---|---|
| `packages/authz-orm/src/lists/dialect.ts` | driver → dialect, `CAST(… AS text)` per dialect, identifier quoting | 1 |
| `packages/authz-orm/src/lists/terms.ts` | `planTermCompilers()`: DI `PlanTermSql`s by op | 1 |
| `packages/authz-orm/src/lists/relation-sql.ts` | built-in `relation.owner` / `relation.self` compilers | 1 |
| `packages/authz-orm/src/lists/context.ts` | `SqlRowContext` of a builder | 2 |
| `packages/authz-orm/src/lists/render.ts` | `AccessPlan` → `Rendered` (SQL / all / none) | 2 |
| `packages/authz-orm/src/lists/augment.ts` | `declare module '@spinajs/orm'` + prototype methods | 3, 7 |
| `packages/authz-orm/src/lists/middleware.ts` | `AccessListMiddleware` | 3, 4, 7 |
| `packages/authz-orm/src/lists/access-field.ts` | `$access` hydration middleware | 4 |
| `packages/authz-orm/src/lists/index.ts` | barrel | 1–4 |
| `packages/authz-orm/src/schema.ts` | `authz.orm.accessField` | 4 |
| `scripts/api-snapshot.json` | `augmentationAllowlist` entry | 3 |
| `docs/plans/authz-v3-rfc/RA4-1.md` | RFC for the augmentation | 3, 7 |
| `packages/authz-orm/src/marker.ts` | `AccessMarks.within` | 7 |
| `packages/authz-orm/test/lists/within.test.ts` | `.within()` | 7 |

---

### Task 1: `PlanTermSql` registry, dialects and the `relation.owner` / `relation.self` compilers

**Files:**
- Create: `packages/authz-orm/src/lists/dialect.ts`, `src/lists/terms.ts`, `src/lists/relation-sql.ts`, `src/lists/index.ts`
- Modify: `packages/authz-orm/src/index.ts`
- Test: `packages/authz-orm/test/lists/terms.test.ts`

**Interfaces:**
- Consumes: `PlanTermSql`, `SqlRowContext` (with `relation(name: 'owner' | 'self'): { column: string; typeColumn?: string } | undefined`), `SqlFragment` (L0, `@spinajs/authz`).
- Produces:
  - `SqlDialect = SqlRowContext['dialect']`; `dialectOf(driver: OrmDriver): SqlDialect` (from `driver.Options.Driver`: `orm-driver-sqlite`, `orm-driver-postgres`, `orm-driver-mysql`, `orm-driver-mysql-ssh`, `orm-driver-mssql`; anything else `AuthzConfigError`); `castText(dialect, sql)`: `CAST(x AS TEXT)` (sqlite, postgres), `CAST(x AS CHAR(64))` (mysql), `CAST(x AS NVARCHAR(64))` (mssql); `quoterOf(driver): (name: string) => string` (the driver's `IdentifierQuoter`).
  - `planTermCompilers(): ReadonlyMap<string, PlanTermSql>` from `DI.resolve(Array.ofType(PlanTermSql))`; two different instances for one op → `AuthzConfigError` naming both classes.
  - `RelationOwnerSql` (`op = 'relation.owner'`) and `RelationSelfSql` (`op = 'relation.self'`), both `@Singleton() @Injectable(PlanTermSql)`. Args (names table, emitted by L8): `{ principals: { type: string; id: string }[] }`. The columns come from `row.relation('owner' | 'self')` (filled from the registry entry by Task 2's `rowContext`); a type without that relation is an `AuthzConfigError`.
    - owner without `typeColumn`: `castText(rowColumn(column)) IN (ids of the user principals)`;
    - owner with `typeColumn`: per principal type `(rowColumn(typeColumn) = ? AND castText(rowColumn(column)) IN (…))`, OR-ed;
    - self: `castText(rowColumn(column)) IN (ids of the user principals)`;
    - nothing to match → `1 = 0`. Comparing as text keeps one rule for int, uuid and text columns and never binds a non-numeric id against an integer column (a cast error on PostgreSQL).

- [ ] **Step 1: Write the failing test**

Create `packages/authz-orm/test/lists/terms.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, PlanTermSql } from '@spinajs/authz';
import type { SqlFragment, SqlRowContext } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { RawQuery } from '@spinajs/orm';
import type { ModelBase, OrmDriver } from '@spinajs/orm';

import { AccessResource, Owner } from '../../src/index.js';
import { RelationOwnerSql, RelationSelfSql, castText, dialectOf, planTermCompilers, quoterOf } from '../../src/lists/index.js';
import { TestDb } from '../support/db.js';

const expect = chai.expect;

type Rel = { column: string; typeColumn?: string } | undefined;
const row = (over: Partial<SqlRowContext> = {}, relations: { owner?: Rel; self?: Rel } = { owner: { column: 'owner' }, self: { column: 'Uuid' } }): SqlRowContext => ({
  type: 'task',
  rowId: 'CAST("t"."id" AS TEXT)',
  rowColumn: (c) => `"t"."${c}"`,
  ancestorTable: '"authz_resource_ancestor"',
  now: new Date(0),
  dialect: 'sqlite',
  relation: (name) => relations[name],
  ...over,
});
const p = (type: string, id: string) => ({ type, id });

class FlagA extends PlanTermSql {
  readonly op = 'test.flag';
  toSql(): SqlFragment {
    return { sql: '1 = 1', bindings: [] };
  }
}
class FlagB extends FlagA {}

describe('PlanTermSql registry and relation.owner / relation.self', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
  });

  afterEach(async () => {
    await db.clear();
  });

  it('casts to text per dialect and maps driver names', () => {
    expect(castText('sqlite', 'x')).to.equal('CAST(x AS TEXT)');
    expect(castText('postgres', 'x')).to.equal('CAST(x AS TEXT)');
    expect(castText('mysql', 'x')).to.equal('CAST(x AS CHAR(64))');
    expect(castText('mssql', 'x')).to.equal('CAST(x AS NVARCHAR(64))');
    expect(dialectOf(db.driver())).to.equal('sqlite');
    expect(dialectOf({ Options: { Driver: 'orm-driver-mysql-ssh' } } as unknown as OrmDriver)).to.equal('mysql');
    expect(dialectOf({ Options: { Driver: 'orm-driver-mssql' } } as unknown as OrmDriver)).to.equal('mssql');
    expect(() => dialectOf({ Options: { Driver: 'orm-driver-oracle', Name: 'x' } } as unknown as OrmDriver)).to.throw(AuthzConfigError, /orm-driver-oracle/);
    expect(quoterOf(db.driver())('task')).to.equal('"task"');
  });

  it('lists the registered compilers by op, relation.owner and relation.self built in', () => {
    const undo = testHost.registerInRoot(PlanTermSql, FlagA);
    try {
      const map = planTermCompilers();
      expect(map.get('relation.owner')).to.be.instanceOf(RelationOwnerSql);
      expect(map.get('relation.self')).to.be.instanceOf(RelationSelfSql);
      expect(map.get('test.flag')).to.be.instanceOf(FlagA);
    } finally {
      undo();
    }
  });

  it('refuses two compilers for one op', () => {
    const undo = [testHost.registerInRoot(PlanTermSql, FlagA), testHost.registerInRoot(PlanTermSql, FlagB)];
    try {
      expect(() => planTermCompilers()).to.throw(AuthzConfigError, /two PlanTermSql compilers for op "test\.flag" \(FlagA, FlagB\)/);
    } finally {
      undo.forEach((u) => u());
    }
  });

  it('relation.owner without a type column matches user principals only', () => {
    const c = new RelationOwnerSql();
    expect(c.toSql({ principals: [p('user', 'alice'), p('agent', 'bot'), p('user', 'bob')] }, row())).to.deep.equal({ sql: 'CAST("t"."owner" AS TEXT) IN (?, ?)', bindings: ['alice', 'bob'] });
    expect(c.toSql({ principals: [p('agent', 'bot')] }, row())).to.deep.equal({ sql: '1 = 0', bindings: [] });
    expect(c.toSql({ principals: [p('user', '1')] }, row({ dialect: 'mssql' })).sql).to.equal('CAST("t"."owner" AS NVARCHAR(64)) IN (?)');
  });

  it('relation.owner with a type column matches type and id', () => {
    const c = new RelationOwnerSql();
    const r = row({}, { owner: { column: 'InitiatorId', typeColumn: 'InitiatorType' } });
    expect(c.toSql({ principals: [p('user', 'alice'), p('agent', 'bot'), p('user', 'bob')] }, r)).to.deep.equal({
      sql: '("t"."InitiatorType" = ? AND CAST("t"."InitiatorId" AS TEXT) IN (?, ?)) OR ("t"."InitiatorType" = ? AND CAST("t"."InitiatorId" AS TEXT) IN (?))',
      bindings: ['user', 'alice', 'bob', 'agent', 'bot'],
    });
  });

  it('relation.self matches the self column against user principals', () => {
    expect(new RelationSelfSql().toSql({ principals: [p('user', 'u1')] }, row())).to.deep.equal({ sql: 'CAST("t"."Uuid" AS TEXT) IN (?)', bindings: ['u1'] });
  });

  it('refuses malformed args and a type without the relation', () => {
    const owner = new RelationOwnerSql();
    for (const bad of [null, {}, { principals: 'alice' }, { principals: [{ type: 'user' }] }, { principals: [{ type: 'user', id: 1 }] }]) {
      expect(() => owner.toSql(bad, row()), JSON.stringify(bad)).to.throw(AuthzConfigError);
    }
    expect(() => owner.toSql({ principals: [] }, row({}, {}))).to.throw(AuthzConfigError, /no owner column/);
    expect(() => new RelationSelfSql().toSql({ principals: [] }, row({}, {}))).to.throw(AuthzConfigError, /no self column/);
  });

  it('relation.owner runs on SQLite against an integer column', async () => {
    const Task = (await db.define({ name: 'Task', columns: { owner_id: 'INTEGER' }, rows: [{ id: 'a', owner_id: 1 }, { id: 'b', owner_id: 2 }], decorate: (cls, proto) => { AccessResource('task')(cls); Owner()(proto, 'owner_id'); } })) as typeof ModelBase;
    const table = db.table(Task);
    const f = new RelationOwnerSql().toSql({ principals: [p('user', '1'), p('user', 'x')] }, row({ rowColumn: (col) => `"${table}"."${col}"` }, { owner: { column: 'owner_id' } }));
    const rows = (await db.driver().select().from(table).where(RawQuery.create(f.sql, [...f.bindings]))) as { id: string }[];
    expect(rows.map((r) => r.id)).to.deep.equal(['a']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-orm && npx ts-mocha -p tsconfig.json test/lists/terms.test.ts`
Expected: FAIL with a TSError `Cannot find module '../../src/lists/index.js'`.

- [ ] **Step 3: Write `src/lists/dialect.ts`**

```ts
import { AuthzConfigError } from '@spinajs/authz';
import type { SqlRowContext } from '@spinajs/authz';
import { IdentifierQuoter } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

export type SqlDialect = SqlRowContext['dialect'];

const DRIVERS: Readonly<Record<string, SqlDialect>> = {
  'orm-driver-sqlite': 'sqlite',
  'orm-driver-postgres': 'postgres',
  'orm-driver-mysql': 'mysql',
  'orm-driver-mysql-ssh': 'mysql',
  'orm-driver-mssql': 'mssql',
};

export function dialectOf(driver: OrmDriver): SqlDialect {
  const name = driver?.Options?.Driver as unknown;
  const dialect = typeof name === 'string' ? DRIVERS[name] : undefined;
  if (dialect === undefined) throw new AuthzConfigError(`authz-orm: connection ${JSON.stringify(driver?.Options?.Name)} uses driver ${JSON.stringify(name)}; lists render for sqlite, postgres, mysql and mssql`);
  return dialect;
}

/** An id or owner value as text; 64 matches authz_resource_ancestor.resource_id. */
export function castText(dialect: SqlDialect, sql: string): string {
  switch (dialect) {
    case 'mysql':
      return `CAST(${sql} AS CHAR(64))`;
    case 'mssql':
      return `CAST(${sql} AS NVARCHAR(64))`;
    default:
      return `CAST(${sql} AS TEXT)`;
  }
}

export function quoterOf(driver: OrmDriver): (name: string) => string {
  const q = driver.Container.resolve(IdentifierQuoter) as IdentifierQuoter;
  return (name) => q.quote(name);
}
```

- [ ] **Step 4: Write `src/lists/terms.ts`**

```ts
import { AuthzConfigError, PlanTermSql } from '@spinajs/authz';
import { DI } from '@spinajs/di';

const nameOf = (c: unknown): string => (c !== null && typeof c === 'object' ? (c.constructor as { name?: string }).name ?? '<anonymous>' : String(c));

/** The registered PlanTermSql compilers by op (DI root); two for one op is a configuration error. */
export function planTermCompilers(): ReadonlyMap<string, PlanTermSql> {
  const list = ((DI.resolve(Array.ofType(PlanTermSql)) as unknown as PlanTermSql[] | undefined) ?? []).filter((c) => c instanceof PlanTermSql);
  const out = new Map<string, PlanTermSql>();
  for (const c of list) {
    if (typeof c.op !== 'string' || c.op === '') throw new AuthzConfigError(`authz-orm: ${nameOf(c)} has no op`);
    const prev = out.get(c.op);
    if (prev !== undefined && prev !== c) throw new AuthzConfigError(`authz-orm: two PlanTermSql compilers for op ${JSON.stringify(c.op)} (${nameOf(prev)}, ${nameOf(c)})`);
    out.set(c.op, c);
  }
  return out;
}
```

- [ ] **Step 5: Write `src/lists/relation-sql.ts`**

```ts
import { AuthzConfigError, PlanTermSql } from '@spinajs/authz';
import type { SqlFragment, SqlRowContext } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { castText } from './dialect.js';

export const RELATION_OWNER_OP = 'relation.owner';
export const RELATION_SELF_OP = 'relation.self';

const NOTHING: SqlFragment = Object.freeze({ sql: '1 = 0', bindings: [] });

interface PrincipalArg {
  readonly type: string;
  readonly id: string;
}

function principalsOf(args: unknown, op: string): PrincipalArg[] {
  const list = (args as { principals?: unknown } | null)?.principals;
  if (!Array.isArray(list) || !list.every((p) => p !== null && typeof p === 'object' && typeof p.type === 'string' && p.type !== '' && typeof p.id === 'string')) {
    throw new AuthzConfigError(`authz-orm: ${op} args must be { principals: { type, id }[] }, got ${JSON.stringify(args)}`);
  }
  return list as PrincipalArg[];
}

function columnsOf(row: SqlRowContext, name: 'owner' | 'self'): { column: string; typeColumn?: string } {
  const rel = row.relation(name);
  if (rel === undefined) throw new AuthzConfigError(`authz-orm: relation.${name}: resource type '${row.type}' has no ${name} column (@${name === 'owner' ? 'Owner' : 'Self'}())`);
  return rel;
}

function idIn(row: SqlRowContext, column: string, ids: readonly string[]): SqlFragment {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return NOTHING;
  return { sql: `${castText(row.dialect, row.rowColumn(column))} IN (${unique.map(() => '?').join(', ')})`, bindings: unique };
}

const userIds = (principals: readonly PrincipalArg[]): string[] => principals.filter((p) => p.type === 'user').map((p) => p.id);

/** The row's owner is one of the principals (design §5): a user id, or a type and id with `typeColumn`. */
@Singleton()
@Injectable(PlanTermSql)
export class RelationOwnerSql extends PlanTermSql {
  readonly op = RELATION_OWNER_OP;

  toSql(args: unknown, row: SqlRowContext): SqlFragment {
    const principals = principalsOf(args, this.op);
    const { column, typeColumn } = columnsOf(row, 'owner');
    if (typeColumn === undefined) return idIn(row, column, userIds(principals));
    const byType = new Map<string, string[]>();
    for (const p of principals) byType.set(p.type, [...(byType.get(p.type) ?? []), p.id]);
    const parts = [...byType].map(([type, ids]) => {
      const match = idIn(row, column, ids);
      return { sql: `${row.rowColumn(typeColumn)} = ? AND ${match.sql}`, bindings: [type, ...match.bindings] };
    });
    if (parts.length === 0) return NOTHING;
    if (parts.length === 1) return parts[0];
    return { sql: parts.map((x) => `(${x.sql})`).join(' OR '), bindings: parts.flatMap((x) => x.bindings) };
  }
}

/** The row is one of the user principals (`users` model, design §5). */
@Singleton()
@Injectable(PlanTermSql)
export class RelationSelfSql extends PlanTermSql {
  readonly op = RELATION_SELF_OP;

  toSql(args: unknown, row: SqlRowContext): SqlFragment {
    return idIn(row, columnsOf(row, 'self').column, userIds(principalsOf(args, this.op)));
  }
}
```

The test of the single type-column case expects the two per-type groups in parentheses; with one principal type the group is returned without them.

Create `packages/authz-orm/src/lists/index.ts`:

```ts
export * from './dialect.js';
export * from './terms.js';
export * from './relation-sql.js';
```

Append to `packages/authz-orm/src/index.ts`:

```ts
export * from './lists/index.js';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/lists/terms.test.ts`
Expected: PASS, `8 passing`.

- [ ] **Step 7: Commit**

```bash
git add packages/authz-orm/src/lists packages/authz-orm/src/index.ts packages/authz-orm/test/lists/terms.test.ts
git commit -m "feat(authz-orm): PlanTermSql registry and the relation.owner / relation.self compilers"
```

---

### Task 2: Rendering an `AccessPlan` to SQL

**Files:**
- Create: `packages/authz-orm/src/lists/context.ts`, `src/lists/render.ts`
- Modify: `packages/authz-orm/src/lists/index.ts`
- Create: `packages/authz-orm/test/support/flag-sql.ts`
- Test: `packages/authz-orm/test/lists/render.test.ts`

**Interfaces:**
- Consumes: `AccessPlan`, `PlanTerm`, `SqlRowContext`, `SqlFragment` (L0); `planTermCompilers`, `castText`, `quoterOf`, `dialectOf` (Task 1); `AUTHZ_RESOURCE_ANCESTOR_TABLE` (L3 Task 2); `ResourceEntry` (L3 Task 1).
- Produces:
  - `rowContext(query: QueryBuilder, entry: ResourceEntry, now: Date): SqlRowContext`. `rowColumn(c)` = `<quoted alias or table>.<quoted c>`; `rowId` = `castText(rowColumn(entry.idColumn))`; `relation(name)` = the entry's owner `{ column, typeColumn? }` or self `{ column }` (undefined when the type has none); **`ancestorTable` is the quoted identifier** (contract issue 2: compilers use it as is).
  - `Rendered = { kind: 'all' } | { kind: 'none'; reason: DenyReason } | { kind: 'sql'; sql: string; bindings: readonly unknown[] }`; `renderPlan(plan, row, compilers?)`.
  - Shape (design §6.2 generalised over opaque terms): `(permit₁) OR (permit₂) …` when `permit` is a list (an empty list is `1 = 0`), `AND NOT ((deny₁) OR …)` when `deny` is non-empty, `AND <within>` when `within` is set; each part parenthesised. `within`: `rowId IN (ids of refs of the row's type)` OR `EXISTS (SELECT 1 FROM <ancestorTable> authz_w WHERE authz_w.resource_type = ? AND authz_w.resource_id = <rowId> AND ((authz_w.ancestor_type = ? AND authz_w.ancestor_id = ?) OR … OR authz_w.ancestor_type IN (type-level refs)))`; a `GLOBAL` or type-level ref of the row's own type makes the ceiling `1 = 1`; an empty `within` is `1 = 0`. `permit: 'all'`, no deny, no within → `{ kind: 'all' }` (no filter).
  - A missing compiler or a compiler answer that is not `{ sql: string, bindings: unknown[] }` → `AuthzConfigError`. A `NULL` term (a `NULL` owner column) makes its group `NULL`, so the row is left out: fail closed.

- [ ] **Step 1: Write the failing test**

Create `packages/authz-orm/test/support/flag-sql.ts`:

```ts
import { PlanTermSql } from '@spinajs/authz';
import type { SqlFragment, SqlRowContext } from '@spinajs/authz';

/** A test op: the row's `flag` column equals `args.flag`. */
export class FlagSql extends PlanTermSql {
  readonly op = 'test.flag';
  toSql(args: unknown, row: SqlRowContext): SqlFragment {
    return { sql: `${row.rowColumn('flag')} = ?`, bindings: [(args as { flag: string }).flag] };
  }
}

/** A compiler that breaks its contract. */
export class BrokenSql extends PlanTermSql {
  readonly op = 'test.broken';
  toSql(): SqlFragment {
    return { sql: 1 } as unknown as SqlFragment;
  }
}
```

Create `packages/authz-orm/test/lists/render.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, GLOBAL, PlanTermSql } from '@spinajs/authz';
import type { AccessPlan, PlanTerm } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { RawQuery } from '@spinajs/orm';
import type { ModelBase, QueryBuilder } from '@spinajs/orm';

import { AccessResource, Owner, Parent } from '../../src/index.js';
import { entryOf } from '../../src/registry.js';
import { renderPlan, rowContext } from '../../src/lists/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createAncestorTable, dropAncestorTable, insertLinks } from '../support/ancestors.js';
import { BrokenSql, FlagSql } from '../support/flag-sql.js';

const expect = chai.expect;

const flag = (f: string): PlanTerm => ({ op: 'test.flag', args: { flag: f } });
const owner = (...ids: string[]): PlanTerm => ({ op: 'relation.owner', args: { principals: ids.map((id) => ({ type: 'user', id })) } });
const filter = (p: Partial<Extract<AccessPlan, { kind: 'filter' }>>): AccessPlan => ({ kind: 'filter', permit: 'all', deny: [], ...p });

const ROWS = [
  { id: 1, flag: 'green', owner: 'alice', project_id: 'p1' },
  { id: 2, flag: 'green', owner: 'bob', project_id: 'p2' },
  { id: 3, flag: 'red', owner: 'alice', project_id: 'p1' },
  { id: 4, flag: null, owner: null, project_id: null },
];

describe('renderPlan', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  const undo: (() => void)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
    undo.push(testHost.registerInRoot(PlanTermSql, FlagSql), testHost.registerInRoot(PlanTermSql, BrokenSql));
  });

  after(async () => {
    undo.forEach((u) => u());
    await db?.close();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Task: typeof ModelBase & { query(): QueryBuilder };

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        Task = (await db.define({ name: 'Task', columns: { id: 'INTEGER', flag: 'TEXT', owner: 'TEXT', project_id: 'TEXT' }, rows: ROWS, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); Owner()(p, 'owner'); } }, dialect)) as never;
        await insertLinks(db.driver(dialect), ['task:1>project:p1@1', 'task:1>org:o1@2', 'task:2>project:p2@1', 'task:3>project:p1@1', 'task:3>org:o1@2']);
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      /** Ids the rendered plan keeps, through a plain select of the table. */
      async function ids(plan: AccessPlan): Promise<number[] | 'all' | 'none'> {
        const query = Task.query();
        const row = rowContext(query, entryOf(Task)!, new Date());
        const r = renderPlan(plan, row);
        if (r.kind !== 'sql') return r.kind;
        const rows = (await db.driver(dialect).select().from(db.table(Task)).where(RawQuery.create(r.sql, [...r.bindings]))) as { id: number }[];
        return rows.map((x) => Number(x.id)).sort();
      }

      it('permit terms are OR-ed', async () => {
        expect(await ids(filter({ permit: [flag('green')] }))).to.deep.equal([1, 2]);
        expect(await ids(filter({ permit: [flag('red'), owner('bob')] }))).to.deep.equal([2, 3]);
        expect(await ids(filter({ permit: [] }))).to.deep.equal([]);
      });

      it('deny terms subtract; a NULL leaves the row out', async () => {
        expect(await ids(filter({ permit: [flag('green'), flag('red')], deny: [owner('bob')] }))).to.deep.equal([1, 3]);
        expect(await ids(filter({ deny: [owner('alice')] }))).to.deep.equal([2]);
      });

      it('within keeps rows that are, or descend from, a ceiling resource', async () => {
        expect(await ids(filter({ within: [{ type: 'org', id: 'o1' }] }))).to.deep.equal([1, 3]);
        expect(await ids(filter({ within: [{ type: 'task', id: '2' }, { type: 'project', id: 'p1' }] }))).to.deep.equal([1, 2, 3]);
        expect(await ids(filter({ within: [{ type: 'project' }] }))).to.deep.equal([1, 2, 3]);
        expect(await ids(filter({ within: [{ type: 'task' }] }))).to.deep.equal([1, 2, 3, 4]);
        expect(await ids(filter({ within: [GLOBAL] }))).to.deep.equal([1, 2, 3, 4]);
        expect(await ids(filter({ within: [] }))).to.deep.equal([]);
        expect(await ids(filter({ permit: [flag('green')], within: [{ type: 'project', id: 'p1' }] }))).to.deep.equal([1]);
      });

      it('all without deny and within is no filter; none is none', async () => {
        expect(await ids(filter({}))).to.equal('all');
        expect(await ids({ kind: 'none', reason: { code: 'no_access' } })).to.equal('none');
      });

      it('refuses an op without a compiler and a malformed compiler answer', async () => {
        const row = rowContext(Task.query(), entryOf(Task)!, new Date());
        expect(() => renderPlan(filter({ permit: [{ op: 'nope', args: {} }] }), row)).to.throw(AuthzConfigError, /no PlanTermSql renders op "nope"/);
        expect(() => renderPlan(filter({ permit: [{ op: 'test.broken', args: {} }] }), row)).to.throw(AuthzConfigError, /BrokenSql/);
      });

      it('the row context quotes the ancestor table and casts the id', () => {
        const row = rowContext(Task.query(), entryOf(Task)!, new Date(5));
        expect(row.type).to.equal('task');
        expect(row.dialect).to.equal(dialect);
        expect(row.ancestorTable).to.equal('"authz_resource_ancestor"');
        expect(row.rowId).to.equal(`CAST("${db.table(Task)}"."id" AS TEXT)`);
        expect(row.now.getTime()).to.equal(5);
        expect(row.relation('owner')).to.deep.equal({ column: 'owner' });
        expect(row.relation('self')).to.equal(undefined);
      });
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-orm && npx ts-mocha -p tsconfig.json test/lists/render.test.ts`
Expected: FAIL with a TSError `Module '"../../src/lists/index.js"' has no exported member 'renderPlan'`.

- [ ] **Step 3: Write `src/lists/context.ts`**

```ts
import type { SqlRowContext } from '@spinajs/authz';
import type { QueryBuilder } from '@spinajs/orm';

import { AUTHZ_RESOURCE_ANCESTOR_TABLE } from '../ancestors/table.js';
import type { ResourceEntry } from '../registry.js';
import { castText, dialectOf, quoterOf } from './dialect.js';

/** What a PlanTermSql renders against: the builder's row, qualified by its alias or table. */
export function rowContext(query: QueryBuilder, entry: ResourceEntry, now: Date): SqlRowContext {
  const dialect = dialectOf(query.Driver);
  const q = quoterOf(query.Driver);
  const owner = q(query.TableAlias || query.Table);
  const rowColumn = (column: string): string => `${owner}.${q(column)}`;
  const relation = (name: 'owner' | 'self'): { column: string; typeColumn?: string } | undefined => {
    if (name === 'owner' && entry.owner) return Object.freeze({ column: entry.owner.column, ...(entry.owner.typeColumn !== undefined ? { typeColumn: entry.owner.typeColumn } : {}) });
    if (name === 'self' && entry.self) return Object.freeze({ column: entry.self.column });
    return undefined;
  };
  return Object.freeze({ type: entry.type, rowId: castText(dialect, rowColumn(entry.idColumn)), rowColumn, ancestorTable: q(AUTHZ_RESOURCE_ANCESTOR_TABLE), now, dialect, relation });
}
```

- [ ] **Step 4: Write `src/lists/render.ts`**

```ts
import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { AccessPlan, DenyReason, PlanTerm, PlanTermSql, ResourceRef, SqlFragment, SqlRowContext } from '@spinajs/authz';

import { planTermCompilers } from './terms.js';

export type Rendered = { readonly kind: 'all' } | { readonly kind: 'none'; readonly reason: DenyReason } | { readonly kind: 'sql'; readonly sql: string; readonly bindings: readonly unknown[] };

const NOTHING: SqlFragment = Object.freeze({ sql: '1 = 0', bindings: [] });
const EVERYTHING: SqlFragment = Object.freeze({ sql: '1 = 1', bindings: [] });

const isFragment = (v: unknown): v is SqlFragment => v !== null && typeof v === 'object' && typeof (v as SqlFragment).sql === 'string' && Array.isArray((v as SqlFragment).bindings);

function join(parts: readonly SqlFragment[], op: 'OR' | 'AND', empty: SqlFragment): SqlFragment {
  if (parts.length === 0) return empty;
  if (parts.length === 1) return parts[0];
  return { sql: parts.map((p) => `(${p.sql})`).join(` ${op} `), bindings: parts.flatMap((p) => [...p.bindings]) };
}

function term(t: PlanTerm, row: SqlRowContext, compilers: ReadonlyMap<string, PlanTermSql>): SqlFragment {
  const compiler = compilers.get(t?.op);
  if (!compiler) throw new AuthzConfigError(`authz-orm: no PlanTermSql renders op ${JSON.stringify(t?.op)}; register one with @Injectable(PlanTermSql)`);
  const out: unknown = compiler.toSql(t.args, row);
  if (!isFragment(out)) throw new AuthzConfigError(`authz-orm: ${compiler.constructor.name}.toSql() for op ${JSON.stringify(t.op)} must return { sql: string, bindings: unknown[] }`);
  return out;
}

/** The row is one of `within`, or descends from one (authz_resource_ancestor). */
export function withinSql(within: readonly ResourceRef[], row: SqlRowContext): SqlFragment {
  if (within.some((r) => r.type === GLOBAL.type || (r.type === row.type && (r.id === undefined || r.id === null)))) return EVERYTHING;
  const parts: SqlFragment[] = [];
  const selfIds = [...new Set(within.filter((r) => r.type === row.type && r.id !== undefined && r.id !== null).map((r) => String(r.id)))];
  if (selfIds.length > 0) parts.push({ sql: `${row.rowId} IN (${selfIds.map(() => '?').join(', ')})`, bindings: selfIds });
  const above: SqlFragment[] = within.filter((r) => r.id !== undefined && r.id !== null).map((r) => ({ sql: 'authz_w.ancestor_type = ? AND authz_w.ancestor_id = ?', bindings: [r.type, String(r.id)] }));
  const types = [...new Set(within.filter((r) => r.id === undefined || r.id === null).map((r) => r.type))];
  if (types.length > 0) above.push({ sql: `authz_w.ancestor_type IN (${types.map(() => '?').join(', ')})`, bindings: types });
  if (above.length > 0) {
    const any = join(above, 'OR', NOTHING);
    parts.push({ sql: `EXISTS (SELECT 1 FROM ${row.ancestorTable} authz_w WHERE authz_w.resource_type = ? AND authz_w.resource_id = ${row.rowId} AND (${any.sql}))`, bindings: [row.type, ...any.bindings] });
  }
  return join(parts, 'OR', NOTHING);
}

/** Design §6.2 over opaque terms: (permit OR …) AND NOT (deny OR …) AND within. */
export function renderPlan(plan: AccessPlan, row: SqlRowContext, compilers: ReadonlyMap<string, PlanTermSql> = planTermCompilers()): Rendered {
  if (plan.kind === 'none') return { kind: 'none', reason: plan.reason };
  if (plan.kind !== 'filter') throw new AuthzConfigError(`authz-orm: unknown access plan kind ${JSON.stringify((plan as { kind?: unknown }).kind)}`);
  const parts: SqlFragment[] = [];
  if (plan.permit !== 'all') parts.push(join(plan.permit.map((t) => term(t, row, compilers)), 'OR', NOTHING));
  if (plan.deny.length > 0) {
    const deny = join(plan.deny.map((t) => term(t, row, compilers)), 'OR', NOTHING);
    parts.push({ sql: `NOT (${deny.sql})`, bindings: deny.bindings });
  }
  if (plan.within !== undefined) parts.push(withinSql(plan.within, row));
  if (parts.length === 0) return { kind: 'all' };
  const all = join(parts, 'AND', EVERYTHING);
  return { kind: 'sql', sql: all.sql, bindings: all.bindings };
}
```

Append to `packages/authz-orm/src/lists/index.ts`:

```ts
export * from './context.js';
export * from './render.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/lists/render.test.ts`
Expected: PASS, `12 passing` with Postgres up (`6 passing, 6 pending` without).

- [ ] **Step 6: Commit**

```bash
git add packages/authz-orm/src/lists packages/authz-orm/test/support/flag-sql.ts packages/authz-orm/test/lists/render.test.ts
git commit -m "feat(authz-orm): render access plans to SQL"
```

---

### Task 3: `.accessible()`, `.unscoped()` and `AccessListMiddleware`

**Files:**
- Create: `packages/authz-orm/src/lists/augment.ts`, `src/lists/middleware.ts`
- Modify: `packages/authz-orm/src/lists/index.ts`, `src/index.ts`, `scripts/api-snapshot.json`
- Create: `docs/plans/authz-v3-rfc/RA4-1.md`
- Test: `packages/authz-orm/test/lists/accessible.test.ts`

**Interfaces:**
- Consumes: `AuthzService.accessPlan(principal, permission, type, env?)` (L0 contract; L2 implements; it refuses a permission without `list: true` and returns `ALL` for SYSTEM); `marksOf` / `setMarks`, `ormDomain`, `domainContainer`, `auditUnscoped` (L3 Task 1); `renderPlan`, `rowContext` (Task 2).
- Produces:
  - Builder methods (module augmentation of `@spinajs/orm`): `accessible(permission: Permission, opts?: { env?: Readonly<Record<string, unknown>> }): this` on `ISelectQueryBuilder`, `SelectQueryBuilder`, `UpdateQueryBuilder`, `IUpdateQueryBuilder`, `DeleteQueryBuilder`, `IDeleteQueryBuilder`; `unscoped(reason: string): this` on the same; `withAccess(permissions, opts?)` on the select ones (Task 4 implements the effect). `env` is passed to `accessPlan` as is; without it, none is passed (overview decision 8).
  - Call-time refusals (`AuthzConfigError`): no `@AccessResource` model; not a permission name; `.accessible()` with `.unscoped()`; two different permissions; an empty `.unscoped()` reason.
  - `AccessListMiddleware` (`@Injectable(QueryMiddleware)`, `order = 100`). At `beforeQueryExecution`: `.unscoped(reason)` → one `unscoped` audit (`authz.audit.unscoped`), no filter; `.accessible(p)` → plan for `currentPrincipal()`; `none` → `AccessDenied` (a `Forbidden`) carrying the plan's reason; `all` → nothing; SQL → the caller's where statements move into one group and the fragment is ANDed (`(caller) AND (plan)`), so a caller's `orWhere` cannot widen it. The marks follow `SelectQueryBuilder.clone()`.

- [ ] **Step 1: Write the failing test**

Create `packages/authz-orm/test/lists/accessible.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AccessDenied, AuthzConfigError, DecisionAudit, PlanTermSql, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, AuthzService, Principal } from '@spinajs/authz';
import { RecordingAudit, testHost } from '@spinajs/authz-testing';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource } from '../../src/index.js';
import { marksOf } from '../../src/marker.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { FlagSql } from '../support/flag-sql.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const green: AccessPlan = { kind: 'filter', permit: [{ op: 'test.flag', args: { flag: 'green' } }], deny: [] };

type Q = Promise<ModelBase[]> & { accessible(p: string, o?: object): Q; unscoped(r: string): Q; where(...a: unknown[]): Q; orWhere(...a: unknown[]): Q; clone(): Q };
type M = typeof ModelBase & { query(): Q; where(...a: unknown[]): Q; update(v: object): Promise<{ RowsAffected: number }> & { accessible(p: string): Promise<{ RowsAffected: number }> }; destroy(pk?: unknown): Promise<unknown> & { accessible(p: string): Promise<unknown> } };

const ids = (rows: ModelBase[]) => rows.map((r) => String((r as unknown as { id: unknown }).id)).sort();

describe('.accessible() and .unscoped()', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  let service: AuthzService;
  let plan: sinon.SinonStub;
  let audit: RecordingAudit;
  const undo: (() => void)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    audit = new RecordingAudit();
    undo.push(testHost.registerInRoot(PlanTermSql, FlagSql), testHost.registerInRoot(DecisionAudit, testHost.instance(audit)));
    service = await (await testHost.domains()).service('root');
    plan = sinon.stub(service, 'accessPlan').resolves(green);
  });

  afterEach(async () => {
    sinon.restore();
    for (const fn of undo.splice(0).reverse()) fn();
    await testHost.resetRoot();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Task: M;
      let Plain: M;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        Task = (await db.define({ name: 'Task', columns: { flag: 'TEXT', title: 'TEXT' }, rows: [{ id: 't1', flag: 'green', title: 'a' }, { id: 't2', flag: 'red', title: 'b' }, { id: 't3', flag: 'green', title: 'c' }], decorate: (c) => AccessResource('task')(c) }, dialect)) as M;
        Plain = (await db.define({ name: 'Plain', columns: { title: 'TEXT' } }, dialect)) as M;
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      const as = <T>(fn: () => Promise<T>) => runWithPrincipal(alice, fn);

      it('filters a select by the plan, for the current principal, with the env given', async () => {
        expect(ids(await as(() => Task.query().accessible('task:read')))).to.deep.equal(['t1', 't3']);
        expect(plan.firstCall.args.slice(0, 3)).to.deep.equal([alice, 'task:read', 'task']);
        expect(plan.firstCall.args[3]).to.equal(undefined);
        await as(() => Task.query().accessible('task:read', { env: { ip: '10.0.0.1' } }));
        expect(plan.secondCall.args[3]).to.deep.equal({ ip: '10.0.0.1' });
      });

      it("keeps the caller's where in one group: an orWhere cannot widen the plan", async () => {
        const rows = await as(() => Task.where('title', 'a').orWhere('title', 'b').accessible('task:read'));
        expect(ids(rows)).to.deep.equal(['t1']);
      });

      it('filters updates and deletes the same way', async () => {
        await as(() => Task.update({ title: 'x' }).accessible('task:update'));
        expect((await db.rows(Task)).filter((r) => r.title === 'x').map((r) => r.id).sort()).to.deep.equal(['t1', 't3']);
        await as(() => Task.destroy().accessible('task:delete'));
        expect((await db.rows(Task)).map((r) => r.id)).to.deep.equal(['t2']);
      });

      it('a none plan is AccessDenied with its reason; an all plan filters nothing', async () => {
        plan.resolves({ kind: 'none', reason: { code: 'no_access' } });
        let err: unknown;
        try {
          await as(() => Task.query().accessible('task:read'));
        } catch (e) {
          err = e;
        }
        expect(err).to.be.instanceOf(AccessDenied);
        expect((err as AccessDenied).decision.reason).to.deep.equal({ code: 'no_access' });
        plan.resolves({ kind: 'filter', permit: 'all', deny: [] });
        expect(ids(await as(() => Task.query().accessible('task:read')))).to.deep.equal(['t1', 't2', 't3']);
      });

      it('unscoped runs unfiltered and audits once', async () => {
        expect(ids(await as(() => Task.query().unscoped('nightly export')))).to.deep.equal(['t1', 't2', 't3']);
        await new Promise((r) => setImmediate(r));
        expect(audit.of('unscoped')).to.deep.equal([{ kind: 'unscoped', principal: { type: 'user', id: 'alice' }, reason: 'nightly export', resource: { type: 'task' } }]);
        expect(plan.called).to.equal(false);
      });

      it('refuses misuse at call time', () => {
        expect(() => Plain.query().accessible('plain:read')).to.throw(AuthzConfigError, /@AccessResource/);
        expect(() => Task.query().accessible('not a permission')).to.throw(AuthzConfigError, /permission/);
        expect(() => Task.query().accessible('task:read').unscoped('x')).to.throw(AuthzConfigError, /exclude each other/);
        expect(() => Task.query().unscoped('x').accessible('task:read')).to.throw(AuthzConfigError, /exclude each other/);
        expect(() => Task.query().accessible('task:read').accessible('task:update')).to.throw(AuthzConfigError, /one permission/);
        expect(() => Task.query().unscoped('')).to.throw(AuthzConfigError, /reason/);
      });

      it('a clone keeps the marks', () => {
        const q = Task.query().accessible('task:read');
        expect(marksOf(q.clone())).to.deep.equal({ accessible: 'task:read' });
      });
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-orm && npx ts-mocha -p tsconfig.json test/lists/accessible.test.ts`
Expected: FAIL with `TypeError: Task.query(...).accessible is not a function`.

- [ ] **Step 3: Write `src/lists/augment.ts`**

```ts
import { AuthzConfigError, isPermission } from '@spinajs/authz';
import type { Permission } from '@spinajs/authz';
import { DeleteQueryBuilder, SelectQueryBuilder, UpdateQueryBuilder } from '@spinajs/orm';

import { marksOf, setMarks } from '../marker.js';
import { entryOf } from '../registry.js';

export interface AccessibleOptions {
  /** Request env for the plan (ABAC env facts); none unless given. */
  readonly env?: Readonly<Record<string, unknown>>;
}

declare module '@spinajs/orm' {
  interface ISelectQueryBuilder<T> {
    /** Only rows `permission` allows the current principal (design §6.2). */
    accessible(permission: Permission, opts?: AccessibleOptions): this;
    /** No access filter, audited (`authz.audit.unscoped`). */
    unscoped(reason: string): this;
    /** `$access` per row for each permission (design §10.3). */
    withAccess(permissions: readonly Permission[], opts?: AccessibleOptions): this;
  }
  interface SelectQueryBuilder<T> {
    accessible(permission: Permission, opts?: AccessibleOptions): this;
    unscoped(reason: string): this;
    withAccess(permissions: readonly Permission[], opts?: AccessibleOptions): this;
  }
  interface IUpdateQueryBuilder<T> {
    accessible(permission: Permission, opts?: AccessibleOptions): this;
    unscoped(reason: string): this;
  }
  interface UpdateQueryBuilder<T> {
    accessible(permission: Permission, opts?: AccessibleOptions): this;
    unscoped(reason: string): this;
  }
  interface IDeleteQueryBuilder<T> {
    accessible(permission: Permission, opts?: AccessibleOptions): this;
    unscoped(reason: string): this;
  }
  interface DeleteQueryBuilder<T> {
    accessible(permission: Permission, opts?: AccessibleOptions): this;
    unscoped(reason: string): this;
  }
}

function requireResource(builder: object, what: string): void {
  const model = (builder as { Model?: unknown }).Model;
  if (!entryOf(model)) throw new AuthzConfigError(`${what}: the query is not on an @AccessResource model (${typeof model === 'function' && model.name ? model.name : 'no model'})`);
}

function envOf(opts: AccessibleOptions | undefined, what: string): { env?: Readonly<Record<string, unknown>> } {
  if (opts === undefined || opts.env === undefined) return {};
  if (opts.env === null || typeof opts.env !== 'object' || Array.isArray(opts.env)) throw new AuthzConfigError(`${what}: env must be an object`);
  return { env: opts.env };
}

function accessible(this: object, permission: Permission, opts?: AccessibleOptions): object {
  const what = `.accessible(${JSON.stringify(permission)})`;
  requireResource(this, what);
  if (!isPermission(permission)) throw new AuthzConfigError(`${what}: not a permission name`);
  const marks = marksOf(this) ?? {};
  if (marks.unscoped !== undefined) throw new AuthzConfigError(`${what}: .accessible() and .unscoped() exclude each other`);
  if (marks.accessible !== undefined && marks.accessible !== permission) throw new AuthzConfigError(`${what}: the query is already .accessible(${JSON.stringify(marks.accessible)}); a query lists by one permission`);
  setMarks(this, { ...marks, accessible: permission, ...envOf(opts, what) });
  return this;
}

function unscoped(this: object, reason: string): object {
  const what = `.unscoped(${JSON.stringify(reason)})`;
  requireResource(this, what);
  if (typeof reason !== 'string' || reason.trim() === '') throw new AuthzConfigError('.unscoped() needs a reason');
  const marks = marksOf(this) ?? {};
  if (marks.accessible !== undefined) throw new AuthzConfigError(`${what}: .accessible() and .unscoped() exclude each other`);
  setMarks(this, { ...marks, unscoped: reason });
  return this;
}

function withAccess(this: object, permissions: readonly Permission[], opts?: AccessibleOptions): object {
  const what = '.withAccess()';
  requireResource(this, what);
  if (!Array.isArray(permissions) || permissions.length === 0 || !permissions.every((p) => isPermission(p))) throw new AuthzConfigError(`${what}: needs a non-empty list of permission names`);
  const marks = marksOf(this) ?? {};
  setMarks(this, { ...marks, withAccess: Object.freeze([...new Set(permissions)]), ...envOf(opts, what) });
  return this;
}

for (const proto of [SelectQueryBuilder.prototype, UpdateQueryBuilder.prototype, DeleteQueryBuilder.prototype] as unknown as Record<string, unknown>[]) {
  proto.accessible = accessible;
  proto.unscoped = unscoped;
}
(SelectQueryBuilder.prototype as unknown as Record<string, unknown>).withAccess = withAccess;

// A clone is the same query: it keeps what the caller declared (clone() runs no middleware, builders.ts:1299).
const clone = SelectQueryBuilder.prototype.clone;
SelectQueryBuilder.prototype.clone = function (this: SelectQueryBuilder) {
  const copy = clone.call(this);
  const marks = marksOf(this);
  if (marks !== undefined) setMarks(copy, marks);
  return copy;
} as typeof clone;
```

- [ ] **Step 4: Write `src/lists/middleware.ts`**

```ts
import { AccessDenied, AuthzClock, FALSE, authz, currentPrincipal } from '@spinajs/authz';
import type { AuthzService, Decision, DenyReason, Permission, Principal, ResourceType } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { QueryMiddleware, RawQuery, SelectQueryBuilder } from '@spinajs/orm';
import type { IQueryStatement, IWhereBuilder, QueryBuilder } from '@spinajs/orm';

import { auditUnscoped, domainContainer, ormDomain } from '../host.js';
import { marksOf } from '../marker.js';
import type { AccessMarks } from '../marker.js';
import { entryOf } from '../registry.js';
import type { ResourceEntry } from '../registry.js';
import { rowContext } from './context.js';
import { renderPlan } from './render.js';
import type { Rendered } from './render.js';

type Where = IWhereBuilder<unknown>;
type Statements = { _statements: IQueryStatement[] };

async function nowOf(domain: string): Promise<Date> {
  const c = domainContainer(domain);
  return c.hasRegistered(AuthzClock) ? ((await c.resolve(AuthzClock)) as AuthzClock).now() : new Date();
}

function denied(domain: string, principal: Principal, permission: Permission, type: ResourceType, reason: DenyReason): Decision {
  return Object.freeze({ allowed: false, permission, resource: Object.freeze({ type }), principal: Object.freeze({ type: principal.type, id: principal.id }), residual: FALSE, fields: Object.freeze({ read: Object.freeze([]), write: Object.freeze([]) }), roles: Object.freeze({}), reason, domain });
}

/**
 * The ORM joins where statements without grouping them, so `(caller) AND (plan)` needs the caller's
 * statements moved into one group first; HAVING statements stay where they are.
 */
export function restrict(query: QueryBuilder, rendered: Extract<Rendered, { kind: 'sql' }>): void {
  const statements = (query as unknown as Statements)._statements;
  const isAggregate = (s: IQueryStatement) => (s as { IsAggregate?: boolean }).IsAggregate === true;
  const callers = statements.filter((s) => !isAggregate(s));
  const aggregates = statements.filter(isAggregate);
  statements.length = 0;
  const where = query as unknown as Where;
  if (callers.length > 0) {
    where.where(function (this: Where) {
      (this as unknown as Statements)._statements.push(...callers);
    } as never);
  }
  where.where(RawQuery.create(rendered.sql, [...rendered.bindings]));
  statements.push(...aggregates);
}

export interface ListRun {
  readonly domain: string;
  readonly principal: Principal;
  readonly service: AuthzService;
  readonly entry: ResourceEntry;
  readonly marks: AccessMarks;
  readonly now: Date;
}

/** Plans `.accessible()` / `.withAccess()` at execution, for the principal the query runs as. */
@Injectable(QueryMiddleware)
export class AccessListMiddleware extends QueryMiddleware {
  public order = 100;

  afterQueryCreation(_query: QueryBuilder): void {}

  async beforeQueryExecution(query: QueryBuilder): Promise<void> {
    const marks = marksOf(query);
    if (marks === undefined) return;
    const entry = entryOf(query.Model);
    if (!entry) return;
    const domain = ormDomain();
    const principal = currentPrincipal();
    if (marks.unscoped !== undefined) auditUnscoped(domain, principal, marks.unscoped, entry.type);
    if (marks.accessible === undefined && marks.withAccess === undefined) return;
    const run: ListRun = { domain, principal, service: authz(domain), entry, marks, now: await nowOf(domain) };
    const row = rowContext(query, entry, run.now);
    if (marks.accessible !== undefined) {
      const rendered = renderPlan(await run.service.accessPlan(principal, marks.accessible, entry.type, marks.env), row);
      if (rendered.kind === 'none') throw new AccessDenied(denied(domain, principal, marks.accessible, entry.type, rendered.reason));
      if (rendered.kind === 'sql') restrict(query, rendered);
    }
    if (marks.withAccess !== undefined && query instanceof SelectQueryBuilder) await this.withAccess(query, run, row);
  }

  // Task 4 fills this in.
  protected async withAccess(_query: SelectQueryBuilder, _run: ListRun, _row: ReturnType<typeof rowContext>): Promise<void> {}
}
```

Check before writing: `AuthzClock` and `FALSE` are exported from `@spinajs/authz` (`src/host/clock.ts`, `src/contracts/filter.ts:33`).

- [ ] **Step 5: Register, allowlist, RFC**

Append to `packages/authz-orm/src/lists/index.ts`:

```ts
export * from './augment.js';
export { AccessListMiddleware, restrict } from './middleware.js';
```

`src/index.ts` already re-exports `./lists/index.js` (Task 1); importing it now also installs the builder methods and registers the middleware.

In `scripts/api-snapshot.json` replace `"augmentationAllowlist": []` with:

```json
  "augmentationAllowlist": ["packages/authz-orm/src/lists/augment.ts"]
```

Create `docs/plans/authz-v3-rfc/RA4-1.md`:

```md
# RA4-1: authz-orm adds list helpers to the ORM builders

Status: APPROVED with the 2026-10-14 resource-access design (lane L4).

## Change

`packages/authz-orm/src/lists/augment.ts` augments `@spinajs/orm`: `accessible(permission, opts?)` and
`unscoped(reason)` on the select, update and delete builders (interfaces and classes), and
`withAccess(permissions, opts?)` on the select builders (design §6.2, §8, §10.3). `opts.env` is the
request env passed to `AuthzService.accessPlan`. The methods only mark the builder; the query
middleware of the same package renders the plan at execution.

`@spinajs/orm` is not a snapshotted package and authz-orm's `api.ts` re-exports nothing from it, so the
snapshot check does not flag this file today; it is listed in `augmentationAllowlist` so that a later
re-export cannot turn it into an unapproved change.

## Affected lanes

L5 and L9 (callers of the helpers), L12 (the ESLint rule recognises the three methods by name).
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/lists/accessible.test.ts`
Expected: PASS, `14 passing` with Postgres up (`7 passing, 7 pending` without).

Run: `cd ../.. && node scripts/api-snapshot.mjs --check`
Expected: no augmentation problem reported for `packages/authz-orm/src/lists/augment.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/authz-orm/src/lists packages/authz-orm/test/lists/accessible.test.ts scripts/api-snapshot.json docs/plans/authz-v3-rfc/RA4-1.md
git commit -m "feat(authz-orm): .accessible() and .unscoped() on select, update and delete (RA4-1)"
```

---

### Task 4: `.withAccess()` and per-row `$access`

**Files:**
- Create: `packages/authz-orm/src/lists/access-field.ts`
- Modify: `packages/authz-orm/src/lists/middleware.ts`, `src/lists/index.ts`, `src/schema.ts`, `test/api.test.ts`
- Test: `packages/authz-orm/test/lists/with-access.test.ts`

**Interfaces:**
- Consumes: `renderPlan`, `rowContext` (Task 2), `AccessListMiddleware` / `ListRun` (Task 3); L1's orm-sql fix (overview decision 19): a raw select column keeps its bindings, in SQL order before the where bindings.
- Produces:
  - `ACCESS_FIELD = '$access'`; `accessField(): string` (config `authz.orm.accessField`, schema default `'$access'`); `accessColumn(i) = '__authz_access_<i>'`.
  - Per permission one select column `CASE WHEN <plan> THEN 1 ELSE 0 END AS "__authz_access_<i>"` (`1` for an `all` plan, `0` for `none`). A query without explicit columns gets `*` first.
  - `AccessFieldMiddleware` (`IBuilderMiddleware`): `afterQuery` moves the columns out of each raw row, `afterHydration` sets `model[accessField] = { [permission]: boolean }` (frozen) and wraps that instance's `dehydrate` / `dehydrateWithRelations` so `toJSON()` and controllers that dehydrate send it. `asRaw()` skips both hooks (`builders.ts:126-128`): raw rows keep the `__authz_access_<i>` columns.
- Bindings: the plan's values are bound as parameters of the `CASE WHEN` column (`RawQuery.create(sql, bindings)` in `select()`); before L1's fix `SqlColumnsCompiler` dropped them (`packages/orm-sql/src/compilers.ts:253-265`), so this task waits for L1.

- [ ] **Step 1: Write the failing test**

Create `packages/authz-orm/test/lists/with-access.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { PlanTermSql, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, AuthzService, Principal } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { FlagSql } from '../support/flag-sql.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const plans: Record<string, AccessPlan> = {
  'task:read': { kind: 'filter', permit: 'all', deny: [] },
  'task:update': { kind: 'filter', permit: [{ op: 'test.flag', args: { flag: "o'green" } }], deny: [] },
  'task:delete': { kind: 'none', reason: { code: 'no_access' } },
};

type Q = Promise<(ModelBase & Record<string, unknown>)[]> & { accessible(p: string): Q; withAccess(p: string[]): Q; asRaw<T>(): Promise<T> };
type M = typeof ModelBase & { query(): Q };

describe('.withAccess()', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  let service: AuthzService;
  const undo: (() => void)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    undo.push(testHost.registerInRoot(PlanTermSql, FlagSql));
    service = await (await testHost.domains()).service('root');
    sinon.stub(service, 'accessPlan').callsFake(async (_p, permission) => plans[permission]);
  });

  afterEach(async () => {
    sinon.restore();
    testHost.config().unset(['authz', 'orm', 'accessField']);
    for (const fn of undo.splice(0).reverse()) fn();
    await testHost.resetRoot();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Task: M;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        Task = (await db.define({ name: 'Task', columns: { flag: 'TEXT', title: 'TEXT' }, rows: [{ id: 't1', flag: "o'green", title: 'a' }, { id: 't2', flag: 'red', title: 'b' }], decorate: (c) => AccessResource('task')(c) }, dialect)) as M;
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      const as = <T>(fn: () => Promise<T>) => runWithPrincipal(alice, fn);

      it('answers each permission per row in one query; a quote in a bound value is just data', async () => {
        const rows = await as(() => Task.query().accessible('task:read').withAccess(['task:update', 'task:delete']));
        const byId = Object.fromEntries(rows.map((r) => [r.id, r.$access]));
        expect(byId).to.deep.equal({ t1: { 'task:update': true, 'task:delete': false }, t2: { 'task:update': false, 'task:delete': false } });
        expect(rows[0].title).to.be.a('string');
        expect(Object.keys(rows[0]).some((k) => k.startsWith('__authz_access_'))).to.equal(false);
      });

      it('serialises $access with the row', async () => {
        const [row] = (await as(() => Task.query().accessible('task:read').withAccess(['task:update']))).filter((r) => r.id === 't1');
        const json = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
        expect(json.$access).to.deep.equal({ 'task:update': true });
        expect((row as unknown as { dehydrateWithRelations(): Record<string, unknown> }).dehydrateWithRelations().$access).to.deep.equal({ 'task:update': true });
      });

      it('uses authz.orm.accessField', async () => {
        testHost.config().set(['authz', 'orm', 'accessField'], 'can');
        const rows = await as(() => Task.query().withAccess(['task:update']).unscoped('admin view'));
        expect(rows.find((r) => r.id === 't1')!.can).to.deep.equal({ 'task:update': true });
        expect(rows[0].$access).to.equal(undefined);
      });

      it('asRaw keeps the raw columns', async () => {
        const raw = await as(() => Task.query().withAccess(['task:update']).unscoped('raw').asRaw<Record<string, unknown>[]>());
        expect(raw.map((r) => Number(r.__authz_access_0)).sort()).to.deep.equal([0, 1]);
      });
    });
  }
});
```

In `packages/authz-orm/test/api.test.ts` change the schema assertion to `expect(root.AUTHZ_ORM_CONFIGURATION_SCHEMA.properties).to.have.keys(['domain', 'accessField']);`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-orm && npx ts-mocha -p tsconfig.json test/lists/with-access.test.ts`
Expected: FAIL: `expected { t1: undefined, t2: undefined } to deeply equal …` (`$access` is not set yet).

- [ ] **Step 3: Write `src/lists/access-field.ts`**

```ts
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IBuilderMiddleware, ModelBase } from '@spinajs/orm';
import type { Permission } from '@spinajs/authz';

export const ACCESS_FIELD = '$access';

export const accessColumn = (i: number): string => `__authz_access_${i}`;

export function accessField(): string {
  const v = DI.get(Configuration)?.get<unknown>(['authz', 'orm', 'accessField']);
  return typeof v === 'string' && v !== '' ? v : ACCESS_FIELD;
}

const truthy = (v: unknown): boolean => v === 1 || v === true || v === '1' || v === 1n;

// dehydrate() emits descriptor columns only, so the answers ride on per-instance overrides.
function attach(model: ModelBase, field: string, access: Readonly<Record<string, boolean>>): void {
  Object.defineProperty(model, field, { value: access, enumerable: true, configurable: true, writable: true });
  for (const method of ['dehydrate', 'dehydrateWithRelations'] as const) {
    const base = (model as unknown as Record<string, (...a: unknown[]) => Record<string, unknown>>)[method];
    Object.defineProperty(model, method, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: function (this: ModelBase, ...args: unknown[]) {
        return { ...base.apply(this, args), [field]: (this as unknown as Record<string, unknown>)[field] };
      },
    });
  }
}

/** Moves the `__authz_access_<i>` columns of each raw row onto the hydrated model as `{ [permission]: boolean }`. */
export class AccessFieldMiddleware implements IBuilderMiddleware {
  private readonly answers: Readonly<Record<string, boolean>>[] = [];

  constructor(private readonly permissions: readonly Permission[], private readonly field: string) {}

  afterQuery(data: unknown[]): unknown[] {
    if (!Array.isArray(data)) return data;
    for (const raw of data as Record<string, unknown>[]) {
      const access: Record<string, boolean> = {};
      this.permissions.forEach((p, i) => {
        access[p] = truthy(raw?.[accessColumn(i)]);
        if (raw) delete raw[accessColumn(i)];
      });
      this.answers.push(Object.freeze(access));
    }
    return data;
  }

  modelCreation(): ModelBase | null {
    return null;
  }

  async afterHydration(models: ModelBase[]): Promise<void> {
    models.forEach((m, i) => {
      const access = this.answers[i];
      if (access !== undefined) attach(m, this.field, access);
    });
  }
}
```

- [ ] **Step 4: Fill in `withAccess` in `src/lists/middleware.ts`**

Add to the imports:

```ts
import { AccessFieldMiddleware, accessColumn, accessField } from './access-field.js';
import { quoterOf } from './dialect.js';
```

Replace the `withAccess` method of `AccessListMiddleware` with:

```ts
  protected async withAccess(query: SelectQueryBuilder, run: ListRun, row: ReturnType<typeof rowContext>): Promise<void> {
    const permissions = run.marks.withAccess ?? [];
    const q = quoterOf(query.Driver);
    if (query.getColumns().length === 0) query.select('*');
    for (const [i, permission] of permissions.entries()) {
      const r = renderPlan(await run.service.accessPlan(run.principal, permission, run.entry.type, run.marks.env), row);
      const expr = r.kind === 'none' ? { sql: '0', bindings: [] as unknown[] } : r.kind === 'all' ? { sql: '1', bindings: [] as unknown[] } : { sql: `CASE WHEN ${r.sql} THEN 1 ELSE 0 END`, bindings: [...r.bindings] };
      query.select(RawQuery.create(`${expr.sql} AS ${q(accessColumn(i))}`, expr.bindings));
    }
    query.middleware(new AccessFieldMiddleware(permissions, accessField()));
  }
```

Append to `packages/authz-orm/src/lists/index.ts`:

```ts
export { ACCESS_FIELD, AccessFieldMiddleware, accessColumn, accessField } from './access-field.js';
```

In `packages/authz-orm/src/schema.ts`, add after the `domain` property:

```ts
    // The model property that carries `.withAccess()` answers (design §10.3).
    accessField: { type: 'string', minLength: 1, default: '$access' },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/lists/with-access.test.ts test/api.test.ts`
Expected: PASS, `11 passing` with Postgres up (`7 passing, 4 pending` without).

- [ ] **Step 6: Commit**

```bash
git add packages/authz-orm/src packages/authz-orm/test/lists/with-access.test.ts packages/authz-orm/test/api.test.ts
git commit -m "feat(authz-orm): .withAccess() with per-row \$access"
```

---

### Task 5: End to end through the engine (needs L2 merged)

**Files:**
- Test: `packages/authz-orm/test/lists/engine.test.ts`
- Modify: `packages/authz-orm/README.md`

**Interfaces:**
- Consumes: L2's `DefaultAuthzService.accessPlan` (L2 Task 5) combining a model's `listSupport` / `listPlan` (L0 `AuthorizationModel` members) under `deny-overrides`; `StaticModel` (`@spinajs/authz-testing`).
- Produces: proof that a model-provided term (`test.flag`) and the built-in `relation.owner` reach SQL through the real engine on SQLite and PostgreSQL.

- [ ] **Step 1: Write the test**

Create `packages/authz-orm/test/lists/engine.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { AccessDenied, AuthorizationModel, PlanTermSql, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { ListPlanRequest, ListSupport, ModelListPlan, PermissionDef, Principal, ResourceType } from '@spinajs/authz';
import { StaticModel, testHost } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource, Owner } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { FlagSql } from '../support/flag-sql.js';

const expect = chai.expect;

const user = (id: string): Principal => ({ type: 'user', id, authenticated: true, source: 'test', attributes: {} });

/** Green rows for everyone, own rows for their owner, never red ones; nobody (user 'eve') gets none. */
class ListModel extends StaticModel {
  listSupport(_p: PermissionDef, _t: ResourceType): ListSupport {
    return true;
  }
  async listPlan(req: ListPlanRequest): Promise<ModelListPlan> {
    if (req.principal.id === 'eve') return { kind: 'abstain' };
    return { kind: 'terms', permit: [{ op: 'test.flag', args: { flag: 'green' } }, { op: 'relation.owner', args: { principals: [{ type: req.principal.type, id: req.principal.id }] } }], deny: [{ op: 'test.flag', args: { flag: 'red' } }] };
  }
}

type Q = Promise<(ModelBase & Record<string, unknown>)[]> & { accessible(p: string): Q; withAccess(p: string[]): Q };
type M = typeof ModelBase & { query(): Q };

describe('lists through the engine', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  const undo: (() => void | Promise<void>)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    undo.push(testHost.registerInRoot(PlanTermSql, FlagSql));
    const cfg = testHost.config();
    cfg.set(['authz', 'domains', 'lists'], { permissions: { 'task:read': { types: ['task'], list: true }, 'task:update': { types: ['task'], list: true } }, combine: { default: { algorithm: 'deny-overrides', models: ['m1'] } }, cache: { maxEntries: 0 } });
    cfg.set(['authz', 'orm', 'domain'], 'lists');
    const ds = await testHost.domains();
    await ds.service('root');
    const container: IContainer = ds.create('lists', 'root');
    container.register(testHost.instance(new ListModel({ name: 'm1', votes: {} }))).as(AuthorizationModel);
    await ds.service('lists');
    undo.push(() => container.dispose(), () => cfg.unset(['authz', 'domains', 'lists']), () => cfg.unset(['authz', 'orm', 'domain']));
  });

  afterEach(async () => {
    for (const fn of undo.splice(0).reverse()) await fn();
    await testHost.resetRoot();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Task: M;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        Task = (await db.define({ name: 'Task', columns: { flag: 'TEXT', owner: 'TEXT' }, rows: [{ id: 't1', flag: 'green', owner: 'bob' }, { id: 't2', flag: 'blue', owner: 'alice' }, { id: 't3', flag: 'red', owner: 'alice' }, { id: 't4', flag: 'blue', owner: 'bob' }], decorate: (c, p) => { AccessResource('task')(c); Owner()(p, 'owner'); } }, dialect)) as M;
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      const ids = (rows: ModelBase[]) => rows.map((r) => String((r as unknown as { id: unknown }).id)).sort();

      it('permits green and own rows, denies red ones', async () => {
        expect(ids(await runWithPrincipal(user('alice'), () => Task.query().accessible('task:read')))).to.deep.equal(['t1', 't2']);
        expect(ids(await runWithPrincipal(user('bob'), () => Task.query().accessible('task:read')))).to.deep.equal(['t1', 't4']);
      });

      it('SYSTEM lists everything; a principal no model plans for is AccessDenied', async () => {
        expect(ids(await runWithPrincipal(SYSTEM, () => Task.query().accessible('task:read')))).to.deep.equal(['t1', 't2', 't3', 't4']);
        let err: unknown;
        try {
          await runWithPrincipal(user('eve'), () => Task.query().accessible('task:read'));
        } catch (e) {
          err = e;
        }
        expect(err).to.be.instanceOf(AccessDenied);
      });

      it('withAccess agrees with the list for the same permission', async () => {
        const rows = await runWithPrincipal(user('alice'), () => Task.query().accessible('task:read').withAccess(['task:update']));
        expect(Object.fromEntries(rows.map((r) => [r.id, (r.$access as Record<string, boolean>)['task:update']]))).to.deep.equal({ t1: true, t2: true });
      });
    });
  }
});
```

- [ ] **Step 2: Run the test**

Run: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/lists/engine.test.ts`
Expected: PASS, `6 passing` with Postgres up (`3 passing, 3 pending` without). If it fails with `accessPlan is not implemented`, L2 is not merged yet: this task waits for it.

- [ ] **Step 3: Document the helpers**

Append to `packages/authz-orm/README.md`:

````md
## Lists

```ts
const tasks = await Task.where('status', 'open').accessible('Task:read');
await Task.update({ archived: true }).where('project_id', 7).accessible('Task:update');
const page = await Task.query().accessible('Task:read').withAccess(['Task:update', 'Task:delete']);
// page[i].$access = { 'Task:update': true, 'Task:delete': false }
```

- The permission must be declared `list: true` (`authz.permissions['Task:read'] = { list: true }`);
  `accessPlan` refuses any other with `AuthzConfigError`.
- The plan is asked for the principal the query runs as, when it executes. A plan that grants nothing
  throws `AccessDenied` (a list with no permit is a 403, not an empty list). `{ env }` passes request
  env facts: `.accessible('Task:read', { env: { ip } })`.
- The caller's where stays one group: `(where) AND (plan)`. Works on select, update and delete.
- `.unscoped(reason)` runs without a filter and writes an `unscoped` audit entry
  (`authz.audit.unscoped`).
- `.withAccess(permissions)` adds one boolean per permission, from the same SQL as `.accessible()`, in
  the same query; the key is `authz.orm.accessField` (default `$access`), sent by `toJSON()` and
  `dehydrate()`.
- Models add list support by registering a `PlanTermSql` (`@Injectable(PlanTermSql)`) for the ops
  their `listPlan` returns. Built in: `relation.owner` and `relation.self`
  (`{ principals: { type, id }[] }`; the columns come from `@Owner()` / `@Self()`).
- `populate('tasks', (q) => q.accessible('Task:read'))` works for relations that run their own query
  (has-many, many-to-many); a belongs-to populate is a join of the parent and is not filtered.
````

- [ ] **Step 4: Commit**

```bash
git add packages/authz-orm/test/lists/engine.test.ts packages/authz-orm/README.md
git commit -m "test(authz-orm): lists through the engine; README"
```

---

### Task 6: Lane verification

- [ ] **Step 1: Package suite**

Run: `cd packages/authz-orm && npm test`
Expected: PASS, `0 failing`.

- [ ] **Step 2: Snapshot**

Run: `cd ../.. && npm run build 2>&1 | tail -3 && node scripts/api-snapshot.mjs --check`
Expected: no problem reported for `authz-orm` (the snapshot of `src/api.ts` is unchanged by this lane).

---

### Task 7: `.within(ref)`: rows at or below a scope (teams lanes L14/L15)

A list narrowed to "this team", "this project" or "this folder" (teams design §9, §10). The rows kept are the refs themselves and every row that descends from one of them in `authz_resource_ancestor`, for any scope type. It narrows; it does not authorize, so the runtime guard (L3 Task 8) still wants `.accessible()`, `.unscoped()` or SYSTEM on a select.

**Files:**
- Modify: `packages/authz-orm/src/marker.ts`, `src/lists/augment.ts`, `src/lists/middleware.ts`, `packages/authz-orm/README.md`, `docs/plans/authz-v3-rfc/RA4-1.md`
- Test: `packages/authz-orm/test/lists/within.test.ts`

**Interfaces:**
- Consumes: `withinSql(within: readonly ResourceRef[], row: SqlRowContext): SqlFragment` (Task 2; the same SQL as the plan's ceiling), `rowContext`, `restrict` (Tasks 2, 3), `marksOf` / `setMarks` (L3 Task 1).
- Produces:
  - `within(ref: ResourceRef | readonly ResourceRef[]): this` on `ISelectQueryBuilder`, `SelectQueryBuilder`, `IUpdateQueryBuilder`, `UpdateQueryBuilder`, `IDeleteQueryBuilder`, `DeleteQueryBuilder` (same augmentation file as `.accessible()`, so the `augmentationAllowlist` entry of Task 3 covers it).
  - `AccessMarks.within?: readonly (readonly ResourceRef[])[]`: one entry per call. The refs of one call are OR-ed, separate calls are AND-ed, and `.accessible()` is AND-ed with all of them. `[]` keeps nothing. A `GLOBAL` ref, or a type-level ref of the row's own type, keeps everything.
  - Call-time refusals (`AuthzConfigError`): no `@AccessResource` model; a ref that is not `{ type: non-empty string, id?: string }`.
  - `.within()` combines with `.accessible()`, `.withAccess()` and `.unscoped()`.

- [ ] **Step 1: Write the failing test**

Create `packages/authz-orm/test/lists/within.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthzConfigError, GLOBAL, PlanTermSql, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, AuthzService, Principal, ResourceRef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource } from '../../src/index.js';
import { marksOf } from '../../src/marker.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createAncestorTable, dropAncestorTable, insertLinks } from '../support/ancestors.js';
import { FlagSql } from '../support/flag-sql.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const green: AccessPlan = { kind: 'filter', permit: [{ op: 'test.flag', args: { flag: 'green' } }], deny: [] };
const T1: ResourceRef = { type: 'team', id: 't1' };
const T2: ResourceRef = { type: 'team', id: 't2' };
const G1: ResourceRef = { type: 'group', id: 'g1' };

type Refs = ResourceRef | readonly ResourceRef[];
type Q = Promise<ModelBase[]> & { within(r: Refs): Q; accessible(p: string): Q; unscoped(r: string): Q; where(...a: unknown[]): Q; orWhere(...a: unknown[]): Q; clone(): Q };
type W = Promise<unknown> & { within(r: Refs): W };
type M = typeof ModelBase & { query(): Q; where(...a: unknown[]): Q; update(v: object): W; destroy(): W };

const ids = (rows: ModelBase[]) => rows.map((r) => String((r as unknown as { id: unknown }).id)).sort();

// d5 belongs to t3, a sub-team of t1; d4 belongs to nothing.
const LINKS = ['doc:d1>team:t1@1', 'doc:d2>group:g1@1', 'doc:d2>team:t1@2', 'doc:d3>team:t2@1', 'doc:d5>team:t3@1', 'doc:d5>team:t1@2'];
const ROWS = [
  { id: 'd1', flag: 'green', title: 'a' },
  { id: 'd2', flag: 'red', title: 'b' },
  { id: 'd3', flag: 'green', title: 'c' },
  { id: 'd4', flag: 'green', title: 'd' },
  { id: 'd5', flag: 'green', title: 'e' },
];

describe('.within()', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  let service: AuthzService;
  let plan: sinon.SinonStub;
  const undo: (() => void)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    undo.push(testHost.registerInRoot(PlanTermSql, FlagSql));
    service = await (await testHost.domains()).service('root');
    plan = sinon.stub(service, 'accessPlan').resolves(green);
  });

  afterEach(async () => {
    sinon.restore();
    testHost.config().unset(['process', 'env', 'APP_ENV']);
    for (const fn of undo.splice(0).reverse()) fn();
    await testHost.resetRoot();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Doc: M;
      let Plain: M;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        Doc = (await db.define({ name: 'Doc', columns: { flag: 'TEXT', title: 'TEXT' }, rows: ROWS, decorate: (c) => AccessResource('doc')(c) }, dialect)) as M;
        Plain = (await db.define({ name: 'Plain', columns: { title: 'TEXT' } }, dialect)) as M;
        await insertLinks(db.driver(dialect), LINKS);
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      const as = <T>(fn: () => Promise<T>) => runWithPrincipal(alice, fn);
      const listed = (q: () => Q) => as(async () => ids(await q().unscoped('within test')));

      it('keeps the rows that are the ref or descend from it, whatever its type', async () => {
        expect(await listed(() => Doc.query().within(T1))).to.deep.equal(['d1', 'd2', 'd5']);
        expect(await listed(() => Doc.query().within(G1))).to.deep.equal(['d2']);
        expect(await listed(() => Doc.query().within({ type: 'doc', id: 'd4' }))).to.deep.equal(['d4']);
        expect(plan.called).to.equal(false);
      });

      it('refs of one call are OR-ed, calls are AND-ed; [] keeps nothing, GLOBAL everything', async () => {
        expect(await listed(() => Doc.query().within([G1, T2]))).to.deep.equal(['d2', 'd3']);
        expect(await listed(() => Doc.query().within([T2, { type: 'doc', id: 'd4' }]))).to.deep.equal(['d3', 'd4']);
        expect(await listed(() => Doc.query().within(T1).within(G1))).to.deep.equal(['d2']);
        expect(await listed(() => Doc.query().within([]))).to.deep.equal([]);
        expect(await listed(() => Doc.query().within(GLOBAL))).to.deep.equal(['d1', 'd2', 'd3', 'd4', 'd5']);
      });

      it("keeps the caller's where in one group: an orWhere cannot widen it", async () => {
        expect(await listed(() => Doc.where('id', 'd3').orWhere('id', 'd1').within(T1))).to.deep.equal(['d1']);
      });

      it('ANDs with .accessible(): a row must be in the scope and allowed', async () => {
        expect(ids(await as(() => Doc.query().within(T1).accessible('doc:read')))).to.deep.equal(['d1', 'd5']);
        expect(ids(await as(() => Doc.query().accessible('doc:read').within([G1, T2])))).to.deep.equal(['d3']);
        expect(plan.firstCall.args.slice(0, 3)).to.deep.equal([alice, 'doc:read', 'doc']);
      });

      it('narrows updates and deletes', async () => {
        await as(() => Doc.update({ title: 'x' }).within(T1));
        expect((await db.rows(Doc)).filter((r) => r.title === 'x').map((r) => r.id).sort()).to.deep.equal(['d1', 'd2', 'd5']);
        await as(() => Doc.destroy().within(G1));
        expect((await db.rows(Doc)).map((r) => r.id).sort()).to.deep.equal(['d1', 'd3', 'd4', 'd5']);
      });

      it('is no access filter: in test the runtime guard still asks for .accessible() on a select', async () => {
        testHost.config().set(['process', 'env', 'APP_ENV'], 'test');
        let err: unknown;
        try {
          await as(async () => await Doc.query().within(T1));
        } catch (e) {
          err = e;
        }
        expect(err).to.be.instanceOf(AuthzConfigError);
        expect((err as Error).message).to.match(/\.accessible\(permission\), \.unscoped\(reason\) or runAs\(SYSTEM\)/);
      });

      it('refuses misuse at call time', () => {
        expect(() => Plain.query().within(T1)).to.throw(AuthzConfigError, /@AccessResource/);
        for (const bad of [null, {}, { type: '' }, { type: 'team', id: 5 }, [T1, 'team:t2']]) {
          expect(() => Doc.query().within(bad as never), JSON.stringify(bad)).to.throw(AuthzConfigError, /\.within\(\): a ref is \{ type, id\? \}/);
        }
      });

      it('a clone keeps the refs', () => {
        expect(marksOf(Doc.query().within(T1).within([G1, T2]).clone())).to.deep.equal({ within: [[T1], [G1, T2]] });
      });
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-orm && npx ts-mocha -p tsconfig.json test/lists/within.test.ts`
Expected: FAIL with `TypeError: Doc.query(...).within is not a function`.

- [ ] **Step 3: The mark**

In `packages/authz-orm/src/marker.ts`, change the type import to `import type { Permission, ResourceRef } from '@spinajs/authz';` and add to `AccessMarks` after `withAccess`:

```ts
  /** `.within()` calls: the refs of one call are OR-ed, the calls are AND-ed. */
  readonly within?: readonly (readonly ResourceRef[])[];
```

- [ ] **Step 4: The builder method**

In `packages/authz-orm/src/lists/augment.ts`:

1. The type import becomes `import type { Permission, ResourceRef } from '@spinajs/authz';`.
2. In `declare module '@spinajs/orm'`, add to each of the six interfaces (`ISelectQueryBuilder`, `SelectQueryBuilder`, `IUpdateQueryBuilder`, `UpdateQueryBuilder`, `IDeleteQueryBuilder`, `DeleteQueryBuilder`), after `unscoped`:

```ts
    /** Only rows that are one of `ref` or descend from one (authz_resource_ancestor); narrows, does not authorize. */
    within(ref: ResourceRef | readonly ResourceRef[]): this;
```

3. Add after `unscoped`:

```ts
function refsOf(v: unknown): readonly ResourceRef[] {
  const list: unknown[] = Array.isArray(v) ? v : [v];
  return Object.freeze(
    list.map((r) => {
      const ref = r as { type?: unknown; id?: unknown } | null;
      const ok = ref !== null && typeof ref === 'object' && typeof ref.type === 'string' && ref.type !== '' && (ref.id === undefined || typeof ref.id === 'string');
      if (!ok) throw new AuthzConfigError(`.within(): a ref is { type, id? } with string values, got ${JSON.stringify(r)}`);
      return Object.freeze(ref.id === undefined ? { type: ref.type as string } : { type: ref.type as string, id: ref.id as string });
    }),
  );
}

function within(this: object, ref: ResourceRef | readonly ResourceRef[]): object {
  requireResource(this, '.within()');
  const refs = refsOf(ref);
  const marks = marksOf(this) ?? {};
  setMarks(this, { ...marks, within: Object.freeze([...(marks.within ?? []), refs]) });
  return this;
}
```

4. In the prototype loop, add `proto.within = within;` after `proto.unscoped = unscoped;`.

- [ ] **Step 5: The middleware**

In `packages/authz-orm/src/lists/middleware.ts`:

1. The `@spinajs/authz` type import gains `SqlFragment`. Change `import { renderPlan } from './render.js';` to `import { renderPlan, withinSql } from './render.js';`.
2. In `beforeQueryExecution`, replace from `if (marks.accessible === undefined && marks.withAccess === undefined) return;` through the closing brace of `if (marks.accessible !== undefined) { … }` with:

```ts
    if (marks.accessible === undefined && marks.withAccess === undefined && marks.within === undefined) return;
    const run: ListRun = { domain, principal, service: authz(domain), entry, marks, now: await nowOf(domain) };
    const row = rowContext(query, entry, run.now);
    const filters: SqlFragment[] = [];
    if (marks.accessible !== undefined) {
      const rendered = renderPlan(await run.service.accessPlan(principal, marks.accessible, entry.type, marks.env), row);
      if (rendered.kind === 'none') throw new AccessDenied(denied(domain, principal, marks.accessible, entry.type, rendered.reason));
      if (rendered.kind === 'sql') filters.push(rendered);
    }
    for (const refs of marks.within ?? []) filters.push(withinSql(refs, row));
    // One restrict: the caller's where becomes one group, ANDed with the plan and every .within().
    if (filters.length > 0) restrict(query, { kind: 'sql', sql: filters.map((f) => `(${f.sql})`).join(' AND '), bindings: filters.flatMap((f) => [...f.bindings]) });
```

The `withAccess` line after it stays as it is.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/lists/within.test.ts test/lists/accessible.test.ts test/lists/with-access.test.ts`
Expected: PASS, `38 passing` with Postgres up (`19 passing, 19 pending` without; `within.test.ts` is 8 per dialect, the other two files are unchanged).

- [ ] **Step 7: README and RFC**

In `packages/authz-orm/README.md`, section `## Lists`, add to the code block after the `.withAccess` line:

```ts
const teamTasks = await Task.query().within({ type: 'team', id: teamId }).accessible('Task:read');
```

and add after the `.unscoped(reason)` bullet:

```md
- `.within(ref | refs)` keeps rows that are one of the refs or lie below one in the resource tree
  (any scope type: a team, a project, a folder). The refs of one call are OR-ed, chained calls are
  AND-ed, `[]` keeps nothing. It narrows a list and authorizes nothing: a select still needs
  `.accessible()`, `.unscoped()` or SYSTEM. Works on select, update and delete.
```

In `docs/plans/authz-v3-rfc/RA4-1.md`, add after the first paragraph of `## Change`:

```md
`within(ref | refs)` on the same select, update and delete builders (teams design 2026-10-14 §10)
keeps rows that are one of the refs or descend from one in `authz_resource_ancestor`. It is no access
check and is ANDed with `accessible()`. It lives in the same augmentation file, so the allowlist entry
below covers it.
```

and change `## Affected lanes` to `L5 and L9 (callers of the helpers), L12 (the ESLint rule recognises the three methods by name), L14/L15 (teams: lists with .within()).`

- [ ] **Step 8: Package and snapshot**

Run: `cd packages/authz-orm && npm test`
Expected: PASS, `0 failing`.

Run: `cd ../.. && npm run build 2>&1 | tail -3 && node scripts/api-snapshot.mjs --check`
Expected: no problem reported for `authz-orm` or for `packages/authz-orm/src/lists/augment.ts` (already in `augmentationAllowlist`; `scripts/api-snapshot.json` is not changed).

- [ ] **Step 9: Commit**

```bash
git add packages/authz-orm/src/marker.ts packages/authz-orm/src/lists packages/authz-orm/test/lists/within.test.ts packages/authz-orm/README.md docs/plans/authz-v3-rfc/RA4-1.md
git commit -m "feat(authz-orm): .within(ref) narrows lists to a scope subtree (RA4-1)"
```

---

## Contract issues found

1. **Owner/self ops (applied).** Per the updated names table, the built-in compilers are `relation.owner` / `relation.self` with `{ principals: { type; id }[] }`, and the columns come from `SqlRowContext.relation(name)`, which `rowContext` fills from the registry entry (`owner.typeColumn` included). The earlier `relation.column` op is gone.
2. **`SqlRowContext.ancestorTable` quoting.** The contract does not say whether it is quoted. L4 passes the quoted identifier (`"authz_resource_ancestor"`, the driver's `IdentifierQuoter`); compilers (L8's `rbac.assignment`) must use it as is. `rowId` and `rowColumn()` are likewise ready-to-use SQL.
3. **Raw select column bindings** (resolved, overview decision 19): L1 fixes orm-sql so a raw select column keeps its bindings; `withAccess` binds the plan's values normally and authz-orm has no orm-sql dependency.
4. **`augmentationAllowlist` is not strictly needed.** `scripts/api-snapshot.mjs` treats only snapshotted packages and packages they *re-export* as targets; authz-orm's `api.ts` re-exports nothing from `@spinajs/orm`. The entry is added as asked, with RFC RA4-1.
5. **No refusal at call time for non-`list` permissions.** `.accessible()` relies on `accessPlan` throwing `AuthzConfigError` for a permission without `list: true` (L2 Task 2 does), so the error surfaces at execution, not at the `.accessible()` call (the permission registry is the domain's, and the builder method has no domain context).
