# Lane L5: consumers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `00-overview.md` first: its Global Constraints, frozen contracts and names table bind every task here.

**Goal:** Move every package that used query rewriting (`@OrmScope`, `@ScopeColumn`, scoped selects, `relationScope`, the ORM behaviour lane) onto check-before-access and `.accessible()`, and give the test kit the pieces later lanes need (list plans in the kit model, the new `orm` lane contract, B06 over `.accessible()`, `runClientAccessConformance`).

**Architecture:** authz-testing changes first, because every consumer harness implements its `orm` lane contract. Then one task per consumer package, each ending with that package's `npm test` green. No consumer keeps a query that relied on the old middleware: single objects load as `SYSTEM` and are checked with `authz().assert(...)`; lists call `.accessible(permission)`.

**Tech Stack:** TypeScript (node16 modules), mocha + chai, fast-check, `@spinajs/authz-orm` (new API from L3/L4), `@spinajs/authz-testing`.

**Depends on:** L0 (contracts: `PermissionDef.list`, `ListPlanRequest`, `ModelListPlan`), L2 (`AuthzService.checkAll`, `accessPlan`, boot rule 12), L3 tasks 1-3 (`AccessResource(type)`, `Parent(type, { nullable? })`, `Owner()`, `Self()`, `registerAccessResource(model, type, { parents?, owner?, self? })`, `OrmResourceAdapter`), L4 (`.accessible()`, `.withAccess()`, `.unscoped()`, the `relation.owner` compiler, runtime guard), L7 (old RBAC ORM code removed).

**Blocks:** L9.

## Global Constraints

- Everything in `00-overview.md` "Global Constraints" applies (English only, comments only for a non-obvious "why", `npm test` per package, one commit per task, conventional messages).
- No compatibility shims: removed names are removed, not aliased.
- A task that finds an L3/L4 name different from the one written here uses the real name and notes it in its commit message; it does not add an alias.
- Facts from the overview's names table and decisions: `.accessible(permission)`, `.withAccess(permissions)` and `.unscoped(reason)` on select/update/delete builders; `authz.orm.domain` (default `root`) stays; `Owner(opts?: { typeColumn?: string })` and `registerAccessResource(..., { owner: string | { column, typeColumn? } })`; RBAC/kit owner list terms are `relation.owner` with `{ principals: { type, id }[] }`. The runtime guard (decision 11) throws `AuthzConfigError` in the `test` env for a **multi-row** select on an `@AccessResource` model without `.accessible()`, `.unscoped()` or `runAs(SYSTEM)`; a select constrained to exactly one primary-key value (`@FromModel` by primary key, `findOrFail(id)`) is not flagged.

## Files

| File | Task | Change |
|---|---|---|
| `packages/authz-testing/src/fakes/list-static-model.ts` | 1 | create: `ListStaticModel` |
| `packages/authz-testing/src/fakes/static-model.ts` | 1 | `ModelCall.method` gains `'listPlan'` |
| `packages/authz-testing/src/fakes/index.ts` | 1 | export |
| `packages/authz-testing/src/behaviour/{types,world,dsl,harness}.ts` | 1 | `lists` on static specs, `allRows`/`ownedRows`/`noRows`, `checkAll`/`accessPlan` on `BehaviourAuthz` |
| `packages/authz-testing/src/behaviour/lane.ts` | 2, 4 | new `orm` lane contract; `accessibleAgree` step |
| `packages/authz-testing/src/behaviour/B20-orm-access.spec.ts` | 2 | replaces `B20-orm-scoping.spec.ts` |
| `packages/authz-testing/src/behaviour/B21-orm-models.spec.ts`, `B09-lanes.spec.ts`, `B30-queue.spec.ts`, `B44-rules-sql.spec.ts`, `B06-check-filter*.spec.ts`, `B05-boot-checks.spec.ts`, `B09-unattended-system.spec.ts`, `B15-relations.spec.ts`, `B22-filter-now.spec.ts`, `B39-scope-attributes.spec.ts`, `catalogue-*.ts`, `rules.ts` | 2, 4 | rewrite / retire |
| `packages/authz-testing/src/behaviour/B05-orm.spec.ts`, `B22-orm.spec.ts`, `B39-orm.spec.ts` | 2 | delete |
| `docs/plans/2026-10-01-authz-v3-design.md` §17 | 2 | the changed rule rows, verbatim as `rules.ts` |
| `packages/authz-testing/test/canvas-c6/{sql-harness,list,list.test}.ts` | 3 | delete; `mismatches.ts`, `config.ts`, `config.test.ts` edited |
| `packages/authz-testing/src/arbitraries/{access,rbac,index}.ts` | 4 | `accessWorld` arbitrary; `TestRoleDef.deny` |
| `packages/authz-testing/src/conformance/client-access.ts` (+ index) | 5 | `runClientAccessConformance` |
| `packages/authz-testing/test/conformance/client-access.test.ts` | 5 | self-test over a fake server |
| `packages/authz-queue/src/job/{job-resource,job-grant}.ts`, `test/job-scope.test.ts`, `test/support/queue-harness.ts` | 6 | owner on the initiator |
| `packages/queue-http-progress/src/controllers/JobsControllers.ts`, `test/support/status-harness.ts` | 7 | load as SYSTEM, then check |
| `packages/configuration-http/src/{bootstrap,controllers/Configuration,write,config/configuration-http}.ts`, `test/*` | 8 | `.accessible()` list, check-before single rows |
| `packages/users/test/{identity-system.test,support/users-db}.ts`, `packages/users-http/src/admin/controllers/Users/Users.ts` | 9 | guard semantics; list query as SYSTEM after the every-user check |
| `packages/http-socket/test/authz/{socket-harness,behaviour.test}.ts` | 10 | new `orm` lane contract |
| `packages/authz-convert/src/analyze.ts`, `test/fixtures/golden/*/expected/authz-warnings.md` | 11 | no `@OrmScope` advice |
| `packages/authz-testing/README.md` | 5 | orm facet, client conformance |

`packages/authz-rbac/**` also imports `@spinajs/authz-orm` today (`src/orm/**`, `test/orm*/**`, `test/ported/active-role-orm.test.ts`, `test/admin/db/backend.test.ts`); that is L7's removal, not this lane's.

---

### Task 0: Read what L3/L4 actually shipped

**Files:** none.

- [ ] **Step 1: Record the real names**

Run (repo root):

```bash
grep -rnE "export (function|const|class) (AccessResource|Parent|Owner|Self|registerAccessResource|unregisterResource|entryOf)\b" packages/authz-orm/src
grep -rnE "accessible|withAccess|unscoped" packages/authz-orm/src --include=*.ts -l
grep -rnE "class \w+ extends (QueryMiddleware|ResourceAdapter|AuthzContributor|PlanTermSql)" packages/authz-orm/src
grep -rnE "'domain'|accessField|env" packages/authz-orm/src/schema.ts
grep -rnE "class \w+_20\d\d_\d\d_\d\d" packages/authz-orm/src
```

Expected: all five decorators/functions found; `.accessible`, `.withAccess`, `.unscoped` declared in the builder augmentation; the class names of the write middleware, adapter and contributor (Task 9 needs them); `authz.orm.domain` in the schema; the migration class names (`AuthzAudit_…`, `AuthzScopeAttribute_…`, the ancestor table migration).

- [ ] **Step 2: Check the typed owner**

Run: `grep -n "typeColumn" packages/authz-orm/src/registry.ts packages/authz-orm/src/decorators.ts`

Expected: `owner?: string | { column: string; typeColumn?: string }` on `registerAccessResource` and `Owner(opts?: { typeColumn?: string })` (overview names table). Task 6 relies on it.

No commit.

---

### Task 1: authz-testing: list plans in the kit model

The kit's `StaticModel` must stay without `listSupport` (L2's boot rule 12 test asserts `model "plain": cannot plan lists: it has no listSupport()` on it), so list plans come from a subclass that `instantiateWorld` builds when a static spec has `lists`.

**Files:**
- Create: `packages/authz-testing/src/fakes/list-static-model.ts`
- Modify: `packages/authz-testing/src/fakes/static-model.ts` (`ModelCall`, L33-36)
- Modify: `packages/authz-testing/src/fakes/index.ts`
- Modify: `packages/authz-testing/src/behaviour/types.ts` (`StaticModelSpec`)
- Modify: `packages/authz-testing/src/behaviour/world.ts:60-63`
- Modify: `packages/authz-testing/src/behaviour/dsl.ts` (after `permit`, L22)
- Modify: `packages/authz-testing/src/behaviour/harness.ts:13` (`BehaviourAuthz`)
- Test: `packages/authz-testing/test/list-static-model.test.ts`

**Interfaces:**
- Produces: `ListStaticModel`, `ListStaticModelOptions { lists?: Record<Permission, ListPlanScript> }`, `ListPlanScript = ModelListPlan | ((principal, type, req) => ModelListPlan | Promise<ModelListPlan>)`; `fixtureDsl.allRows()`, `fixtureDsl.ownedRows()`, `fixtureDsl.noRows(code?)`; `staticModel(name, { votes, lists })`; `BehaviourAuthz` gains optional `checkAll` and `accessPlan`.

- [ ] **Step 1: Write the failing test**

`packages/authz-testing/test/list-static-model.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import type { ListPlanRequest } from '@spinajs/authz';

import { ListStaticModel, StaticModel, fixtureDsl, instantiateWorld, toPermissionDef, userPrincipal } from '../src/index.js';

const { allRows, combine, noRows, ownedRows, staticModel } = fixtureDsl;
const alice = userPrincipal('alice');
const read = toPermissionDef({ name: 'task:read', list: true });
const update = toPermissionDef('task:update');

describe('ListStaticModel', () => {
  const model = new ListStaticModel({ name: 'm1', lists: { 'task:read': ownedRows() } });

  it('supports exactly the permissions it has a plan for', () => {
    expect(model.listSupport(read, 'task')).to.equal(true);
    expect(model.listSupport(update, 'task')).to.deep.equal({ reason: "static model m1 has no list plan for 'task:update'" });
  });

  it('answers the scripted plan for the principal and records the call', async () => {
    const req: ListPlanRequest = { principal: alice, permission: read, type: 'task' };
    expect(await model.listPlan(req, {} as never)).to.deep.equal({ kind: 'terms', permit: [{ op: 'relation.owner', args: { principals: [{ type: 'user', id: 'alice' }] } }], deny: [] });
    expect(model.calls.filter((c) => c.method === 'listPlan').map((c) => c.args[0])).to.deep.equal([req]);
  });

  it('has the constant plans of the DSL', () => {
    expect(allRows()).to.deep.equal({ kind: 'all' });
    expect(noRows()).to.deep.equal({ kind: 'deny-all', reason: { code: 'no_access' } });
  });

  it('instantiateWorld builds it only for a static spec with lists', () => {
    const world = { permissions: [{ name: 'task:read', list: true }], combine: combine('deny-overrides', 'a', 'b'), models: [staticModel('a', { lists: { 'task:read': allRows() } }), staticModel('b')] };
    const kit = instantiateWorld(world);
    const [a, b] = kit.models;
    expect(a).to.be.instanceOf(ListStaticModel);
    expect(b).to.be.instanceOf(StaticModel);
    expect(b).to.not.be.instanceOf(ListStaticModel);
    expect((b as unknown as { listSupport?: unknown }).listSupport).to.equal(undefined);
  });
});
```

(`instantiateWorld(world).models` is the list of built kit models in spec order; if the KitWorld field has another name, `grep -n "readonly models" packages/authz-testing/src/behaviour/world.ts` and use it.)

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd packages/authz-testing && npm run compile; npx ts-mocha -p tsconfig.json test/list-static-model.test.ts`
Expected: FAIL, TS2305 `Module '"../src/index.js"' has no exported member 'ListStaticModel'`.

- [ ] **Step 3: Implement**

`packages/authz-testing/src/fakes/static-model.ts`, `ModelCall`:

```ts
export interface ModelCall {
  readonly method: 'init' | 'evaluate' | 'preload' | 'summarize' | 'invalidate' | 'dispose' | 'listPlan';
  readonly args: readonly unknown[];
}
```

`packages/authz-testing/src/fakes/list-static-model.ts`:

```ts
import { AuthzConfigError } from '@spinajs/authz';
import type { EvaluationContext, ListPlanRequest, ListSupport, ModelListPlan, Permission, PermissionDef, Principal, ResourceType } from '@spinajs/authz';

import { StaticModel } from './static-model.js';
import type { StaticModelOptions } from './static-model.js';

export type ListPlanScript = ModelListPlan | ((principal: Principal, type: ResourceType, req: ListPlanRequest) => ModelListPlan | Promise<ModelListPlan>);

export interface ListStaticModelOptions extends StaticModelOptions {
  /** By permission name; `listSupport` answers true for exactly these. */
  readonly lists?: Readonly<Record<Permission, ListPlanScript>>;
}

/** StaticModel with scripted list plans. StaticModel itself has no listSupport, so boot rule 12 refuses it for list permissions. */
export class ListStaticModel extends StaticModel {
  constructor(private readonly listOpts: ListStaticModelOptions = {}) {
    super(listOpts);
  }

  listSupport(permission: PermissionDef, _type: ResourceType): ListSupport {
    return this.listOpts.lists && Object.hasOwn(this.listOpts.lists, permission.name) ? true : { reason: `static model ${this.name} has no list plan for '${permission.name}'` };
  }

  async listPlan(req: ListPlanRequest, ctx: EvaluationContext): Promise<ModelListPlan> {
    this.calls.push({ method: 'listPlan', args: [req, ctx] });
    const script = this.listOpts.lists?.[req.permission.name];
    if (script === undefined) throw new AuthzConfigError(`static model ${this.name}: no list plan for '${req.permission.name}'`);
    return typeof script === 'function' ? script(req.principal, req.type, req) : script;
  }
}
```

`packages/authz-testing/src/fakes/index.ts`: add `export * from './list-static-model.js';` after the `static-model.js` line.

`packages/authz-testing/src/behaviour/types.ts`: in the import from `'../fakes/index.js'` add `ListStaticModelOptions`, and change

```ts
export interface StaticModelSpec extends StaticModelOptions {
```

to

```ts
export interface StaticModelSpec extends ListStaticModelOptions {
```

`packages/authz-testing/src/behaviour/world.ts` (case `'static'`, L60-63; add `ListStaticModel` to the fakes import):

```ts
      case 'static': {
        const { kind: _kind, ...opts } = spec;
        return opts.lists ? new ListStaticModel(opts) : new StaticModel(opts);
      }
```

`packages/authz-testing/src/behaviour/dsl.ts`, after `permit` (add `ModelListPlan`, `Principal` to the `@spinajs/authz` type import):

```ts
/** A list plan without a filter. */
export const allRows = (): ModelListPlan => ({ kind: 'all' });

/** A list plan of the rows the principal owns (authz-orm compiles `relation.owner` from the model's `@Owner` column). */
export const ownedRows =
  () =>
  (principal: Principal): ModelListPlan => ({ kind: 'terms', permit: [{ op: 'relation.owner', args: { principals: [{ type: principal.type, id: String(principal.id) }] } }], deny: [] });

/** A list plan that can never permit. */
export const noRows = (code = 'no_access'): ModelListPlan => ({ kind: 'deny-all', reason: { code } });
```

`packages/authz-testing/src/behaviour/harness.ts:13`:

```ts
export type BehaviourAuthz = Pick<AuthzService, 'check' | 'checkMany' | 'explain'> & Partial<Pick<AuthzService, 'can' | 'assert' | 'filter' | 'filterNow' | 'summary' | 'covers' | 'preload' | 'invalidate' | 'models' | 'current' | 'runAs' | 'checkAll' | 'accessPlan'>>;
```

- [ ] **Step 4: Run the test**

Run: `cd packages/authz-testing && npm run compile && npx ts-mocha -p tsconfig.json test/list-static-model.test.ts`
Expected: `4 passing`.

- [ ] **Step 5: Whole package**

Run: `cd packages/authz-testing && npm test`
Expected: `0 failing`.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-testing/src/fakes packages/authz-testing/src/behaviour/types.ts packages/authz-testing/src/behaviour/world.ts packages/authz-testing/src/behaviour/dsl.ts packages/authz-testing/src/behaviour/harness.ts packages/authz-testing/test/list-static-model.test.ts
git commit -m "feat(authz-testing): ListStaticModel and list-plan DSL for list permissions"
```

---

### Task 2: authz-testing: the `orm` lane under check-before-access

The `orm` facet promised query scoping. It now promises `.accessible()`, `.withAccess()` and the runtime guard, and the fixtures that tested scoping are rewritten or retired. Every fixture id B01-B46 keeps a fixture (worlds.test.ts asserts all 46), and `rules.ts` must equal the §17 table of `docs/plans/2026-10-01-authz-v3-design.md` verbatim (worlds.test.ts reads it), so both change together.

**Files:**
- Modify: `packages/authz-testing/src/behaviour/lane.ts` (L84-133 lane data, L236-250 result and handle, L520-561 `orm` step)
- Modify: `packages/authz-testing/src/behaviour/types.ts` (`FACETS.orm`)
- Create: `packages/authz-testing/src/behaviour/B20-orm-access.spec.ts`; delete `B20-orm-scoping.spec.ts`
- Modify: `B21-orm-models.spec.ts`, `B09-lanes.spec.ts`, `B30-queue.spec.ts`, `B09-unattended-system.spec.ts:52`, `B05-boot-checks.spec.ts:107-111`, `B15-relations.spec.ts:111`, `B22-filter-now.spec.ts:91`, `B39-scope-attributes.spec.ts:174`, `B44-rules-sql.spec.ts`, `B06-check-filter-rules.spec.ts` (part `rulesSql`), `B06-check-filter.spec.ts` (parts `sql`, `rulesSql`), `catalogue-lanes.ts`, `rules.ts`
- Delete: `B05-orm.spec.ts`, `B22-orm.spec.ts`, `B39-orm.spec.ts`
- Modify: `docs/plans/2026-10-01-authz-v3-design.md` (§17 rows B06, B09, B15, B20, B21, B44)
- Test: `packages/authz-testing/test/behaviour/lanes.test.ts` (L21 `FILLED`, L180-186, L257-286, L433), `test/behaviour/models.test.ts:87`

**Interfaces:**
- Consumes: Task 1 (`staticModel(..., { lists })`, `allRows`, `ownedRows`, `noRows`).
- Produces (consumer harnesses implement these): 

```ts
export interface OrmModelSpec {
  readonly name: string;
  readonly type?: ResourceType;                 // @AccessResource(type)
  readonly owner?: string;                      // @Owner() column
  readonly parents?: readonly { readonly column: string; readonly type: ResourceType; readonly nullable?: boolean }[]; // @Parent
  readonly columns: readonly string[];
  readonly rows?: readonly FakeRow[];
}
export type OrmQuery =
  | { op: 'select'; model: string; where?: Record<string, unknown>; accessible?: Permission; withAccess?: readonly Permission[] }
  | { op: 'insert'; model: string; values: Record<string, unknown> }
  | { op: 'update'; model: string; where: Record<string, unknown>; values: Record<string, unknown>; accessible?: Permission }
  | { op: 'delete'; model: string; where: Record<string, unknown>; accessible?: Permission };
export interface OrmResult { ids?: readonly string[]; count?: number; sql: readonly string[]; access?: Record<string, Record<Permission, boolean>> }
```

  (all fields `readonly` in the code below). Exports of `B20-orm-access.spec.ts`: `alice`, `bob`, `TASK`, `ALL`, `ormWorld(votes, lists?, models?, extra?)`.

- [ ] **Step 1: Write the failing lane tests**

In `packages/authz-testing/test/behaviour/lanes.test.ts` replace the two `it` blocks at L257-286 (`'orm: runs the query, compares ids, count and WHERE, and the thrown reason'` and `'orm: compares populated exactly, null included (RFC L4-1)'`) with:

```ts
    it('orm: runs the query, compares ids, count, access and the thrown reason', async () => {
      const seen: OrmQuery[] = [];
      const access = { a: { 'task:update': true }, b: { 'task:update': false } };
      const res = { ids: ['b', 'a'], count: 2, sql: ['select 1'], access };
      const c = ctx({ orm: { run: async (q) => (seen.push(q), res), rows: async () => [{ id: 't1', title: 'a', owner: 'alice' }] } });
      const q = { op: 'select', model: 'Task', accessible: 'task:read', withAccess: ['task:update'] } as const;
      await run(orm(q, { ids: ['a', 'b'], count: 2, access }), c);
      assert.deepEqual(seen, [q]);
      await fails(orm(q, { access: { a: { 'task:update': true } } }), c, /access/);
      await fails(orm(q, { ids: ['a'] }), c, /ids/);
      await fails(orm(q, { throws: 'AccessDenied' }), c, /expected a throw of AccessDenied/);
      await run(ormRows('Task', { ids: ['t1'], rows: [{ id: 't1', owner: 'alice' }] }), c);
      await fails(ormRows('Task', { rows: [{ id: 't1', owner: 'bob' }] }), c, /row t1/);

      const denied = new AccessDenied({ allowed: false, permission: 'task:read', resource: { type: 'task' }, principal: UNATTENDED, residual: FALSE, fields: { read: [], write: [] }, roles: {}, domain: 'root', reason: { code: 'unattended' } });
      const d = ctx({ orm: { run: async () => Promise.reject(denied), rows: async () => [] } });
      await run(orm(q, { throws: 'AccessDenied', reason: 'unattended' }), d);
      await run(orm(q, { throws: 'Forbidden' }), d);
      await fails(orm(q, { throws: 'AccessDenied', reason: 'no_access' }), d, /decision.reason.code/);
      await assert.rejects(run(orm(q, {}), d), /Access denied/);
    });
```

In the same file: L21 `FILLED` drop `'B05.orm'`, `'B22.orm'` and `'B39.orm'`; in the test at L180-186 change the expected first call to

```ts
      assert.deepEqual(first, { what: 'orm', as: 'user:alice', args: { op: 'select', model: 'Task', accessible: 'task:read' } });
```

and in the type-check source at L433 replace the `OrmModelSpec` literal with

```ts
`const lane: LaneWorld = { orm: { models: [{ name: 'Org', type: 'org', columns: ['parent_id'], parents: [{ column: 'parent_id', type: 'org', nullable: true }] } satisfies OrmModelSpec] } };
```

In `packages/authz-testing/test/behaviour/models.test.ts:87` replace `['B06.rules', 'B06.rulesSql', 'B44.config', 'B44.db']` with `['B06.rules']`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd packages/authz-testing && npx ts-mocha -p tsconfig.json test/behaviour/lanes.test.ts`
Expected: FAIL, TS2353 `Object literal may only specify known properties, and 'accessible' does not exist in type 'OrmQuery'`.

- [ ] **Step 3: The lane contract**

In `packages/authz-testing/src/behaviour/lane.ts`:

Delete `OrmScopeSpec` and `OrmJunctionSpec` (L84-103) and replace `OrmModelSpec`, `OrmWorld` and `OrmQuery` (L104-133) with:

```ts
/**
 * An ORM model; with `type` it carries `@AccessResource(type)`. Primary key `id`, every column text.
 * A harness inserts the rows through the ORM as SYSTEM, in `OrmWorld.models` order, so the closure table is right:
 * a parent model comes before its children.
 */
export interface OrmModelSpec {
  readonly name: string;
  readonly type?: ResourceType;
  /** The `@Owner()` column. */
  readonly owner?: string;
  /** `@Parent(type, { nullable })` columns. */
  readonly parents?: readonly { readonly column: string; readonly type: ResourceType; readonly nullable?: boolean }[];
  /** Columns besides `id`. */
  readonly columns: readonly string[];
  readonly rows?: readonly FakeRow[];
}

export interface OrmWorld {
  readonly models: readonly OrmModelSpec[];
}

/**
 * `model` names a model of `World.lane.orm` or one a lane package registers (`DbConfig`, `JobModel`).
 * `accessible` adds `.accessible(permission)`; `withAccess` adds `.withAccess(permissions)` to a select.
 */
export type OrmQuery =
  | { readonly op: 'select'; readonly model: string; readonly where?: Readonly<Record<string, unknown>>; readonly accessible?: Permission; readonly withAccess?: readonly Permission[] }
  | { readonly op: 'insert'; readonly model: string; readonly values: Readonly<Record<string, unknown>> }
  | { readonly op: 'update'; readonly model: string; readonly where: Readonly<Record<string, unknown>>; readonly values: Readonly<Record<string, unknown>>; readonly accessible?: Permission }
  | { readonly op: 'delete'; readonly model: string; readonly where: Readonly<Record<string, unknown>>; readonly accessible?: Permission };
```

Replace `OrmResult` (L236-245) with:

```ts
export interface OrmResult {
  /** Primary keys of the rows a select returned. */
  readonly ids?: readonly string[];
  /** Rows a select returned, or rows an update or delete reached. */
  readonly count?: number;
  /** Every SQL statement the query executed, in order. */
  readonly sql: readonly string[];
  /** A select with `withAccess`: per row id, the `$access` map it carried. */
  readonly access?: Readonly<Record<string, Readonly<Record<Permission, boolean>>>>;
}
```

Replace the `// --- orm` block from `export interface OrmExpectation` through the end of `export const orm` (L522-561, including `const WHERE`) with:

```ts
export interface OrmExpectation {
  /** Exactly these ids, any order. */
  readonly ids?: readonly string[];
  readonly count?: number;
  /** Exactly `OrmResult.access`. */
  readonly access?: Readonly<Record<string, Readonly<Record<Permission, boolean>>>>;
}

export const orm = (q: OrmQuery, expect: OrmExpectation | LaneThrows): DoStep => {
  const where = 'where' in q && q.where ? ` ${short(q.where)}` : '';
  const accessible = 'accessible' in q && q.accessible ? ` accessible ${q.accessible}` : '';
  const withAccess = 'withAccess' in q && q.withAccess ? ` withAccess ${q.withAccess.join(',')}` : '';
  const note = `orm ${q.op} ${q.model}${where}${accessible}${withAccess}`;
  return {
    note,
    do: async (ctx) => {
      const res = await settle(() => laneHandle(ctx, 'orm').run(q), expect, note);
      if (res.threw) return;
      const e = expect as OrmExpectation;
      if (e.ids) assert.deepEqual([...(res.value.ids ?? [])].sort(), [...e.ids].sort(), `${note}: ids`);
      if (e.count !== undefined) assert.equal(res.value.count, e.count, `${note}: count`);
      if (e.access !== undefined) assert.deepEqual(res.value.access, e.access, `${note}: access`);
    },
  };
};
```

The `OrmHandle` comment (L247) becomes:

```ts
/** orm facet: queries run in the current ALS (as `authz().current()`); `rows` reads a table raw, without the guard. */
```

`Permission` is already in the `@spinajs/authz` type import (L4).

In `packages/authz-testing/src/behaviour/types.ts` replace the `orm:` entry of `FACETS`:

```ts
  orm: "ORM queries on the models of `world.lane.orm` (lane handle `orm`): `@AccessResource(type)`, `@Owner()` and `@Parent` as each spec says, rows inserted through the ORM as SYSTEM in model order, so `authz_resource_ancestor` is right. Queries run in the current ALS. The app env is `test`: a multi-row select on an `@AccessResource` model without `.accessible()`, `.unscoped(reason)` or `runAs(SYSTEM)` throws `AuthzConfigError` (design 2026-10-14 §8).",
```

- [ ] **Step 4: B20 over `.accessible()`**

Create `packages/authz-testing/src/behaviour/B20-orm-access.spec.ts`:

```ts
import { SYSTEM } from '@spinajs/authz';
import type { Permission } from '@spinajs/authz';

import type { ListPlanScript, VoteTable } from '../fakes/index.js';
import { userPrincipal } from '../principals.js';
import { allRows, combine, fixture, noRows, ownedRows, permit, relation, staticModel } from './dsl.js';
import { as, orm, ormRows } from './lane.js';
import type { OrmModelSpec, OrmQuery } from './lane.js';
import type { Case, World } from './types.js';

export const alice = userPrincipal('alice');
export const bob = userPrincipal('bob');
const admin = userPrincipal('admin');

/** `@AccessResource('task')` with `@Owner() owner`. alice owns t1 and t3, bob t2. */
export const TASK: OrmModelSpec = {
  name: 'Task',
  type: 'task',
  owner: 'owner',
  columns: ['title', 'owner'],
  rows: [
    { id: 't1', title: 'a', owner: 'alice' },
    { id: 't2', title: 'b', owner: 'bob' },
    { id: 't3', title: 'c', owner: 'alice' },
  ],
};

export const ALL = ['t1', 't2', 't3'];

/** One kit model m1; task:read, task:update and task:delete are list permissions. */
export const ormWorld = (votes: VoteTable, lists: Readonly<Record<Permission, ListPlanScript>> = {}, models: readonly OrmModelSpec[] = [TASK], extra: Partial<World> = {}): World => ({
  permissions: [{ name: 'task:read', list: true }, { name: 'task:update', list: true }, { name: 'task:delete', list: true }, 'task:create'],
  principals: { alice, bob, admin },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes, lists })],
  lane: { orm: { models } },
  ...extra,
});

const select = (accessible?: Permission): OrmQuery => ({ op: 'select', model: 'Task', ...(accessible ? { accessible } : {}) });
const OWNER_READ = { 'task:read': permit(relation('owner')) };
const OWNER_READ_LIST = { 'task:read': ownedRows() };
const NOT_CALLED = { calls: { model: 'm1', count: 0 } } as const;
const NOT_PLANNED = { calls: { model: 'm1', method: 'listPlan', count: 0 } } as const;

const selects: Case[] = [
  { name: 'select: a permit without a condition lists every row', world: ormWorld({ 'task:read': permit() }, { 'task:read': allRows() }), steps: [as('alice', orm(select('task:read'), { ids: ALL }))] },
  {
    name: 'select: an owner permit lists the rows whose owner column holds the principal',
    world: ormWorld(OWNER_READ, OWNER_READ_LIST),
    steps: [as('alice', orm(select('task:read'), { ids: ['t1', 't3'] })), as('bob', orm(select('task:read'), { ids: ['t2'] }))],
  },
  { name: 'select: no permit at all throws AccessDenied, not an empty list (H16)', world: ormWorld({}, { 'task:read': noRows() }), steps: [as('alice', orm(select('task:read'), { throws: 'AccessDenied', reason: 'no_access' }))] },
  { name: '.accessible() of a permission that is not list: true throws AuthzConfigError', world: ormWorld({ 'task:create': permit() }), steps: [as('alice', orm(select('task:create'), { throws: 'AuthzConfigError' }))] },
  { name: 'select: without .accessible() a query as a principal is refused by the runtime guard', world: ormWorld(OWNER_READ, OWNER_READ_LIST), steps: [as('alice', orm(select(), { throws: 'AuthzConfigError' })), NOT_CALLED, NOT_PLANNED] },
  {
    name: 'select: under runAs(SYSTEM) a query without .accessible() reads every row and consults no model',
    world: ormWorld(OWNER_READ, OWNER_READ_LIST),
    steps: [{ runAs: { as: SYSTEM, reason: 'test' }, steps: [orm(select(), { ids: ALL })] }, NOT_CALLED, NOT_PLANNED],
  },
  {
    name: 'select: .withAccess() carries per row what a check of the row answers',
    world: ormWorld({ 'task:read': permit(), 'task:update': permit(relation('owner')) }, { 'task:read': allRows(), 'task:update': ownedRows() }),
    steps: [as('alice', orm({ op: 'select', model: 'Task', accessible: 'task:read', withAccess: ['task:update'] }, { ids: ALL, access: { t1: { 'task:update': true }, t2: { 'task:update': false }, t3: { 'task:update': true } } }))],
  },
];

const writes: Case[] = [
  {
    name: 'update: .accessible() limits a bulk update to the rows the plan selects',
    world: ormWorld({ 'task:update': permit(relation('owner')) }, { 'task:update': ownedRows() }),
    steps: [as('alice', orm({ op: 'update', model: 'Task', where: {}, values: { title: 'z' }, accessible: 'task:update' }, {})), ormRows('Task', { rows: [{ id: 't1', title: 'z' }, { id: 't2', title: 'b' }, { id: 't3', title: 'z' }] })],
  },
  {
    name: 'delete: .accessible() limits a bulk delete the same way',
    world: ormWorld({ 'task:delete': permit(relation('owner')) }, { 'task:delete': ownedRows() }),
    steps: [as('bob', orm({ op: 'delete', model: 'Task', where: {}, accessible: 'task:delete' }, {})), ormRows('Task', { ids: ['t1', 't3'] })],
  },
  {
    name: 'insert: the ORM authorizes no insert; the app checks the parent first (design 2026-10-14 §6.1)',
    world: ormWorld({}),
    steps: [as('alice', orm({ op: 'insert', model: 'Task', values: { id: 't9', title: 'n', owner: 'bob' } }, {})), ormRows('Task', { ids: [...ALL, 't9'] }), NOT_CALLED],
  },
];

// configuration-http registers DbConfig with registerAccessResource(DbConfig, 'configuration'); its harness declares configuration:read with list: true.
const configWorld: World = {
  permissions: [],
  principals: { alice, admin },
  combine: combine('deny-overrides', 'm1'),
  models: [
    staticModel('m1', {
      votes: (req) => (req.principal.id === 'admin' && req.permission === 'configuration:read' ? permit() : {}),
      lists: { 'configuration:read': (p) => (p.id === 'admin' ? allRows() : noRows()) },
    }),
  ],
  lane: {
    configuration: {
      rows: [
        { path: 'app.title', value: 'T' },
        { path: 'app.theme', value: 'dark' },
      ],
    },
  },
};

const CONFIG_LIST: OrmQuery = { op: 'select', model: 'DbConfig', accessible: 'configuration:read' };

export const B20 = fixture('B20', [
  {
    name: 'orm',
    facets: ['engine', 'host', 'orm'],
    lanes: ['L5'],
    note: 'Lists through .accessible(), per-row access through .withAccess(), the runtime guard (test env) and runAs(SYSTEM) (design 2026-10-14 §6.2, §8, §10.3).',
    cases: [...selects, ...writes],
  },
  {
    name: 'configuration',
    facets: ['engine', 'host', 'orm', 'configuration'],
    lanes: ['L5'],
    world: configWorld,
    cases: [
      { name: 'DbConfig: no permit is AccessDenied', steps: [as('alice', orm(CONFIG_LIST, { throws: 'AccessDenied' }))] },
      { name: 'DbConfig: configuration:read lists every row', steps: [as('admin', orm(CONFIG_LIST, { count: 2 }))] },
      { name: 'DbConfig: without a principal the list is refused (unattended)', steps: [orm(CONFIG_LIST, { throws: 'AccessDenied', reason: 'unattended' })] },
    ],
  },
]);
```

Run: `git rm packages/authz-testing/src/behaviour/B20-orm-scoping.spec.ts packages/authz-testing/src/behaviour/B05-orm.spec.ts packages/authz-testing/src/behaviour/B22-orm.spec.ts packages/authz-testing/src/behaviour/B39-orm.spec.ts`

- [ ] **Step 5: B21**

Replace `packages/authz-testing/src/behaviour/B21-orm-models.spec.ts` with:

```ts
import { fixture, ownedRows, permit, relation } from './dsl.js';
import { as, orm } from './lane.js';
import type { OrmModelSpec } from './lane.js';
import { TASK, ormWorld } from './B20-orm-access.spec.js';

/** No @AccessResource. */
const NOTE: OrmModelSpec = {
  name: 'Note',
  columns: ['text'],
  rows: [
    { id: 'n1', text: 'x' },
    { id: 'n2', text: 'y' },
  ],
};
/** A second model of type 'task'. */
const ARCHIVE: OrmModelSpec = {
  ...TASK,
  name: 'TaskArchive',
  rows: [
    { id: 'a1', title: 'old', owner: 'alice' },
    { id: 'a2', title: 'old', owner: 'bob' },
  ],
};

const OWNER = { 'task:read': permit(relation('owner')) };
const OWNER_LIST = { 'task:read': ownedRows() };

export const B21 = fixture('B21', [
  {
    name: 'orm',
    facets: ['engine', 'host', 'orm'],
    lanes: ['L5'],
    cases: [
      {
        name: 'a model without @AccessResource is never checked nor guarded, also without a principal',
        world: ormWorld({}, {}, [TASK, NOTE]),
        steps: [orm({ op: 'select', model: 'Note' }, { ids: ['n1', 'n2'] }), as('alice', orm({ op: 'select', model: 'Note' }, { ids: ['n1', 'n2'] })), { calls: { model: 'm1', count: 0 } }],
      },
      {
        name: 'several models may share a type, each filtered by .accessible() alike',
        world: ormWorld(OWNER, OWNER_LIST, [TASK, ARCHIVE]),
        steps: [as('alice', orm({ op: 'select', model: 'Task', accessible: 'task:read' }, { ids: ['t1', 't3'] }), orm({ op: 'select', model: 'TaskArchive', accessible: 'task:read' }, { ids: ['a1'] }))],
      },
    ],
  },
]);
```

- [ ] **Step 6: B09 lane parts, B30, retired parts**

In `packages/authz-testing/src/behaviour/B09-lanes.spec.ts`:

- imports: `import { TASK, ormWorld } from './B20-orm-access.spec.js';` and add `allRows, ownedRows` to the `./dsl.js` import;
- after `const SELECT …` add `const ACCESSIBLE: OrmQuery = { op: 'select', model: 'Task', accessible: 'task:read' };` and `const NOT_PLANNED = { calls: { model: 'm1', method: 'listPlan', count: 0 } } as const;`
- replace `ormPart`, `httpWorld`, `httpPart` and `socketPart` with:

```ts
const ormPart: FixturePart = {
  name: 'orm',
  facets: ['engine', 'host', 'audit', 'orm'],
  lanes: ['L5'],
  world: ormWorld({ 'task:read': permit(relation('owner')) }, { 'task:read': ownedRows() }, [TASK], { config: AUDIT }),
  cases: [
    { name: '.accessible() without a principal throws AccessDenied (unattended) and asks no model', steps: [orm(ACCESSIBLE, UNATTENDED_DENIED), NOT_CALLED, NOT_PLANNED] },
    {
      name: 'under runAs(SYSTEM, reason) a select reads every row, consults no model and the bypass is audited',
      steps: [{ runAs: { as: SYSTEM, reason: 'cli' }, steps: [orm(SELECT, { ids: ALL })] }, NOT_CALLED, NOT_PLANNED, { audit: { kind: 'runAs', reason: 'cli' } }],
    },
  ],
};

const httpWorld: World = {
  ...ormWorld({ 'task:read': permit(relation('owner')) }, { 'task:read': ownedRows() }, [TASK], { config: AUDIT }),
  lane: {
    orm: { models: [TASK] },
    http: { routes: [{ method: 'GET', path: '/tasks', access: { permission: 'task:read' }, handler: { orm: ACCESSIBLE } }] },
  },
};

const httpPart: FixturePart = {
  name: 'http',
  facets: ['engine', 'audit', 'http', 'orm'],
  lanes: ['L5'],
  world: httpWorld,
  cases: [{ name: "a route's .accessible() list runs as the request principal", steps: [http({ method: 'GET', path: '/tasks', as: 'alice' }, { status: 200, body: { ids: ['t1', 't3'] }, none: [{ at: 'ids', match: 't2' }] })] }],
};

const socketPart: FixturePart = {
  name: 'socket',
  facets: ['engine', 'orm', 'socket'],
  lanes: ['C9'],
  world: { ...ormWorld({ 'task:read': permit() }, { 'task:read': allRows() }), lane: { orm: { models: [TASK] }, socket: { handlers: [{ event: 'tasks', orm: ACCESSIBLE }] } } },
  cases: [{ name: 'a socket handler without a principal source fails closed on .accessible()', steps: [laneCall('emit tasks', (ctx) => laneHandle(ctx, 'socket').emit('tasks'), UNATTENDED_DENIED), NOT_CALLED] }],
};
```

In `packages/authz-testing/src/behaviour/B30-queue.spec.ts` (L79-84) the status world grants `job:read` on the owner relation:

```ts
// job:read on the owner relation (the initiator columns) for users, unconditional for carol (design 2026-10-14 §6.3).
const statusWorld: World = {
  permissions: [],
  principals: { alice, bob, carol },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: (req) => (req.permission !== 'job:read' ? {} : req.principal.id === 'carol' ? permit() : permit(relation('owner'))) })],
  lane: { queue: { records: [{ id: 'j1', job: 'export', initiator: ALICE, status: 'success' }] } },
};
```

Retired parts keep their place with a note (each `cases: []`):

- `B05-boot-checks.spec.ts`, part `orm` (L107-111): `note: 'Rule 6 (relationScope) went with query rewriting (design 2026-10-14 §9). Boot rule 12 (list permissions) is covered by authz-orm/test/e2e (L9).'`, `lanes: ['L9']`.
- `B22-filter-now.spec.ts:91`: `note: 'Query scoping went with query rewriting (design 2026-10-14 §9); no ORM path calls filterNow.'`, `lanes: ['L5']`.
- `B39-scope-attributes.spec.ts:174`: `note: 'Scope attributes no longer come from @AccessResource columns: the scope resolver and authz_scope_attribute supply them (design 2026-10-14 §5).'`, `lanes: ['L5']`.
- `B09-unattended-system.spec.ts:52`: `later('orm', ['orm'], ['L5'], 'Filled by the orm part of B09-lanes.spec.ts: .accessible() without a principal throws; runAs(SYSTEM) bypasses the guard.')`.
- `B15-relations.spec.ts:111` note: replace "`@Owner and @OrmScope (L4)`" with "`@Owner (authz-orm)`" and "`job initiator (L6)`" with "`the job owner (authz-queue)`".
- `B06-check-filter.spec.ts`: delete the part `sql` and its `sqlCases` cache and the `rulesSql` part (Task 4 adds the `accessible` part); delete `agreeCases` only if nothing else uses it (`grep -n "agreeCases" packages/authz-testing/src`).
- `B06-check-filter-rules.spec.ts`: delete the part `rulesSql` (L23 onwards to the end of that part).
- `B44-rules-sql.spec.ts`: replace the whole file (first check `grep -rn "B44-rules-sql" packages/*/src packages/*/test` lists only `catalogue-models.ts`; L7 removes authz-rbac's consumers):

```ts
import { fixture } from './dsl.js';

export const B44 = fixture('B44', [
  {
    name: 'retired',
    facets: ['engine'],
    lanes: ['L5'],
    note: 'Retired with query rewriting (design 2026-10-14 §9): RBAC rules are check-only, and boot rule 12 refuses a list: true permission on a type with a cap, restrict or threshold rule.',
    cases: [],
  },
]);
```

`catalogue-lanes.ts`: drop the imports and entries `B05Orm`, `B22Orm`, `B39Orm`; change `'./B20-orm-scoping.spec.js'` to `'./B20-orm-access.spec.js'`.

- [ ] **Step 7: Rule texts, in both places**

In `packages/authz-testing/src/behaviour/rules.ts` replace these entries; then replace the same rows of the `## 17. Behaviour spec` table in `docs/plans/2026-10-01-authz-v3-design.md` (`| B06 | … |` etc.) with exactly the same text, and add under that section's heading the line `Rows B06, B09, B15, B20, B21 and B44 were rewritten by docs/plans/2026-10-14-authz-resource-access-design.md.` (outside the table):

```ts
  B06: '(r2) Without a subject a conditional permit returns `allowed: true` with a non-`TRUE` residual; with a subject the residual is evaluated and the answer is definite. For every row r: `check(subject = r).allowed` ⇔ r ∈ rows(`filter`) in memory; over the ORM, `.accessible(p)` returns exactly the rows `checkAll` definitely allows, and `.withAccess` answers what `checkAll` answers.',
  B09: "No principal ⇒ `UNATTENDED`: every check denies (`unattended`), and so does `.accessible()` (`AccessDenied`). `runAs(SYSTEM, reason)`, `@Job({ runAs: 'system' })` and `@Unscoped(reason)` are the only bypasses; `SYSTEM` consults no model; each bypass is audited with its reason.",
  B15: "A grant with relation R ⇒ residual `relation(R)`; several relations OR; a grant without relation ⇒ unconditional; relations resolve through the type's `RelationResolver` (the `@Owner` column, `self`, file metadata).",
  B20: '(r2) `.accessible(p)` on an `@AccessResource` select, update or delete filters by the access plan: `all` ⇒ no filter; `filter` ⇒ the fixed EXISTS shape; `none` ⇒ `AccessDenied` (a list with no permit at all is 403, not an empty list, H16); `p` not `list: true` ⇒ `AuthzConfigError`. In the test env a multi-row select with none of `.accessible()`, `.unscoped(reason)`, `runAs(SYSTEM)` throws `AuthzConfigError`; a select on one primary key is a single-object load and passes. `.withAccess(ps)` adds `$access` per row. The ORM authorizes no insert.',
  B21: 'A model without `@AccessResource` is never checked nor guarded; several models may share a type, each filtered by `.accessible()` alike; `populate()` and relations are not filtered (authorize the aggregate root).',
  B44: '(retired) Lists on types with RBAC rules were pure SQL; rules are now check-only, and boot rule 12 refuses a `list: true` permission on a type with rules.',
```

- [ ] **Step 8: Run the package tests**

Run: `cd packages/authz-testing && npm test`
Expected: `0 failing`. If worlds.test.ts reports a rule text mismatch, the design table row and `rules.ts` differ by a character: copy `rules.ts` into the table again.

- [ ] **Step 9: Commit**

```bash
git add -A packages/authz-testing/src/behaviour packages/authz-testing/test/behaviour docs/plans/2026-10-01-authz-v3-design.md
git commit -m "refactor(authz-testing): orm lane over .accessible(); retire query-scoping fixtures"
```

---

### Task 3: authz-testing: remove the canvas SQL list harness

Design §9 deletes the canvas-c6 ORM tests. Only the SQL list half uses the removed compiler; the canvas check conformance (B40, in memory and on the DB stores) stays.

**Files:**
- Delete: `packages/authz-testing/test/canvas-c6/sql-harness.ts`, `list.ts`, `list.test.ts`
- Modify: `packages/authz-testing/test/canvas-c6/mismatches.ts`, `config.ts:60,229`, `config.test.ts:125-130`

- [ ] **Step 1: Check what L7 left**

Run: `ls packages/authz-testing/test/canvas-c6`
Expected: the directory exists with `sql-harness.ts`. If L7 already deleted the whole directory, skip to Step 5 (only the commit is skipped too).

- [ ] **Step 2: Delete the SQL list files**

```bash
git rm packages/authz-testing/test/canvas-c6/sql-harness.ts packages/authz-testing/test/canvas-c6/list.ts packages/authz-testing/test/canvas-c6/list.test.ts
```

- [ ] **Step 3: Edit what referenced them**

In `mismatches.ts` remove the `import type { CanvasSqlKind } from './sql-harness.js';` line and the `LIST_MISMATCHES` export with its `KnownListMismatch` type (both were used only by `list.ts`; confirm with `grep -rn "LIST_MISMATCHES\|KnownListMismatch\|CanvasSqlKind" packages/authz-testing/test`).

`scopeResiduals` goes with L10. In `config.ts` change L60 to `abac: { policies: CanvasPolicy[] };` and L229 to `abac: { policies: canvasPolicies() },`. In `config.test.ts` replace the test at L125-130 with:

```ts
    it('has the agents-disabled policy', () => {
      expect(config.abac).to.deep.equal({
        policies: [{ id: 'agents-disabled', effect: 'deny', actorTypes: ['agent'], permissions: ['*'], when: { attr: 'scope.org.policies.agents_allowed', eq: false }, reason: 'agents_disabled', priority: 100 }],
      });
    });
```

- [ ] **Step 4: Nothing else imports authz-orm's removed names**

Run: `grep -rnE "OrmScope|ScopeColumn|compileResidual|relationPrincipalOf|authz-orm/lib" packages/authz-testing/test packages/authz-testing/src`
Expected: no output. (`DbScopeAttributeStore` in `harness.ts` stays: design §9 keeps scope attributes in the new authz-orm; `grep -n "export class DbScopeAttributeStore" packages/authz-orm/src -r` must find it.)

- [ ] **Step 5: Run the package tests**

Run: `cd packages/authz-testing && npm test`
Expected: `0 failing`.

- [ ] **Step 6: Commit**

```bash
git add -A packages/authz-testing/test/canvas-c6
git commit -m "test(authz-testing): drop the canvas SQL list harness (residual compiler removed)"
```

---

### Task 4: authz-testing: B06 over `.accessible()` and the `accessWorld` arbitrary

**Files:**
- Modify: `packages/authz-testing/src/behaviour/lane.ts` (new step after `ormRows`)
- Modify: `packages/authz-testing/src/behaviour/B06-check-filter.spec.ts` (new part `accessible`)
- Modify: `packages/authz-testing/src/arbitraries/rbac.ts` (`TestRoleDef.deny`)
- Create: `packages/authz-testing/src/arbitraries/access.ts`; modify `src/arbitraries/index.ts`
- Test: `packages/authz-testing/test/access-world.test.ts`

**Interfaces:**
- Consumes: `OrmHandle`, `BehaviourAuthz.checkAll` / `runAs`.
- Produces: `laneSteps.accessibleAgree({ as, permissions, model, type })`; `arb.accessWorld(opts?) : fc.Arbitrary<AccessWorld>` with `AccessWorld = { world: World; users: readonly string[]; models: { org: 'Org'; project: 'Project'; doc: 'Doc' } }`; constants `ACCESS_ROLES`, `ACCESS_PERMISSIONS`. L9 runs both against the real stack.

- [ ] **Step 1: Write the failing test**

`packages/authz-testing/test/access-world.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import * as fc from 'fast-check';

import { ACCESS_PERMISSIONS, ACCESS_ROLES, arb, validateWorld } from '../src/index.js';

describe('arb.accessWorld', () => {
  it('builds valid worlds whose rows only point at earlier parents', () => {
    fc.assert(
      fc.property(arb.accessWorld(), ({ world, users }) => {
        validateWorld(world);
        const [org, project, doc] = world.lane!.orm!.models;
        expect([org.name, project.name, doc.name]).to.deep.equal(['Org', 'Project', 'Doc']);
        const orgs = new Set((org.rows ?? []).map((r) => r.id));
        const projects = new Set((project.rows ?? []).map((r) => r.id));
        for (const r of project.rows ?? []) expect(orgs.has(r.org_id as string)).to.equal(true);
        for (const r of doc.rows ?? []) {
          expect(projects.has(r.project_id as string)).to.equal(true);
          expect(users).to.include(r.owner);
        }
        for (const a of world.rbac!.assignments ?? []) expect(Object.keys(ACCESS_ROLES)).to.include(a.role);
        expect(world.permissions).to.deep.equal(ACCESS_PERMISSIONS);
      }),
      { numRuns: 50 },
    );
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd packages/authz-testing && npx ts-mocha -p tsconfig.json test/access-world.test.ts`
Expected: FAIL, TS2305 `has no exported member 'ACCESS_PERMISSIONS'`.

- [ ] **Step 3: Implement the arbitrary**

`packages/authz-testing/src/arbitraries/rbac.ts`, in `TestRoleDef` after `subjectSet`:

```ts
  /** A deny role (design 2026-10-14 §4.2). */
  readonly deny?: boolean;
```

`packages/authz-testing/src/arbitraries/access.ts`:

```ts
import * as fc from 'fast-check';

import { GLOBAL } from '@spinajs/authz';
import type { Assignment, ResourceRef } from '@spinajs/authz';

import type { OrmModelSpec } from '../behaviour/lane.js';
import type { World } from '../behaviour/types.js';
import type { FakePermissionInput } from '../registry.js';
import { userPrincipal } from '../principals.js';
import type { TestRoleDef } from './rbac.js';

export const ACCESS_PERMISSIONS: readonly FakePermissionInput[] = Object.freeze([
  { name: 'doc:read', list: true },
  { name: 'doc:update', list: true },
  { name: 'project:read', list: true },
]);

const role = (name: string, grants: TestRoleDef['grants'], extra: Partial<TestRoleDef> = {}): TestRoleDef => ({ name, extends: [], assignable: true, source: 'test', grants, ...extra });

/** viewer < editor by grants; author reads its own docs; blocked denies reading at its scope and below. */
export const ACCESS_ROLES: Readonly<Record<string, TestRoleDef>> = Object.freeze({
  viewer: role('viewer', [{ permission: 'doc:read' }, { permission: 'project:read' }]),
  editor: role('editor', [{ permission: 'doc:read' }, { permission: 'doc:update' }, { permission: 'project:read' }]),
  author: role('author', [{ permission: 'doc:read', relation: 'owner' }, { permission: 'doc:update', relation: 'owner' }]),
  blocked: role('blocked', [{ permission: 'doc:read' }], { deny: true }),
});

export interface AccessWorld {
  readonly world: World;
  /** User ids of `world.principals`. */
  readonly users: readonly string[];
}

export interface AccessWorldOptions {
  readonly now?: Date;
  readonly maxDocs?: number;
}

const USERS = ['alice', 'bob', 'carol'] as const;

/**
 * Random org > project > doc data (`@Parent` chains, `@Owner` on docs) and RBAC assignments of ACCESS_ROLES at
 * $global, org, project or doc scope, to a user or to `user:*`, live, expired or expiring later. Combined
 * deny-overrides over the model 'rbac'. B06 over the ORM holds for every such world.
 */
export function accessWorld(opts: AccessWorldOptions = {}): fc.Arbitrary<AccessWorld> {
  const now = opts.now ?? new Date('2026-10-14T12:00:00.000Z');
  const past = new Date(now.getTime() - 3_600_000);
  const later = new Date(now.getTime() + 3_600_000);
  const shape = fc.record({
    projects: fc.array(fc.constantFrom('o1', 'o2'), { minLength: 1, maxLength: 3 }),
    docs: fc.array(fc.record({ project: fc.nat(), owner: fc.constantFrom(...USERS) }), { maxLength: opts.maxDocs ?? 6 }),
  });
  return shape.chain(({ projects, docs }) => {
    const projectIds = projects.map((_, i) => `p${i + 1}`);
    const docRows = docs.map((d, i) => ({ id: `d${i + 1}`, project_id: projectIds[d.project % projectIds.length], owner: d.owner }));
    const scopes: ResourceRef[] = [GLOBAL, { type: 'org', id: 'o1' }, { type: 'org', id: 'o2' }, ...projectIds.map((id) => ({ type: 'project', id })), ...docRows.map((d) => ({ type: 'doc', id: d.id }))];
    const grant = fc.record({
      subject: fc.constantFrom<string>(...USERS, '*'),
      role: fc.constantFrom(...Object.keys(ACCESS_ROLES)),
      scope: fc.constantFrom(...scopes),
      expires: fc.constantFrom<'never' | 'past' | 'later'>('never', 'never', 'past', 'later'),
    });
    return fc.array(grant, { maxLength: 8 }).map((grants): AccessWorld => {
      const assignments: Assignment[] = grants.map((g, i) => ({
        id: `a${i + 1}`,
        subject: { type: 'user', id: g.subject },
        role: g.role,
        scope: g.scope,
        source: 'test',
        ...(g.expires === 'never' ? {} : { expiresAt: g.expires === 'past' ? past : later }),
      }));
      const models: OrmModelSpec[] = [
        { name: 'Org', type: 'org', columns: [], rows: [{ id: 'o1' }, { id: 'o2' }] },
        { name: 'Project', type: 'project', parents: [{ column: 'org_id', type: 'org' }], columns: ['org_id'], rows: projects.map((org, i) => ({ id: projectIds[i], org_id: org })) },
        { name: 'Doc', type: 'doc', owner: 'owner', parents: [{ column: 'project_id', type: 'project' }], columns: ['project_id', 'owner'], rows: docRows },
      ];
      return {
        users: USERS,
        world: {
          now,
          permissions: ACCESS_PERMISSIONS,
          principals: Object.fromEntries(USERS.map((u) => [u, userPrincipal(u)])),
          combine: { default: { algorithm: 'deny-overrides', models: ['rbac'] } },
          rbac: { roles: Object.values(ACCESS_ROLES), assignments },
          lane: { orm: { models } },
        },
      };
    });
  });
}
```

`packages/authz-testing/src/arbitraries/index.ts`: add `export * from './access.js';`. `packages/authz-testing/src/index.ts`: add `export { ACCESS_PERMISSIONS, ACCESS_ROLES } from './arbitraries/access.js';` and `export type { AccessWorld, AccessWorldOptions } from './arbitraries/access.js';` (the namespace `arb` already carries `accessWorld`).

- [ ] **Step 4: The `accessibleAgree` lane step**

In `packages/authz-testing/src/behaviour/lane.ts`, after `ormRows`:

```ts
export interface AccessibleAgreeRequest {
  readonly as: readonly Who[];
  /** Each must be list: true; also the `.withAccess` set. */
  readonly permissions: readonly Permission[];
  readonly model: string;
  readonly type: ResourceType;
}

/**
 * B06 over the ORM: for each principal and permission, `.accessible(permission)` returns exactly the rows `checkAll`
 * definitely allows (allowed with a TRUE residual), and `.withAccess(permissions)` carries what `checkAll` answers.
 * A list that throws AccessDenied agrees when `checkAll` allows no row.
 */
export const accessibleAgree = (req: AccessibleAgreeRequest): DoStep => ({
  note: `accessible ⇔ checkAll on ${req.model} for ${req.as.map((w) => (typeof w === 'string' ? w : principalKey(w))).join(', ')}`,
  do: async (ctx) => {
    const authz = ctx.authz();
    assert.ok(authz.checkAll && authz.runAs, 'accessibleAgree: the session authz needs checkAll and runAs');
    const handle = laneHandle(ctx, 'orm');
    const ids = (await handle.rows(req.model)).map((r) => String(r.id));
    for (const who of req.as) {
      const principal = ctx.principal(who);
      const label = typeof who === 'string' ? who : principalKey(who);
      const definite = new Map<Permission, Set<string>>();
      for (const permission of req.permissions) {
        const decisions = await authz.checkAll(principal, ids.map((id) => ({ permission, resource: { type: req.type, id } })));
        definite.set(permission, new Set(ids.filter((_, i) => decisions[i].allowed && decisions[i].residual.op === 'true')));
      }
      for (const permission of req.permissions) {
        const allowed = [...definite.get(permission)!].sort();
        let res: OrmResult;
        try {
          res = await authz.runAs(principal, 'b06-accessible', () => handle.run({ op: 'select', model: req.model, accessible: permission, withAccess: req.permissions }));
        } catch (e) {
          if (!(e instanceof Error && e.name === 'AccessDenied')) throw e;
          assert.deepEqual(allowed, [], `${label} ${permission}: .accessible() threw AccessDenied, checkAll allows ${allowed.join(', ')}`);
          continue;
        }
        assert.deepEqual([...(res.ids ?? [])].sort(), allowed, `${label} ${permission}: .accessible() ids vs checkAll`);
        for (const id of res.ids ?? []) {
          for (const p of req.permissions) assert.equal(res.access?.[id]?.[p], definite.get(p)!.has(id), `${label} ${id} $access['${p}'] vs checkAll`);
        }
      }
    }
  },
});
```

- [ ] **Step 5: The B06 part**

In `packages/authz-testing/src/behaviour/B06-check-filter.spec.ts` add imports `import { accessibleAgree } from './lane.js';` and `import { ACCESS_PERMISSIONS, ACCESS_ROLES } from '../arbitraries/access.js';`, and add `assignment` to the `./dsl.js` import if missing. Before `export const B06` add:

```ts
// alice views org o1 and edits d5; bob is author everywhere but blocked under p3; carol edits p2; everyone views d4.
const accessWorldFixed: World = {
  now: new Date('2026-10-14T12:00:00.000Z'),
  permissions: ACCESS_PERMISSIONS,
  principals: { alice, bob, carol, dave: userPrincipal('dave') },
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    roles: Object.values(ACCESS_ROLES),
    assignments: [
      assignment('a1', alice, 'viewer', ref('org', 'o1')),
      assignment('a2', alice, 'editor', ref('doc', 'd5')),
      assignment('a3', bob, 'author'),
      assignment('a4', bob, 'blocked', ref('project', 'p3')),
      assignment('a5', carol, 'editor', ref('project', 'p2')),
      assignment('a6', { type: 'user', id: '*' }, 'viewer', ref('doc', 'd4')),
      assignment('a7', carol, 'editor', ref('doc', 'd1'), { expiresAt: new Date('2026-10-14T11:00:00.000Z') }),
    ],
  },
  lane: {
    orm: {
      models: [
        { name: 'Org', type: 'org', columns: [], rows: [{ id: 'o1' }, { id: 'o2' }] },
        { name: 'Project', type: 'project', parents: [{ column: 'org_id', type: 'org' }], columns: ['org_id'], rows: [{ id: 'p1', org_id: 'o1' }, { id: 'p2', org_id: 'o1' }, { id: 'p3', org_id: 'o2' }] },
        {
          name: 'Doc',
          type: 'doc',
          owner: 'owner',
          parents: [{ column: 'project_id', type: 'project' }],
          columns: ['project_id', 'owner'],
          rows: [
            { id: 'd1', project_id: 'p1', owner: 'alice' },
            { id: 'd2', project_id: 'p1', owner: 'bob' },
            { id: 'd3', project_id: 'p2', owner: 'carol' },
            { id: 'd4', project_id: 'p3', owner: 'bob' },
            { id: 'd5', project_id: 'p3', owner: 'alice' },
          ],
        },
      ],
    },
  },
};
```

and add this part to the `B06` fixture list (where `sql` was):

```ts
  {
    name: 'accessible',
    facets: ['engine', 'rbac', 'orm'],
    lanes: ['L9'],
    note: 'Ancestor, direct, owner, wildcard, deny-role and expired grants over org > project > doc; arb.accessWorld() is the property form (design 2026-10-14 §6.2, §10.3).',
    world: accessWorldFixed,
    cases: [
      {
        name: '.accessible() ⇔ checkAll and .withAccess ⇔ checkAll, docs and projects',
        steps: [
          accessibleAgree({ as: ['alice', 'bob', 'carol', 'dave'], permissions: ['doc:read', 'doc:update'], model: 'Doc', type: 'doc' }),
          accessibleAgree({ as: ['alice', 'bob', 'carol', 'dave'], permissions: ['project:read'], model: 'Project', type: 'project' }),
        ],
      },
    ],
  },
```

(`alice`, `bob`, `carol` already exist in this file; `ref`, `combine` come from `./dsl.js`.)

- [ ] **Step 6: Run the tests**

Run: `cd packages/authz-testing && npm test`
Expected: `0 failing` (the `accessible` part runs in no harness of this package; `runner.test.ts`/`worlds.test.ts` validate its world and steps).

- [ ] **Step 7: Commit**

```bash
git add -A packages/authz-testing/src packages/authz-testing/test/access-world.test.ts
git commit -m "feat(authz-testing): B06 over .accessible() and the accessWorld arbitrary"
```

---

### Task 5: authz-testing: `runClientAccessConformance`

Drives a running app's `POST /user/access/checks`, `$access` in a list response, `X-Access-Epoch` and `GET /user/access/events` with the request shapes of ckit's `createHttpChecker` tests (`coderush/ckit/packages/access/src/http.test.ts`: `{ checks: [{ object: { type: 'doc', id }, permission: 'edit', subject: { type: 'user', id: 'me' }, context? }] }` → `{ results: boolean[] }`, default batch 100), so a change that breaks ckit fails spinajs CI (design §10.7).

**Files:**
- Create: `packages/authz-testing/src/conformance/client-access.ts`
- Modify: `packages/authz-testing/src/conformance/index.ts`
- Test: `packages/authz-testing/test/conformance/client-access.test.ts`
- Modify: `packages/authz-testing/README.md` (a section "Client access conformance" after the conformance suites section)

**Interfaces:**
- Produces:

```ts
export const CLIENT_ACCESS_FIXTURE: { type: 'doc'; ids: readonly string[]; permissions: Record<string, { list: true }>; roles: Record<string, { grants: string[] }>; assignments: readonly { subject: PrincipalRef; role: string; scope: ResourceRef }[]; listPath: '/docs' };
export interface ClientAccessApp { readonly baseUrl: string; headers(id?: 'me' | 'other'): Readonly<Record<string, string>>; assign(id: 'me' | 'other', role: string, scope: ResourceRef): Promise<void>; stop(): Promise<void>; }
export type ClientAccessHarness = () => Promise<ClientAccessApp>;
export function clientAccessConformanceChecks(app: () => ClientAccessApp): readonly ConformanceCheck<ClientAccessCheckId>[];
export function runClientAccessConformance(name: string, harness: ClientAccessHarness, opts?: { timeoutMs?: number; skip?: readonly ClientAccessCheckId[] }): void;
```

The app under test holds `CLIENT_ACCESS_FIXTURE`: users `me` and `other` (principal type `user`), docs `1`-`4`, roles and assignments as listed, and serves `GET /docs` as `Doc.query().accessible('doc:view').withAccess(['doc:edit', 'doc:view'])` returning the rows (with `id` and `$access`) as a JSON array.

- [ ] **Step 1: Write the failing self-test**

`packages/authz-testing/test/conformance/client-access.test.ts` (a fake server implementing the contract, and a broken one):

```ts
import 'mocha';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'chai';

import { CLIENT_ACCESS_FIXTURE, clientAccessConformanceChecks, runClientAccessConformance } from '../../src/index.js';
import type { ClientAccessApp } from '../../src/index.js';

interface Grant { readonly user: string; readonly role: string; readonly scope: { readonly type: string; readonly id?: string } }

/** An in-process app that answers as design 2026-10-14 §10.2-§10.4 says; `broken` honours the body's subject. */
async function fakeApp(broken = false): Promise<ClientAccessApp> {
  const grants: Grant[] = CLIENT_ACCESS_FIXTURE.assignments.map((a) => ({ user: a.subject.id, role: a.role, scope: a.scope }));
  const streams = new Map<string, ServerResponse[]>();
  const can = (user: string | undefined, permission: string, id: string): boolean => {
    if (!user) return false;
    return grants.some((g) => (g.user === user || g.user === '*') && CLIENT_ACCESS_FIXTURE.roles[g.role].grants.includes(permission) && (g.scope.type === '$global' || (g.scope.type === 'doc' && (id === '*' || g.scope.id === id))));
  };
  const userOf = (req: IncomingMessage): string | undefined => (typeof req.headers['x-user'] === 'string' ? req.headers['x-user'] : undefined);
  const epoch = (user: string | undefined) => createHash('sha256').update(user ?? 'anonymous').digest('hex').slice(0, 16);
  const body = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => resolve(raw ? JSON.parse(raw) : undefined));
    });
  const json = (res: ServerResponse, status: number, value: unknown, user: string | undefined) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-access-epoch': epoch(user) });
    res.end(JSON.stringify(value));
  };
  const server: Server = createServer(async (req, res) => {
    const user = userOf(req);
    if (req.method === 'POST' && req.url === '/user/access/checks') {
      const { checks } = (await body(req)) as { checks: unknown[] };
      if (!Array.isArray(checks) || checks.length > 100) return json(res, 400, { error: 'bad request' }, user);
      const results: boolean[] = [];
      const reasons: (string | null)[] = [];
      for (const c of checks as { object?: { type?: string; id?: string }; permission?: string; subject?: { type: string; id: string } }[]) {
        if (!c || typeof c.object?.type !== 'string' || typeof c.object.id !== 'string' || typeof c.permission !== 'string') {
          results.push(false);
          reasons.push('invalid_request');
          continue;
        }
        const asUser = broken && c.subject ? c.subject.id : user;
        if (!broken && c.subject && (c.subject.type !== 'user' || c.subject.id !== user)) {
          results.push(false);
          reasons.push('subject_mismatch');
          continue;
        }
        const permission = c.permission.includes(':') ? c.permission : `${c.object.type}:${c.permission}`;
        const ok = can(asUser, permission, c.object.id);
        results.push(ok);
        reasons.push(ok ? null : 'no_access');
      }
      return json(res, 200, { results, reasons }, user);
    }
    if (req.method === 'GET' && req.url === CLIENT_ACCESS_FIXTURE.listPath) {
      const rows = CLIENT_ACCESS_FIXTURE.ids.filter((id) => can(user, 'doc:view', id)).map((id) => ({ id, $access: { 'doc:edit': can(user, 'doc:edit', id), 'doc:view': can(user, 'doc:view', id) } }));
      return json(res, 200, rows, user);
    }
    if (req.method === 'GET' && req.url === '/user/access/events' && user) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-access-epoch': epoch(user) });
      res.write(': open\n\n');
      streams.set(user, [...(streams.get(user) ?? []), res]);
      return;
    }
    json(res, 404, {}, user);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    headers: (id) => (id ? { 'x-user': id } : {}),
    async assign(id, role, scope) {
      grants.push({ user: id, role, scope });
      for (const s of streams.get(id) ?? []) s.write(`event: authz.changed\ndata: ${JSON.stringify({ objects: [scope] })}\n\n`);
    },
    async stop() {
      for (const list of streams.values()) for (const s of list) s.end();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

runClientAccessConformance('client access conformance over a fake app', () => fakeApp());

describe('client access conformance catches a broken app', () => {
  it('fails the subject check when the app honours the body subject', async () => {
    const app = await fakeApp(true);
    try {
      const subject = clientAccessConformanceChecks(() => app).find((c) => c.id === 'subject')!;
      let failed: Error | undefined;
      await subject.run().catch((e: Error) => (failed = e));
      expect(failed?.message).to.match(/subject/);
    } finally {
      await app.stop();
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd packages/authz-testing && npx ts-mocha -p tsconfig.json test/conformance/client-access.test.ts`
Expected: FAIL, TS2305 `has no exported member 'CLIENT_ACCESS_FIXTURE'`.

- [ ] **Step 3: Implement**

`packages/authz-testing/src/conformance/client-access.ts`:

```ts
import { GLOBAL } from '@spinajs/authz';
import type { PrincipalRef, ResourceRef } from '@spinajs/authz';

import { check, fail } from './common.js';
import type { ConformanceCheck } from './common.js';

/** What the app under test holds when the suite starts. */
export const CLIENT_ACCESS_FIXTURE = Object.freeze({
  type: 'doc' as const,
  ids: Object.freeze(['1', '2', '3', '4']),
  permissions: Object.freeze({ 'doc:edit': { list: true as const }, 'doc:view': { list: true as const } }),
  roles: Object.freeze({ 'doc.editor': { grants: ['doc:edit', 'doc:view'] }, 'doc.viewer': { grants: ['doc:view'] } }) as Readonly<Record<string, { readonly grants: readonly string[] }>>,
  assignments: Object.freeze([
    { subject: { type: 'user', id: 'me' }, role: 'doc.editor', scope: { type: 'doc', id: '1' } },
    { subject: { type: 'user', id: 'me' }, role: 'doc.editor', scope: { type: 'doc', id: '3' } },
    { subject: { type: 'user', id: '*' }, role: 'doc.viewer', scope: GLOBAL },
  ]) as readonly { readonly subject: PrincipalRef; readonly role: string; readonly scope: ResourceRef }[],
  listPath: '/docs' as const,
});

export interface ClientAccessApp {
  /** Origin of the running app, e.g. `http://127.0.0.1:41234`. */
  readonly baseUrl: string;
  /** Headers that authenticate as user `id`; no id: no credential (the app's anonymous principal). */
  headers(id?: 'me' | 'other'): Readonly<Record<string, string>>;
  /** Assigns `role` at `scope` to user `id` through AuthzAdmin, so the change is pushed. */
  assign(id: 'me' | 'other', role: string, scope: ResourceRef): Promise<void>;
  stop(): Promise<void>;
}

export type ClientAccessHarness = () => Promise<ClientAccessApp>;

export type ClientAccessCheckId = 'wire' | 'permission-names' | 'isolation' | 'subject' | 'anonymous' | 'type-level' | 'limit' | 'access-field' | 'epoch' | 'push';

export interface ClientAccessOptions {
  readonly timeoutMs?: number;
  readonly skip?: readonly ClientAccessCheckId[];
}

const me = { type: 'user', id: 'me' };
/** ckit's `request(id, permission)` (http.test.ts). */
const request = (id: string, permission = 'edit', extra: Readonly<Record<string, unknown>> = {}) => ({ object: { type: 'doc', id }, permission, subject: me, ...extra });
const EPOCH = /^[0-9a-f]{16}$/;

interface Answer {
  readonly status: number;
  readonly results: unknown;
  readonly reasons: unknown;
  readonly epoch: string | null;
  readonly contentType: string | null;
}

async function checks(app: ClientAccessApp, body: unknown, as: 'me' | 'other' | undefined = 'me'): Promise<Answer> {
  const res = await fetch(`${app.baseUrl}/user/access/checks`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...app.headers(as) }, body: JSON.stringify(body) });
  const payload = (await res.json().catch(() => undefined)) as { results?: unknown; reasons?: unknown } | undefined;
  return { status: res.status, results: payload?.results, reasons: payload?.reasons, epoch: res.headers.get('x-access-epoch'), contentType: res.headers.get('content-type') };
}

function booleans(a: Answer, n: number, what: string): boolean[] {
  check(a.status === 200, `${what}: status ${a.status}`);
  check(Array.isArray(a.results) && a.results.length === n && a.results.every((r) => typeof r === 'boolean'), () => `${what}: results must be ${n} booleans, got ${JSON.stringify(a.results)}`);
  check(Array.isArray(a.reasons) && a.reasons.length === n, () => `${what}: reasons must have ${n} entries, got ${JSON.stringify(a.reasons)}`);
  return a.results as boolean[];
}

const same = (a: readonly unknown[], b: readonly unknown[], what: string) => check(JSON.stringify(a) === JSON.stringify(b), () => `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

/** The first SSE event named `name` on an open response, or a failure after `timeoutMs`. */
async function nextEvent(res: Response, name: string, timeoutMs: number): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now())))]);
      if (chunk === null || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const lines = buffer.slice(0, end).split('\n');
        buffer = buffer.slice(end + 2);
        const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? 'message';
        if (event === name) return lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return fail(`push: no ${name} event within ${timeoutMs} ms`);
}

/** The checks in run order; `push` changes the app's data, so it runs last. */
export function clientAccessConformanceChecks(app: () => ClientAccessApp, opts: ClientAccessOptions = {}): readonly ConformanceCheck<ClientAccessCheckId>[] {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const docs = ['1', '2', '3', '4'];
  return [
    {
      id: 'wire',
      title: "ckit's default wire format: { checks } in, { results } out, one boolean per check in order; context is never env",
      run: async () => {
        const a = await checks(app(), { checks: [request('1'), request('2', 'edit', { context: { ip: '10.0.0.1' } }), request('3'), request('4')] });
        same(booleans(a, 4, 'wire'), [true, false, true, false], 'wire: answers');
        check(a.contentType?.startsWith('application/json') === true, `wire: content-type ${a.contentType}`);
        check(a.epoch !== null && EPOCH.test(a.epoch), `wire: X-Access-Epoch ${a.epoch}`);
      },
    },
    {
      id: 'permission-names',
      title: "a permission without ':' becomes <type>:<permission>; one with ':' is used as given",
      run: async () => {
        const short = booleans(await checks(app(), { checks: docs.map((id) => request(id, 'edit')) }), 4, 'short names');
        const full = booleans(await checks(app(), { checks: docs.map((id) => request(id, 'doc:edit')) }), 4, 'full names');
        same(short, full, 'permission names');
      },
    },
    {
      id: 'isolation',
      title: 'a malformed or unknown entry is false and never fails the batch',
      run: async () => {
        const a = await checks(app(), { checks: [request('1'), { object: null, permission: 'edit' }, request('1', 'nope'), { object: { type: 'unknown-type', id: '1' }, permission: 'edit' }, request('3')] });
        same(booleans(a, 5, 'isolation'), [true, false, false, false, true], 'isolation: answers');
        check((a.reasons as unknown[])[0] === null, 'isolation: an allowed entry has a null reason');
      },
    },
    {
      id: 'subject',
      title: "the subject is the session's principal: another subject is false with subject_mismatch; no subject is the caller",
      run: async () => {
        const a = await checks(app(), { checks: [request('1', 'edit', { subject: { type: 'user', id: 'other' } }), { object: { type: 'doc', id: '1' }, permission: 'edit' }] });
        same(booleans(a, 2, 'subject'), [false, true], 'subject: answers (an app that honours the body subject answers true first)');
        check((a.reasons as unknown[])[0] === 'subject_mismatch', () => `subject: reason ${JSON.stringify((a.reasons as unknown[])[0])}`);
      },
    },
    {
      id: 'anonymous',
      title: 'an anonymous caller may ask and gets false where no grant reaches it',
      run: async () => {
        const a = await checks(app(), { checks: docs.map((id) => ({ object: { type: 'doc', id }, permission: 'view' })) }, undefined);
        same(booleans(a, 4, 'anonymous'), [false, false, false, false], 'anonymous: answers (user:* does not cover anonymous)');
      },
    },
    {
      id: 'type-level',
      title: "object id '*' asks at the type level",
      run: async () => {
        const a = await checks(app(), { checks: [request('*', 'view'), request('*', 'edit')] });
        same(booleans(a, 2, 'type-level'), [true, false], 'type-level: view through user:* at $global, no global edit');
      },
    },
    {
      id: 'limit',
      title: "a batch of ckit's default maximum (100) is answered",
      run: async () => {
        const a = await checks(app(), { checks: Array.from({ length: 100 }, (_, i) => request(docs[i % 4])) });
        booleans(a, 100, 'limit');
      },
    },
    {
      id: 'access-field',
      title: 'each $access entry of a list row equals what /user/access/checks answers for that row',
      run: async () => {
        const a = app();
        const res = await fetch(`${a.baseUrl}${CLIENT_ACCESS_FIXTURE.listPath}`, { headers: { accept: 'application/json', ...a.headers('me') } });
        check(res.status === 200, `access-field: list status ${res.status}`);
        const rows = (await res.json()) as { id: unknown; $access?: Record<string, unknown> }[];
        same(rows.map((r) => String(r.id)).sort(), docs, 'access-field: listed ids (user:* views every doc)');
        for (const row of rows) {
          for (const [permission, value] of Object.entries(row.$access ?? fail(`access-field: row ${String(row.id)} has no $access`))) {
            const [answer] = booleans(await checks(a, { checks: [request(String(row.id), permission)] }), 1, `access-field ${String(row.id)} ${permission}`);
            check(value === answer, `access-field: row ${String(row.id)} $access['${permission}'] = ${String(value)}, checks = ${answer}`);
          }
        }
      },
    },
    {
      id: 'epoch',
      title: 'X-Access-Epoch is stable for a session and differs between principals',
      run: async () => {
        const first = (await checks(app(), { checks: [request('1')] })).epoch;
        const again = (await checks(app(), { checks: [request('1')] })).epoch;
        const other = (await checks(app(), { checks: [] }, 'other')).epoch;
        check(first !== null && first === again, `epoch: ${first} then ${again}`);
        check(other !== null && other !== first, `epoch: other principal ${other}, me ${first}`);
      },
    },
    {
      id: 'push',
      title: 'an assignment to the caller pushes authz.changed on GET /user/access/events, and checks then follow it',
      run: async () => {
        const a = app();
        const abort = new AbortController();
        const res = await fetch(`${a.baseUrl}/user/access/events`, { headers: { accept: 'text/event-stream', ...a.headers('me') }, signal: abort.signal });
        try {
          check(res.status === 200 && res.headers.get('content-type')?.startsWith('text/event-stream') === true, `push: events status ${res.status}, content-type ${res.headers.get('content-type')}`);
          const pending = nextEvent(res, 'authz.changed', timeoutMs);
          await a.assign('me', 'doc.editor', { type: 'doc', id: '2' });
          const data = JSON.parse(await pending) as { objects?: { type: string; id: string }[] };
          if (data.objects) check(data.objects.some((o) => o.type === 'doc' && o.id === '2'), () => `push: objects ${JSON.stringify(data.objects)} leave out doc:2`);
          same(booleans(await checks(a, { checks: [request('2')] }), 1, 'push'), [true], 'push: doc 2 after the grant');
        } finally {
          abort.abort();
        }
      },
    },
  ];
}

/** Starts the app once, runs every check in order, stops the app. */
export function runClientAccessConformance(name: string, harness: ClientAccessHarness, opts: ClientAccessOptions = {}): void {
  let app: ClientAccessApp | undefined;
  const checksInOrder = clientAccessConformanceChecks(() => app ?? fail('the app did not start'), opts);
  describe(name, function () {
    this.timeout((opts.timeoutMs ?? 5000) * 3);
    before(async () => {
      app = await harness();
    });
    after(async () => {
      await app?.stop();
      app = undefined;
    });
    for (const c of checksInOrder) {
      if (opts.skip?.includes(c.id)) it(c.title);
      else it(c.title, () => c.run());
    }
  });
}
```

`packages/authz-testing/src/conformance/index.ts`: add `export * from './client-access.js';`.

`packages/authz-testing/README.md`, new section after the conformance suites:

```md
## Client access conformance

`runClientAccessConformance(name, harness)` checks a running app against the client access API
(design 2026-10-14 §10): `POST /user/access/checks` with the request bodies of ckit's
`createHttpChecker`, `$access` on a list route, `X-Access-Epoch` and `GET /user/access/events`. The
harness starts the app holding `CLIENT_ACCESS_FIXTURE` (users `me` and `other`, docs 1-4, the roles and
assignments listed there, `GET /docs` as `.accessible('doc:view').withAccess(['doc:edit', 'doc:view'])`)
and returns `{ baseUrl, headers(id), assign(id, role, scope), stop() }`. The checks run in order; `push`
changes data and runs last.
```

Also in the README's facet table row for `orm` (L162) change the description to "`.accessible()`, `.withAccess()`, the runtime guard" and delete the paragraph `D-F5-9` at L292 (B05.orm rule 6 no longer exists).

- [ ] **Step 4: Run the self-test**

Run: `cd packages/authz-testing && npm run compile && npx ts-mocha -p tsconfig.json test/conformance/client-access.test.ts`
Expected: `11 passing` (10 checks over the fake app, 1 broken-app test).

- [ ] **Step 5: Whole package**

Run: `cd packages/authz-testing && npm test`
Expected: `0 failing`.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-testing/src/conformance packages/authz-testing/test/conformance/client-access.test.ts packages/authz-testing/README.md
git commit -m "feat(authz-testing): runClientAccessConformance over ckit's checker fixtures"
```

---

### Task 6: authz-queue: the job owner is the initiator

**Files:**
- Modify: `packages/authz-queue/src/job/job-resource.ts`
- Modify: `packages/authz-queue/src/job/job-grant.ts`
- Modify: `packages/authz-queue/test/job-scope.test.ts`
- Modify: `packages/authz-queue/README.md` (the "JobModel as a resource" lines)

**Interfaces:**
- Consumes: `registerAccessResource(JobModel, 'job', { owner: { column: 'InitiatorId', typeColumn: 'InitiatorType' } })` (L3, overview names table).
- Produces: `job:read` granted to role `user` with `relation: 'owner'`; `JobInitiatorScope` removed (it was not in `src/api.ts`, so no API snapshot change).

A job's initiator is a principal of any type, stored as `InitiatorType` + `InitiatorId`. An owner check on `InitiatorId` alone would let user `x` read the jobs of `service:x`, so the registration names the type column too; with it the owner holds only when both the type and the id match.

- [ ] **Step 1: Write the failing test**

Replace the `world` and the first `describe` of `packages/authz-queue/test/job-scope.test.ts` (L18-73) with:

```ts
const { combine, permit, relation, staticModel } = fixtureDsl;
const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const svcAlice = servicePrincipal('alice');

const world: World = {
  permissions: [],
  principals: { alice, bob, svcAlice },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: (req) => (req.permission === 'job:read' ? permit(relation('owner')) : {}) })],
  lane: { queue: { jobs: [{ name: 'plain' }, { name: 'progress' }] } },
};

describe('JobModel as an access resource', () => {
  const harness = queueHarness();
  let session: HarnessSession;

  before(() => harness.beforeAll?.());
  after(() => harness.afterAll?.());
  beforeEach(async () => {
    session = await harness.setup(world, { id: 'B30', part: 'queue', case: 'job-scope', title: 'job-scope', facets: ['engine', 'host', 'queue'] } as SetupContext);
  });
  afterEach(() => session.dispose());

  const service = () => session.authz as unknown as AuthzService;

  const emitAs = async (who: Principal, job: string) => {
    const message = await service().runAs(who, 'test', () => session.lane!.queue!.emit(job));
    await session.lane!.queue!.handle(message);
    return message as unknown as { JobId: string };
  };

  const rowOf = (jobId: string) => service().runAs(SYSTEM, 'test', () => JobModel.where({ JobId: jobId }).first());

  it('the consumer tracks an unattended job', async () => {
    const m = await emitAs(alice, 'plain');
    const row = await rowOf(m.JobId);
    expect(row?.Status).to.equal('success');
    expect(row?.InitiatorId).to.equal('alice');
  });

  it('a select on JobModel without .accessible() or runAs is refused by the guard', async () => {
    await service().runAs(alice, 'test', async () => {
      await JobModel.all().then(
        () => expect.fail('should be refused'),
        (e) => expect(e).to.be.instanceOf(AuthzConfigError),
      );
    });
  });

  it('the initiator owns the job; another user and a principal of another type with the same id do not', async () => {
    const m = await emitAs(alice, 'plain');
    const row = (await rowOf(m.JobId))!;
    const ref = { type: 'job', id: String(row.Id) };
    expect(await service().can(alice, 'job:read', ref, row)).to.equal(true);
    expect(await service().can(bob, 'job:read', ref, row)).to.equal(false);
    expect(await service().can(svcAlice, 'job:read', ref, row)).to.equal(false);
    expect(await service().can(alice, 'job:read', ref)).to.equal(true);
  });
});
```

Imports at the top: add `servicePrincipal` to the `@spinajs/authz-testing` import, `AuthzConfigError` to `@spinajs/authz`, `import type { AuthzService, Principal } from '@spinajs/authz';`, and drop `AccessDenied` and `UNATTENDED` if unused. In the second `describe` (`job:read grant`) replace both `relation: 'initiator'` with `relation: 'owner'`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd packages/authz-queue && npm run compile; npx ts-mocha -p tsconfig.json test/job-scope.test.ts`
Expected: FAIL at compile (`OrmScope` is not exported by `@spinajs/authz-orm`) or, once compiled, `the initiator owns the job…` fails (no `owner` relation on `job`).

- [ ] **Step 3: Implement**

`packages/authz-queue/src/job/job-resource.ts`:

```ts
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { registerAccessResource } from '@spinajs/authz-orm';
import { SYSTEM } from '@spinajs/authz';
import { JobModel, QueueTrackingHook } from '@spinajs/queue';

import { authzFor } from '../hook/service.js';
import './job-grant.js';

// The initiator can be any principal type, so the owner check compares the type column too.
registerAccessResource(JobModel, 'job', { owner: { column: 'InitiatorId', typeColumn: 'InitiatorType' } });

/** The queue's own job-row queries run as SYSTEM: the job's principal may not touch the table. */
@Injectable(QueueTrackingHook)
export class AuthzQueueTrackingHook extends QueueTrackingHook {
  @Config('authz.queue.domain')
  protected Domain: string;

  async aroundTracking<T>(next: () => Promise<T>): Promise<T> {
    return (await authzFor(this.Domain)).runAs(SYSTEM, 'queue:tracking', next);
  }
}
```

`packages/authz-queue/src/job/job-grant.ts`:

```ts
import { Injectable } from '@spinajs/di';
import { ConfigurationSource } from '@spinajs/configuration';
import type { IConfigLike } from '@spinajs/configuration';

/**
 * Every user holds job:read on the jobs they emitted (`owner` is the initiator). It is a source and not a config file
 * because every installed package's config dir is read whether or not the package is imported, and a grant of a
 * permission nothing registered fails the boot. Order 0 loads before the file sources.
 */
@Injectable(ConfigurationSource)
export class JobGrantSource extends ConfigurationSource {
  public get Order(): number {
    return 0;
  }

  public Load(): Promise<IConfigLike> {
    return Promise.resolve({ authz: { rbac: { roles: { user: { grants: [{ permission: 'job:read', relation: 'owner' }] } } } } } as unknown as IConfigLike);
  }
}
```

`packages/authz-queue/README.md`: replace every mention of `JobInitiatorScope`, `@OrmScope` and "relation `initiator`" with "`JobModel` is the `job` resource; its `owner` is the initiator (`InitiatorType` and `InitiatorId`), and the `user` role holds `job:read` on `owner`".

- [ ] **Step 4: Run the package tests**

Run: `cd packages/authz-queue && npm test`
Expected: `0 failing` (behaviour.test.ts runs B30.queue, which this lane did not change).

- [ ] **Step 5: Grep**

Run: `grep -rnE "OrmScope|relation: 'initiator'" packages/authz-queue/src packages/authz-queue/test`
Expected: no output (`runAs: 'initiator'` in job options is a different thing and stays).

- [ ] **Step 6: Commit**

```bash
git add -A packages/authz-queue
git commit -m "refactor(authz-queue): JobModel owner is the initiator; job:read on relation owner"
```

---

### Task 7: queue-http-progress: load as SYSTEM, then check

`GET jobs/v1/:jobId/status` read the row under the request principal, relying on the old middleware's scoping. It now loads as SYSTEM and checks the row; no list route exists, so nothing needs `.accessible()`.

**Files:**
- Modify: `packages/queue-http-progress/src/controllers/JobsControllers.ts`
- Test: `packages/queue-http-progress/test/status-route.test.ts` (unchanged; it already asserts `canRead`), `test/behaviour.test.ts` (B30.status)

- [ ] **Step 1: Run the current tests to see the failure**

Run: `cd packages/queue-http-progress && npm test`
Expected after Tasks 2 and 6: FAIL in B30.status, `AuthzConfigError` from the runtime guard (a select on `JobModel` without `.accessible()` as the request principal).

- [ ] **Step 2: Implement**

`packages/queue-http-progress/src/controllers/JobsControllers.ts`, replace the imports and `getStatus` head through the `if (!row)` block, and `canRead`:

```ts
import { AuthzDomains, AuthzService, SYSTEM } from "@spinajs/authz";
import { Access } from "@spinajs/authz-http";
import { DI } from "@spinajs/di";
import { ResourceNotFound } from "@spinajs/exceptions";
import { BaseController, BasePath, Get, Ok, Param, Req } from "@spinajs/http";
import type { Request } from "@spinajs/http";
import { JobModel } from "@spinajs/queue";
import { IJobStatusResponse } from "../models/JobEntry.js";

@BasePath("jobs/v1")
export class JobsController extends BaseController {
  @Get(":jobId/status")
  @Access("job:read")
  public async getStatus(@Param() jobId: string, @Req() req: Request): Promise<Ok> {
    const authz = await this.authzOf(req);
    const found = await authz.runAs(SYSTEM, "job-status:load", () => JobModel.select().where("JobId", jobId).first());
    // The job resource id is the integer Id, not the uuid JobId (RFC L6-2).
    const row = found && (await this.canRead(req, found)) ? found : undefined;

    // An unknown and a denied job answer alike, so the route does not reveal which jobs exist.
    if (!row) {
      throw new ResourceNotFound(`Job ${jobId} not found`);
    }
```

(the rest of `getStatus` is unchanged), and:

```ts
  protected async authzOf(req: Request): Promise<AuthzService> {
    const domain = req.storage.AuthzHttpRoute?.domain ?? "root";
    return domain === "root"
      ? ((await DI.resolve(AuthzService)) as AuthzService)
      : await ((await DI.resolve(AuthzDomains)) as AuthzDomains).service(domain);
  }

  protected async canRead(req: Request, row: JobModel): Promise<boolean> {
    const principal = req.storage.Principal;
    if (!principal) return false;
    // The row is the subject: a ref alone leaves the grant's owner relation to a second load.
    return (await this.authzOf(req)).can(principal, "job:read", { type: "job", id: String(row.Id) }, row);
  }
```

`test/JobsController.test.ts` stubs `JobModel.select`; if its cases now fail because `authz.runAs` needs a booted service, register the test's stub service the way `status-route.test.ts` does (`authz.runAs(SYSTEM, 'test', …)` over the harness), or stub `AuthzService.prototype.runAs` with `sinon.stub(...).callsFake((_p, _r, fn) => fn())` in that file's `beforeEach`.

- [ ] **Step 3: Run the package tests**

Run: `cd packages/queue-http-progress && npm test`
Expected: `0 failing`, including `B30.status`: alice 200, bob 403 or 404, carol 200.

- [ ] **Step 4: Commit**

```bash
git add -A packages/queue-http-progress
git commit -m "refactor(queue-http-progress): load the job as SYSTEM and check job:read on the row"
```

---

### Task 8: configuration-http: `.accessible()` for the list, check-before for one entry

Behaviour that came from scoping and now must be explicit: a conditional `configuration:update` grant that does not cover the row (was: the UPDATE matched nothing), a principal that may update but not read (was: the `@FromModel` load found nothing), a conditional read grant on one entry. The routes keep loading by slug, which is not the primary key, so the load runs as SYSTEM explicitly (the guard exempts only single primary-key selects, overview decision 11) and each entry is then checked as the caller. A conditional read grant can no longer list: `configuration:read` becomes `list: true`, and a row condition is not list-filterable (design §7), so the `scoped` list case is dropped.

**Files:**
- Modify: `packages/configuration-http/src/config/configuration-http.ts` (permissions)
- Modify: `packages/configuration-http/src/controllers/Configuration.ts`
- Modify: `packages/configuration-http/src/write.ts` (comment)
- Modify: `packages/configuration-http/src/bootstrap.ts` (comment)
- Modify: `packages/configuration-http/test/configuration.test.ts` (model with list plans; the `scoped` list case)
- Modify: `packages/configuration-http/test/behaviour.test.ts` (orm handle)

- [ ] **Step 1: Update the tests first**

`test/configuration.test.ts`: the root model must plan lists. Replace

```ts
      testHost.instance(new StaticModel({ name: 'config-votes', votes, capabilities: { fields: true } })),
```

with

```ts
      testHost.instance(new ListStaticModel({ name: 'config-votes', votes, capabilities: { fields: true }, lists: { 'configuration:read': listPlan } })),
```

and add after `votes`:

```ts
// Readers with an unconditional read list everything; nobody else lists (a row condition is not list-filterable).
const listPlan = (p: Principal): ModelListPlan => (['admin', 'reader', 'mailEditor', 'both', 'narrow', 'masked'].includes(String(p.id)) ? { kind: 'all' } : { kind: 'deny-all', reason: { code: 'no_access' } });
```

(imports: `ListStaticModel` from `@spinajs/authz-testing`, `type { ModelListPlan, Principal }` from `@spinajs/authz`). Replace the test `'lists only the rows a conditional read grant covers'` with:

```ts
    it('refuses a list to a principal whose read grant is conditional (not list-filterable)', async () => {
      const list = await req('scoped').get('configuration').set(JSON_HEADERS);
      expect(list).to.have.status(403);
    });
```

`test/behaviour.test.ts`, the `orm` handle's `run`:

```ts
              async run(q) {
                if (q.op !== 'select') throw new Error('B20.configuration only selects');
                const query = DbConfig.query();
                const rows = await (q.accessible ? query.accessible(q.accessible) : query);
                return { ids: rows.map((r) => String(r.Id)), count: rows.length, sql: [] };
              },
```

The permissions loop there already copies `configurationHttpConfig.authz.permissions`, which gain `list: true` in Step 3.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd packages/configuration-http && npm test`
Expected: FAIL: `GET /configuration` throws `AuthzConfigError` from the runtime guard (500), and B20.configuration `.accessible()` fails with `configuration:read` not `list: true`.

- [ ] **Step 3: Implement**

`src/config/configuration-http.ts` permissions:

```ts
    permissions: {
      'configuration:read': { fields: true, list: true },
      'configuration:update': { fields: true },
    },
```

`src/controllers/Configuration.ts`: imports become

```ts
import { BadRequestResponse, BaseController, BasePath, Body, Get, Ok, Param, Patch, Query, ServerError } from '@spinajs/http';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';
import { AccessDenied, SYSTEM, authz } from '@spinajs/authz';
import type { Permission, Principal } from '@spinajs/authz';
import { ResourceNotFound } from '@spinajs/exceptions';
import { Autoinject } from '@spinajs/di';
import { DataValidator } from '@spinajs/validation';
import { DbConfig } from '@spinajs/configuration-db-source';
import '@spinajs/authz-orm';
```

(the `FromModel` import goes; add `@spinajs/exceptions` to `package.json` `dependencies` as `"2.0.549"` if it is not there). The three routes:

```ts
  @Get('/')
  @Access('configuration:read', { fields: 'filter' })
  public async list(@Query() group?: string) {
    const query = group ? DbConfig.where('Group', group) : DbConfig.query();
    const entries = await query.accessible('configuration:read');
    return new Ok(entries.map((e) => present(e)));
  }

  @Get(':slug')
  @Access('configuration:read', { fields: 'filter' })
  public async get(@CurrentPrincipal() caller: Principal, @Param() slug: string) {
    const entry = await this.entryFor(caller, slug, ['configuration:read']);
    return new Ok(present(entry));
  }

  @Patch(':slug')
  @Access('configuration:update', { fields: 'filter' })
  public async update(@CurrentPrincipal() caller: Principal, @Param() slug: string, @Body() data: UpdateConfigDto) {
    // The response carries the entry, so updating it needs read too.
    const entry = await this.entryFor(caller, slug, ['configuration:read', 'configuration:update']);
```

(the body of `update` after this line is unchanged) and the helper at the end of the class:

```ts
  /** The entry by slug, loaded as SYSTEM, once `caller` holds each permission on it; otherwise 404, so slugs are not probed. */
  private async entryFor(caller: Principal, slug: string, permissions: readonly Permission[]): Promise<DbConfig> {
    const service = authz();
    const entry = await service.runAs(SYSTEM, 'configuration-http:load', () => DbConfig.where('Slug', slug).first());
    if (!entry) throw new ResourceNotFound(`configuration entry ${slug} not found`);
    const ref = { type: 'configuration', id: String(entry.Id) };
    for (const permission of permissions) {
      if (!(await service.can(caller, permission, ref, entry))) throw new ResourceNotFound(`configuration entry ${slug} not found`);
    }
    return entry;
  }
```

`AccessDenied` is not needed if unused; remove it from the import then. The route tests expecting 403 for `updater` and `mailEditor` (`answers 403 to a principal that may update but not read`, `answers 403 when the update grant is conditional …`) now get 404: change those two `expect(res).to.have.status(403)` to `expect(res.status).to.be.oneOf([403, 404])`, matching the existing `outside` case.

`src/write.ts` comment:

```ts
/**
 * Persists the entry. The route checked configuration:update on the row before, so zero rows affected means the row
 * went away in between: that must not read as a write.
 */
```

`src/bootstrap.ts` comment:

```ts
/**
 * `DbConfig` lives in `@spinajs/configuration-db-source`, which does not depend on authz. Its `@Model('configuration')`
 * only names the table; this registers it as the `configuration` access resource, so lists of it go through
 * `.accessible('configuration:read')` and single entries are checked before use.
 */
```

The `registerAccessResource(DbConfig, 'configuration')` call stays: it has no parents and no owner.

- [ ] **Step 4: Run the package tests**

Run: `cd packages/configuration-http && npm test`
Expected: `0 failing`.

- [ ] **Step 5: Ledger line**

In `packages/configuration-http/test/LEDGER.md`, the two rows that say "`registerAccessResource(DbConfig, 'configuration')` makes a query without a principal throw": replace that clause with "a select on DbConfig without `.accessible()` or `runAs(SYSTEM)` throws in the test env (design 2026-10-14 §8)".

- [ ] **Step 6: Commit**

```bash
git add -A packages/configuration-http
git commit -m "refactor(configuration-http): .accessible() list, check-before single entries"
```

---

### Task 9: users and users-http

`users` itself registers no `@AccessResource`; its stores already run their lookups as SYSTEM, and `self` stays with users' own resolvers (`UserSelfRelation`, `UsersSelfRelation`). Its test that registers `User` as a resource now proves the stores keep working under the runtime guard instead of under scoping. In users-http the only list over the user model (`GET /users`) runs as the caller after `requireEveryUser`; it now runs as SYSTEM, since an app's user model may be an `@AccessResource` and the every-user check already decided. Every other user-model query in users-http is already wrapped (`userRowFor`, `everyUserRow`, `asSystem`, `runAs` in `current-user.ts`, `metadata-scope.ts`); `FilterableUserMetadata` and `UserMetadataBase` are not access resources.

**Files:**
- Modify: `packages/users/test/identity-system.test.ts`
- Modify: `packages/users/test/support/users-db.ts:44-76` (`USERS_HOST_KEYS`)
- Modify: `packages/users-http/src/admin/controllers/Users/Users.ts` (the `list` route, around L325-365)

- [ ] **Step 1: Update the users test**

In `packages/users/test/identity-system.test.ts`:

- `import { AccessDenied, AuthzConfigError, AuthzContributor, … }` (keep `AccessDenied` only if still used);
- the `after()` hook unregisters the classes the import registered: replace the three names with the ones Task 0 printed (write middleware, `OrmResourceAdapter`, contributor), e.g.

```ts
    for (const [service, name] of [
      [QueryMiddleware, '<L3 write middleware class>'],
      [ResourceAdapter, 'OrmResourceAdapter'],
      [AuthzContributor, '<L3 contributor class, if any>'],
    ] as [Class<unknown>, string][]) {
```

  with the literal class names (drop the contributor row if L3 registers none);
- the first test becomes:

```ts
  it('an unwrapped lookup of a login caller is refused by the runtime guard', async () => {
    scopeUsers();

    for (const [name, caller] of CALLERS) {
      await expect(as(caller, () => User.query().withDeleted().where('Uuid', TEST_USER_UUID).first()), name).to.be.rejectedWith(AuthzConfigError);
    }
  });
```

  (a raw driver select has no model, so the guard does not see it; design §8 accepts that, and the ESLint rule covers source).

The other tests stay: each store call must still resolve as UNATTENDED and anonymous callers, which now proves the stores wrap their lookups in `runAs(SYSTEM)`.

In `packages/users/test/support/users-db.ts` remove `'AuthzQueryMiddleware'`, `'OrmAuthzContributor'`, `'OrmNativeCompiler'` and `'RbacOrmCompiler'` from `USERS_HOST_KEYS` and add the class names Task 0 printed for the write middleware and the contributor (`'OrmResourceAdapter'` stays if L3 kept the name).

- [ ] **Step 2: Run the users tests**

Run: `cd packages/users && npm test`
Expected: `0 failing`. A store test that fails with `AuthzConfigError` names a store whose lookup is not wrapped in `runAs(SYSTEM)`: wrap that lookup in the store (`src/identity/*.ts`) with `authz.runAs(SYSTEM, '<store>-lookup', …)` as its siblings do, rather than relaxing the test.

- [ ] **Step 3: users-http list route**

In `packages/users-http/src/admin/controllers/Users/Users.ts`, `list`: replace the two awaits

```ts
    const result = await query;
    const count = await countQuery.selectCount();
```

with

```ts
    // requireEveryUser decided for every row; the application's user model may be an @AccessResource.
    const authz = (await DI.resolve(AuthzService)) as AuthzService;
    const [result, count] = await authz.runAs(SYSTEM, 'users-http-list', async () => [await query, await countQuery.selectCount()] as const);
```

(`DI`, `AuthzService`, `SYSTEM` are already imported in this file; check with `grep -n "^import" packages/users-http/src/admin/controllers/Users/Users.ts`).

- [ ] **Step 4: Run the users-http tests**

Run: `cd packages/users-http && npm test`
Expected: `0 failing`.

- [ ] **Step 5: Commit**

```bash
git add -A packages/users/test packages/users-http/src
git commit -m "refactor(users, users-http): runtime guard semantics; user list as SYSTEM after the every-user check"
```

---

### Task 10: http-socket tests on the new `orm` lane

**Files:**
- Modify: `packages/http-socket/test/authz/socket-harness.ts` (imports L13, `checkSpec` L69-87, `define` L127-130, `run` L145-151, `register` L245-256)
- Modify: `packages/http-socket/test/authz/behaviour.test.ts` (world L32-47)

- [ ] **Step 1: Run the suite to see it fail**

Run: `cd packages/http-socket && npm test`
Expected: FAIL at compile: `OrmModelSpec` has no `attributes`, `relationScope`…; `AccessResource` takes one argument.

- [ ] **Step 2: The harness**

`socket-harness.ts`:

- L13 stays `import { AccessResource, Owner } from '@spinajs/authz-orm';`.
- `checkSpec`:

```ts
/** What this harness maps: `@AccessResource(type)` and `@Owner()` over text columns. */
function checkSpec(s: OrmModelSpec): void {
  const where = `model ${s.name}`;
  if (s.parents !== undefined) fail(`${where}: parents are not supported here`);
  const columns = new Set(s.columns);
  if (columns.size !== s.columns.length || columns.has('id')) fail(`${where}: columns repeat a name or list id`);
  if (s.type === undefined && s.owner !== undefined) fail(`${where}: owner needs a type`);
  if (s.owner !== undefined && !columns.has(s.owner)) fail(`${where}: the owner ${s.owner} is not one of its columns`);
  for (const r of s.rows ?? []) {
    if (typeof r.id !== 'string') fail(`${where}: rows need string ids`);
    for (const [k, v] of Object.entries(r)) {
      if (k !== 'id' && !columns.has(k)) fail(`${where}: the row field ${k} is not one of its columns`);
      if (v !== null && typeof v !== 'string') fail(`${where}: ${k} holds a ${typeof v}; only text columns are supported here`);
    }
  }
}
```

- in `define`:

```ts
    if (s.type !== undefined) {
      AccessResource(s.type)(cls);
      if (s.owner !== undefined) Owner()(cls.prototype, s.owner);
    }
```

- `run`:

```ts
  async run(q: OrmQuery): Promise<{ ids: string[] }> {
    if (q.op !== 'select' || q.withAccess !== undefined) return fail(`only a select (with or without accessible) is supported here, not ${JSON.stringify(q)}`);
    const d = this.current.get(q.model) ?? fail(`no model ${q.model} in the world`);
    let b = (d.cls as unknown as { query(): any }).query();
    for (const [k, v] of Object.entries(q.where ?? {})) b = b.where(k, v);
    if (q.accessible) b = b.accessible(q.accessible);
    return { ids: ((await b) as ModelBase[]).map(pk) };
  }
```

- in `register`, delete the block from `// The test domain declares the ORM adapter's permissions …` through the `for (const { name, ...def } of ormAdapter?.permissions() ?? [])` loop (the worlds now declare their permissions, with `list: true`), and drop the then-unused `ResourceAdapter` import.

- [ ] **Step 3: The own world**

`behaviour.test.ts`:

```ts
const { allRows, combine, extension, ownedRows, permit, relation, staticModel } = fixtureDsl;
```

```ts
const SELECT = { op: 'select', model: 'Task' } as const;
const ACCESSIBLE = { op: 'select', model: 'Task', accessible: 'task:read' } as const;
```

```ts
const world: World = {
  permissions: [{ name: 'task:read', list: true }],
  principals: { alice: userPrincipal('alice'), bob: userPrincipal('bob') },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: { 'task:read': permit(relation('owner')) }, lists: { 'task:read': ownedRows() } })],
  config: AUDIT,
  lane: {
    orm: { models: [TASK] },
    socket: {
      handlers: [
        { event: 'tasks', orm: ACCESSIBLE },
        { event: 'tasks.system', orm: SELECT },
      ],
    },
  },
};
```

(`allRows` is unused here; leave it out of the destructuring if lint complains.) The `TASK` spec in this file has no `attributes` and stays.

- [ ] **Step 4: Run the package tests**

Run: `cd packages/http-socket && npm test`
Expected: `0 failing`: `tasks.system` as SYSTEM sees t1-t3; `tasks` unattended is `AccessDenied` (`unattended`); alice sees t1, t3; bob t2.

- [ ] **Step 5: Commit**

```bash
git add -A packages/http-socket/test
git commit -m "test(http-socket): socket harness on the .accessible() orm lane"
```

---

### Task 11: authz-convert: no `@OrmScope` advice

`spinajs-authz-convert` tells 2.x apps to port policies to `@OrmScope`, which no longer exists. Relations other than `owner` and `self` become roles assigned on the resource (design §3).

**Files:**
- Modify: `packages/authz-convert/src/analyze.ts:143-157`
- Modify: `packages/authz-convert/test/fixtures/golden/*/expected/authz-warnings.md` (regenerated)
- Test: `packages/authz-convert/test/analyze.test.ts` (severities unchanged; add a text check)

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe` of `test/analyze.test.ts` that covers `scope-relation` (search `'scope-relation'`):

```ts
    it('advises roles on the resource, never @OrmScope', () => {
      const list = findings({ rbac: { grants: { r: { Campaign: { 'read:own': ['scope:partner'] }, Note: { 'read:own': ['own'] } } } } });
      for (const f of list) expect(f.message).to.not.match(/OrmScope/);
      expect(byCode(list, 'scope-relation')[0].message).to.match(/role/);
    });
```

(If `'read:own': ['own']` is not how the file spells an owner grant, copy the owner grant from the test at L76.)

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd packages/authz-convert && npx ts-mocha -p tsconfig.json test/analyze.test.ts`
Expected: FAIL, a message matches `/OrmScope/`.

- [ ] **Step 3: Implement**

`src/analyze.ts`, the three messages:

```ts
          f.warn('owner-relation', `:own grants on ${resource} became relation 'owner'. Each model of type '${resource}' needs @Owner() (was @ResourceOwner()) on the column that holds the owner's id; route checks need a RelationResolver. Run with --src to check the models.`, resource);
```

```ts
          f.warn('owner-relation', `:own grants on ${resource} became relation 'owner', but its model (${files.join(', ')}) has no @ResourceOwner(): add @Owner() on the column that holds the owner's id. A default-scope @OrmPermission policy has no 3.0 form.`, resource);
```

```ts
          `'scope:${rel}' on ${resource} became relation '${rel}', which 3.0 has no query form for: assign a role on each ${resource} row to the subjects @OrmPermission(Model, '${rel}') selected (a user, or a subject set such as team:<id>#member), and register a RelationResolver for '${rel}' on '${resource}' until then.${missing ? ` No @OrmPermission(…, '${rel}') policy was found under --src.` : ''}`,
```

- [ ] **Step 4: Regenerate the golden files and review**

Run: `cd packages/authz-convert && UPDATE_GOLDEN=1 npm test && git diff --stat test/fixtures/golden`
Expected: only the `owner-relation` and `scope-relation` lines of the two `authz-warnings.md` files change. Then `npm test` without the variable: `0 failing`.

- [ ] **Step 5: Commit**

```bash
git add -A packages/authz-convert
git commit -m "fix(authz-convert): advise roles on resources instead of @OrmScope"
```

---

### Task 12: Lane verification

**Files:** none (fix-ups only).

- [ ] **Step 1: Removed names are gone from this lane's packages**

Run: `grep -rnE "OrmScope|OrmNativeCompiler|ScopeColumn|RbacOrmCompiler|authz-orm/native|relationScope|allowJit|AUTHZ_ORM_CONFIGURATION_SCHEMA" packages/{authz-queue,configuration-http,users,users-http,http-socket,queue-http-progress,authz-testing,authz-convert}/{src,test}`
Expected: no output.

- [ ] **Step 2: Every consumer suite**

Run each, in this order (dependencies first):

```bash
cd packages/authz-testing && npm test
cd ../authz-queue && npm test
cd ../queue-http-progress && npm test
cd ../configuration-http && npm test
cd ../users && npm test
cd ../users-http && npm test
cd ../http-socket && npm test
cd ../authz-convert && npm test
```

Expected: each ends with `0 failing`.

- [ ] **Step 3: Root build and snapshot**

Run (repo root): `npm run build && node scripts/api-snapshot.mjs --check`
Expected: success; this lane changed no snapshotted file (`authz-queue/src/api.ts` and `authz-testing/src/rebac.ts` are untouched).

- [ ] **Step 4: Commit any fix-ups**

```bash
git add -A packages
git commit -m "chore: lane L5 verification fixes"
```

(Skip when nothing changed.)

---

## Contract issues found

All resolved in `00-overview.md` (2026-10-14):

1. Typed owner: accepted (`Owner(opts?: { typeColumn?: string })`, `registerAccessResource(..., { owner: { column, typeColumn } })`); Task 6 uses it. Owner/self list terms are `relation.owner` / `relation.self` with `{ principals: { type, id }[] }`; the kit's `ownedRows()` emits that.
2. `.unscoped(reason)` and `authz.orm.domain` (default `root`) are in the names table.
3. The runtime guard skips selects on exactly one primary-key value (decision 11). configuration-http still loads by slug as SYSTEM: the slug is not the primary key, and conditional grants need a row check anyway.
4. Class names of the write middleware, adapter, contributor and migrations are read in Task 0 (Task 9's unregister list uses them).
5. Kit list support: this lane owns `ListStaticModel` (Task 1).
6. L11 SSE: `authz.changed` with `AccessChangedEvent` JSON and reason `subject_mismatch`, as Task 5 assumes.
