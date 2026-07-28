# ORM Migration Service Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract migration execution from `Orm` into a per-connection, DI-injectable `OrmMigrationService` (+ `MigrationRunner` facade at `orm.Migration`), adding batch rollback, locking, failure-state tracking with resolve, fake apply, checksums, per-migration transaction opt-out, and a new `@spinajs/orm-cli` command package.

**Architecture:** Spec at `docs/superpowers/specs/2026-07-28-orm-migration-service-design.md` (read it first). Two new units in `@spinajs/orm` — `migration-service.ts` (abstract contract + `DefaultMigrationService`, per connection) and `migration-runner.ts` (cross-connection orchestrator) — plus a new `packages/orm-cli` package following the `packages/email` CLI pattern. `Orm.migrateUp/migrateDown` are deleted (breaking).

**Tech Stack:** TypeScript ESM (all relative imports MUST end in `.js`), `@spinajs/di`, luxon, node:crypto, node:os, mocha+chai+sinon (`ts-mocha`), commander via `@spinajs/cli`.

## Global Constraints

- Every relative import inside packages ends with `.js` (ESM, `"type": "module"`).
- New package version: `2.0.486`; internal deps use `^2.0.486`.
- Node >= 16.11.
- Windows dev box; run tests per package: `cd packages/<p>` then `npm run test` (`ts-mocha -p tsconfig.json test/**/*.test.ts`). Compile check: `npm run compile`.
- Conventional commits. Commit at the end of every task.
- Do NOT touch `packages/*/lib/**` (build output).
- MySQL/MSSQL integration suites need live servers — do not run them; compile-check those packages instead (`npm run compile`).
- The tracking-table default name stays `spinajs_migration`. Migration class-name regex stays `/(.*)_([0-9]{4}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2})/`.

---

### Task 1: Config surface in `interfaces.ts`

**Files:**
- Modify: `packages/orm/src/interfaces.ts:252-262` (enum), `packages/orm/src/interfaces.ts:379-399` (Migration config)
- Modify: `packages/orm/test/migration.test.ts:98` (config typo)

**Interfaces:**
- Produces: `MigrationTransactionMode.PerRun`; `IDriverOptions.Migration.Service?: string`; `IDriverOptions.Migration.Lock?: { Enabled?: boolean; Timeout?: number; StaleAfter?: number }`.

- [ ] **Step 1: Extend enum + config type**

In `interfaces.ts` replace the `MigrationTransactionMode` enum with:

```ts
export enum MigrationTransactionMode {
  /**
   * Migration is run whithout transaction
   */
  None,

  /**
   * On transaction for one migration - every migration has its own
   */
  PerMigration,

  /**
   * One transaction wraps the whole per-connection run. Migrations with
   * `transaction = false` run outside it, splitting the run into segments.
   */
  PerRun,
}
```

Replace the `Migration?: {...}` block of `IDriverOptions` with:

```ts
  Migration?: {
    /**
     * Should run migration on startup
     */
    OnStartup?: boolean;

    /**
     * Migration table name, if not set default is spinajs_migration
     */
    Table?: string;

    /**
     * DI token of an OrmMigrationService implementation used for this
     * connection. Absent = built-in DefaultMigrationService.
     */
    Service?: string;

    /**
     * Migration transaction options
     */
    Transaction?: {
      /**
       * How to run migration - with or without transaction
       */
      Mode?: MigrationTransactionMode;
    };

    /**
     * Concurrency guard for migration runs.
     */
    Lock?: {
      /**
       * Default true.
       */
      Enabled?: boolean;

      /**
       * Ms to wait for the lock before failing. Default 30_000.
       */
      Timeout?: number;

      /**
       * Ms after which a held lock counts as stale and is stolen. Default 600_000.
       */
      StaleAfter?: number;
    };
  };
```

- [ ] **Step 2: Fix test config typo**

`packages/orm/test/migration.test.ts` line 98: `Startup: true,` → `OnStartup: true,`.

- [ ] **Step 3: Verify**

Run: `cd packages/orm && npm run compile` → exit 0. `npm run test -- --grep "Orm migrations"` → all green (same count as before).

- [ ] **Step 4: Commit**

```bash
git add packages/orm/src/interfaces.ts packages/orm/test/migration.test.ts
git commit -m "feat(orm): migration config surface - PerRun mode, Service token, Lock options"
```

---

### Task 2: `migration-service.ts` — types, contract, storage

**Files:**
- Create: `packages/orm/src/migration-service.ts`
- Modify: `packages/orm/src/index.ts` (add `export * from './migration-service.js';`)
- Test: `packages/orm/test/migration-service.test.ts` (new)

**Interfaces:**
- Consumes: `OrmDriver` (`driver.schema()`, `driver.select()`, `driver.insert()`, `driver.update()`, `driver.del()`, `driver.tableInfo()`, `driver.transaction()`, `driver.Options`, `driver.Container`), Task 1 config types.
- Produces (used by Tasks 3-10):

```ts
export const MIGRATION_TABLE_NAME = 'spinajs_migration';
export type MigrationResolveAction = 'applied' | 'rolled-back';

export interface IMigrationRecord {
  Migration: string;
  CreatedAt: Date;
  StartedAt: Date;
  FinishedAt: Date | null;
  RolledBackAt: Date | null;
  Logs: string | null;
  Checksum: string | null;
  Batch: number;
}

export interface IMigrationUnit {
  name: string;              // class name
  created: DateTime;         // parsed from name (luxon)
  type: Class<OrmMigration>;
}

export interface IMigrationRunOptions { fake?: boolean; }
export interface IMigrationDownOptions extends IMigrationRunOptions { all?: boolean; }

export interface IMigrationStatusEntry {
  name: string;
  connection: string;
  applied: boolean;
  failed: boolean;
  rolledBack: boolean;
  pending: boolean;
  batch: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  checksumMismatch: boolean;
}

export function migrationChecksum(type: Class<OrmMigration>): string; // sha256 hex of type.toString()

@NewInstance()
export abstract class OrmMigrationService {
  constructor(protected driver: OrmDriver);
  public abstract ensureStorage(): Promise<void>;
  public abstract applied(): Promise<IMigrationRecord[]>;
  public abstract up(units: IMigrationUnit[], options?: IMigrationRunOptions): Promise<OrmMigration[]>;
  public abstract down(units: IMigrationUnit[], options?: IMigrationDownOptions): Promise<OrmMigration[]>;
  public abstract status(units: IMigrationUnit[]): Promise<IMigrationStatusEntry[]>;
  public abstract resolve(name: string, action: MigrationResolveAction): Promise<void>;
}

export class DefaultMigrationService extends OrmMigrationService { ... }
```

- [ ] **Step 1: Write failing tests**

Create `packages/orm/test/migration-service.test.ts`:

```ts
import { Configuration } from '@spinajs/configuration';
import { DI, Bootstrapper } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import { FakeSqliteDriver, FakeSelectQueryCompiler, FakeDeleteQueryCompiler, FakeUpdateQueryCompiler, FakeInsertQueryCompiler, ConnectionConf, FakeTableQueryCompiler, FakeColumnQueryCompiler, FakeTableExistsCompiler, TEST_TABLE_INFO } from './misc.js';
import { SelectQueryCompiler, DeleteQueryCompiler, UpdateQueryCompiler, InsertQueryCompiler, TableQueryCompiler, ColumnQueryCompiler, TableExistsCompiler, DefaultMigrationService, MIGRATION_TABLE_NAME, migrationChecksum, OrmMigration } from '../src/index.js';
import { TableQueryBuilder, AlterTableQueryBuilder, RawQuery } from '../src/builders.js';
import { OrmDriver } from '../src/driver.js';
import '../src/bootstrap.js';

const expect = chai.expect;

async function makeDriver(): Promise<FakeSqliteDriver> {
  // resolve driver exactly like Orm does, with the sqlite connection options from ConnectionConf
  const conf = await DI.resolve(Configuration);
  const opts = conf.get<any[]>('db.Connections').find((c) => c.Name === 'sqlite');
  return (await DI.resolve<OrmDriver>('sqlite', [opts])) as FakeSqliteDriver;
}

describe('DefaultMigrationService storage', () => {
  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    DI.register(FakeSelectQueryCompiler).as(SelectQueryCompiler);
    DI.register(FakeDeleteQueryCompiler).as(DeleteQueryCompiler);
    DI.register(FakeUpdateQueryCompiler).as(UpdateQueryCompiler);
    DI.register(FakeInsertQueryCompiler).as(InsertQueryCompiler);
    DI.register(FakeTableQueryCompiler).as(TableQueryCompiler);
    DI.register(FakeColumnQueryCompiler).as(ColumnQueryCompiler);
    DI.register(FakeTableExistsCompiler).as(TableExistsCompiler);
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) await b.bootstrap();
  });

  afterEach(() => {
    DI.clearCache();
    sinon.restore();
    delete TEST_TABLE_INFO[MIGRATION_TABLE_NAME];
  });

  it('creates tracking and lock tables when absent', async () => {
    const driver = await makeDriver();
    // tableExists compiles through FakeTableExistsCompiler; empty result = table absent
    const exec = sinon.stub(FakeSqliteDriver.prototype, 'execute').resolves([]);
    const svc = new DefaultMigrationService(driver);

    await svc.ensureStorage();

    const created = exec.getCalls().filter((c) => c.args[0] instanceof TableQueryBuilder);
    expect(created).to.have.length(2); // spinajs_migration + spinajs_migration_lock
  });

  it('upgrades legacy 2-column table and backfills', async () => {
    const driver = await makeDriver();
    // legacy shape: only Migration + CreatedAt known to tableInfo
    TEST_TABLE_INFO[MIGRATION_TABLE_NAME] = [
      { Name: 'Migration' }, { Name: 'CreatedAt' },
    ] as any;
    const exec = sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
      // tableExists → any non-empty row = exists
      return [{ 1: 1 }];
    });
    const svc = new DefaultMigrationService(driver);

    await svc.ensureStorage();

    const alters = exec.getCalls().filter((c) => c.args[0] instanceof AlterTableQueryBuilder);
    // StartedAt, FinishedAt, RolledBackAt, Logs, Checksum, Batch = 6 added columns
    expect(alters.length).to.be.gte(1);
    const raws = exec.getCalls().filter((c) => c.args[0] instanceof RawQuery || c.args[0]?.constructor?.name === 'RawSchemaQueryBuilder');
    expect(raws.length).to.be.gte(1); // backfill UPDATE ran
  });

  it('applied() returns only finished, not-rolled-back rows', async () => {
    const driver = await makeDriver();
    const now = new Date();
    sinon.stub(FakeSqliteDriver.prototype, 'execute').resolves([
      { Migration: 'A_2021_01_01_00_00_00', CreatedAt: now, StartedAt: now, FinishedAt: now, RolledBackAt: null, Logs: null, Checksum: null, Batch: 1 },
      { Migration: 'B_2021_01_02_00_00_00', CreatedAt: now, StartedAt: now, FinishedAt: null, RolledBackAt: null, Logs: 'boom', Checksum: null, Batch: 1 },
      { Migration: 'C_2021_01_03_00_00_00', CreatedAt: now, StartedAt: now, FinishedAt: now, RolledBackAt: now, Logs: null, Checksum: null, Batch: 2 },
    ]);
    const svc = new DefaultMigrationService(driver);

    const rows = await svc.applied();
    expect(rows.map((r) => r.Migration)).to.eql(['A_2021_01_01_00_00_00']);
  });

  it('migrationChecksum is stable sha256 hex of class source', () => {
    class X_2021_01_01_00_00_00 extends OrmMigration {
      public async up() {}
      public async down() {}
    }
    const a = migrationChecksum(X_2021_01_01_00_00_00);
    const b = migrationChecksum(X_2021_01_01_00_00_00);
    expect(a).to.eq(b);
    expect(a).to.match(/^[0-9a-f]{64}$/);
  });
});
```

Note: `TEST_TABLE_INFO` must be exported from `test/misc.ts` — if it is module-private today, export the existing object (`export const TEST_TABLE_INFO`), do not duplicate it.

- [ ] **Step 2: Run tests, verify failure**

Run: `cd packages/orm && npm run test -- --grep "DefaultMigrationService storage"`
Expected: FAIL — `migration-service.js` has no exported members.

- [ ] **Step 3: Implement**

Create `packages/orm/src/migration-service.ts`:

```ts
import { NewInstance, Class } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';
import { OrmDriver } from './driver.js';
import { OrmMigration, MigrationTransactionMode } from './interfaces.js';
import { OrmException } from './exceptions.js';

export const MIGRATION_TABLE_NAME = 'spinajs_migration';
export const MIGRATION_LOCK_POLL_INTERVAL = 500;
export const MIGRATION_LOCK_TIMEOUT = 30_000;
export const MIGRATION_LOCK_STALE_AFTER = 600_000;

export type MigrationResolveAction = 'applied' | 'rolled-back';

export interface IMigrationRecord {
  Migration: string;
  CreatedAt: Date;
  StartedAt: Date;
  FinishedAt: Date | null;
  RolledBackAt: Date | null;
  Logs: string | null;
  Checksum: string | null;
  Batch: number;
}

export interface IMigrationUnit {
  name: string;
  created: DateTime;
  type: Class<OrmMigration>;
}

export interface IMigrationRunOptions {
  fake?: boolean;
}

export interface IMigrationDownOptions extends IMigrationRunOptions {
  all?: boolean;
}

export interface IMigrationStatusEntry {
  name: string;
  connection: string;
  applied: boolean;
  failed: boolean;
  rolledBack: boolean;
  pending: boolean;
  batch: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  checksumMismatch: boolean;
}

export function migrationChecksum(type: Class<OrmMigration>): string {
  return createHash('sha256').update(type.toString()).digest('hex');
}

/**
 * Per-connection migration execution contract. Configure an alternative
 * implementation with db.Connections[n].Migration.Service (DI token).
 */
@NewInstance()
export abstract class OrmMigrationService {
  constructor(protected driver: OrmDriver) {}

  public abstract ensureStorage(): Promise<void>;
  public abstract applied(): Promise<IMigrationRecord[]>;
  public abstract up(units: IMigrationUnit[], options?: IMigrationRunOptions): Promise<OrmMigration[]>;
  public abstract down(units: IMigrationUnit[], options?: IMigrationDownOptions): Promise<OrmMigration[]>;
  public abstract status(units: IMigrationUnit[]): Promise<IMigrationStatusEntry[]>;
  public abstract resolve(name: string, action: MigrationResolveAction): Promise<void>;
}

export class DefaultMigrationService extends OrmMigrationService {
  @Logger('ORM')
  protected Log: Log;

  protected get table(): string {
    return this.driver.Options.Migration?.Table ?? MIGRATION_TABLE_NAME;
  }

  protected get lockTable(): string {
    return `${this.table}_lock`;
  }

  public async ensureStorage(): Promise<void> {
    const schema = () => this.driver.schema();
    const db = this.driver.Options.Database;

    if (!(await schema().tableExists(this.table, db))) {
      await schema().createTable(this.table, (t) => {
        t.string('Migration').unique().notNull();
        t.dateTime('CreatedAt').notNull();
        t.dateTime('StartedAt').notNull();
        t.dateTime('FinishedAt');
        t.dateTime('RolledBackAt');
        t.text('Logs');
        t.string('Checksum', 64);
        t.int('Batch').notNull().default().value(1);
      });
    } else {
      const cols = (await this.driver.tableInfo(this.table, db)) ?? [];
      const has = (n: string) => cols.some((c) => c.Name === n);

      if (!has('StartedAt') || !has('FinishedAt') || !has('RolledBackAt') || !has('Logs') || !has('Checksum') || !has('Batch')) {
        await schema().alterTable(this.table, (t) => {
          if (!has('StartedAt')) t.dateTime('StartedAt').addColumn();
          if (!has('FinishedAt')) t.dateTime('FinishedAt').addColumn();
          if (!has('RolledBackAt')) t.dateTime('RolledBackAt').addColumn();
          if (!has('Logs')) t.text('Logs').addColumn();
          if (!has('Checksum')) t.string('Checksum', 64).addColumn();
          if (!has('Batch')) t.int('Batch').default().value(1).addColumn();
        });

        // legacy rows: applied long ago, treat CreatedAt as both start and finish
        await schema().raw(`UPDATE ${this.table} SET StartedAt = CreatedAt WHERE StartedAt IS NULL`);
        await schema().raw(`UPDATE ${this.table} SET FinishedAt = CreatedAt WHERE FinishedAt IS NULL AND Logs IS NULL`);
        await schema().raw(`UPDATE ${this.table} SET Batch = 1 WHERE Batch IS NULL`);
      }
    }

    if (!(await schema().tableExists(this.lockTable, db))) {
      await schema().createTable(this.lockTable, (t) => {
        t.int('Id').unique().notNull();
        t.dateTime('AcquiredAt').notNull();
        t.string('Owner', 255).notNull();
      });
    }
  }

  protected async records(): Promise<IMigrationRecord[]> {
    return ((await this.driver.select().from(this.table)) ?? []) as IMigrationRecord[];
  }

  public async applied(): Promise<IMigrationRecord[]> {
    return (await this.records()).filter((r) => r.FinishedAt !== null && r.FinishedAt !== undefined && !r.RolledBackAt);
  }

  // up/down/status/resolve/locking implemented in later tasks
  public async up(): Promise<OrmMigration[]> {
    throw new OrmException('not implemented');
  }
  public async down(): Promise<OrmMigration[]> {
    throw new OrmException('not implemented');
  }
  public async status(): Promise<IMigrationStatusEntry[]> {
    throw new OrmException('not implemented');
  }
  public async resolve(): Promise<void> {
    throw new OrmException('not implemented');
  }
}
```

(`node:os` `hostname` is NOT imported here — Task 5 adds it together with the lock code.)

Add to `packages/orm/src/index.ts` (alphabetical spot near other exports): `export * from './migration-service.js';`

Export `TEST_TABLE_INFO` from `test/misc.ts` if not already exported.

- [ ] **Step 4: Run tests, verify pass**

Run: `cd packages/orm && npm run test -- --grep "DefaultMigrationService storage"` → 4 passing. Full suite: `npm run test` → no regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/orm/src/migration-service.ts packages/orm/src/index.ts packages/orm/test/migration-service.test.ts packages/orm/test/misc.ts
git commit -m "feat(orm): OrmMigrationService contract + DefaultMigrationService storage"
```

---

### Task 3: `DefaultMigrationService.up()` — gate, batch, fake, checksum, failure state, transactions

**Files:**
- Modify: `packages/orm/src/migration-service.ts`
- Test: `packages/orm/test/migration-service.test.ts`

**Interfaces:**
- Consumes: Task 2 storage helpers.
- Produces: working `up(units, {fake})`; per-class opt-out honored via `(migration as any).transaction === false`; throws `OrmException` when a failed row blocks the run.

- [ ] **Step 1: Write failing tests** (append to `migration-service.test.ts`; reuse the `before`/`beforeEach` registration block in a new `describe('DefaultMigrationService up', ...)` with the same body as Task 2's)

```ts
const now = new Date();
const row = (over: Partial<IMigrationRecord>): IMigrationRecord => ({
  Migration: 'X', CreatedAt: now, StartedAt: now, FinishedAt: now,
  RolledBackAt: null, Logs: null, Checksum: null, Batch: 1, ...over,
});

class MigA_2021_01_01_00_00_00 extends OrmMigration {
  public async up(_c: OrmDriver) {}
  public async down(_c: OrmDriver) {}
}
class MigB_2021_01_02_00_00_00 extends OrmMigration {
  public async up(_c: OrmDriver) {}
  public async down(_c: OrmDriver) {}
}
const unit = (t: Class<OrmMigration>): IMigrationUnit => ({
  name: t.name,
  created: DateTime.fromFormat(t.name.match(/_(\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2})$/)![1], 'yyyy_MM_dd_HH_mm_ss'),
  type: t,
});

// Helper: stub execute so select-from-tracking-table returns `rows`,
// everything else resolves []. InsertQueryBuilder calls captured for assertions.
function stubDb(rows: IMigrationRecord[]) {
  return sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
    if (b instanceof SelectQueryBuilder && b.Table === MIGRATION_TABLE_NAME) return rows;
    return [{ 1: 1 }]; // tableExists = true, other statements = ok
  });
}

it('runs pending migrations, skips applied, stamps next batch', async () => {
  const driver = await makeDriver();
  const exec = stubDb([row({ Migration: 'MigA_2021_01_01_00_00_00', Batch: 3 })]);
  const upA = sinon.spy(MigA_2021_01_01_00_00_00.prototype, 'up');
  const upB = sinon.spy(MigB_2021_01_02_00_00_00.prototype, 'up');
  const svc = new DefaultMigrationService(driver);

  const executed = await svc.up([unit(MigA_2021_01_01_00_00_00), unit(MigB_2021_01_02_00_00_00)]);

  expect(upA.called).to.be.false;
  expect(upB.calledOnce).to.be.true;
  expect(executed).to.have.length(1);
  const inserts = exec.getCalls().filter((c) => c.args[0] instanceof InsertQueryBuilder);
  expect(inserts.length).to.be.gte(1);
  // batch = max(3) + 1
  const insertedValues = (inserts[0].args[0] as any).Values ?? (inserts[0].args[0] as any)._values;
  // assert through update call instead when insert only carries StartedAt — see implementation note
});

it('fake: true records without executing', async () => {
  const driver = await makeDriver();
  const exec = stubDb([]);
  const upB = sinon.spy(MigB_2021_01_02_00_00_00.prototype, 'up');
  const svc = new DefaultMigrationService(driver);

  const executed = await svc.up([unit(MigB_2021_01_02_00_00_00)], { fake: true });

  expect(upB.called).to.be.false;
  expect(executed).to.have.length(1);
  expect(exec.getCalls().some((c) => c.args[0] instanceof InsertQueryBuilder)).to.be.true;
});

it('failed row blocks the run with resolve hint', async () => {
  const driver = await makeDriver();
  stubDb([row({ Migration: 'MigA_2021_01_01_00_00_00', FinishedAt: null, Logs: 'kaboom' })]);
  const svc = new DefaultMigrationService(driver);

  try {
    await svc.up([unit(MigB_2021_01_02_00_00_00)]);
    expect.fail('should have thrown');
  } catch (e: any) {
    expect(e.message).to.contain('MigA_2021_01_01_00_00_00');
    expect(e.message).to.contain('resolve');
  }
});

it('failing up() writes Logs and rethrows', async () => {
  const driver = await makeDriver();
  const exec = stubDb([]);
  sinon.stub(MigA_2021_01_01_00_00_00.prototype, 'up').rejects(new Error('ddl exploded'));
  const svc = new DefaultMigrationService(driver);

  try {
    await svc.up([unit(MigA_2021_01_01_00_00_00)]);
    expect.fail('should have thrown');
  } catch (e: any) {
    expect(e.message).to.contain('ddl exploded');
  }
  // failure recorded via UpdateQueryBuilder carrying Logs
  const updates = exec.getCalls().filter((c) => c.args[0] instanceof UpdateQueryBuilder);
  expect(updates.some((c) => (c.args[0] as any).Value?.Logs)).to.be.true;
});

it('PerRun wraps whole run in one transaction, transaction=false runs outside', async () => {
  const driver = await makeDriver();
  (driver.Options.Migration ??= {}).Transaction = { Mode: MigrationTransactionMode.PerRun };
  stubDb([]);
  class NoTx_2021_01_03_00_00_00 extends OrmMigration {
    public transaction = false;
    public async up(_c: OrmDriver) {}
    public async down(_c: OrmDriver) {}
  }
  const tr = sinon.spy(FakeSqliteDriver.prototype, 'transaction');
  const svc = new DefaultMigrationService(driver);

  await svc.up([unit(MigA_2021_01_01_00_00_00), unit(MigB_2021_01_02_00_00_00), unit(NoTx_2021_01_03_00_00_00)]);

  expect(tr.callCount).to.eq(1); // A+B in one tx; NoTx outside
});
```

Add needed imports at top of the test file: `SelectQueryBuilder, InsertQueryBuilder as InsertQB...` — import `SelectQueryBuilder`, `InsertQueryBuilder`, `UpdateQueryBuilder` classes from `../src/builders.js`, `IMigrationRecord`, `IMigrationUnit`, `MigrationTransactionMode`, `DateTime` from luxon, `Class` from `@spinajs/di`.

- [ ] **Step 2: Run, verify failure** — `npm run test -- --grep "DefaultMigrationService up"` → FAIL (`not implemented`).

- [ ] **Step 3: Implement `up()` + helpers in `DefaultMigrationService`**

```ts
  protected async upsertStart(name: string, existing: IMigrationRecord | undefined): Promise<void> {
    const now = new Date();
    if (existing) {
      await this.driver.update().in(this.table).update({ StartedAt: now, FinishedAt: null, RolledBackAt: null, Logs: null }).where({ Migration: name });
    } else {
      await this.driver.insert().into(this.table).values({ Migration: name, CreatedAt: now, StartedAt: now, FinishedAt: null, RolledBackAt: null, Logs: null, Checksum: null, Batch: 0 });
    }
  }

  protected async markFinished(name: string, batch: number, checksum: string): Promise<void> {
    await this.driver.update().in(this.table).update({ FinishedAt: new Date(), Batch: batch, Checksum: checksum }).where({ Migration: name });
  }

  protected async markFailed(name: string, err: Error): Promise<void> {
    await this.driver.update().in(this.table).update({ Logs: `${err.message}\n${err.stack ?? ''}` }).where({ Migration: name });
  }

  protected assertNoFailed(records: IMigrationRecord[]): void {
    const failed = records.find((r) => !r.FinishedAt && r.Logs);
    if (failed) {
      throw new OrmException(
        `Migration ${failed.Migration} on connection ${this.driver.Options.Name} failed previously and blocks migration runs. Inspect Logs column, fix the database manually, then run orm.Migration.resolve('${failed.Migration}', 'applied') or ('rolled-back').`,
      );
    }
  }

  protected transactionMode(): MigrationTransactionMode {
    return this.driver.Options.Migration?.Transaction?.Mode ?? MigrationTransactionMode.None;
  }

  public async up(units: IMigrationUnit[], options?: IMigrationRunOptions): Promise<OrmMigration[]> {
    await this.ensureStorage();

    return await this.withLock(async () => {
      const records = await this.records();
      this.assertNoFailed(records);

      const isApplied = (n: string) => records.some((r) => r.Migration === n && r.FinishedAt && !r.RolledBackAt);
      const pending = units.filter((u) => !isApplied(u.name));
      if (pending.length === 0) {
        return [];
      }

      const batch = Math.max(0, ...records.filter((r) => r.FinishedAt && !r.RolledBackAt).map((r) => r.Batch ?? 0)) + 1;
      const executed: OrmMigration[] = [];

      if (options?.fake) {
        const now = new Date();
        for (const u of pending) {
          const existing = records.find((r) => r.Migration === u.name);
          if (existing) {
            await this.driver.update().in(this.table).update({ StartedAt: now, FinishedAt: now, RolledBackAt: null, Logs: null, Batch: batch, Checksum: migrationChecksum(u.type) }).where({ Migration: u.name });
          } else {
            await this.driver.insert().into(this.table).values({ Migration: u.name, CreatedAt: now, StartedAt: now, FinishedAt: now, RolledBackAt: null, Logs: null, Checksum: migrationChecksum(u.type), Batch: batch });
          }
          executed.push(await this.driver.Container.resolve<OrmMigration>(u.type, [this.driver]));
          this.Log.info(`Migration ${u.name}: faked (recorded without executing)`);
        }
        return executed;
      }

      const runOne = async (u: IMigrationUnit) => {
        const migration = await this.driver.Container.resolve<OrmMigration>(u.type, [this.driver]);
        this.warnOnChecksumDrift(u, records);
        await migration.up(this.driver);
        await this.markFinished(u.name, batch, migrationChecksum(u.type));
        executed.push(migration);
        this.Log.info(`Migration ${u.name}:up() success !`);
      };

      const mode = this.transactionMode();

      // segments: consecutive migrations sharing "wrap in tx" flag; transaction=false opts out
      const optedOut = (u: IMigrationUnit) => (u.type.prototype as any).transaction === false || (u.type as any).transaction === false;

      const execute = async (u: IMigrationUnit, wrap: boolean) => {
        const existing = (await this.records()).find((r) => r.Migration === u.name);
        try {
          if (wrap) {
            await this.driver.transaction(async () => {
              await this.upsertStart(u.name, existing);
              await runOne(u);
            });
          } else {
            await this.upsertStart(u.name, existing);
            await runOne(u);
          }
        } catch (err) {
          // failure record must survive the rollback: write it AFTER the tx unwound
          const fresh = (await this.records()).find((r) => r.Migration === u.name);
          if (!fresh) {
            await this.upsertStart(u.name, undefined);
          }
          await this.markFailed(u.name, err as Error);
          throw new OrmException(`Migration ${u.name} failed on connection ${this.driver.Options.Name}: ${(err as Error).message}`, this.driver.Options, undefined, undefined, err);
        }
      };

      if (mode === MigrationTransactionMode.PerRun) {
        // split into segments around opted-out migrations, preserve order
        let i = 0;
        while (i < pending.length) {
          if (optedOut(pending[i])) {
            await execute(pending[i], false);
            i++;
            continue;
          }
          const segment: IMigrationUnit[] = [];
          while (i < pending.length && !optedOut(pending[i])) segment.push(pending[i++]);
          try {
            await this.driver.transaction(async () => {
              for (const u of segment) {
                const existing = (await this.records()).find((r) => r.Migration === u.name);
                await this.upsertStart(u.name, existing);
                await runOne(u);
              }
            });
          } catch (err) {
            const failedName = segment.find((u) => !executed.some((e) => e.constructor.name === u.name))?.name ?? segment[segment.length - 1].name;
            const fresh = (await this.records()).find((r) => r.Migration === failedName);
            if (!fresh) await this.upsertStart(failedName, undefined);
            await this.markFailed(failedName, err as Error);
            throw err instanceof OrmException ? err : new OrmException(`Migration run failed on ${failedName}: ${(err as Error).message}`, this.driver.Options, undefined, undefined, err);
          }
        }
      } else if (mode === MigrationTransactionMode.PerMigration) {
        for (const u of pending) await execute(u, !optedOut(u));
      } else {
        for (const u of pending) await execute(u, false);
      }

      return executed;
    });
  }

  protected warnOnChecksumDrift(u: IMigrationUnit, records: IMigrationRecord[]): void {
    const rec = records.find((r) => r.Migration === u.name);
    if (rec?.Checksum && rec.Checksum !== migrationChecksum(u.type)) {
      this.Log.warn(`Migration ${u.name} source changed since it was applied (checksum mismatch). This is advisory - transpilation differences also change the checksum.`);
    }
  }

  // Task 5 replaces this passthrough with real locking
  protected async withLock<R>(fn: () => Promise<R>): Promise<R> {
    return fn();
  }
```

Implementation note for the batch assertion in test 1: batch number lands via `markFinished` (an `UpdateQueryBuilder` whose `.Value.Batch === 4`); assert on that instead of the insert if simpler — adjust the test accordingly when wiring it up.

- [ ] **Step 4: Run, verify pass** — `npm run test -- --grep "DefaultMigrationService up"` → 5 passing; full `npm run test` green.

- [ ] **Step 5: Commit** — `git add -A packages/orm && git commit -m "feat(orm): DefaultMigrationService.up - batch, fake, checksum, failure state, tx modes"`

---

### Task 4: `down()`, `resolve()`, `status()`

**Files:**
- Modify: `packages/orm/src/migration-service.ts`
- Test: `packages/orm/test/migration-service.test.ts`

**Interfaces:**
- Produces: `down(units, {all?, fake?})` default = last batch; `resolve(name, 'applied'|'rolled-back')`; `status(units)` → `IMigrationStatusEntry[]`.

- [ ] **Step 1: Failing tests** (new `describe('DefaultMigrationService down/resolve/status', ...)`, same registration boilerplate)

```ts
it('down() reverses only the last batch, in reverse order', async () => {
  const driver = await makeDriver();
  stubDb([
    row({ Migration: 'MigA_2021_01_01_00_00_00', Batch: 1 }),
    row({ Migration: 'MigB_2021_01_02_00_00_00', Batch: 2 }),
  ]);
  const dA = sinon.spy(MigA_2021_01_01_00_00_00.prototype, 'down');
  const dB = sinon.spy(MigB_2021_01_02_00_00_00.prototype, 'down');
  const svc = new DefaultMigrationService(driver);

  const executed = await svc.down([unit(MigA_2021_01_01_00_00_00), unit(MigB_2021_01_02_00_00_00)]);

  expect(dA.called).to.be.false;
  expect(dB.calledOnce).to.be.true;
  expect(executed).to.have.length(1);
});

it('down({all:true}) reverses everything, newest first', async () => {
  const driver = await makeDriver();
  stubDb([
    row({ Migration: 'MigA_2021_01_01_00_00_00', Batch: 1 }),
    row({ Migration: 'MigB_2021_01_02_00_00_00', Batch: 2 }),
  ]);
  const dA = sinon.spy(MigA_2021_01_01_00_00_00.prototype, 'down');
  const dB = sinon.spy(MigB_2021_01_02_00_00_00.prototype, 'down');
  const svc = new DefaultMigrationService(driver);

  await svc.down([unit(MigA_2021_01_01_00_00_00), unit(MigB_2021_01_02_00_00_00)], { all: true });

  expect(dB.calledBefore(dA)).to.be.true;
});

it('down({fake:true}) removes records without executing', async () => {
  const driver = await makeDriver();
  const exec = stubDb([row({ Migration: 'MigB_2021_01_02_00_00_00', Batch: 1 })]);
  const dB = sinon.spy(MigB_2021_01_02_00_00_00.prototype, 'down');
  const svc = new DefaultMigrationService(driver);

  await svc.down([unit(MigB_2021_01_02_00_00_00)], { fake: true });

  expect(dB.called).to.be.false;
  expect(exec.getCalls().some((c) => c.args[0] instanceof DeleteQueryBuilder)).to.be.true;
});

it('resolve applied / rolled-back mutate the failed row', async () => {
  const driver = await makeDriver();
  const exec = stubDb([row({ Migration: 'MigA_2021_01_01_00_00_00', FinishedAt: null, Logs: 'x' })]);
  const svc = new DefaultMigrationService(driver);

  await svc.resolve('MigA_2021_01_01_00_00_00', 'applied');
  let updates = exec.getCalls().filter((c) => c.args[0] instanceof UpdateQueryBuilder);
  expect((updates.at(-1)!.args[0] as any).Value.FinishedAt).to.be.instanceOf(Date);

  await svc.resolve('MigA_2021_01_01_00_00_00', 'rolled-back');
  updates = exec.getCalls().filter((c) => c.args[0] instanceof UpdateQueryBuilder);
  expect((updates.at(-1)!.args[0] as any).Value.RolledBackAt).to.be.instanceOf(Date);
});

it('resolve on unknown or healthy migration throws', async () => {
  const driver = await makeDriver();
  stubDb([row({ Migration: 'MigA_2021_01_01_00_00_00' })]); // healthy
  const svc = new DefaultMigrationService(driver);
  try {
    await svc.resolve('MigA_2021_01_01_00_00_00', 'applied');
    expect.fail('should throw');
  } catch (e: any) {
    expect(e.message).to.contain('not in failed state');
  }
});

it('status() merges registry with records', async () => {
  const driver = await makeDriver();
  stubDb([
    row({ Migration: 'MigA_2021_01_01_00_00_00', Batch: 1, Checksum: 'deadbeef' }), // mismatch
    row({ Migration: 'MigB_2021_01_02_00_00_00', FinishedAt: null, Logs: 'x' }),    // failed
  ]);
  const svc = new DefaultMigrationService(driver);

  const st = await svc.status([unit(MigA_2021_01_01_00_00_00), unit(MigB_2021_01_02_00_00_00)]);

  expect(st.find((s) => s.name.startsWith('MigA'))!.applied).to.be.true;
  expect(st.find((s) => s.name.startsWith('MigA'))!.checksumMismatch).to.be.true;
  expect(st.find((s) => s.name.startsWith('MigB'))!.failed).to.be.true;
  expect(st.find((s) => s.name.startsWith('MigB'))!.pending).to.be.false;
});
```

(import `DeleteQueryBuilder` from `../src/builders.js`.)

- [ ] **Step 2: Run, verify FAIL** — grep `"down/resolve/status"`.

- [ ] **Step 3: Implement**

```ts
  public async down(units: IMigrationUnit[], options?: IMigrationDownOptions): Promise<OrmMigration[]> {
    await this.ensureStorage();

    return await this.withLock(async () => {
      const records = await this.records();
      const appliedRows = records.filter((r) => r.FinishedAt && !r.RolledBackAt);
      if (appliedRows.length === 0) return [];

      let target = appliedRows;
      if (!options?.all) {
        const lastBatch = Math.max(...appliedRows.map((r) => r.Batch ?? 0));
        target = appliedRows.filter((r) => (r.Batch ?? 0) === lastBatch);
      }

      const toRun = units
        .filter((u) => target.some((r) => r.Migration === u.name))
        .sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : b.name.localeCompare(a.name)));

      const executed: OrmMigration[] = [];
      const mode = this.transactionMode();
      const optedOut = (u: IMigrationUnit) => (u.type.prototype as any).transaction === false;

      const runOne = async (u: IMigrationUnit) => {
        const migration = await this.driver.Container.resolve<OrmMigration>(u.type, [this.driver]);
        if (!options?.fake) {
          await migration.down(this.driver);
        }
        await this.driver.del().from(this.table).where({ Migration: u.name });
        executed.push(migration);
        this.Log.info(`Migration down ${u.name}:${options?.fake ? 'faked' : 'DOWN success !'}`);
      };

      if (mode === MigrationTransactionMode.PerRun && !options?.fake) {
        await this.driver.transaction(async () => {
          for (const u of toRun) {
            if (optedOut(u)) throw new OrmException(`Migration ${u.name} has transaction=false - run it individually, PerRun down cannot mix modes`);
            await runOne(u);
          }
        });
      } else if (mode === MigrationTransactionMode.PerMigration && !options?.fake) {
        for (const u of toRun) {
          if (optedOut(u)) {
            await runOne(u);
          } else {
            await this.driver.transaction(async () => runOne(u));
          }
        }
      } else {
        for (const u of toRun) await runOne(u);
      }

      return executed;
    });
  }

  public async resolve(name: string, action: MigrationResolveAction): Promise<void> {
    await this.ensureStorage();
    const rec = (await this.records()).find((r) => r.Migration === name);

    if (!rec || rec.FinishedAt || !rec.Logs) {
      throw new OrmException(`Migration ${name} is not in failed state on connection ${this.driver.Options.Name} - nothing to resolve`);
    }

    if (action === 'applied') {
      await this.driver.update().in(this.table).update({ FinishedAt: new Date() }).where({ Migration: name });
      this.Log.info(`Migration ${name} resolved as applied`);
    } else {
      await this.driver.update().in(this.table).update({ RolledBackAt: new Date() }).where({ Migration: name });
      this.Log.info(`Migration ${name} resolved as rolled-back (pending again)`);
    }
  }

  public async status(units: IMigrationUnit[]): Promise<IMigrationStatusEntry[]> {
    await this.ensureStorage();
    const records = await this.records();

    return units.map((u) => {
      const rec = records.find((r) => r.Migration === u.name);
      const applied = !!(rec?.FinishedAt && !rec.RolledBackAt);
      const failed = !!(rec && !rec.FinishedAt && rec.Logs);
      return {
        name: u.name,
        connection: this.driver.Options.Name,
        applied,
        failed,
        rolledBack: !!rec?.RolledBackAt,
        pending: !applied && !failed,
        batch: rec?.Batch ?? null,
        startedAt: rec?.StartedAt ?? null,
        finishedAt: rec?.FinishedAt ?? null,
        checksumMismatch: !!(rec?.Checksum && rec.Checksum !== migrationChecksum(u.type)),
      };
    });
  }
```

- [ ] **Step 4: Run, verify pass**; full package suite green.
- [ ] **Step 5: Commit** — `git commit -am "feat(orm): DefaultMigrationService down/resolve/status"`

---

### Task 5: Lock

**Files:**
- Modify: `packages/orm/src/migration-service.ts` (replace `withLock` passthrough)
- Test: `packages/orm/test/migration-service.test.ts`

**Interfaces:**
- Produces: `withLock` acquiring/releasing `<table>_lock` row honoring `Lock.{Enabled,Timeout,StaleAfter}`.

- [ ] **Step 1: Failing tests**

```ts
describe('DefaultMigrationService lock', () => {
  // same registration boilerplate

  it('acquires and releases lock around up()', async () => {
    const driver = await makeDriver();
    const exec = stubDb([]);
    const svc = new DefaultMigrationService(driver);

    await svc.up([unit(MigA_2021_01_01_00_00_00)]);

    const lockInserts = exec.getCalls().filter((c) => c.args[0] instanceof InsertQueryBuilder && (c.args[0] as any).Table === `${MIGRATION_TABLE_NAME}_lock`);
    const lockDeletes = exec.getCalls().filter((c) => c.args[0] instanceof DeleteQueryBuilder && (c.args[0] as any).Table === `${MIGRATION_TABLE_NAME}_lock`);
    expect(lockInserts).to.have.length(1);
    expect(lockDeletes).to.have.length(1);
  });

  it('lock released even when migration throws', async () => {
    const driver = await makeDriver();
    const exec = stubDb([]);
    sinon.stub(MigA_2021_01_01_00_00_00.prototype, 'up').rejects(new Error('x'));
    const svc = new DefaultMigrationService(driver);

    await svc.up([unit(MigA_2021_01_01_00_00_00)]).catch(() => undefined);

    expect(exec.getCalls().some((c) => c.args[0] instanceof DeleteQueryBuilder && (c.args[0] as any).Table === `${MIGRATION_TABLE_NAME}_lock`)).to.be.true;
  });

  it('fresh foreign lock: times out with holder in message', async () => {
    const driver = await makeDriver();
    (driver.Options.Migration ??= {}).Lock = { Timeout: 600, StaleAfter: 60_000 };
    sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
      if (b instanceof InsertQueryBuilder && (b as any).Table === `${MIGRATION_TABLE_NAME}_lock`) throw new Error('UNIQUE constraint failed');
      if (b instanceof SelectQueryBuilder && (b as any).Table === `${MIGRATION_TABLE_NAME}_lock`) return [{ Id: 1, AcquiredAt: new Date(), Owner: 'other:123' }];
      if (b instanceof SelectQueryBuilder) return [];
      return [{ 1: 1 }];
    });
    const svc = new DefaultMigrationService(driver);

    try {
      await svc.up([unit(MigA_2021_01_01_00_00_00)]);
      expect.fail('should throw');
    } catch (e: any) {
      expect(e.message).to.contain('other:123');
    }
  }).timeout(5000);

  it('stale lock is stolen', async () => {
    const driver = await makeDriver();
    (driver.Options.Migration ??= {}).Lock = { Timeout: 5_000, StaleAfter: 1_000 };
    let insertAttempt = 0;
    sinon.stub(FakeSqliteDriver.prototype, 'execute').callsFake(async (b: any) => {
      if (b instanceof InsertQueryBuilder && (b as any).Table === `${MIGRATION_TABLE_NAME}_lock`) {
        insertAttempt++;
        if (insertAttempt === 1) throw new Error('UNIQUE constraint failed');
        return [];
      }
      if (b instanceof SelectQueryBuilder && (b as any).Table === `${MIGRATION_TABLE_NAME}_lock`) return [{ Id: 1, AcquiredAt: new Date(Date.now() - 10_000), Owner: 'dead:1' }];
      if (b instanceof SelectQueryBuilder) return [];
      return [{ 1: 1 }];
    });
    const svc = new DefaultMigrationService(driver);

    await svc.up([unit(MigA_2021_01_01_00_00_00)]); // no throw = stolen + acquired

    expect(insertAttempt).to.eq(2);
  });

  it('Enabled:false skips lock entirely', async () => {
    const driver = await makeDriver();
    (driver.Options.Migration ??= {}).Lock = { Enabled: false };
    const exec = stubDb([]);
    const svc = new DefaultMigrationService(driver);

    await svc.up([unit(MigA_2021_01_01_00_00_00)]);

    expect(exec.getCalls().some((c) => (c.args[0] as any)?.Table === `${MIGRATION_TABLE_NAME}_lock` && c.args[0] instanceof InsertQueryBuilder)).to.be.false;
  });
});
```

Note: builder table property — `QueryBuilder` exposes `Table` (see `interfaces.ts` `IQueryBuilder.Table`); verify casing when implementing, adjust assertions to the actual getter.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** — replace the passthrough:

```ts
  protected lockOptions() {
    const cfg = this.driver.Options.Migration?.Lock;
    return {
      enabled: cfg?.Enabled ?? true,
      timeout: cfg?.Timeout ?? MIGRATION_LOCK_TIMEOUT,
      staleAfter: cfg?.StaleAfter ?? MIGRATION_LOCK_STALE_AFTER,
    };
  }

  protected async acquireLock(): Promise<void> {
    const { timeout, staleAfter } = this.lockOptions();
    const owner = `${hostname()}:${process.pid}`;
    const start = Date.now();

    for (;;) {
      try {
        await this.driver.insert().into(this.lockTable).values({ Id: 1, AcquiredAt: new Date(), Owner: owner });
        return;
      } catch {
        const rows = (await this.driver.select().from(this.lockTable)) as Array<{ AcquiredAt: Date | string; Owner: string }>;
        const holder = rows?.[0];

        if (holder) {
          const acquiredAt = holder.AcquiredAt instanceof Date ? holder.AcquiredAt : new Date(holder.AcquiredAt);
          if (Date.now() - acquiredAt.getTime() > staleAfter) {
            this.Log.warn(`Stealing stale migration lock held by ${holder.Owner} on ${this.driver.Options.Name}`);
            await this.driver.del().from(this.lockTable).where({ Id: 1 });
            continue;
          }

          if (Date.now() - start > timeout) {
            throw new OrmException(`Could not acquire migration lock on connection ${this.driver.Options.Name} within ${timeout}ms - held by ${holder.Owner} since ${acquiredAt.toISOString()}`);
          }
        } else if (Date.now() - start > timeout) {
          throw new OrmException(`Could not acquire migration lock on connection ${this.driver.Options.Name} within ${timeout}ms`);
        }

        await new Promise((r) => setTimeout(r, MIGRATION_LOCK_POLL_INTERVAL));
      }
    }
  }

  protected async releaseLock(): Promise<void> {
    await this.driver.del().from(this.lockTable).where({ Id: 1 });
  }

  protected async withLock<R>(fn: () => Promise<R>): Promise<R> {
    if (!this.lockOptions().enabled) {
      return fn();
    }

    await this.acquireLock();
    try {
      return await fn();
    } finally {
      await this.releaseLock();
    }
  }
```

Add `import { hostname } from 'node:os';` now.

- [ ] **Step 4: Run lock tests + full suite** → green.
- [ ] **Step 5: Commit** — `git commit -am "feat(orm): migration concurrency lock with staleness steal"`

---

### Task 6: `MigrationRunner`

**Files:**
- Create: `packages/orm/src/migration-runner.ts`
- Modify: `packages/orm/src/index.ts` (`export * from './migration-runner.js';`)
- Test: `packages/orm/test/migration-runner.test.ts` (new)

**Interfaces:**
- Consumes: `Orm` shape — `orm.Migrations: Array<ClassInfo<OrmMigration>>`, `orm.Connections: Map<string, OrmDriver>`; `MIGRATION_DESCRIPTION_SYMBOL`; Task 2-5 service.
- Produces:

```ts
export class MigrationRunner {
  constructor(protected orm: { Migrations: Array<ClassInfo<OrmMigration>>; Connections: Map<string, OrmDriver> });
  public up(name?: string, options?: { force?: boolean; fake?: boolean }): Promise<OrmMigration[]>;
  public down(name?: string, options?: { force?: boolean; fake?: boolean; all?: boolean }): Promise<OrmMigration[]>;
  public status(): Promise<IMigrationStatusEntry[]>;
  public resolve(name: string, action: MigrationResolveAction): Promise<void>;
}
```

- [ ] **Step 1: Failing tests** — `migration-runner.test.ts`: same DI boilerplate as Task 2, plus mock migrations decorated `@Migration('sqlite')` (import decorator from `../src/decorators.js`):

```ts
it('orders deterministically: timestamp then name', async () => {
  @Migration('sqlite') class Zeta_2021_05_05_05_05_05 extends OrmMigration { public async up() {} public async down() {} }
  @Migration('sqlite') class Alpha_2021_05_05_05_05_05 extends OrmMigration { public async up() {} public async down() {} }
  const orm = { Migrations: [ci(Zeta_2021_05_05_05_05_05), ci(Alpha_2021_05_05_05_05_05)], Connections: new Map([['sqlite', await makeDriver()]]) };
  stubDb([]);
  const calls: string[] = [];
  sinon.stub(Zeta_2021_05_05_05_05_05.prototype, 'up').callsFake(async () => { calls.push('Z'); });
  sinon.stub(Alpha_2021_05_05_05_05_05.prototype, 'up').callsFake(async () => { calls.push('A'); });

  await new MigrationRunner(orm as any).up();

  expect(calls).to.eql(['A', 'Z']);
});

it('throws on invalid migration name', async () => {
  @Migration('sqlite') class Broken extends OrmMigration { public async up() {} public async down() {} }
  const orm = { Migrations: [ci(Broken)], Connections: new Map([['sqlite', await makeDriver()]]) };
  try {
    await new MigrationRunner(orm as any).up();
    expect.fail('should throw');
  } catch (e: any) {
    expect(e.message).to.contain('invalid name format');
  }
});

it('skips connections gated by OnStartup when force=false', async () => {
  // ConnectionConf sqlite has OnStartup: false
  @Migration('sqlite') class Gate_2021_01_01_00_00_00 extends OrmMigration { public async up() {} public async down() {} }
  const up = sinon.spy(Gate_2021_01_01_00_00_00.prototype, 'up');
  const orm = { Migrations: [ci(Gate_2021_01_01_00_00_00)], Connections: new Map([['sqlite', await makeDriver()]]) };
  stubDb([]);

  await new MigrationRunner(orm as any).up(undefined, { force: false });
  expect(up.called).to.be.false;

  await new MigrationRunner(orm as any).up(); // force defaults true
  expect(up.calledOnce).to.be.true;
});

it('falls back to DefaultMigrationService when Service token absent', async () => {
  const driver = await makeDriver();
  expect(driver.Options.Migration?.Service).to.be.undefined;
  @Migration('sqlite') class Def_2021_01_01_00_00_00 extends OrmMigration { public async up() {} public async down() {} }
  const up = sinon.spy(Def_2021_01_01_00_00_00.prototype, 'up');
  stubDb([]);
  const orm = { Migrations: [ci(Def_2021_01_01_00_00_00)], Connections: new Map([['sqlite', driver]]) };

  await new MigrationRunner(orm as any).up(); // resolves DefaultMigrationService internally

  expect(up.calledOnce).to.be.true;
});

it('resolves custom service from Migration.Service token', async () => {
  const driver = await makeDriver();
  class RecordingService extends DefaultMigrationService {
    public static calls = 0;
    public async up(u: IMigrationUnit[], o?: IMigrationRunOptions) { RecordingService.calls++; return super.up(u, o); }
  }
  DI.register(RecordingService).as('my-migration-service');
  (driver.Options.Migration ??= {}).Service = 'my-migration-service';
  @Migration('sqlite') class Cust_2021_01_01_00_00_00 extends OrmMigration { public async up() {} public async down() {} }
  stubDb([]);
  const orm = { Migrations: [ci(Cust_2021_01_01_00_00_00)], Connections: new Map([['sqlite', driver]]) };

  await new MigrationRunner(orm as any).up();

  expect(RecordingService.calls).to.eq(1);
});

it('warns and skips migration whose connection is missing', async () => {
  @Migration('nope') class Lost_2021_01_01_00_00_00 extends OrmMigration { public async up() {} public async down() {} }
  const up = sinon.spy(Lost_2021_01_01_00_00_00.prototype, 'up');
  const orm = { Migrations: [ci(Lost_2021_01_01_00_00_00)], Connections: new Map() };

  const result = await new MigrationRunner(orm as any).up();

  expect(up.called).to.be.false;
  expect(result).to.eql([]);
});
```

Helper `ci(type)` builds `ClassInfo`: `{ file: type.name + '.registered', name: type.name, type }`.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement `migration-runner.ts`**

```ts
import { ClassInfo } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { DateTime } from 'luxon';
import { OrmDriver } from './driver.js';
import { OrmMigration, IMigrationDescriptor } from './interfaces.js';
import { MIGRATION_DESCRIPTION_SYMBOL } from './symbols.js';
import { OrmException } from './exceptions.js';
import { DefaultMigrationService, OrmMigrationService, IMigrationUnit, IMigrationStatusEntry, MigrationResolveAction } from './migration-service.js';

export const MIGRATION_FILE_REGEXP = /(.*)_([0-9]{4}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2})/;

interface IOrmLike {
  Migrations: Array<ClassInfo<OrmMigration>>;
  Connections: Map<string, OrmDriver>;
}

export interface IMigrationUpOptions {
  force?: boolean;
  fake?: boolean;
}

export interface IMigrationDownFacadeOptions extends IMigrationUpOptions {
  all?: boolean;
}

export class MigrationRunner {
  @Logger('ORM')
  protected Log: Log;

  constructor(protected orm: IOrmLike) {}

  public async up(name?: string, options?: IMigrationUpOptions): Promise<OrmMigration[]> {
    const executed: OrmMigration[] = [];
    for (const [driver, units] of this.plan(name, options?.force ?? true)) {
      const service = await this.service(driver);
      executed.push(...(await service.up(units, { fake: options?.fake })));
    }
    return executed;
  }

  public async down(name?: string, options?: IMigrationDownFacadeOptions): Promise<OrmMigration[]> {
    const executed: OrmMigration[] = [];
    for (const [driver, units] of this.plan(name, options?.force ?? true)) {
      const service = await this.service(driver);
      executed.push(...(await service.down(units, { fake: options?.fake, all: options?.all })));
    }
    return executed;
  }

  public async status(): Promise<IMigrationStatusEntry[]> {
    const entries: IMigrationStatusEntry[] = [];
    for (const [driver, units] of this.plan(undefined, true)) {
      const service = await this.service(driver);
      entries.push(...(await service.status(units)));
    }
    return entries;
  }

  public async resolve(name: string, action: MigrationResolveAction): Promise<void> {
    for (const [driver, units] of this.plan(name, true)) {
      if (units.length !== 0) {
        return await (await this.service(driver)).resolve(name, action);
      }
    }
    throw new OrmException(`Migration ${name} not registered`);
  }

  protected async service(driver: OrmDriver): Promise<OrmMigrationService> {
    const token = driver.Options.Migration?.Service;
    return await driver.Container.resolve<OrmMigrationService>((token as any) ?? DefaultMigrationService, [driver]);
  }

  /**
   * Validate, order (timestamp, name), group by existing connection, apply OnStartup gate.
   * Returns per-connection ordered unit lists.
   */
  protected plan(name: string | undefined, force: boolean): Array<[OrmDriver, IMigrationUnit[]]> {
    const source = name ? this.orm.Migrations.filter((m) => m.name === name) : this.orm.Migrations;

    const units = source
      .map((m) => {
        const match = m.type.name.match(MIGRATION_FILE_REGEXP);
        const created = match && match.length === 3 ? DateTime.fromFormat(match[2], 'yyyy_MM_dd_HH_mm_ss') : null;

        if (!created || !created.isValid) {
          throw new OrmException(`Migration file ${m.name} have invalid name format ( invalid migration name,  expected: some_name_yyyy_MM_dd_HH_mm_ss got ${m.name})`);
        }

        return { name: m.name, created, type: m.type } as IMigrationUnit;
      })
      .sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.name.localeCompare(b.name)));

    const groups = new Map<OrmDriver, IMigrationUnit[]>();

    for (const u of units) {
      const md = (u.type as any)[MIGRATION_DESCRIPTION_SYMBOL] as IMigrationDescriptor;
      const driver = this.orm.Connections.get(md?.Connection);

      if (!driver) {
        this.Log.warn(`Connection ${md?.Connection} not exists for migration ${u.name}`);
        continue;
      }

      if (!driver.Options.Migration?.OnStartup && !force) {
        this.Log.warn(`Migration for connection ${md.Connection} is disabled on startup, please check conf file for db.[connection].migration.OnStartup property`);
        continue;
      }

      if (!groups.has(driver)) groups.set(driver, []);
      groups.get(driver)!.push(u);
    }

    return [...groups.entries()];
  }
}
```

- [ ] **Step 4: Run runner tests + full suite** → green.
- [ ] **Step 5: Commit** — `git commit -am "feat(orm): MigrationRunner cross-connection facade"`

---

### Task 7: Wire into `Orm`, delete old API, update core migration tests

**Files:**
- Modify: `packages/orm/src/orm.ts` (delete `migrateUp` lines 40-83, `migrateDown` lines 85-121, `executeAvaibleMigrations` lines 424-497, `getMigrationDate` lines 409-422, `MIGRATION_TABLE_NAME`/`MIGRATION_FILE_REGEXP` consts; keep `registerMigration` but delegate name validation)
- Modify: `packages/orm/test/migration.test.ts`

**Interfaces:**
- Produces: `orm.Migration: MigrationRunner`; `Orm.resolve()` boot uses it; `data()` aggregate error; `registerMigration` still validates names.

- [ ] **Step 1: Update tests first** — in `migration.test.ts` replace every `orm.migrateUp(...)` → `orm.Migration.up(...)`, `orm.migrateDown(...)` → `orm.Migration.down(...)`. The two down-order tests exercise ALL applied migrations → pass `{ all: true }`. Add new tests:

```ts
it('data() failures aggregate and every hook still runs', async () => {
  const orm = await db();
  stubTrackingEmpty(); // sinon stub execute → select on tracking = [], rest ok
  const d1 = sinon.stub(Migration1_2021_12_01_12_00_00.prototype, 'data').rejects(new Error('seed 1 failed'));
  const d2 = sinon.stub(Migration2_2021_12_02_12_00_00.prototype, 'data').resolves();
  // boot already ran in db(); call the phase directly through a fresh resolve on child container
  // (see implementation: Orm.runDataPhase(executed) extracted as protected method for testability)
  try {
    await (orm as any).runDataPhase([new Migration1_2021_12_01_12_00_00(), new Migration2_2021_12_02_12_00_00()]);
    expect.fail('should throw');
  } catch (e: any) {
    expect(e.message).to.contain('seed 1 failed');
  }
  expect(d2.calledOnce).to.be.true;
});

it('migrations discovered purely via DI registration', async () => {
  const orm = await db();
  expect(orm.Migrations.every((m) => typeof m.type === 'function')).to.be.true;
  expect(DI.getRegisteredTypes('__migrations__')).to.include(Migration1_2021_12_01_12_00_00);
});
```

- [ ] **Step 2: Run — FAIL** (`orm.Migration` undefined).

- [ ] **Step 3: Rewrite `orm.ts` migration parts**

Remove listed members. Add:

```ts
import { MigrationRunner, MIGRATION_FILE_REGEXP } from './migration-runner.js';
```

```ts
  public Migration: MigrationRunner;
```

`resolve()` becomes:

```ts
  public async resolve(): Promise<void> {
    await super.resolve();

    await this.createConnections();

    const migrations = DI.getRegisteredTypes<OrmMigration>('__migrations__');
    if (migrations) {
      migrations.forEach((m) => {
        this.registerMigration(m);
      });
    }

    const models = DI.getRegisteredTypes<ModelBase>('__models__');
    if (models) {
      models.forEach((m) => {
        this.registerModel(m);
      });
    }

    this.Migration = new MigrationRunner(this);

    const executedMigrations = await this.Migration.up(undefined, { force: false });

    this.registerDefaultConverters();

    await this.reloadTableInfo();
    this.wireRelations();
    this.applyModelMixins();

    await this.runDataPhase(executedMigrations);
  }

  protected async runDataPhase(executed: OrmMigration[]): Promise<void> {
    const errors: Array<{ name: string; error: Error }> = [];

    for (const m of executed) {
      this.Log.trace(`Migrating data function for migration ${m.constructor.name} ...`);
      try {
        await m.data();
      } catch (err) {
        this.Log.error(`Migration ${m.constructor.name}:data() failed: ${(err as Error).message}`);
        errors.push({ name: m.constructor.name, error: err as Error });
      }
    }

    if (errors.length > 0) {
      throw new OrmException(`Migration data() phase failed for: ${errors.map((e) => `${e.name} (${e.error.message})`).join(', ')}`, undefined, undefined, undefined, errors[0].error);
    }
  }
```

`registerMigration` keeps its validation, now against the runner's regexp:

```ts
  protected registerMigration<T extends OrmMigration>(migration: Class<T>) {
    const match = migration.name.match(MIGRATION_FILE_REGEXP);
    const created = match && match.length === 3 ? DateTime.fromFormat(match[2], 'yyyy_MM_dd_HH_mm_ss') : null;

    if (created === null || !created.isValid) {
      throw new OrmException(`Migration file ${migration.name} have invalid name format ( invalid migration name,  expected: some_name_yyyy_MM_dd_HH_mm_ss got ${migration.name})`);
    }

    this.Migrations.push({
      file: `${migration.name}.registered`,
      name: `${migration.name}`,
      type: migration,
    });
  }
```

Delete now-unused imports (`IMigrationDescriptor`, `MigrationTransactionMode`, `MIGRATION_DESCRIPTION_SYMBOL` if unused elsewhere in file).

- [ ] **Step 4: Run full orm suite** — `cd packages/orm && npm run test` → green (migration.test.ts, migration-service.test.ts, migration-runner.test.ts, all others).
- [ ] **Step 5: Commit** — `git commit -am "feat(orm)!: orm.Migration facade replaces migrateUp/migrateDown (breaking)"`

---

### Task 8: Call-site sweep in dependent packages

**Files:**
- Modify (mechanical): `packages/orm-sqlite/test/*.ts` (13 files), `packages/orm-mysql/test/*.ts` (4), `packages/orm-mssql/test/mssql.test.ts`, `packages/queue/test/migrations.mysql.test.ts`

- [ ] **Step 1: Replace call sites** — PowerShell from repo root:

```powershell
$files = Get-ChildItem packages/orm-sqlite/test, packages/orm-mysql/test, packages/orm-mssql/test, packages/queue/test -Recurse -Include *.ts
foreach ($f in $files) {
  (Get-Content $f.FullName -Raw) `
    -replace '\.migrateUp\(', '.Migration.up(' `
    -replace '\.migrateDown\(', '.Migration.down(' |
    Set-Content $f.FullName -NoNewline
}
```

- [ ] **Step 2: Audit down() semantics** — `grep -rn "Migration.down(" packages/orm-sqlite/test packages/orm-mysql/test packages/orm-mssql/test packages/queue/test`. For each hit that expects FULL teardown (inspect surrounding assertions), change to `.Migration.down(undefined, { all: true })`. Single-name calls stay as-is.

- [ ] **Step 3: Verify** — `cd packages/orm-sqlite && npm run test` → green. `cd packages/orm-mysql && npm run compile`, `cd packages/orm-mssql && npm run compile`, `cd packages/queue && npm run compile` → exit 0 (live-DB suites not run, per Global Constraints).

- [ ] **Step 4: Commit** — `git add packages/orm-sqlite packages/orm-mysql packages/orm-mssql packages/queue && git commit -m "refactor!: migrate call sites to orm.Migration facade"`

---

### Task 9: orm-sqlite storage-upgrade smoke test

**Files:**
- Create: `packages/orm-sqlite/test/migration-upgrade.test.ts`

- [ ] **Step 1: Write the test** (real sqlite, in-memory is per-handle — use temp file):

```ts
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm, MIGRATION_TABLE_NAME } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';
import _ from 'lodash';
import { dir, mergeArrays } from './common.js'; // reuse existing test helpers; check actual names in this suite
import * as fs from 'fs';

const expect = chai.expect;
const DB_FILE = dir('./migration-upgrade-test.sqlite');

// config class following the suite's existing pattern (see sqlite.test.ts ConnectionConf):
// one sqlite connection, Filename: DB_FILE, Migration: { OnStartup: true }

describe('tracking table upgrade', () => {
  before(async () => {
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    // craft legacy table with raw driver before Orm boots:
    const driver = await DI.resolve<any>('orm-driver-sqlite', [{ Driver: 'orm-driver-sqlite', Filename: DB_FILE, Name: 'legacy-prep' }]);
    await driver.connect();
    await driver.schema().createTable(MIGRATION_TABLE_NAME, (t: any) => {
      t.string('Migration').unique().notNull();
      t.dateTime('CreatedAt').notNull();
    });
    await driver.execute(`INSERT INTO ${MIGRATION_TABLE_NAME} (Migration, CreatedAt) VALUES ('Old_2020_01_01_00_00_00', '2020-01-01 00:00:00')`, []);
    await driver.disconnect();
  });

  after(() => {
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  });

  it('boot upgrades legacy 2-column table, backfills, and keeps old row applied', async () => {
    const orm = await DI.resolve(Orm);
    const driver = orm.Connections.get('default')!; // adjust to config Name
    const cols = await driver.tableInfo(MIGRATION_TABLE_NAME, undefined as any);

    for (const c of ['StartedAt', 'FinishedAt', 'RolledBackAt', 'Logs', 'Checksum', 'Batch']) {
      expect(cols!.some((x) => x.Name === c), `missing column ${c}`).to.be.true;
    }

    const rows = await driver.select().from(MIGRATION_TABLE_NAME);
    const old = (rows as any[]).find((r) => r.Migration === 'Old_2020_01_01_00_00_00');
    expect(old.Batch).to.eq(1);
    expect(old.FinishedAt).to.not.be.null;
  });
});
```

Check the exact sqlite driver DI token and test-helper names in `packages/orm-sqlite/test/sqlite.test.ts` before finalizing (driver token is what `ConnectionConf` there uses as `Driver:`), and mirror its `ConnectionConf` pattern.

- [ ] **Step 2: Run** — `cd packages/orm-sqlite && npm run test -- --grep "tracking table upgrade"` → PASS.
- [ ] **Step 3: Commit** — `git add packages/orm-sqlite/test/migration-upgrade.test.ts && git commit -m "test(orm-sqlite): real-driver tracking-table upgrade smoke"`

---

### Task 10: `@spinajs/orm-cli` package

**Files:**
- Create: `packages/orm-cli/package.json`, `packages/orm-cli/tsconfig.json`, `packages/orm-cli/tsconfig.mjs.json`, `packages/orm-cli/tsconfig.cjs.json` (copy all three from `packages/email`, fix `references`/paths if any), `packages/orm-cli/.npmignore` (copy), `packages/orm-cli/README.md`
- Create: `packages/orm-cli/src/index.ts`, `packages/orm-cli/src/cli/MigrateUp.ts`, `MigrateDown.ts`, `MigrateStatus.ts`, `MigrateResolve.ts`, `MigrateCreate.ts`
- Test: `packages/orm-cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `orm.Migration` facade (Task 7), `@spinajs/cli` (`CliCommand`, `@Command`, `@Option`, `@Argument` — check exact argument decorator name in `packages/cli/src/decorators.ts`; email example shows `@Command`/`@Option`).

- [ ] **Step 1: Scaffold package** — `package.json`:

```json
{
  "name": "@spinajs/orm-cli",
  "version": "2.0.486",
  "description": "CLI commands for spinajs ORM migrations",
  "main": "lib/cjs/index.js",
  "module": "lib/mjs/index.js",
  "exports": {
    ".": {
      "types": "./lib/mjs/index.d.ts",
      "import": "./lib/mjs/index.js",
      "require": "./lib/cjs/index.js"
    }
  },
  "type": "module",
  "private": false,
  "publishConfig": { "access": "public" },
  "engines": { "node": ">=16.11" },
  "scripts": {
    "build": "npm run clean && npm run compile",
    "compile": "tsc -b tsconfig.mjs.json",
    "compile:cjs": "tsc -b tsconfig.cjs.json",
    "clean": "rimraf lib/ && rimraf tsconfig.tsbuildinfo",
    "test": "ts-mocha -p tsconfig.json test/**/*.test.ts",
    "coverage": "nyc npm run test",
    "format": "prettier --write \"src/**/*.ts\"",
    "lint": "eslint -c .eslintrc.cjs --ext .ts src --fix"
  },
  "files": ["lib/**/*"],
  "repository": { "type": "git", "url": "git+https://github.com/spinajs/main.git" },
  "keywords": ["spinajs", "orm", "migrations", "cli"],
  "author": "SpinaJS <spinajs@coderush.pl> (https://github.com/spinajs/main)",
  "license": "MIT",
  "bugs": { "url": "https://github.com/spinajs/main/issues" },
  "homepage": "https://github.com/spinajs/main#readme",
  "dependencies": {
    "@spinajs/cli": "^2.0.486",
    "@spinajs/di": "^2.0.486",
    "@spinajs/exceptions": "^2.0.486",
    "@spinajs/log": "^2.0.486",
    "@spinajs/orm": "^2.0.486",
    "luxon": "^3.6.1"
  },
  "devDependencies": {
    "@spinajs/orm-sqlite": "^2.0.486",
    "@types/luxon": "^3.6.1",
    "@types/node": "^22.14.1"
  }
}
```

Copy `.eslintrc.cjs`, `typedoc.json` if the email package has them; mirror `tsconfig*.json` contents exactly (they extend root configs).

- [ ] **Step 2: Commands** — `src/cli/MigrateUp.ts`:

```ts
import { CliCommand, Command, Option } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log-common';
import { Orm } from '@spinajs/orm';

interface MigrateUpOptions {
  name?: string;
  fake?: boolean;
}

@Command('migrate-up', 'Runs pending ORM migrations (all connections)')
@Option('-n, --name [name]', false, 'run single migration by class name')
@Option('-f, --fake', false, 'record as applied without executing')
export class MigrateUpCommand extends CliCommand {
  @Logger('ORM-CLI')
  protected Log: Log;

  public async execute(options: MigrateUpOptions): Promise<void> {
    const orm = await DI.resolve(Orm);
    const executed = await orm.Migration.up(options.name, { fake: options.fake });
    this.Log.info(`Applied ${executed.length} migration(s): ${executed.map((m) => m.constructor.name).join(', ') || 'none'}`);
  }
}
```

`MigrateDown.ts` — same shape: `@Command('migrate-down', ...)`, options `-n/--name`, `-a/--all`, `-f/--fake`; calls `orm.Migration.down(options.name, { all: options.all, fake: options.fake })`.

`MigrateStatus.ts`:

```ts
@Command('migrate-status', 'Prints migration status for all connections')
export class MigrateStatusCommand extends CliCommand {
  public async execute(): Promise<void> {
    const orm = await DI.resolve(Orm);
    const entries = await orm.Migration.status();

    for (const e of entries) {
      const state = e.failed ? 'FAILED' : e.applied ? 'applied' : e.rolledBack ? 'rolled-back' : 'pending';
      const drift = e.checksumMismatch ? ' [checksum mismatch]' : '';
      console.log(`${state.padEnd(12)} ${String(e.batch ?? '-').padStart(5)}  ${e.connection.padEnd(16)} ${e.name}${drift}`);
    }

    if (entries.some((e) => e.failed || e.pending)) {
      process.exitCode = 1;
    }
  }
}
```

`MigrateResolve.ts` — `@Command('migrate-resolve', ...)`, options `-n, --name [name]` (required true), `--applied`, `--rolled-back`; validate exactly one flag set, else throw; calls `orm.Migration.resolve(name, action)`.

`MigrateCreate.ts` — no Orm needed:

```ts
import { CliCommand, Command, Option } from '@spinajs/cli';
import { DateTime } from 'luxon';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface MigrateCreateOptions {
  name: string;
  dir?: string;
  connection?: string;
}

const TEMPLATE = (cls: string, connection: string) => `import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('${connection}')
export class ${cls} extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    // schema changes - models are NOT available here
  }

  public async down(connection: OrmDriver): Promise<void> {
    // undo up()
  }
}
`;

@Command('migrate-create', 'Scaffolds a new migration file')
@Option('-n, --name [name]', true, 'migration name prefix, valid TS class name')
@Option('-d, --dir [dir]', false, 'target directory, default ./src/migrations')
@Option('-c, --connection [connection]', false, 'connection name, default "default"')
export class MigrateCreateCommand extends CliCommand {
  public async execute(options: MigrateCreateOptions): Promise<void> {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(options.name)) {
      throw new Error(`Invalid migration name ${options.name} - must be a plain class-name prefix`);
    }

    const stamp = DateTime.now().toFormat('yyyy_MM_dd_HH_mm_ss');
    const cls = `${options.name}_${stamp}`;
    const dir = options.dir ?? './src/migrations';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${cls}.ts`);
    fs.writeFileSync(file, TEMPLATE(cls, options.connection ?? 'default'), { flag: 'wx' });
    console.log(file);
  }
}
```

`src/index.ts` re-exports all five command classes.

- [ ] **Step 3: Tests** — `test/cli.test.ts`: register `@spinajs/orm-sqlite` driver + config with one in-memory sqlite connection and one test migration class; instantiate each command via `DI.resolve(CommandClass)` and call `execute()` directly (skip commander wiring — command classes are plain DI classes):
  - `migrate-up` applies test migration (row lands in tracking table).
  - `migrate-status` sets `process.exitCode = 1` while pending, 0 after up (reset `process.exitCode` between assertions).
  - `migrate-resolve` errors when both/neither flags set.
  - `migrate-create` writes file matching `/^Name_\d{4}(_\d{2}){5}\.ts$/` into a temp dir (use test scratch dir + cleanup) and refuses invalid names.

- [ ] **Step 4: Run** — `cd packages/orm-cli && npm install` (workspace link), `npm run compile` → exit 0, `npm run test` → green.
- [ ] **Step 5: Commit** — `git add packages/orm-cli && git commit -m "feat(orm-cli): migration CLI commands (up/down/status/resolve/create)"`

---

### Task 11: Docs

**Files:**
- Modify: `packages/orm/docs/10-schema-and-migrations.md`, `packages/orm/docs/02-configuration.md`, `packages/orm/docs/12-architecture.md`
- Create: `packages/orm-cli/README.md`

- [ ] **Step 1: `10-schema-and-migrations.md`** — rewrite "The lifecycle" and "Running them by hand" for the new facade; add sections: **Batches** (batch column, down = last batch, `{all:true}`), **Locking** (mechanism, config, staleness), **Failure state and resolve** (blocked runs, `resolve('applied'|'rolled-back')`), **Fake runs** (baselining), **Checksums** (advisory, why warn-only), **Custom migration service** (config token, abstract class contract, sample skeleton). Update every ` ```ts sample ` block from `orm.migrateUp()` to `orm.Migration.up()` — samples are type-checked, so they must compile against the new API.

- [ ] **Step 2: `02-configuration.md`** — extend the `Migration` config key table with `Service`, `Lock.Enabled/Timeout/StaleAfter`, `Transaction.Mode: PerRun`; correct any `spinajs_orm_migrations` mention.

- [ ] **Step 3: `12-architecture.md`** — add `migration-service.ts` / `migration-runner.ts` to the component overview with one line each.

- [ ] **Step 4: `packages/orm-cli/README.md`** — package intro + command table (5 commands, options, exit codes) + one usage example per command.

- [ ] **Step 5: Verify samples compile** — from repo root: `npm run docs:check` → 0 failing samples (script: `scripts/check-doc-samples.mjs`).

- [ ] **Step 6: Commit** — `git add packages/orm/docs packages/orm-cli/README.md && git commit -m "docs(orm): migration service, batches, lock, resolve, fake, orm-cli"`

---

### Task 12: Final verification sweep

- [ ] **Step 1:** `cd packages/orm && npm run test` → green.
- [ ] **Step 2:** `cd packages/orm-sqlite && npm run test` → green.
- [ ] **Step 3:** `cd packages/orm-cli && npm run test` → green.
- [ ] **Step 4:** Compile-only packages: `orm-mysql`, `orm-mssql`, `queue`, `intl-orm`, `rbac`, `orm-http`, `orm-api` → `npm run compile` exit 0 each (catches any missed `migrateUp` consumer).
- [ ] **Step 5:** `git grep -n "migrateUp\|migrateDown" -- packages ':!packages/*/lib' ':!packages/*/docs'` → zero hits in source/tests (docs already rewritten).
- [ ] **Step 6:** `npm run docs:check` → clean.
- [ ] **Step 7:** Commit anything outstanding; leave branch `feat/orm-migration-service` ready for review.
