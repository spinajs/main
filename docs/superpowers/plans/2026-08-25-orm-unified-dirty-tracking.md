# ORM Unified Dirty Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse `ModelBase`'s three change-tracking mechanisms (Proxy dirty list, snapshot diff, implicit "persisted" flag) into one snapshot-derived API — `IsNew`, `IsDirty`, `changes()` — and make yourscreen-backend record entity history from it through `@ChangeTracked` + `_update_tracked`.

**Architecture:** One private field, `__snapshot__`, is the only state; `IsNew`, `IsDirty` and `changes()` are computed from it on demand, and every read/write path ends in `takeSnapshot()`. The Proxy, `__dirty_props__`, `markDirty()`, `changedColumns()` and the `IsDirty` setter are deleted. The backend gains a `@ChangeTracked(resource)` model decorator and an FP chain step `_update_tracked(tag, opts)` = diff → `update()` → emit, replacing the hand-rolled `_dto_changes`.

**Tech Stack:** TypeScript (ESM), `@spinajs/orm` 2.0.x monorepo (mocha + chai + sinon, `ts-mocha`), sqlite integration suite in `packages/orm-sqlite`; yourscreen-backend monorepo (`common` → `features` → `backend`, mocha over a local MySQL stack).

Spec: `docs/superpowers/specs/2026-08-25-orm-unified-dirty-tracking-design.md` (this repo).

## Global Constraints

- All code, comments, commit messages and identifiers in English.
- Two repositories, two branches:
  - spinajs: `c:\Users\grzch\SourceCodes\Spinajs\main`, branch `feat/orm-unified-dirty-tracking` (already created, spec committed there). Tasks 1–5.
  - yourscreen-backend: `c:\Users\grzch\SourceCodes\Screennetwork\agentic_development\agent-1\yourscreen-backend`, create branch `feat/entity-history-model-changes` off `main` at the start of Task 6. Tasks 6–12.
- Line numbers in **Modify:** entries are as of spinajs commit `236fde07a` / backend commit `6e752842`; they shift as earlier steps land — locate by the quoted code, not the number.
- spinajs unit tests (`packages/orm`): `cd packages/orm && npx ts-mocha -p tsconfig.json test/<file>.test.ts`. Full package: `npm test` there.
- spinajs sqlite tests (`packages/orm-sqlite`) import `@spinajs/orm` from `packages/orm/lib/mjs` — **rebuild `orm` first**: `cd packages/orm && npm run compile`. Then `cd packages/orm-sqlite && npx ts-mocha -p tsconfig.json test/<file>.test.ts`.
- yourscreen-backend consumes spinajs through symlinks in `node_modules/@spinajs/*` → the same `npm run compile` in `packages/orm` is what the backend sees.
- yourscreen-backend `@screen-network/common` resolves to `packages/common/build` (no `development` export condition) — **rebuild after every edit in `common`**: `cd packages/common && npm run compile`. `@screen-network/features` resolves to `src` under the test runner's `conditions=development`, so features edits need no rebuild for tests.
- yourscreen-backend tests need the local stack: from `packages/backend`, `node scripts/local-suite.mjs up` once (Docker MySQL/ActiveMQ/mailpit). Single file: create the untracked config `packages/backend/.mocharc.scoped.json` (contents in Task 6) and run `node --env-file-if-exists=.env ../../node_modules/mocha/bin/mocha.js --config .mocharc.scoped.json --exit test/<path>.test.ts` from `packages/backend`. (Mocha concatenates the config's `spec` with CLI paths, which is why a config without `spec` is needed.)
- Persisted contract that must not change: entity-history change records are `{ Column, OldValue, NewValue }` (JSON in `entity_change.changes`, read by the frontend by key name); resource strings `arrow-offer`, `arrow-campaign`, `campaign-comment`, `content-entry`, `entries-group`.
- No manual version bumps in spinajs; CI cuts `2.0.x`.
- Do not add dependencies to any `package.json` (the root lockfile is not regenerated in this plan). `@spinajs/exceptions` is importable from `common` without a declared dependency — `models/yourscreen/player-content/Entries.ts` already does so.

---

## Task 1: `IModelChange` and `baselineValue` in `snapshot.ts`

**Files:**
- Modify: `packages/orm/src/snapshot.ts:36-37` (after the `UNCOPYABLE` export)
- Test: `packages/orm/test/snapshot.test.ts`

**Interfaces:**
- Produces: `interface IModelChange { Column: string; OldValue: unknown; NewValue: unknown }` and `baselineValue(value: unknown): unknown` (both exported from `@spinajs/orm` via the existing `export * from './snapshot.js'` in `index.ts`).

- [ ] **Step 1: Write the failing test**

In `packages/orm/test/snapshot.test.ts`, change the import line to:

```ts
import { baselineValue, createSnapshot, snapshotEquals, snapshotValue, UNCOPYABLE } from '../src/snapshot.js';
```

and add, inside `describe('snapshot primitives', ...)` after the last existing `describe` block:

```ts
  describe('baselineValue', () => {
    it('passes an ordinary baseline through untouched', () => {
      const obj = { a: 1 };

      expect(baselineValue(1)).to.equal(1);
      expect(baselineValue(null)).to.equal(null);
      expect(baselineValue(undefined)).to.equal(undefined);
      expect(baselineValue(obj)).to.equal(obj);
    });

    it('maps the UNCOPYABLE marker to undefined so it never leaks into a change record', () => {
      expect(baselineValue(UNCOPYABLE)).to.equal(undefined);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/snapshot.test.ts`
Expected: compile error `Module '"../src/snapshot.js"' has no exported member 'baselineValue'`.

- [ ] **Step 3: Implement**

In `packages/orm/src/snapshot.ts`, directly after `export const UNCOPYABLE = Symbol('spinajs.orm.snapshot.uncopyable');` add:

```ts

/** One column-level difference between a model's baseline and its current values. */
export interface IModelChange {
  Column: string;
  OldValue: unknown;
  NewValue: unknown;
}

/**
 * The baseline value as a change record may carry it. `UNCOPYABLE` is an internal marker for a
 * value the snapshot could not copy; it must never leak out of the ORM, so it is reported as
 * `undefined` ( "no usable old value" ) while the column itself is still reported as changed.
 */
export function baselineValue(value: unknown): unknown {
  return value === UNCOPYABLE ? undefined : value;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/snapshot.test.ts`
Expected: all passing, including the two new `baselineValue` cases.

- [ ] **Step 5: Commit**

```bash
git add packages/orm/src/snapshot.ts packages/orm/test/snapshot.test.ts
git commit -m "feat(orm): IModelChange and baselineValue snapshot primitives"
```

---

## Task 2: `IsNew`, `changes()` and the single diff on `ModelBase` (additive)

The old members stay in this task so the package keeps compiling; they go in Task 4.

**Files:**
- Modify: `packages/orm/src/model.ts:15` (snapshot import), `:261-263` (after `clearSnapshot()`)
- Modify: `packages/orm/src/interfaces.ts:20`, `:826-841`
- Test: `packages/orm/test/modelSnapshot.test.ts`

**Interfaces:**
- Consumes: `IModelChange`, `baselineValue` (Task 1); existing `snapshotEquals`, `snapshotColumns()`, `RelationType` (already imported in `model.ts`).
- Produces on `ModelBase` / `IModelBase`: `readonly IsNew: boolean`, `changes(): IModelChange[]`, and `private diff(stopAtFirst: boolean): IModelChange[]`.

- [ ] **Step 1: Write the failing tests**

In `packages/orm/test/modelSnapshot.test.ts` add to the imports:

```ts
import { Model4 } from './mocks/models/Model4.js';
import { UNCOPYABLE } from '../src/snapshot.js';
```

and add these cases inside `describe('ModelBase snapshot', ...)`, before its closing `});`:

```ts
  it('IsNew is true until a snapshot exists and true again after clearSnapshot', () => {
    const m = new Model1();
    expect(m.IsNew).to.equal(true);

    m.takeSnapshot();
    expect(m.IsNew).to.equal(false);

    m.clearSnapshot();
    expect(m.IsNew).to.equal(true);
  });

  it('changes() reports every column with OldValue undefined when there is no snapshot', () => {
    const m = new Model1();
    m.Id = 1;
    m.Bar = 'x';

    const changes = m.changes();

    expect(changes.find((c) => c.Column === 'Bar')).to.deep.equal({ Column: 'Bar', OldValue: undefined, NewValue: 'x' });
    expect(changes.map((c) => c.Column)).to.include('Id');
  });

  it('changes() is empty right after takeSnapshot', () => {
    const m = new Model1();
    m.Id = 1;
    m.Bar = 'x';
    m.takeSnapshot();

    expect(m.changes()).to.deep.equal([]);
  });

  it('changes() names exactly the differing columns with old and new values', () => {
    const m = new Model1();
    m.Id = 1;
    m.Bar = 'x';
    m.takeSnapshot();

    m.Bar = 'y';

    expect(m.changes()).to.deep.equal([{ Column: 'Bar', OldValue: 'x', NewValue: 'y' }]);
  });

  it('changes() ignores a write that restores the original value', () => {
    const m = new Model1();
    m.Bar = 'x';
    m.takeSnapshot();

    m.Bar = 'y';
    m.Bar = 'x';

    expect(m.changes()).to.deep.equal([]);
  });

  it('changes() sees an in-place mutation of a mutable column value', () => {
    const m = new Model1() as any;
    m.Bar = { tags: ['a'] };
    m.takeSnapshot();

    m.Bar.tags.push('b');

    expect(m.changes()).to.deep.equal([{ Column: 'Bar', OldValue: { tags: ['a'] }, NewValue: { tags: ['a', 'b'] } }]);
  });

  it('changes() compares DateTime by instant, not identity', () => {
    const m = new Model1() as any;
    m.Bar = DateTime.fromISO('2020-01-01T00:00:00.000Z');
    m.takeSnapshot();

    m.Bar = DateTime.fromISO('2020-01-01T00:00:00.000Z');
    expect(m.changes()).to.deep.equal([]);

    m.Bar = DateTime.fromISO('2021-01-01T00:00:00.000Z');
    expect(m.changes().map((c) => c.Column)).to.deep.equal(['Bar']);
  });

  it('changes() compares a Buffer by content', () => {
    const m = new Model1() as any;
    m.Bar = Buffer.from('ab');
    m.takeSnapshot();

    m.Bar = Buffer.from('ab');
    expect(m.changes()).to.deep.equal([]);

    m.Bar = Buffer.from('ac');
    expect(m.changes().map((c) => c.Column)).to.deep.equal(['Bar']);
  });

  it('changes() reports an UNCOPYABLE baseline as changed, with OldValue undefined', () => {
    class Opaque {
      constructor(public v: number) {}
    }
    const m = new Model1() as any;
    m.Bar = new Opaque(1);
    m.takeSnapshot();

    expect(m.Snapshot!.Columns.get('Bar')).to.equal(UNCOPYABLE);
    expect(m.changes()).to.deep.equal([{ Column: 'Bar', OldValue: undefined, NewValue: m.Bar }]);
  });

  it('changes() reports a belongsTo foreign key re-pointed through the relation', () => {
    const m = new Model1();
    (m as any).OwnerId = 1;
    m.takeSnapshot();

    m.Owner.attach(new Model4({ Id: 2 }));

    expect(m.changes()).to.deep.equal([{ Column: 'OwnerId', OldValue: 1, NewValue: 2 }]);
  });

  it('changes() reports a detached belongsTo as a change to null', () => {
    const m = new Model1();
    (m as any).OwnerId = 1;
    m.takeSnapshot();

    m.Owner.detach();

    expect(m.changes()).to.deep.equal([{ Column: 'OwnerId', OldValue: 1, NewValue: null }]);
  });

  it('changes() does not report a belongsTo that was never attached or populated', () => {
    const m = new Model1();
    (m as any).OwnerId = 1;
    m.takeSnapshot();

    expect(m.Owner.Value).to.equal(undefined);
    expect(m.changes()).to.deep.equal([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/modelSnapshot.test.ts`
Expected: compile errors `Property 'IsNew' does not exist on type 'Model1'` / `Property 'changes' does not exist`.

- [ ] **Step 3: Implement**

`packages/orm/src/model.ts` line 15 — extend the snapshot import:

```ts
import { baselineValue, createSnapshot, IModelChange, IModelSnapshot, snapshotEquals, snapshotValue } from './snapshot.js';
```

Directly after the `clearSnapshot()` method (ends `this.__snapshot__ = null; }`) insert:

```ts

  /**
   * `true` until the row has been in the database: the diff baseline is `null`. This is what
   * classifies the model as an INSERT - not the presence of a primary key, because
   * `setDefaults()` pre-fills @Uuid keys on construction.
   */
  public get IsNew(): boolean {
    return this.__snapshot__ === null;
  }

  /**
   * Every persisted column whose current value differs from the baseline, in descriptor column
   * order, followed by any @BelongsTo foreign key whose relation was re-pointed without a column
   * write. On a model with no baseline every column is reported with `OldValue: undefined`.
   *
   * Computed on demand - nothing observes writes - so an in-place mutation of a JSON column is
   * seen exactly like an assignment. Call it once and reuse the result rather than polling it
   * in a loop.
   */
  public changes(): IModelChange[] {
    return this.diff(false);
  }

  /**
   * The single diff. `stopAtFirst` lets a boolean question return as soon as one change is found.
   */
  private diff(stopAtFirst: boolean): IModelChange[] {
    const columns = this.snapshotColumns();
    const snap = this.__snapshot__?.Columns;
    const out: IModelChange[] = [];

    for (const c of columns) {
      const current = (this as any)[c.Name];
      if (!snap || !snapshotEquals(snap.get(c.Name), current, c.Converter)) {
        out.push({ Column: c.Name, OldValue: baselineValue(snap?.get(c.Name)), NewValue: current });
        if (stopAtFirst) {
          return out;
        }
      }
    }

    // A @BelongsTo re-pointed via SingleRelation.attach() writes no column: toSql() materialises
    // the foreign key from Value.PrimaryKeyValue at write time, so it is derived the same way
    // here. `Value === undefined` means never attached and never populated - nothing to report.
    for (const [, r] of this.ModelDescriptor?.Relations ?? []) {
      if (r.Type !== RelationType.One || !r.ForeignKey) {
        continue;
      }
      if (out.some((x) => x.Column === r.ForeignKey)) {
        continue;
      }

      const rel = (this as any)[r.Name];
      if (!rel || rel.Value === undefined) {
        continue;
      }

      const target = rel.Value === null ? null : rel.Value.PrimaryKeyValue;
      const converter = columns.find((c) => c.Name === r.ForeignKey)?.Converter;

      if (!snap || !snapshotEquals(snap.get(r.ForeignKey), target, converter)) {
        out.push({ Column: r.ForeignKey, OldValue: baselineValue(snap?.get(r.ForeignKey)), NewValue: target });
        if (stopAtFirst) {
          return out;
        }
      }
    }

    return out;
  }
```

`packages/orm/src/interfaces.ts` line 20:

```ts
import type { IModelChange, IModelSnapshot } from './snapshot.js';
```

and in `IModelBase`, after the `Snapshot: IModelSnapshot | null;` member add:

```ts
  /** `true` until the row has been in the database - there is no diff baseline. */
  readonly IsNew: boolean;
```

and after the `changedColumns(): string[];` member add:

```ts
  /** Column-level differences between the baseline and the current values, old and new. */
  changes(): IModelChange[];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/modelSnapshot.test.ts`
Expected: all passing (the pre-existing `changedColumns`/`markDirty` cases still pass — they are removed in Task 4).

- [ ] **Step 5: Commit**

```bash
git add packages/orm/src/model.ts packages/orm/src/interfaces.ts packages/orm/test/modelSnapshot.test.ts
git commit -m "feat(orm): IsNew and changes() derived from the snapshot"
```

---

## Task 3: Every write path uses the diff and re-baselines

`insert()`, `refresh()` and `archive()` gain `takeSnapshot()`; `update()`, `toSql(onlyDirty)`, the subject builder and the relation update gate read `changes()` / `IsNew`. The `IsDirty = false` resets stay for now (Task 4 deletes them with the setter).

**Files:**
- Modify: `packages/orm/src/model.ts` — `toSql()` (~694), `archive()` (~727), `update()` docblock + body (~737-790), `insert()` tail (~846-851), `refresh()` (~913-923)
- Modify: `packages/orm/src/subject-builder.ts:128`, `:331-344`
- Modify: `packages/orm/src/relation-objects.ts:706-709`
- Modify: `packages/orm/test/model.test.ts:656-667`
- Create: `packages/orm-sqlite/test/rebaseline.test.ts`

**Interfaces:**
- Consumes: `IsNew`, `changes()` (Task 2).
- Produces: `insert()` now awaits its statement and returns the resolved insert result; after `insert()` / `refresh()` / `archive()` the model has a fresh snapshot.

- [ ] **Step 1: Write the failing tests**

Create `packages/orm-sqlite/test/rebaseline.test.ts`:

```ts
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import { bootUow, captureStatements, registerUowConnection, rows, UowOrder } from './uowFixture.js';

describe('re-baseline after insert / refresh', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  it('insert() leaves the model with a snapshot that includes the generated key', async () => {
    const order = new UowOrder({ Total: 10 });

    await order.insert();

    expect(order.IsNew).to.equal(false);
    expect(order.Snapshot!.Columns.get('Id')).to.equal(order.Id);
    expect(order.changes()).to.deep.equal([]);
  });

  it('update() after insert() on the same instance writes only the changed column', async () => {
    const order = new UowOrder({ Total: 10 });
    await order.insert();

    order.Total = 20;

    const capture = captureStatements();
    await order.update();
    capture.restore();

    const updates = capture.statements.filter((s) => /^update/i.test(s.expression.trim()));
    expect(updates).to.have.length(1);
    expect(updates[0].expression).to.contain('`Total`');
    expect(updates[0].expression).to.not.contain('`client_id`');
    expect((await rows('uow_order'))[0].Total).to.equal(20);
  });

  it('refresh() re-baselines to what the database holds', async () => {
    const order = new UowOrder({ Total: 10 });
    await order.insert();

    // Change the row behind this instance's back.
    const other = await UowOrder.where({ Id: order.Id }).first();
    other.Total = 55;
    await other.update();

    await order.refresh();

    expect(order.Total).to.equal(55);
    expect(order.Snapshot!.Columns.get('Total')).to.equal(55);
    expect(order.changes()).to.deep.equal([]);
  });
});
```

In `packages/orm/test/model.test.ts` replace the test `'refresh clears dirty state'` (lines 656-667) with:

```ts
  it('refresh re-baselines the snapshot to the fresh values', async () => {
    await db();

    const model = new Model1({ Id: 1 });
    const fresh = new Model1({ Id: 999, Bar: 'refreshed' });
    sinon.stub(model, 'fresh').resolves(fresh);

    await model.refresh();

    expect(model.IsDirty).to.be.false;
    expect(model.Snapshot).to.not.equal(null);
    expect(model.Snapshot!.Columns.get('Bar')).to.eq('refreshed');
    expect(model.changes()).to.deep.equal([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/model.test.ts`
Expected: `refresh re-baselines the snapshot to the fresh values` fails — `expected null not to equal null`.

Run: `cd packages/orm && npm run compile && cd ../orm-sqlite && npx ts-mocha -p tsconfig.json test/rebaseline.test.ts`
Expected: first case fails with `expected true to equal false` (no snapshot after insert); second case fails on the statement count or on `client_id` being written.

- [ ] **Step 3: Implement**

`packages/orm/src/model.ts`:

`toSql()`:

```ts
  public toSql(onlyDirty?: boolean): Partial<this> {
    const vals = this.Container.resolve(ModelToSqlConverter).toSql(this) as Partial<this>;

    if (onlyDirty) {
      return _.pick(vals, this.changes().map((c) => c.Column));
    }

    return vals;
  }
```

`archive()` — replace `return await query;` with:

```ts
    const result = await query;

    // The whole model is in the database now - that is the baseline for the next update().
    this.takeSnapshot();

    return result;
```

`update()` — replace the docblock and the change-set computation:

```ts
  /**
   * Writes the columns that differ from the snapshot.
   *
   * The change set is `changes()` - the snapshot diff, which also covers a foreign key that was
   * re-pointed through its relation - so re-assigning a column its current value produces no
   * UPDATE, and a column written A -> B -> A is not written back.
   *
   * A model with no snapshot ( never hydrated ) reports every column as changed, which is the
   * right answer: there is no baseline to be more precise than.
   *
   * @param data - optional patch hydrated onto the model first
   */
  public async update(data?: Partial<this>) {
    const result = {
      RowsAffected: 0,
      LastInsertId: 0,
    };

    if (data) {
      this.hydrate(data);
    }

    const keyColumns = this.ModelDescriptor!.PrimaryKey ?? [];
    const changed = this.changes()
      .map((c) => c.Column)
      .filter((c) => !keyColumns.includes(c));
```

(the rest of `update()` — the empty check, `UpdatedAt` stamping, the query, `IsDirty = false`, `takeSnapshot()` — stays as it is).

`insert()` tail — replace

```ts
    const result = query.values(this.toSql());

    this.IsDirty = false;

    return result;
```

with

```ts
    // Awaited here, not by the caller: the afterQuery middleware above backfills a generated key
    // during execution, and the snapshot must include it. Taken only after the await - a throw
    // leaves the model exactly as dirty as it was.
    const result = await query.values(this.toSql());

    this.IsDirty = false;
    this.takeSnapshot();

    return result;
```

`refresh()` — replace the final `this.IsDirty = false;` with:

```ts
    // Every column now holds what the database holds - that is the new baseline, not the one
    // captured before the refresh.
    this.IsDirty = false;
    this.takeSnapshot();
```

`packages/orm/src/subject-builder.ts` line 128:

```ts
        subject.ChangedColumns = model.changes().map((c) => c.Column);
```

and `classify()`:

```ts
/**
 * `Insert` when the model has never been in the database, `Update` when its snapshot diff is
 * non-empty, `None` otherwise.
 *
 * Deliberately not keyed on the primary key: `setDefaults()` pre-fills @Uuid keys on
 * construction, so a brand-new UUID-keyed model already has one.
 */
function classify(model: ModelBase): SubjectOperation {
  if (model.IsNew) {
    return SubjectOperation.Insert;
  }

  return model.changes().length > 0 ? SubjectOperation.Update : SubjectOperation.None;
}
```

`packages/orm/src/relation-objects.ts` `_update()` — replace the two comment lines and the filter:

```ts
    // A fresh model ( never in the database ) is inserted; a loaded one is written when the key
    // assignment above - or any other write - moved it away from its snapshot.
    const dirty = this.filter((x) => x.IsNew || x.IsDirty);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/orm && npm test`
Expected: all passing.

Run: `cd packages/orm && npm run compile && cd ../orm-sqlite && npm test`
Expected: all passing, including `rebaseline.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/orm/src packages/orm/test/model.test.ts packages/orm-sqlite/test/rebaseline.test.ts
git commit -m "fix(orm): write paths read changes() and re-baseline after insert, refresh and archive"
```

---

## Task 4: Delete the Proxy and the dirty list; `IsDirty` becomes derived

**Files:**
- Modify: `packages/orm/src/model.ts` — `MODEL_PROXY_HANDLER` (26-38), class fields (73-95), `changedColumns()` / `relationDirtyColumns()` / `markDirty()` (264-339), `diff()` second loop, constructor (598-606), `attach()` (637, 664), `destroy()` (718), `update()` (769, 787), `insert()`, `refresh()`
- Modify: `packages/orm/src/converters.ts` `StandardModelToSqlConverter.toSql()` (~149-157)
- Modify: `packages/orm/src/interfaces.ts:822-844`
- Modify: `packages/orm/src/builders.ts:143`
- Modify: `packages/orm/src/subject-executor.ts:92`, `:102`, `:117`, `:139`
- Modify: `packages/orm/src/subject-builder.ts` `classify()`
- Modify: `packages/orm/src/relation-objects.ts:323-345`, `_update()` filter
- Modify: `packages/orm/src/metadata.ts:125-128`
- Test (rewrite): `packages/orm/test/modelSnapshot.test.ts`, `packages/orm/test/model.test.ts:636-654`, `:1437`, `packages/orm/test/metadata-lowercase.test.ts:62-85`, `packages/orm/test/relation-populate.test.ts:87`, `packages/orm/test/relation.test.ts:1301`
- Test (rewrite): `packages/orm-sqlite/test/markDirty.test.ts` → `packages/orm-sqlite/test/attachDiff.test.ts`, `packages/orm-sqlite/test/attach.test.ts:44-55`, `packages/orm-sqlite/test/snapshotCapture.test.ts:43,53,62`, `packages/orm-sqlite/test/uowExecutor.test.ts:55,163`

**Interfaces:**
- Consumes: `IsNew`, `changes()`, `diff()` (Task 2).
- Produces: `readonly IsDirty: boolean` (getter only); `markDirty`, `relationDirtyColumns`, `changedColumns`, the `IsDirty` setter and the constructor Proxy no longer exist. `SingleRelation.attach(obj)` now also writes the owner's foreign-key column (target key, or `null`); `toSql()` writes `NULL` for a detached relation and keeps the raw column for a relation that was never attached or whose `populate()` found no row.

Why the write-path fix lives here (decided during execution, after the Task 3 review): `toSql()` treated a detached relation (`Value === null`) like an untouched one and wrote the old key back, so `detach()` + `update()` and `SingleRelation.remove()` never cleared the foreign key — and once `changes()` drives `update()`, the relation (`null`) and the column/snapshot (old id) disagree forever and the model never converges. The column must follow the relation and the write path must honour a detach.

- [ ] **Step 1: Write the failing tests (unit)**

`packages/orm/test/modelSnapshot.test.ts`:

1. In `'takeSnapshot skips Virtual columns, ...'` replace `expect(m.changedColumns()).to.not.include('Owner');` with `expect(m.changes().map((c) => c.Column)).to.not.include('Owner');`.
2. Delete these seven cases outright (Task 2 added their `changes()` equivalents): `'changedColumns is empty right after takeSnapshot'`, `'changedColumns names only the columns that actually differ'`, `'changedColumns ignores a write that restores the original value'`, `'changedColumns compares DateTime by instant, not identity'`, `'changedColumns lists every column when there is no snapshot'`, `'markDirty records the property and flips IsDirty'`, `'markDirty does not record the same property twice'`.
3. Add before the closing `});` of the describe:

```ts
  it('IsDirty is true on a model that was never in the database', () => {
    const m = new Model1();
    expect(m.IsDirty).to.equal(true);
  });

  it('IsDirty is false right after takeSnapshot and true after a column write', () => {
    const m = new Model1();
    m.Bar = 'x';
    m.takeSnapshot();
    expect(m.IsDirty).to.equal(false);

    m.Bar = 'y';
    expect(m.IsDirty).to.equal(true);
  });

  it('IsDirty is false again once the original value is written back', () => {
    const m = new Model1();
    m.Bar = 'x';
    m.takeSnapshot();

    m.Bar = 'y';
    m.Bar = 'x';

    expect(m.IsDirty).to.equal(false);
  });

  it('IsDirty sees an in-place mutation of a mutable column value', () => {
    const m = new Model1() as any;
    m.Bar = { tags: ['a'] };
    m.takeSnapshot();

    m.Bar.tags.push('b');

    expect(m.IsDirty).to.equal(true);
  });

  it('IsDirty has no setter', () => {
    const m = new Model1();
    m.takeSnapshot();

    expect(() => {
      (m as any).IsDirty = true;
    }).to.throw(TypeError);
  });

  it('a constructed model is a plain instance, not a Proxy', () => {
    const m = new Model1();
    expect(Object.getPrototypeOf(m)).to.equal(Model1.prototype);
    expect(util.types.isProxy(m)).to.equal(false);
  });

  it('toSql(true) is narrowed to the columns changes() reports', () => {
    const m = new Model1();
    m.Id = 1;
    m.Bar = 'x';
    m.takeSnapshot();

    m.Bar = 'y';

    expect(Object.keys(m.toSql(true) as object)).to.deep.equal(['Bar']);
  });
```

and add `import util from 'node:util';` to the imports.

`packages/orm/test/model.test.ts` — replace `'a query-produced model records a dirty prop exactly once'` (lines 636-654) with:

```ts
  it('a query-produced model is clean and reports a single write as its only change', async () => {
    await db();

    sinon.stub(FakeSqliteDriver.prototype, 'execute').returns(
      new Promise((res) => {
        res([
          {
            Id: 1,
          },
        ]);
      }),
    );

    const model = await Model1.get(1);
    expect(model.IsDirty).to.be.false;

    model.Bar = 'changed';

    expect(model.changes().map((c) => c.Column)).to.deep.equal(['Bar']);
  });
```

and at line 1437 replace `model.IsDirty = false;` with `model.takeSnapshot();`.

`packages/orm/test/metadata-lowercase.test.ts` — replace the two tests at lines 62-85 with:

```ts
  it('Should report the value as changed when it is set through the metadata proxy', async () => {
    await db();

    const owner = new LowercaseMetaOwner();
    const existing = new LowercaseMeta({ key: 'foo', value: 'old', owner_id: 13276 } as any);
    existing.takeSnapshot();
    (owner.Metadata as any).push(existing);

    owner.Metadata['foo'] = 'new';

    expect(existing.value).to.eq('new');
    expect(existing.IsDirty).to.be.true;
    expect(existing.changes()).to.deep.equal([{ Column: 'value', OldValue: 'old', NewValue: 'new' }]);
  });

  it('Should NOT report a change when the value is unchanged', async () => {
    await db();

    const owner = new LowercaseMetaOwner();
    const existing = new LowercaseMeta({ key: 'foo', value: 'same', owner_id: 13276 } as any);
    existing.takeSnapshot();
    (owner.Metadata as any).push(existing);

    owner.Metadata['foo'] = 'same';

    expect(existing.IsDirty).to.be.false;
  });
```

`packages/orm/test/relation-populate.test.ts` line 87: replace `owner.IsDirty = false;` with `owner.takeSnapshot();`.

`packages/orm/test/relation.test.ts` line 1301: replace `child.IsDirty = false;` with `child.takeSnapshot();`.

- [ ] **Step 2: Write the failing tests (sqlite)**

Rename `packages/orm-sqlite/test/markDirty.test.ts` to `packages/orm-sqlite/test/attachDiff.test.ts` (`git mv`) and replace its content with:

```ts
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import { bootUow, registerUowConnection, UowOrder, UowOrderItem } from './uowFixture.js';

describe('SingleRelation.attach change tracking', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  async function loadedItem(): Promise<UowOrderItem> {
    await UowOrder.insert({ Total: 1 });
    await UowOrder.insert({ Total: 2 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });

    return UowOrderItem.where({ Id: 1 }).first();
  }

  it('reports the foreign key with the attached target key as the new value', async () => {
    const item = await loadedItem();
    const target = await UowOrder.where({ Id: 2 }).first();

    item.Order.attach(target);

    expect(item.IsDirty).to.equal(true);
    expect(item.changes()).to.deep.equal([{ Column: 'order_id', OldValue: 1, NewValue: 2 }]);
  });

  it('reports the foreign key once across repeated attaches', async () => {
    const item = await loadedItem();
    const target = await UowOrder.where({ Id: 2 }).first();

    item.Order.attach(target);
    item.Order.attach(target);

    expect(item.changes().filter((c) => c.Column === 'order_id')).to.have.length(1);
  });

  it('reports an attached target that is not saved yet, so a cascade can insert it first', async () => {
    const item = await loadedItem();

    item.Order.attach(new UowOrder({ Total: 9 }));

    const change = item.changes().find((c) => c.Column === 'order_id');
    expect(change).to.not.equal(undefined);
    expect(change!.OldValue).to.equal(1);
    expect(change!.NewValue).to.equal(undefined);
  });

  it('detach reports the foreign key as a change to null', async () => {
    const item = await loadedItem();

    item.Order.detach();

    expect(item.IsDirty).to.equal(true);
    expect(item.changes()).to.deep.equal([{ Column: 'order_id', OldValue: 1, NewValue: null }]);
    expect((item.Order as any).Value).to.equal(null);
  });

  it('attaching the target the row already points at is not a change', async () => {
    const item = await loadedItem();
    const same = await UowOrder.where({ Id: 1 }).first();

    item.Order.attach(same);

    expect(item.IsDirty).to.equal(false);
  });

  it('does not reach into a private dirty list from outside the model', () => {
    const source = (Object.getPrototypeOf(new UowOrderItem({ Sku: 'A', Qty: 1 }).Order) as any).attach.toString();

    expect(source).to.not.contain('__dirty_props__');
    expect(source).to.not.contain('markDirty');
  });
});
```

`packages/orm-sqlite/test/attach.test.ts` — replace `'attaches a belongsTo target and marks the foreign key dirty exactly once'` (lines 44-55) with:

```ts
  it('attaches a belongsTo target and reports the foreign key exactly once', () => {
    const item = new UowOrderItem({ Sku: 'A', Qty: 1, order_id: 5 });
    item.takeSnapshot();
    const order = new UowOrder({ Total: 1 });
    order.Id = 7;

    item.attach(order);
    item.attach(order);

    expect((item.Order as any).Value).to.equal(order);
    expect(item.changes()).to.deep.equal([{ Column: 'order_id', OldValue: 5, NewValue: 7 }]);
  });
```

`packages/orm-sqlite/test/snapshotCapture.test.ts`: line 43 `expect(item.changedColumns()).to.deep.equal([]);` → `expect(item.changes()).to.deep.equal([]);`; line 53 `expect(item.changedColumns()).to.deep.equal(['Val']);` → `expect(item.changes().map((c) => c.Column)).to.deep.equal(['Val']);`; line 62 `expect(c.changedColumns()).to.deep.equal([]);` → `expect(c.changes()).to.deep.equal([]);`.

`packages/orm-sqlite/test/uowExecutor.test.ts`: lines 55 and 163 `expect(order.changedColumns()).to.deep.equal([]);` → `expect(order.changes()).to.deep.equal([]);`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/modelSnapshot.test.ts`
Expected: `IsDirty is true on a model that was never in the database` fails (`expected false to equal true`); `IsDirty has no setter` fails (`expected [Function] to throw TypeError`); `a constructed model is a plain instance` fails (`expected true to equal false`).

- [ ] **Step 4: Implement — `model.ts`**

Delete the whole `const MODEL_PROXY_HANDLER = { ... };` block (lines 26-38).

Replace the class head (from `export class ModelBase<M = unknown> implements IModelBase {` through the `__snapshot__` field, lines 72-103) with:

```ts
export class ModelBase<M = unknown> implements IModelBase {
  private _container: IContainer;

  /**
   * Diff baseline: a value copy of every persisted column, taken when the row was last read
   * from or written to the database. `null` means the row has never been in the database, which
   * is what classifies it as an INSERT - not the presence of a primary key, because
   * `setDefaults()` pre-fills @Uuid keys on construction. Written only by `takeSnapshot()` and
   * `clearSnapshot()`.
   */
  private __snapshot__: IModelSnapshot | null = null;
```

Directly after the `IsNew` getter (Task 2) add:

```ts

  /**
   * Whether `save()` would write anything: a model that has never been in the database, or one
   * with at least one column ( or re-pointed foreign key ) differing from its baseline.
   *
   * Derived from the snapshot on every read - there is no write observer - so it costs one
   * comparison per column until the first difference. There is deliberately no setter: the only
   * way to make a model clean is to persist it or to re-baseline it with `takeSnapshot()`.
   */
  public get IsDirty(): boolean {
    return this.IsNew || this.diff(true).length > 0;
  }
```

Delete the methods `changedColumns()`, `relationDirtyColumns()` and `markDirty()` together with their doc comments (the block between `clearSnapshot()`'s new neighbours and `public valueOf()`).

Constructor — delete the line `return new Proxy(this, MODEL_PROXY_HANDLER);` so it reads:

```ts
  constructor(data?: Partial<M>) {
    this.setDefaults();

    if (data) {
      this.hydrate(data as any);
    }
  }
```

`attach()` — in the `case RelationType.One:` branch delete `this.markDirty(v.ForeignKey);`; at the end of the method delete `this.IsDirty = true;`.

`destroy()` — delete `this.IsDirty = false;`.

`update()` — delete both `this.IsDirty = false;` lines (the one in the `changed.length === 0` branch and the one before `this.takeSnapshot()`).

`insert()` — delete `this.IsDirty = false;` (keep `this.takeSnapshot();`).

`refresh()` — delete `this.IsDirty = false;` (keep `this.takeSnapshot();`).

- [ ] **Step 5: Implement — the other files**

`packages/orm/src/interfaces.ts`, in `IModelBase`: change `IsDirty: boolean;` to `readonly IsDirty: boolean;` and update its comment to `/** Whether save() would write anything. Derived from the snapshot; no setter. */`; delete the `changedColumns(): string[];` member and the `markDirty(prop: string): void;` member, each with its comment.

`packages/orm/src/builders.ts` line 143: delete `model.IsDirty = false;`.

`packages/orm/src/subject-executor.ts`: delete `model.IsDirty = false;` (line 92) and `subject.Model.IsDirty = false;` (line 117).

`packages/orm/src/subject-builder.ts` `classify()` — the last line becomes:

```ts
  return model.IsDirty ? SubjectOperation.Update : SubjectOperation.None;
```

`packages/orm/src/relation-objects.ts` — replace `attach()` and its doc comment (lines 323-345) with:

```ts
  /**
   * Points this relation at `obj` and writes the owner's foreign-key column to match: the
   * target's key, or NULL when detaching. No database access.
   *
   * The column is what the snapshot records and what the diff compares, so it has to follow
   * the relation - otherwise a detach would leave column and relation disagreeing and the model
   * dirty forever. An unsaved target has no key yet, so the column holds `undefined` until the
   * unit of work inserts the parent and backfills it; `toSql()` reads the key off `Value` at
   * write time either way.
   *
   * @param obj - the related model, or null to clear the relation
   */
  public attach(obj: R | null) {
    this.Value = obj;

    const foreignKey = this.Relation?.ForeignKey;
    if (foreignKey) {
      (this._owner as any)[foreignKey] = obj === null ? null : obj.PrimaryKeyValue;
    }
  }
```

and in `_update()` the filter becomes `const dirty = this.filter((x) => x.IsDirty);` with the comment:

```ts
    // A fresh model ( never in the database ) is dirty by definition; a loaded one is dirty when
    // the key assignment above - or any other write - moved it away from its snapshot.
```

`packages/orm/src/metadata.ts` lines 125-128 — delete `x.IsDirty = true;`:

```ts
            found.forEach((x) => {
              if (x.Value === value) return;
              x.Value = value;
            });
```

`packages/orm/src/subject-executor.ts` `updatePayload()` (~line 139): `const changed = subject.Model.changedColumns().filter((c) => !keyColumns.includes(c));` → `const changed = subject.Model.changes().map((c) => c.Column).filter((c) => !keyColumns.includes(c));`; in the `runUpdates()` doc comment (~line 102) replace `` `changedColumns()` `` with `` `changes()` ``.

- [ ] **Step 5b: Write the failing tests — detach must persist and converge**

Append to `packages/orm-sqlite/test/attachDiff.test.ts` (inside the describe; add `UowClient` and `rows` to the `./uowFixture.js` import):

```ts
  async function orderWithClient(): Promise<UowOrder> {
    await UowClient.insert({ Name: 'acme' });
    await UowOrder.insert({ Total: 1, client_id: 1 });

    return UowOrder.where({ Id: 1 }).first();
  }

  it('detach() then update() writes NULL and leaves the model clean', async () => {
    const order = await orderWithClient();

    order.Client.detach();
    await order.update();

    expect((await rows('uow_order'))[0].client_id).to.equal(null);
    expect(order.IsDirty).to.equal(false);
    expect(order.changes()).to.deep.equal([]);
  });

  it('remove() deletes the target and clears the foreign key', async () => {
    const order = await orderWithClient();
    await order.Client.populate();

    await order.Client.remove();

    expect(await rows('uow_client')).to.have.length(0);
    expect((await rows('uow_order'))[0].client_id).to.equal(null);
    expect(order.IsDirty).to.equal(false);
  });

  it('populate() that finds no row is a read, not a detach', async () => {
    await UowOrder.insert({ Total: 1, client_id: 42 });
    const order = await UowOrder.where({ Id: 1 }).first();

    await order.Client.populate();

    expect(order.Client.Value).to.equal(null);
    expect(order.IsDirty).to.equal(false);
    expect(order.toSql().client_id).to.equal(42);
  });
```

Run: `cd packages/orm && npm run compile && cd ../orm-sqlite && npx ts-mocha -p tsconfig.json test/attachDiff.test.ts`
Expected: `detach() then update() writes NULL` fails (`expected 1 to equal null` — `toSql()` fell back to the raw column) and `remove() ... clears the foreign key` fails the same way.

- [ ] **Step 5c: Implement — the write path honours a detached relation, the diff mirrors it**

`packages/orm/src/converters.ts`, `StandardModelToSqlConverter.toSql()`, the `RelationType.One` branch (lines ~149-157) becomes:

```ts
      if (val.Type === RelationType.One) {
        const relation = (model as any)[val.Name];
        if (relation?.Value) {
          (obj as any)[val.ForeignKey] = relation.Value.PrimaryKeyValue;
        } else if ((model as any)[val.ForeignKey] != null) {
          // Never attached, or populate() found no row for the key the row carries: the raw
          // column is the value. Without this, InsertOrUpdate emits the FK as an empty binding
          // and orphans the row.
          (obj as any)[val.ForeignKey] = (model as any)[val.ForeignKey];
        } else if (relation && relation.Value === null) {
          // Detached: attach(null) cleared the relation AND the column, and that is what a
          // detach means for the row - the key is written as NULL.
          (obj as any)[val.ForeignKey] = null;
        }
      }
```

`packages/orm/src/model.ts` `diff()` — the second loop. Replace the comment above it and its body so that a relation holding a target overrides the column-loop entry instead of being skipped, while a null/undefined `Value` leaves the column loop authoritative:

```ts
    // A @BelongsTo whose relation holds a target is written from that target - toSql() reads
    // Value.PrimaryKeyValue at write time - so the target's key is the value the diff compares,
    // not the column. That covers a re-point through attach() ( which also writes the column,
    // possibly `undefined` for an unsaved target ) and the back-references the relation
    // machinery assigns to `Value` directly. A relation holding null or undefined decides
    // nothing: the column - NULL after a detach, untouched after a populate() that found no
    // row - is what toSql() writes, and the column loop above already compared it.
    for (const [, r] of this.ModelDescriptor?.Relations ?? []) {
      if (r.Type !== RelationType.One || !r.ForeignKey) {
        continue;
      }

      const rel = (this as any)[r.Name];
      if (!rel || !rel.Value) {
        continue;
      }

      const target = rel.Value.PrimaryKeyValue;
      const converter = columns.find((c) => c.Name === r.ForeignKey)?.Converter;
      const existing = out.findIndex((x) => x.Column === r.ForeignKey);

      if (!snap || !snapshotEquals(snap.get(r.ForeignKey), target, converter)) {
        const change = { Column: r.ForeignKey, OldValue: baselineValue(snap?.get(r.ForeignKey)), NewValue: target };
        if (existing >= 0) {
          out[existing] = change;
        } else {
          out.push(change);
          if (stopAtFirst) {
            return out;
          }
        }
      } else if (existing >= 0) {
        // The column was written to something else, but the relation wins at write time and
        // its target equals the baseline: no change reaches the database.
        out.splice(existing, 1);
      }
    }

    return out;
```

Then re-run the Task 2 unit cases and the new sqlite cases:

Run: `cd packages/orm && npx ts-mocha -p tsconfig.json test/modelSnapshot.test.ts`
Expected: all passing (the belongsTo cases still hold: attach now writes the column, and the relation override yields the same single entry).

Run: `cd packages/orm && npm run compile && cd ../orm-sqlite && npx ts-mocha -p tsconfig.json test/attachDiff.test.ts`
Expected: all passing, including the three Step 5b cases.

- [ ] **Step 6: Verify nothing references the deleted members**

Run: `cd packages/orm && grep -rn "markDirty\|__dirty_props__\|__is_dirty__\|changedColumns\|relationDirtyColumns\|MODEL_PROXY_HANDLER\|IsDirty = " src`
Expected: no output.

Run: `cd packages/orm-sqlite && grep -rn "markDirty\|__dirty_props__\|changedColumns\|IsDirty = " test`
Expected: no output.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/orm && npm test`
Expected: all passing.

Run: `cd packages/orm && npm run compile && cd ../orm-sqlite && npm test`
Expected: all passing, including `attachDiff.test.ts`, `attach.test.ts`, `snapshotCapture.test.ts`, `uowExecutor.test.ts`, `uowSubject.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add -A packages/orm/src packages/orm/test packages/orm-sqlite/test
git commit -m "feat(orm)!: snapshot-derived IsDirty; remove the Proxy, the dirty list, markDirty and changedColumns"
```

---

## Task 5: Documentation, release notes, downstream compile check

**Files:**
- Modify: `packages/orm/docs/05-instance-api.md:36-37`, `:90-145`, `:204-209`, `:219-226`, `:244-247`, `:288-291`, `:341-342`
- Modify: `packages/orm/docs/07-relations.md:352`, `:424`, `:470-473`, `:494-495`
- Modify: `packages/orm/docs/08-unit-of-work.md:200-201`, `:354`
- Modify: `packages/orm/docs/12-architecture.md:46`
- Modify: `RELEASE_NOTES.md` (prepend)

- [ ] **Step 1: `05-instance-api.md`**

Replace list item 3 of "The constructor does three things" (lines 36-37) with:

```
3. That is all. A model is a plain instance — there is no `Proxy` and no write observer. Change
   detection is a diff against the snapshot, described under *Dirty tracking and snapshots*.
```

Replace everything from the line `## Dirty tracking and snapshots` up to (not including) the next `## ` heading with:

````
## Dirty tracking and snapshots

One mechanism: the **snapshot**, a value copy of every persisted column taken when the row was
last read from or written to the database. Everything else is derived from it on demand.

| Member | Meaning |
| --- | --- |
| `Snapshot` | The baseline, or `null` for a model that has never been in the database. Read-only. |
| `IsNew` | `Snapshot === null`. This — not the absence of a primary key — is what classifies a model as an INSERT, because `setDefaults()` pre-fills `@Uuid` keys at construction. |
| `IsDirty` | `IsNew`, or at least one column differs from the baseline. Derived on every read; no setter. |
| `changes()` | `{ Column, OldValue, NewValue }` for every column that differs, in descriptor order, followed by any `@BelongsTo` foreign key re-pointed through its relation. On an `IsNew` model: every column, `OldValue: undefined`. |
| `takeSnapshot()` | Capture current column values as the baseline. Values are **copied**, never aliased. |
| `snapshotRelation(name)` | Record the current member primary keys of one relation. No-op without a snapshot. |
| `clearSnapshot()` | Discard the baseline. The model is then `IsNew` again — an INSERT. |

Because nothing observes writes, the diff is exact: a column written `A → B → A` is not a change,
a `DateTime` re-created from the same instant is not a change, and an in-place mutation of a JSON
column (`model.Tags.push('x')`) **is** one. `snapshotEquals` compares `DateTime` by instant,
`Buffer` by bytes and objects by deep equality; a converter can supply its own hooks
(`11-converters-and-hydration.md`).

`IsDirty` costs one comparison per column until the first difference, and `changes()` compares
every column. Call `changes()` once and reuse the result rather than polling `IsDirty` in a loop
over models with large JSON columns.

Every write path re-baselines after its statement ran — `insert()`, `update()`, `archive()`,
`refresh()` and `save()` all end with a fresh snapshot — and only after: a statement that throws
leaves the model as dirty as it was, so a retry writes the same columns. `takeSnapshot()` is
public for the rare case where a caller must re-baseline by hand (narrowing a loaded user's roles
before handing it to a controller, say); calling it on a model that was never inserted makes
`save()` emit an UPDATE for a row that does not exist.

A `@BelongsTo` whose relation holds a target has its foreign key decided by that target: the
value is read off the relation's **join column** (`Relation.PrimaryKey` — the target's primary
key unless `@BelongsTo` names another column), it overrides a direct write of the raw column, and
it is what `toSql()`, the diff and the unit of work's pending keys all use.
`SingleRelation.attach()` also writes the owner's column to match (the join value, or `NULL` on
`detach()`), and after every successful write the ORM reconciles the foreign-key columns with
their relations before taking the fresh snapshot — so a model is clean after `insert()`,
`update()`, `archive()` and `save()`, even when the target's key only came into existence during
the write. A relation that was never attached, or whose `populate()` found no row for the key the
row carries, decides nothing: the column stands, and reading is never a change.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Name: string;
}

export async function tracking() {
  const user = await User.getOrFail(1);   // hydrated => has a snapshot, IsNew === false

  const originalName = user.Name;
  user.Name = 'Changed';
  user.changes();          // [{ Column: 'Name', OldValue: originalName, NewValue: 'Changed' }]

  user.Name = originalName;
  user.IsDirty;            // false — net change is nothing
  user.changes();          // []

  await user.update();     // issues no statement
}
```

````

In `### \`insert(behaviour?)\`` append after the paragraph "Inserts this instance.":

```
Afterwards a fresh snapshot is taken — generated key included — so a following `update()` on the
same instance writes only what changed since.
```

Replace the body of `### \`update(data?)\`` (lines 219-226) with:

```
Hydrates `data` when given, then writes the columns `changes()` reports — including a foreign key
re-pointed through a relation. Primary key columns are excluded from the `SET` list.

When nothing changed it returns `{ RowsAffected: 0, LastInsertId: 0 }` without touching the
database.

When something *is* written and the model has `@UpdatedAt`, the column is stamped and added to
the change set. Afterwards a fresh snapshot is taken.
```

In `### \`archive()\`` replace "Stamps the `@Archived` column and writes the whole model. Throws when the model has no archive column." with:

```
Stamps the `@Archived` column and writes the whole model, then takes a fresh snapshot. Throws
when the model has no archive column.
```

Replace the body of `### \`refresh()\`` (lines 288-291) with:

```
Re-reads the row and copies every column onto **this** instance, then takes a fresh snapshot, so
the baseline is what the database holds. Use `save({ reload: true })` when you need the diff
against current database state without discarding your in-memory edits.
```

In `### \`toSql(onlyDirty?)\`` replace "With `onlyDirty` it is narrowed to `__dirty_props__` — the *dirty list*, not the snapshot diff." with "With `onlyDirty` it is narrowed to the columns `changes()` reports."

- [ ] **Step 2: `07-relations.md`, `08-unit-of-work.md`, `12-architecture.md`**

`07-relations.md`:
- line 352 → `| \`attach(obj \| null)\` | Point at a model and write the owner's foreign key to match (the target's join-column value, or NULL). No database access; the owner's \`changes()\` then reports the key. |`
- line 424 → `| \`update()\` | Insert-or-update every member that is \`IsDirty\` (new, or changed since it was loaded), in one transaction. |`
- lines 470-473 → 

```
`OneToManyRelationList._update()` assigns each member's foreign key **before** filtering on
`IsDirty`. A child re-parented onto this owner needs its key rewritten and persisted; filtering
first would leave a previously-clean child holding its old foreign key, and a following `sync()`
would then delete it as "not belonging" here.
```

- lines 494-495: replace "Attaching would mark the owner dirty — a read must not create
unsaved changes — feed every sibling relation" with "Attaching would feed every sibling relation".

`08-unit-of-work.md`:
- line 200 → `| \`Insert\` | \`model.IsNew\` — never in the database. |`
- line 201 → `| \`Update\` | \`model.IsDirty\` — the snapshot diff is non-empty. |`
- line 354: `changedColumns()` → `changes()`.

`12-architecture.md` line 46 → `  │     │           → model.hydrate(row); takeSnapshot()`.

- [ ] **Step 3: `RELEASE_NOTES.md`**

Prepend this block (the existing content follows it unchanged):

```
# Release notes — ORM unified dirty tracking

> Branch `feat/orm-unified-dirty-tracking`. Design:
> `docs/superpowers/specs/2026-08-25-orm-unified-dirty-tracking-design.md`.

## BREAKING CHANGES

### `@spinajs/orm` — one change-tracking mechanism

`ModelBase` no longer keeps a write-time dirty list. The snapshot taken at hydration and after
every write is the only state; everything is derived from it.

| Removed | Use instead |
|---|---|
| `IsDirty` setter (`model.IsDirty = false`) | Persist the model, or `takeSnapshot()` to re-baseline by hand. |
| `markDirty(prop)` | Nothing — `attach()` / `detach()` are visible to `changes()` directly. |
| `changedColumns()` | `changes().map((c) => c.Column)` |
| The constructor's `Proxy` | Nothing — `new Model()` returns the plain instance. |

Behaviour changes:

- `IsDirty` is `true` for a model that has never been in the database (`IsNew`), and `false`
  again when a write restores the original value. It is computed on every read.
- `IsNew` and `changes(): IModelChange[]` (`{ Column, OldValue, NewValue }`) are new.
- `insert()`, `refresh()` and `archive()` take a fresh snapshot after their statement, so a
  following `update()` on the same instance writes only what changed since. `insert()` now awaits
  its statement internally.
- `SingleRelation.attach()` on a `RelationType.Query` relation no longer flags the owner dirty;
  there is no column such a flag could write.
- `Relation.update()` persists every member that is `IsDirty` (new, or changed since loaded).
- `SingleRelation.attach(obj)` / `detach()` now also write the owner's foreign-key column (the
  target's join-column value, or `null`), and `toSql()` writes `NULL` for a detached relation.
  Before, `detach()` + `update()` — and therefore `SingleRelation.remove()` — wrote the old key
  back and never cleared the reference. A relation whose `populate()` found no row still keeps
  the row's key, as before.
- Foreign keys are resolved from the relation's **join column** (`Relation.PrimaryKey`)
  everywhere — `toSql()` in both converters, the diff, `attach()`, and the unit of work's
  pending keys (`IPendingForeignKey` gained `JoinColumn`). Previously the target's primary key
  was used even when `@BelongsTo` declared another column. A relation holding a target overrides
  a direct write of the raw foreign-key column.
- After every successful write the foreign-key columns are reconciled with their relations
  before the fresh snapshot is taken, so a model converges to clean. Static bulk
  `Model.insert()` now re-baselines (and reconciles) model instances too.

---

```

- [ ] **Step 4: Downstream compile check**

Run: `cd packages/orm && grep -rn "markDirty\|__dirty_props__\|changedColumns" docs`
Expected: no output.

Run: `cd packages/rbac-http-token && npm run compile`
Expected: exit 0 (it only calls `takeSnapshot()` / `snapshotRelation()`, both unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/orm/docs RELEASE_NOTES.md
git commit -m "docs(orm): document snapshot-derived change tracking"
```

---

## Task 6: yourscreen-backend — `IChangeValue` becomes `IModelChange`

**Files:**
- Modify: `packages/common/src/models/yourscreen/EntityChange.ts:1-21`, `:71-72`
- Modify: `packages/features/src/entity-history/events/EntityChanged.ts:2`, `:31`
- Modify: `packages/features/src/entity-history/actions/History.ts:2`, `:28`, `:34`, `:271`
- Modify: `packages/features/src/entity-history/actions/Emit.ts:5`, `:41`, `:72-73`
- Modify: `packages/backend/test/features/entity-history/history.actions.test.ts:9`, `:36`, `:53`, `:145`
- Modify: `packages/backend/test/controllers/entity-history.controller.test.ts:8`, `:44`
- Create (untracked, do not commit): `packages/backend/.mocharc.scoped.json`

**Interfaces:**
- Consumes: `IModelChange` from `@spinajs/orm` (Task 1, rebuilt in Task 4).
- Produces: `EntityChange.changes: IModelChange[]`, `EntityChanged.Changes: IModelChange[]`, `_entity_changed(..., changes: IModelChange[], ...)`. `IChangeValue` no longer exists.

- [ ] **Step 1: Branch and test scaffolding**

```bash
cd c:/Users/grzch/SourceCodes/Screennetwork/agentic_development/agent-1/yourscreen-backend
git checkout -b feat/entity-history-model-changes main
```

Create `packages/backend/.mocharc.scoped.json` (untracked — it exists only so one file can be run):

```json
{
  "extensions": ["ts"],
  "require": ["test/harness/global-setup.ts"],
  "node-option": [
    "experimental-specifier-resolution=node",
    "loader=ts-node/esm",
    "conditions=development"
  ]
}
```

Start the stack: `cd packages/backend && node scripts/local-suite.mjs up`.

- [ ] **Step 2: Make the type swap**

`packages/common/src/models/yourscreen/EntityChange.ts`: add `IModelChange` to the `@spinajs/orm` import list (`import { BelongsTo, Connection, CreatedAt, DateTime as DT, IModelChange, Json, Model, ModelBase, Primary, SingleRelation } from '@spinajs/orm';`), delete the `IChangeValue` interface and its doc comment (lines 16-21), and change the column to `public changes: IModelChange[];`.

`packages/features/src/entity-history/events/EntityChanged.ts` line 2 → `import type { IModelChange } from '@spinajs/orm';`; line 31 → `public Changes: IModelChange[];`.

`packages/features/src/entity-history/actions/History.ts`: line 2 → `import type { IModelChange } from '@spinajs/orm';` (keep the `EntityChange` value import on line 1); line 28 → `function assertChanges(changes: unknown): asserts changes is IModelChange[] {`; line 34 → `const column = (change as IModelChange | null)?.Column;`; line 271 → `const changes: IModelChange[] = [];`.

`packages/features/src/entity-history/actions/Emit.ts`: line 5 → `import type { IModelChange } from '@spinajs/orm';`; `changes: IChangeValue[],` in `_entity_changed` → `changes: IModelChange[],`; in `_dto_changes` both `IChangeValue[]` → `IModelChange[]`.

`packages/backend/test/features/entity-history/history.actions.test.ts`: line 9 → `import type { IModelChange } from '@spinajs/orm';`; replace the three remaining `IChangeValue` identifiers (lines 36, 53, 145) with `IModelChange`.

`packages/backend/test/controllers/entity-history.controller.test.ts`: line 8 → `import type { IModelChange } from '@spinajs/orm';`; line 44 → `function changeEvent(entityId: string | number, changes: IModelChange[]): EntityChanged {`.

- [ ] **Step 3: Verify nothing references the old name; rebuild**

Run: `grep -rn "IChangeValue" packages/*/src packages/backend/test`
Expected: no output.

Run: `cd packages/common && npm run compile`
Expected: exit 0.

- [ ] **Step 4: Run the entity-history suites**

Run (from `packages/backend`): `node --env-file-if-exists=.env ../../node_modules/mocha/bin/mocha.js --config .mocharc.scoped.json --exit test/features/entity-history/history.actions.test.ts test/controllers/entity-history.controller.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/common/src/models/yourscreen/EntityChange.ts packages/features/src/entity-history packages/backend/test/features/entity-history/history.actions.test.ts packages/backend/test/controllers/entity-history.controller.test.ts
git commit -m "refactor(entity-history): use the ORM's IModelChange instead of a local IChangeValue"
```

---

## Task 7: `@ChangeTracked(resource)` on the five tracked models

**Files:**
- Create: `packages/common/src/models/yourscreen/ChangeTracked.ts`
- Modify: `packages/common/src/models/yourscreen/index.ts`
- Modify: `packages/common/src/models/legacy/arrow/ArrowOffer.ts:1-28`, `ArrowCampaign.ts:3,93-96`, `ArrowCampaignComments.ts:1-11`
- Modify: `packages/common/src/models/yourscreen/player-content/Entries.ts:1,70-73`, `EntriesGroup.ts:1,50-53`
- Modify: `packages/features/src/campaigns/entity-history.ts`, `packages/features/src/player-content/entity-history.ts`
- Test: `packages/backend/test/features/entity-history/change-tracked.test.ts`

**Interfaces:**
- Produces (exported from `@screen-network/common`): `ChangeTracked(resource: string)` class decorator, `changeResourceOf(model: ModelBase): string`, `IChangeTrackedDescriptor`, and the constants `ARROW_OFFER_RESOURCE`, `ARROW_CAMPAIGN_RESOURCE`, `CAMPAIGN_COMMENT_RESOURCE`, `CONTENT_ENTRY_RESOURCE`, `ENTRIES_GROUP_RESOURCE` (same names and values as today, re-exported by the two feature `entity-history.ts` modules).

- [ ] **Step 1: Write the failing test**

Create `packages/backend/test/features/entity-history/change-tracked.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { InvalidOperation } from '@spinajs/exceptions';
import {
  ArrowCampaign,
  ArrowCampaignComments,
  ArrowOffer,
  ContentEntries,
  EntityChange,
  EntriesGroup,
  changeResourceOf,
  ARROW_CAMPAIGN_RESOURCE,
  ARROW_OFFER_RESOURCE,
  CAMPAIGN_COMMENT_RESOURCE,
  CONTENT_ENTRY_RESOURCE,
  ENTRIES_GROUP_RESOURCE,
} from '@screen-network/common';

import { startHttp, stopHttp } from '../../harness/server.js';

describe('@ChangeTracked', function () {
  this.timeout(120000);

  before(async () => {
    await startHttp();
  });

  after(async () => {
    await stopHttp();
  });

  it('resolves the declared resource for every tracked model', () => {
    expect(changeResourceOf(new ArrowOffer())).to.equal(ARROW_OFFER_RESOURCE);
    expect(changeResourceOf(new ArrowCampaign())).to.equal(ARROW_CAMPAIGN_RESOURCE);
    expect(changeResourceOf(new ArrowCampaignComments())).to.equal(CAMPAIGN_COMMENT_RESOURCE);
    expect(changeResourceOf(new ContentEntries())).to.equal(CONTENT_ENTRY_RESOURCE);
    expect(changeResourceOf(new EntriesGroup())).to.equal(ENTRIES_GROUP_RESOURCE);
  });

  it('keeps the persisted resource strings', () => {
    expect(ARROW_OFFER_RESOURCE).to.equal('arrow-offer');
    expect(ARROW_CAMPAIGN_RESOURCE).to.equal('arrow-campaign');
    expect(CAMPAIGN_COMMENT_RESOURCE).to.equal('campaign-comment');
    expect(CONTENT_ENTRY_RESOURCE).to.equal('content-entry');
    expect(ENTRIES_GROUP_RESOURCE).to.equal('entries-group');
  });

  it('throws InvalidOperation for a model that is not @ChangeTracked', () => {
    expect(() => changeResourceOf(new EntityChange())).to.throw(InvalidOperation, /EntityChange is not @ChangeTracked/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `packages/backend`): `node --env-file-if-exists=.env ../../node_modules/mocha/bin/mocha.js --config .mocharc.scoped.json --exit test/features/entity-history/change-tracked.test.ts`
Expected: compile error — `'@screen-network/common' has no exported member 'changeResourceOf'`.

- [ ] **Step 3: Implement the decorator**

Create `packages/common/src/models/yourscreen/ChangeTracked.ts`:

```ts
import { extractDecoratorDescriptor } from '@spinajs/orm';
import type { IModelDescriptor, ModelBase } from '@spinajs/orm';
import { InvalidOperation } from '@spinajs/exceptions';

/**
 * Entity-history resource keys. Each is the `resource` column of every `entity_change` row a
 * model's changes are recorded under, so the strings are a storage contract: renaming one
 * orphans every step already recorded for that model.
 */
export const ARROW_OFFER_RESOURCE = 'arrow-offer';
export const ARROW_CAMPAIGN_RESOURCE = 'arrow-campaign';
export const CAMPAIGN_COMMENT_RESOURCE = 'campaign-comment';
export const CONTENT_ENTRY_RESOURCE = 'content-entry';
export const ENTRIES_GROUP_RESOURCE = 'entries-group';

/** Model descriptor extended with the change-history resource the model records under. */
export interface IChangeTrackedDescriptor extends IModelDescriptor {
  ChangeResource?: string;
}

/**
 * Declares the entity-history resource a model's changes are recorded under - the `Resource` of
 * every `EntityChanged` event `_update_tracked` emits for it. Attached to the model descriptor at
 * class definition, like `@OrmResource()`, so there is no registration order to get wrong.
 *
 * Declaring the resource is not the same as registering it for listing and revert: that stays in
 * `ChangeTrackingRegistry.register()` (features), which also decides the RBAC resource and the
 * column allow-list a rollback may write.
 */
export function ChangeTracked(resource: string) {
  return extractDecoratorDescriptor((model: IChangeTrackedDescriptor) => {
    model.ChangeResource = resource;
  });
}

/** The resource a model was declared with via `@ChangeTracked`; throws for an undecorated model. */
export function changeResourceOf(model: ModelBase): string {
  const resource = (model.ModelDescriptor as IChangeTrackedDescriptor | null)?.ChangeResource;
  if (!resource) {
    throw new InvalidOperation(`${model.constructor.name} is not @ChangeTracked`);
  }
  return resource;
}
```

`packages/common/src/models/yourscreen/index.ts` — add `export * from './ChangeTracked.js';` after the `EntityChange.js` line.

- [ ] **Step 4: Decorate the models**

`packages/common/src/models/legacy/arrow/ArrowOffer.ts`: add `import { ARROW_OFFER_RESOURCE, ChangeTracked } from '../../yourscreen/ChangeTracked.js';` to the imports and the decorator above the class:

```ts
@Connection('arrow4-legacy')
@Model('arrow_offer')
@ChangeTracked(ARROW_OFFER_RESOURCE)
export class ArrowOffer extends ModelBase {
```

`packages/common/src/models/legacy/arrow/ArrowCampaign.ts`: add `import { ARROW_CAMPAIGN_RESOURCE, ChangeTracked } from '../../yourscreen/ChangeTracked.js';` and:

```ts
@Connection('arrow4-legacy')
@Model('arrow_campaign')
@OrmResource()
@ChangeTracked(ARROW_CAMPAIGN_RESOURCE)
export class ArrowCampaign extends ModelBase {
```

`packages/common/src/models/legacy/arrow/ArrowCampaignComments.ts`: add `import { CAMPAIGN_COMMENT_RESOURCE, ChangeTracked } from '../../yourscreen/ChangeTracked.js';` and:

```ts
@Connection('arrow4-legacy')
@Model('arrow_campaign_comments')
@ChangeTracked(CAMPAIGN_COMMENT_RESOURCE)
export class ArrowCampaignComments extends ModelBase {
```

`packages/common/src/models/yourscreen/player-content/Entries.ts`: add `import { CONTENT_ENTRY_RESOURCE, ChangeTracked } from '../ChangeTracked.js';` and:

```ts
@Connection('yourscreen')
@Model('player_content_entries')
@OrmResource()
@ChangeTracked(CONTENT_ENTRY_RESOURCE)
export class ContentEntries extends ModelBase<ContentEntries> {
```

`packages/common/src/models/yourscreen/player-content/EntriesGroup.ts`: add `import { ENTRIES_GROUP_RESOURCE, ChangeTracked } from '../ChangeTracked.js';` and, on the `EntriesGroup` class only (not the `_view` model below it):

```ts
@OrmResource()
@ChangeTracked(ENTRIES_GROUP_RESOURCE)
export class EntriesGroup extends ModelBase<EntriesGroup> {
```

- [ ] **Step 5: Re-export the constants from the feature modules**

`packages/features/src/campaigns/entity-history.ts` — replace the three `export const ..._RESOURCE = '...';` lines (keep their doc comments above the new lines) and the import:

```ts
import { ArrowOffer, ARROW_CAMPAIGN_RESOURCE, ARROW_OFFER_RESOURCE, CAMPAIGN_COMMENT_RESOURCE } from '@screen-network/common';

import { ChangeTrackingRegistry } from '#features/entity-history/registry.js';

/**
 * The resource strings are declared on the models themselves (`@ChangeTracked`, in `common`) and
 * re-exported here so producers and the registration below keep one import path.
 */
export { ARROW_CAMPAIGN_RESOURCE, ARROW_OFFER_RESOURCE, CAMPAIGN_COMMENT_RESOURCE };
```

The `ChangeTrackingRegistry.register(ARROW_OFFER_RESOURCE, {...})` call and the three existing doc comments stay; only the `export const` lines go.

`packages/features/src/player-content/entity-history.ts` — replace the two `export const` lines with:

```ts
import { CONTENT_ENTRY_RESOURCE, ENTRIES_GROUP_RESOURCE } from '@screen-network/common';

export { CONTENT_ENTRY_RESOURCE, ENTRIES_GROUP_RESOURCE };
```

(keep the file's doc comment).

- [ ] **Step 6: Rebuild and run**

Run: `cd packages/common && npm run compile`
Expected: exit 0.

Run (from `packages/backend`): `node --env-file-if-exists=.env ../../node_modules/mocha/bin/mocha.js --config .mocharc.scoped.json --exit test/features/entity-history/change-tracked.test.ts test/features/entity-history/history.actions.test.ts`
Expected: all passing.

- [ ] **Step 7: Commit**

```bash
git add packages/common/src/models packages/features/src/campaigns/entity-history.ts packages/features/src/player-content/entity-history.ts packages/backend/test/features/entity-history/change-tracked.test.ts
git commit -m "feat(entity-history): @ChangeTracked declares a model's history resource"
```

---

## Task 8: `_update_tracked(tag, opts?)` chain step

**Files:**
- Modify: `packages/features/src/entity-history/actions/Emit.ts` (imports; new function after `_entity_changed`)
- Test: `packages/backend/test/features/entity-history/update-tracked.test.ts`

**Interfaces:**
- Consumes: `changeResourceOf` (Task 7), `ModelBase.changes()` / `update()` (Tasks 2-4), `_entity_changed`, `_ev` from `@spinajs/queue`, `_chain` from `@spinajs/util`.
- Produces: `_update_tracked(tag: string, opts?: IEmitOptions): <T extends ModelBase>(model: T) => Promise<T>`.

- [ ] **Step 1: Write the failing test**

Create `packages/backend/test/features/entity-history/update-tracked.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DefaultQueueService } from '@spinajs/queue';
import { EntriesGroup, ENTRIES_GROUP_RESOURCE } from '@screen-network/common';

import { startHttp, stopHttp } from '../../harness/server.js';
import { cleanup, makeGroup, testUser } from '../../harness/fixtures.js';
import { TEST_USER_LOGIN } from '../../../src/migrations/baseline/test-seed.js';
import { _update_tracked } from '#features/entity-history/actions/Emit.js';
import { EntityChanged } from '#features/entity-history/events/EntityChanged.js';
import { UPDATED_TAG } from '#features/entity-history/tags.js';

describe('_update_tracked', function () {
  this.timeout(120000);

  let emitStub: sinon.SinonStub;

  const emitted = (): EntityChanged[] =>
    emitStub.getCalls().map((c) => c.args[0]).filter((e): e is EntityChanged => e instanceof EntityChanged);

  before(async () => {
    await startHttp();
  });

  after(async () => {
    await cleanup();
    await stopHttp();
  });

  beforeEach(() => {
    emitStub = sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
  });

  afterEach(() => {
    emitStub.restore();
  });

  it('writes the model and emits one step with exactly the changed columns', async () => {
    const created = await makeGroup(`update-tracked-${Date.now()}`);
    const group = await EntriesGroup.getOrFail(created.id);
    const actor = await testUser(TEST_USER_LOGIN('contentmanager.user'));
    const oldName = group.name;
    const newName = `${oldName}-x`.slice(0, 64);

    group.name = newName;
    const result = await _update_tracked(UPDATED_TAG, { actor })(group);

    expect(result).to.equal(group);
    expect((await EntriesGroup.getOrFail(group.id)).name).to.equal(newName);
    expect(group.changes()).to.deep.equal([]);

    const events = emitted();
    expect(events).to.have.length(1);
    expect(events[0].Resource).to.equal(ENTRIES_GROUP_RESOURCE);
    expect(events[0].Tag).to.equal(UPDATED_TAG);
    expect(events[0].EntityId).to.equal(String(group.id));
    expect(events[0].ActorId).to.equal(actor.Id);
    expect(events[0].Changes).to.deep.equal([{ Column: 'name', OldValue: oldName, NewValue: newName }]);
  });

  it('emits nothing for a clean model', async () => {
    const created = await makeGroup(`update-tracked-clean-${Date.now()}`);
    const group = await EntriesGroup.getOrFail(created.id);

    await _update_tracked(UPDATED_TAG)(group);

    expect(emitted()).to.have.length(0);
  });

  it('emits nothing when the write fails', async () => {
    const created = await makeGroup(`update-tracked-fail-${Date.now()}`);
    const group = await EntriesGroup.getOrFail(created.id);
    group.name = `${group.name}-y`.slice(0, 64);
    sinon.stub(group, 'update').rejects(new Error('boom'));

    let error: unknown;
    try {
      await _update_tracked(UPDATED_TAG)(group);
    } catch (e) {
      error = e;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.equal('boom');
    expect(emitted()).to.have.length(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `packages/backend`): `node --env-file-if-exists=.env ../../node_modules/mocha/bin/mocha.js --config .mocharc.scoped.json --exit test/features/entity-history/update-tracked.test.ts`
Expected: compile error — `'#features/entity-history/actions/Emit.js' has no exported member '_update_tracked'`.

- [ ] **Step 3: Implement**

`packages/features/src/entity-history/actions/Emit.ts` — imports become:

```ts
import type { IModelChange, ModelBase } from '@spinajs/orm';
import { _ev } from '@spinajs/queue';
import type { User } from '@spinajs/rbac';
import { _chain } from '@spinajs/util';
import { DateTime } from 'luxon';
import { v4 as uuidv4 } from 'uuid';

import { changeResourceOf } from '@screen-network/common';

import { EntityChanged } from '../events/EntityChanged.js';
import { storable } from './History.js';
```

and after `_entity_changed` add:

```ts

/**
 * Chain step that persists a mutated model and records what the write changed - one step, so the
 * ordering the history depends on cannot be got wrong at a call site:
 *
 * 1. `changes()` is read BEFORE `update()`: a successful update re-baselines the snapshot, and
 *    the diff is gone.
 * 2. `update()` runs.
 * 3. The `EntityChanged` is emitted only once the write landed. A step describing a write that
 *    never happened is worse than a missing step, so a throw from `update()` skips the emit and
 *    propagates.
 *
 * A model with nothing to write emits nothing; `update()` is still called and is a no-op. The
 * resource comes from the model's `@ChangeTracked` declaration, the entity id from its primary key.
 */
export function _update_tracked(tag: string, opts?: IEmitOptions) {
  return async <T extends ModelBase>(model: T): Promise<T> => {
    const changes = model.changes();
    const event = changes.length > 0 ? _entity_changed(changeResourceOf(model), model.PrimaryKeyValue, tag, changes, opts) : null;

    await model.update();

    if (event) {
      await _chain(_ev(event));
    }

    return model;
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `packages/backend`): `node --env-file-if-exists=.env ../../node_modules/mocha/bin/mocha.js --config .mocharc.scoped.json --exit test/features/entity-history/update-tracked.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/features/src/entity-history/actions/Emit.ts packages/backend/test/features/entity-history/update-tracked.test.ts
git commit -m "feat(entity-history): _update_tracked chain step - diff, update, emit"
```

---

## Task 9: Groups and entries actions use `_update_tracked`

**Files:**
- Modify: `packages/features/src/player-content/actions/Groups.ts:1-17`, `:224-247`
- Modify: `packages/features/src/player-content/actions/Entries.ts:1-16`, `:244-271`, `:325-378`
- Test (unchanged, acceptance): `packages/backend/test/features/player-content/groups.actions.test.ts`, `packages/backend/test/features/player-content/entries.actions.test.ts`

**Interfaces:**
- Consumes: `_update_tracked` (Task 8).

- [ ] **Step 1: Run the acceptance tests before changing anything**

Run (from `packages/backend`): `node --env-file-if-exists=.env ../../node_modules/mocha/bin/mocha.js --config .mocharc.scoped.json --exit test/features/player-content/groups.actions.test.ts test/features/player-content/entries.actions.test.ts`
Expected: all passing (baseline — these tests do not change in this task).

- [ ] **Step 2: `Groups.ts`**

Imports: change `import { _delete, _insert, _update } from "@spinajs/orm";` to `import { _delete, _insert } from "@spinajs/orm";`; delete `import type { EntityChanged } from "#features/entity-history/events/EntityChanged.js";`, `import { _dto_changes, _entity_changed } from "#features/entity-history/actions/Emit.js";` and `import { ENTRIES_GROUP_RESOURCE } from "../entity-history.js";`; add `import { _update_tracked } from "#features/entity-history/actions/Emit.js";`.

Replace `_update_group` with:

```ts
export function _update_group(group: EntriesGroup | number, data: Partial<EntriesGroup>): Promise<EntriesGroup> {
    if (data.validation_rules !== undefined) {
        _validate_group_rules(data.validation_rules);
    }

    return _chain(
        _get_group(group),
        (group: EntriesGroup) => {
            // `_update_group_field_rules` routes through here with a one-key payload, so a rules
            // edit moves `field_rules` and nothing else - and that is exactly what the step
            // `_update_tracked` records: the model's own diff, taken after this hydrate and
            // before the write.
            group.hydrate(data as any);
            return group;
        },
        _update_tracked(UPDATED_TAG),
    );
}
```

- [ ] **Step 3: `Entries.ts`**

Imports: change `import { _delete, _insert, _update } from "@spinajs/orm";` to `import { _delete, _insert } from "@spinajs/orm";`; delete `import type { EntityChanged } from "#features/entity-history/events/EntityChanged.js";`, `import { _dto_changes, _entity_changed } from "#features/entity-history/actions/Emit.js";` and `import { CONTENT_ENTRY_RESOURCE } from "../entity-history.js";`; add `import { _update_tracked } from "#features/entity-history/actions/Emit.js";`.

Replace `_set_entry_status` with:

```ts
export function _set_entry_status(entry: ContentEntries | number, status: number) {
    const s = _check_arg(_is_number(_min(0), _max(1)))(status, 'status');

    return _chain(
        _get_entry(entry),
        (entry: ContentEntries) => {
            // The column is a boolean (`@Bool()`), so the 0/1 argument is narrowed before it is
            // assigned. An entry already at this status does not move, and `_update_tracked`
            // then records nothing - a step recording no change is noise no consumer and no
            // revert can use.
            entry.status = Boolean(s);
            return entry;
        },
        _update_tracked(STATUS_CHANGED_TAG),
    );
}
```

In `_update_entry`: delete the two lines

```ts
    // Built from the payload BEFORE hydrate(), emitted only after the write lands.
    let change: EntityChanged | null = null;
```

replace the block from the comment `// Last read of the stored values: hydrate() overwrites them on the next line. Only` through `entry.hydrate(updatedData); return entry;` with:

```ts
            // Only the keys the payload actually carries are hydrated, and `_update_tracked` diffs
            // the model after this hydrate and before the write - so a PATCH that touches one
            // field records one column; the rest of the entry is not in the history because it
            // did not move.
            entry.hydrate(updatedData);
            return entry;
```

and replace the chain tail

```ts
        _update(),
        _tap(() => (change ? _chain(_ev(change)) : Promise.resolve())),
    );
```

with

```ts
        _update_tracked(UPDATED_TAG),
    );
```

- [ ] **Step 4: Verify no leftovers, run the acceptance tests**

Run: `grep -n "_dto_changes\|_entity_changed\|EntityChanged\|_update()" packages/features/src/player-content/actions/Groups.ts packages/features/src/player-content/actions/Entries.ts`
Expected: no output.

Run (from `packages/backend`): `node --env-file-if-exists=.env ../../node_modules/mocha/bin/mocha.js --config .mocharc.scoped.json --exit test/features/player-content/groups.actions.test.ts test/features/player-content/entries.actions.test.ts`
Expected: all passing — same set as Step 1.

- [ ] **Step 5: Commit**

```bash
git add packages/features/src/player-content/actions/Groups.ts packages/features/src/player-content/actions/Entries.ts
git commit -m "refactor(player-content): record group and entry history through _update_tracked"
```

---

## Task 10: Comment updates use `_update_tracked`; comment tests move to the database harness

`fakeComment()` (`test/campaigns/helpers.ts`) builds its comment with `Object.create(prototype)` and no ORM boot: no snapshot field, no column descriptors. `changes()` needs both, so the `_update_comment` cases run against a real row from now on. Other `fakeComment` users (add / delete / attach) are untouched.

**Files:**
- Modify: `packages/features/src/campaigns/actions/Comments.ts:1-20`, `:31-66`
- Modify: `packages/backend/test/harness/fixtures.ts:326-330` (`makeComment`)
- Modify: `packages/backend/test/campaigns/comments-actions.test.ts` (delete the `describe('_update_comment')` block, lines 52-108; drop the now-unused `CommentPatchDTO`, `_update_comment`, `EntityChanged`, `UPDATED_TAG`, `CAMPAIGN_COMMENT_RESOURCE` imports)
- Create: `packages/backend/test/campaigns/comment-update.test.ts`
- Modify: `docs/superpowers/specs/2026-08-25-orm-unified-dirty-tracking-design.md` (spinajs repo, section 6)

**Interfaces:**
- Consumes: `_update_tracked` (Task 8), `makeCampaign` fixture.
- Produces: `makeComment(id, campaignId, columns?: { content?: string; type?: string; state?: 'accomplish' | 'none' })`.

- [ ] **Step 1: Extend the fixture**

Replace `makeComment` in `packages/backend/test/harness/fixtures.ts` with:

```ts
/**
 * An `arrow4.arrow_campaign_comments` row with a chosen id - same reasoning as {@link makeOffer}.
 * Optional text columns are inlined as quoted literals (test values only); everything else keeps
 * the table default.
 */
export async function makeComment(
  id: number,
  campaignId: number,
  columns: { content?: string; type?: string; state?: 'accomplish' | 'none' } = {},
): Promise<void> {
  const driver = await arrowDriver();
  const extra = Object.entries(columns).filter(([, v]) => v !== undefined) as [string, string][];
  const names = ['id', 'campaignId', ...extra.map(([k]) => k)].map((c) => `\`${c}\``).join(', ');
  const values = [String(id), String(campaignId), ...extra.map(([, v]) => `'${v.replace(/'/g, "''")}'`)].join(', ');
  await driver.schema().raw(`INSERT IGNORE INTO \`arrow4\`.\`arrow_campaign_comments\` (${names}) VALUES (${values})`);
  rawRegistry.push({ table: 'arrow_campaign_comments', id });
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/backend/test/campaigns/comment-update.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DefaultQueueService } from '@spinajs/queue';
import type { User } from '@spinajs/rbac';
import { ArrowCampaignComments, CommentPatchDTO, CAMPAIGN_COMMENT_RESOURCE } from '@screen-network/common';

import { startHttp, stopHttp } from '../harness/server.js';
import { cleanup, makeCampaign, makeComment, testUser } from '../harness/fixtures.js';
import { TEST_USER_LOGIN } from '../../src/migrations/baseline/test-seed.js';
import { _update_comment } from '#features/campaigns/actions/Comments.js';
import { EntityChanged } from '#features/entity-history/events/EntityChanged.js';
import { UPDATED_TAG } from '#features/entity-history/tags.js';

/**
 * `_update_comment` against a real comment row. The change step is the model's own snapshot
 * diff, which needs a hydrated model with column metadata - the prototype-only stand-in in
 * helpers.ts (`fakeComment`) has neither, so these cases run on the database harness.
 */
describe('_update_comment (database)', function () {
  this.timeout(120000);

  const CAMPAIGN_ID = 920100;
  let nextCommentId = 920100;

  let emitStub: sinon.SinonStub;
  let user: User;

  const emitted = (): EntityChanged[] =>
    emitStub.getCalls().map((c) => c.args[0]).filter((e): e is EntityChanged => e instanceof EntityChanged);

  const comment = async (columns: { content?: string; type?: string; state?: 'accomplish' | 'none' }) => {
    const id = nextCommentId++;
    await makeComment(id, CAMPAIGN_ID, columns);
    return id;
  };

  before(async () => {
    await startHttp();
    user = await testUser(TEST_USER_LOGIN('yourscreen.salesman'));
    await makeCampaign(CAMPAIGN_ID, { author: user.Id, name: `comment-update-${Date.now()}` });
  });

  after(async () => {
    await cleanup();
    await stopHttp();
  });

  beforeEach(() => {
    emitStub = sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
  });

  afterEach(() => {
    emitStub.restore();
  });

  it('patches only the fields present in the dto and persists', async () => {
    const id = await comment({ content: 'old content', type: 'comment', state: 'none' });

    await _update_comment(user, id, { content: 'new content' } as CommentPatchDTO);

    const row = await ArrowCampaignComments.getOrFail(id);
    expect(row.content).to.equal('new content');
    expect(row.type).to.equal('comment');
    expect(row.state).to.equal('none');
  });

  it('applies a state change from the dto', async () => {
    const id = await comment({ content: 'c', state: 'none' });

    await _update_comment(user, id, { state: 'accomplish' } as CommentPatchDTO);

    expect((await ArrowCampaignComments.getOrFail(id)).state).to.equal('accomplish');
  });

  it('emits an EntityChanged step for the edited column, attributed to the editing user', async () => {
    const id = await comment({ content: 'c' });

    await _update_comment(user, id, { content: 'changed' } as CommentPatchDTO);

    const events = emitted();
    expect(events).to.have.length(1);
    expect(events[0].Resource).to.equal(CAMPAIGN_COMMENT_RESOURCE);
    expect(events[0].Tag).to.equal(UPDATED_TAG);
    expect(events[0].EntityId).to.equal(String(id));
    expect(events[0].ActorId).to.equal(user.Id);
    expect(events[0].Changes).to.deep.equal([{ Column: 'content', OldValue: 'c', NewValue: 'changed' }]);
  });

  /**
   * The patch semantics are `dto.field ?? stored`, so a field the payload omits keeps its value
   * and must not appear in the history - and re-assigning the stored value is not a change.
   */
  it('records only the columns the patch actually changes', async () => {
    const id = await comment({ content: 'c', type: 'comment', state: 'none' });

    await _update_comment(user, id, { content: 'c', state: 'accomplish' } as CommentPatchDTO);

    const events = emitted();
    expect(events).to.have.length(1);
    expect(events[0].Changes).to.deep.equal([{ Column: 'state', OldValue: 'none', NewValue: 'accomplish' }]);
  });

  it('emits nothing when the patch changes no value', async () => {
    const id = await comment({ content: 'c', state: 'none' });

    await _update_comment(user, id, { content: 'c' } as CommentPatchDTO);

    expect(emitted()).to.have.length(0);
  });
});
```

In `packages/backend/test/campaigns/comments-actions.test.ts` delete the whole `describe('_update_comment', () => { ... });` block (lines 52-108) and remove `CommentPatchDTO` from the `@screen-network/common` import, `_update_comment` from the Comments actions import, and the three imports `EntityChanged`, `UPDATED_TAG`, `CAMPAIGN_COMMENT_RESOURCE` (they are used nowhere else in that file).

- [ ] **Step 3: Run the new tests to verify they fail**

Run (from `packages/backend`): `node --env-file-if-exists=.env ../../node_modules/mocha/bin/mocha.js --config .mocharc.scoped.json --exit test/campaigns/comment-update.test.ts`
Expected: 5 passing against the current `_update_comment` (still `_dto_changes`-based, which also works on real rows). This run proves the fixture rows insert and hydrate; the rewrite in Step 4 must keep the same five green.

- [ ] **Step 4: `Comments.ts`**

Imports: delete `import type { EntityChanged } from '#features/entity-history/events/EntityChanged.js';`, `import { _dto_changes, _entity_changed } from '#features/entity-history/actions/Emit.js';` and `import { CAMPAIGN_COMMENT_RESOURCE } from '../entity-history.js';`; add `import { _update_tracked } from '#features/entity-history/actions/Emit.js';`. Keep `_update` in the `@spinajs/orm` import (another action in the file still uses it) and keep `_` from lodash (used by `_get_comment`).

Replace `_update_comment` with:

```ts
export function _update_comment(userOrId: User | number, commentOrId: ArrowCampaignComments | number, dto: CommentPatchDTO): Promise<void> {
  _check_arg(_or(_is_number(_gt(0)), _is_object()))(userOrId, 'user');
  _check_arg(_or(_is_number(_gt(0)), _is_object()))(commentOrId, 'comment');
  _check_arg(_is_object())(dto, 'dto');

  return _chain(
    _use(_user(userOrId), 'user'),
    _use(_get_comment(commentOrId), 'comment'),
    _tap(({ comment, user }: { comment: ArrowCampaignComments; user: User }) =>
      _chain(
        () => {
          // Patch semantics: a field the payload omits - or sends as null - keeps its stored
          // value. Re-assigning the stored value is not a change, so the step `_update_tracked`
          // records holds only the columns the patch actually moved.
          comment.content = dto.content ?? comment.content;
          comment.inner = dto.inner ?? comment.inner;
          comment.type = dto.type ?? comment.type;
          comment.state = dto.state ?? comment.state;

          return comment;
        },
        _update_tracked(UPDATED_TAG, { actor: user }),
      ),
    ),
  );
}
```

- [ ] **Step 5: Run the comment suites**

Run (from `packages/backend`): `node --env-file-if-exists=.env ../../node_modules/mocha/bin/mocha.js --config .mocharc.scoped.json --exit test/campaigns/comment-update.test.ts test/campaigns/comments-actions.test.ts`
Expected: all passing.

- [ ] **Step 6: Amend the spec**

In the spinajs repo, `docs/superpowers/specs/2026-08-25-orm-unified-dirty-tracking-design.md`, section 6, replace the first bullet with:

```
- Existing group / entry history tests (`groups.actions.test.ts`, `entries.actions.test.ts`) pass unchanged. That is the acceptance criterion for those call-site rewrites. The `_update_comment` cases move from `comments-actions.test.ts` to a database-backed `comment-update.test.ts`: their `fakeComment()` stand-in is built with `Object.create(prototype)` and no ORM boot, so it has neither a snapshot nor column descriptors and `changes()` cannot see it.
```

Commit it there: `git commit -am "docs(orm): spec - comment tests run on the database harness"`.

- [ ] **Step 7: Commit (backend)**

```bash
git add packages/features/src/campaigns/actions/Comments.ts packages/backend/test/harness/fixtures.ts packages/backend/test/campaigns/comments-actions.test.ts packages/backend/test/campaigns/comment-update.test.ts
git commit -m "refactor(campaigns): record comment edits through _update_tracked"
```

---

## Task 11: `PUT /campaigns/:campaign` uses `_update_tracked`

Behaviour change accepted in the spec: the step now goes through the queue (worker persists it) like every other producer, instead of a synchronous `_record_change`.

**Files:**
- Modify: `packages/backend/src/controllers/yourscreen/campaign/Campaigns.ts:11-14`, `:92-113`
- Create: `packages/backend/test/controllers/campaign-update.controller.test.ts`

**Interfaces:**
- Consumes: `_update_tracked` (Task 8), `makeCampaign` fixture, `agentFor('yourscreen.salesman')`.

- [ ] **Step 1: Write the failing test**

Create `packages/backend/test/controllers/campaign-update.controller.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DefaultQueueService } from '@spinajs/queue';
import type { User } from '@spinajs/rbac';
import { ArrowCampaign, ARROW_CAMPAIGN_RESOURCE } from '@screen-network/common';

import { startHttp, stopHttp } from '../harness/server.js';
import { agentFor, closeAgents } from '../harness/agents.js';
import { cleanup, makeCampaign, testUser } from '../harness/fixtures.js';
import { TEST_USER_LOGIN } from '../../src/migrations/baseline/test-seed.js';
import { EntityChanged } from '#features/entity-history/events/EntityChanged.js';
import { UPDATED_TAG } from '#features/entity-history/tags.js';

/**
 * The campaign PUT records its history step through `_update_tracked`, i.e. as an `EntityChanged`
 * queue event the worker persists - captured here at the queue service, like the action suites do.
 * Fixture campaigns are owned by the calling salesman: `@FromModel()` resolves the campaign under
 * the role's `:own` grant.
 */
describe('PUT /yourscreen/v1/campaigns/:campaign', function () {
  this.timeout(120000);

  const url = (id: number) => `/yourscreen/v1/campaigns/${id}`;
  const run = Date.now();

  let agent: ChaiHttp.Agent;
  let salesman: User;
  let emitStub: sinon.SinonStub;

  const emitted = (): EntityChanged[] =>
    emitStub.getCalls().map((c) => c.args[0]).filter((e): e is EntityChanged => e instanceof EntityChanged);

  before(async () => {
    await startHttp();
    agent = await agentFor('yourscreen.salesman');
    salesman = await testUser(TEST_USER_LOGIN('yourscreen.salesman'));
  });

  after(async () => {
    closeAgents();
    await cleanup();
    await stopHttp();
  });

  beforeEach(() => {
    emitStub = sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
  });

  afterEach(() => {
    emitStub.restore();
  });

  it('records an UPDATED step with exactly the changed columns, attributed to the caller', async () => {
    const campaign = await makeCampaign(920200, { author: salesman.Id, name: `put-campaign-${run}` });

    const res = await agent.put(url(campaign.id)).send({ name: `put-campaign-${run}-renamed` });

    expect(res.status).to.equal(200);
    expect((await ArrowCampaign.getOrFail(campaign.id)).name).to.equal(`put-campaign-${run}-renamed`);

    const events = emitted();
    expect(events).to.have.length(1);
    expect(events[0].Resource).to.equal(ARROW_CAMPAIGN_RESOURCE);
    expect(events[0].Tag).to.equal(UPDATED_TAG);
    expect(events[0].EntityId).to.equal(String(campaign.id));
    expect(events[0].ActorId).to.equal(salesman.Id);
    expect(events[0].Changes).to.deep.equal([{ Column: 'name', OldValue: `put-campaign-${run}`, NewValue: `put-campaign-${run}-renamed` }]);
  });

  it('records an author change resolved from the user uuid', async () => {
    const campaign = await makeCampaign(920201, { author: salesman.Id, name: `put-author-${run}` });
    const other = await testUser(TEST_USER_LOGIN('yourscreen.realisation'));

    const res = await agent.put(url(campaign.id)).send({ name: `put-author-${run}`, author: other.Uuid });

    expect(res.status).to.equal(200);

    const events = emitted();
    expect(events).to.have.length(1);
    expect(events[0].Changes).to.deep.equal([{ Column: 'author', OldValue: salesman.Id, NewValue: other.Id }]);
  });

  it('records nothing when the body repeats the stored values', async () => {
    const campaign = await makeCampaign(920202, { author: salesman.Id, name: `put-noop-${run}` });

    const res = await agent.put(url(campaign.id)).send({ name: `put-noop-${run}` });

    expect(res.status).to.equal(200);
    expect(emitted()).to.have.length(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `packages/backend`): `node --env-file-if-exists=.env ../../node_modules/mocha/bin/mocha.js --config .mocharc.scoped.json --exit test/controllers/campaign-update.controller.test.ts`
Expected: the first and second cases fail — the current controller persists through `_record_change` and emits no queue event, so `expected [] to have a length of 1`.

- [ ] **Step 3: Implement**

`packages/backend/src/controllers/yourscreen/campaign/Campaigns.ts` imports: replace

```ts
import { _dto_changes, _entity_changed } from '#features/entity-history/actions/Emit.js';
import { _get_entity_changes, _get_entity_changes_combined, _get_entity_changes_for_entities, _record_change } from '#features/entity-history/actions/History.js';
```

with

```ts
import { _update_tracked } from '#features/entity-history/actions/Emit.js';
import { _get_entity_changes, _get_entity_changes_combined, _get_entity_changes_for_entities } from '#features/entity-history/actions/History.js';
```

(`ARROW_CAMPAIGN_RESOURCE`, `ARROW_OFFER_RESOURCE`, `CAMPAIGN_COMMENT_RESOURCE` and `UPDATED_TAG` stay — the history endpoints and the new call use them.)

Replace `updateCampaign` with:

```ts
  @Put(':campaign')
  public async updateCampaign(@FromModel() campaign: ArrowCampaign, @Body() dto: CampaignDTO, @UserParam() user: User) {
    const { author, ...data } = dto;

    campaign.hydrate(data as Partial<ArrowCampaign>);

    if (author) {
      const owner = await User.where({ Uuid: author }).firstOrThrow(new OrmNotFoundException('Author user not found'));
      campaign.author = owner.Id;
    }

    // Diff, update, emit - in that order, inside the step. The step is an EntityChanged on the
    // queue like every other producer's; the worker persists it.
    await _update_tracked(UPDATED_TAG, { actor: user })(campaign);

    return new Ok(campaign.dehydrate({ skipUndefined: true, dateTimeFormat: 'iso' }));
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `packages/backend`): `node --env-file-if-exists=.env ../../node_modules/mocha/bin/mocha.js --config .mocharc.scoped.json --exit test/controllers/campaign-update.controller.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/controllers/yourscreen/campaign/Campaigns.ts packages/backend/test/controllers/campaign-update.controller.test.ts
git commit -m "refactor(campaigns): PUT records its history step through _update_tracked"
```

---

## Task 12: Delete `_dto_changes`, rewrite the README, full verification

**Files:**
- Modify: `packages/features/src/entity-history/actions/Emit.ts` (delete `_dto_changes` and its doc comment)
- Modify: `packages/features/src/entity-history/README.md:97-131`, `:145-156`

- [ ] **Step 1: Delete `_dto_changes`**

In `packages/features/src/entity-history/actions/Emit.ts` delete the `_dto_changes` function together with its doc comment (from `/** * Change list for an update driven by a partial DTO` to the function's closing `}`).

Run: `grep -rn "_dto_changes" packages/*/src packages/backend/test`
Expected: no output.

- [ ] **Step 2: README — producing events**

In `packages/features/src/entity-history/README.md` replace everything from the line `## Producing events from an action` up to (not including) the line `Rules for a hand-built event:` with:

````
## Producing events from an action

A model declares the resource it records under with `@ChangeTracked('<resource>')` — next to
`@OrmResource()`, in `common` (`models/yourscreen/ChangeTracked.ts`, which also holds the
resource constants). The producer is then one chain step, `_update_tracked(tag, opts?)`
(`actions/Emit.ts`), which replaces `_update()` wherever history is recorded:

```ts
return _chain(
  _get_group(group),
  (group: EntriesGroup) => {
    group.hydrate(data);
    return group;
  },
  _update_tracked(UPDATED_TAG),
);
```

`_update_tracked` reads `model.changes()` — the ORM's snapshot diff, `{ Column, OldValue,
NewValue }` per column that actually moved — builds the `EntityChanged`, runs `model.update()`,
and emits only once the write landed. The ordering is the whole point and it lives in that one
function: the diff is taken BEFORE `update()`, because a successful update re-baselines the
snapshot and the diff is gone; the event goes out AFTER, because a step describing a write that
never happened is worse than a missing step. A clean model emits nothing. `opts.actor` attributes
the step to a user, `opts.source` tags the producer (default `'api'`).

What ends up in the step is exactly what the action changed: a payload key equal to the stored
value is not a change, a JSON column compares by content, and a foreign key re-pointed through a
relation is reported too. Which columns a *revert* may write back is still the registration's
`columns` allow-list.

`_entity_changed(resource, entityId, tag, changes, opts)` remains for the one case a diff cannot
express: a synthetic step, such as the campaign-level `status` step `_set_campaign_status` emits
for a column `arrow_campaign` does not have.

````

- [ ] **Step 3: README — the coverage gap that no longer exists**

Under `### What the history will not cover`, delete the second bullet (`**Foreign keys re-pointed through a relation.** ... Record the target id you attached, not the model's column.`). The first bullet (columns mutated by a different code path) stays.

- [ ] **Step 4: Full verification**

Run (from `packages/backend`): `node --env-file-if-exists=.env ../../node_modules/mocha/bin/mocha.js --config .mocharc.scoped.json --exit test/features/entity-history/*.test.ts test/features/player-content/groups.actions.test.ts test/features/player-content/entries.actions.test.ts test/campaigns/comment-update.test.ts test/campaigns/comments-actions.test.ts test/campaigns/campaign-actions.test.ts test/controllers/campaign-update.controller.test.ts test/controllers/entity-history.controller.test.ts`
Expected: all passing.

Run: `cd packages/features && npm run compile && cd ../backend && npm run compile && cd ../worker && npm run compile`
Expected: exit 0 for all three (the worker only imports the `EntityChanged` type).

Run (from `packages/backend`): `npm test`
Expected: all passing (full backend suite against the running stack).

- [ ] **Step 5: Commit**

```bash
git add packages/features/src/entity-history/actions/Emit.ts packages/features/src/entity-history/README.md
git commit -m "refactor(entity-history): drop _dto_changes; document @ChangeTracked and _update_tracked"
```

- [ ] **Step 6: Final spinajs verification**

In the spinajs repo: `cd packages/orm && npm test && npm run compile && cd ../orm-sqlite && npm test`
Expected: all passing. Both branches are then ready for review — spinajs `feat/orm-unified-dirty-tracking`, backend `feat/entity-history-model-changes` (the backend branch depends on the spinajs branch being built into the symlinked `packages/orm/lib`).
