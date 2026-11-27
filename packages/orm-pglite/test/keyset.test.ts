import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Archived, Connection, DataException, InvalidCursor, Model, ModelBase, Orm, Primary, QueryContext, QueryMiddleware, SelectQueryBuilder, SelectQueryExtension, SoftDelete } from '@spinajs/orm';
import type { QueryBuilder } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import sinon from 'sinon';
import { PgliteOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

class PgliteKeysetConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    Object.assign(this.Config, {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
      db: { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-pglite', Name: 'pglite', Filename: ':memory:' }] },
    });
  }
}

@Connection('pglite')
@Model('pgl_keyset')
class PglKeyset extends ModelBase {
  @Primary()
  public Id: number;

  public Score: number;

  public Name: string;
}

@Connection('pglite')
@Model('pgl_keyset_mood')
class PglMood extends ModelBase {
  @Primary()
  public Id: number;

  public Mood: string;
}

@Connection('pglite')
@Model('pgl_keyset_shift')
class PglShift extends ModelBase {
  @Primary()
  public Id: number;
  public Tenant: number;
  public Day: number;
  public Slot: number;
  public DeletedAt: unknown;
  public ArchivedAt: unknown;
}
// applied by hand: the decorators check for a DateTime property only when decorator metadata names one
(SoftDelete() as PropertyDecorator)(PglShift.prototype, 'DeletedAt');
(Archived() as PropertyDecorator)(PglShift.prototype, 'ArchivedAt');

/** Confines the shifts to the caller's tenant when a select runs, as tenancy-orm's row mode does. */
class ShiftTenantFilter extends QueryMiddleware {
  public afterQueryCreation(): void {}
  public beforeQueryExecution(query: QueryBuilder): void {
    if (query instanceof SelectQueryBuilder && query.Model === PglShift) {
      query.where('Tenant', 1);
    }
  }
}

/** `B` itself; `_Row` lets a merged builder declaration use its row type, as tenancy-orm's `SameQuery` does. */
type SameQuery<B, _Row> = B;

declare module '@spinajs/orm' {
  interface ISelectQueryBuilder<T> {
    keysetConfined(): SameQuery<this, T>;
  }
  interface SelectQueryBuilder<T> {
    keysetConfined(): SameQuery<this, T>;
    KeysetConfined?: boolean;
  }
}

/** A per-query mark that follows a clone, as authz-orm's `.accessible()` and tenancy-orm's `.acrossTenants()` do. */
class KeysetConfineExtension extends SelectQueryExtension {
  public readonly name = 'keyset-confine';
  public readonly methods = {
    keysetConfined(this: QueryBuilder): QueryBuilder {
      if (this instanceof SelectQueryBuilder) this.KeysetConfined = true;
      return this;
    },
  };

  public onClone(source: QueryBuilder, clone: QueryBuilder): void {
    if (source instanceof SelectQueryBuilder && clone instanceof SelectQueryBuilder) clone.KeysetConfined = source.KeysetConfined;
  }
}

@Connection('pglite')
@Model('pgl_keyset_shift')
class PglConfinedShift extends ModelBase {
  @Primary()
  public Id: number;
  public Tenant: number;
  public Day: number;
  public Slot: number;
}

@Connection('pglite')
@Model('pgl_keyset_shift')
class PglGuardedShift extends ModelBase {
  @Primary()
  public Id: number;
  public Tenant: number;
  public Day: number;
  public Slot: number;
}

class ShiftRefused extends Error {}

/** Confines a marked select to tenant 1 and leaves an unmarked one alone, as authz-orm's list filter does. */
class MarkedTenantFilter extends QueryMiddleware {
  public afterQueryCreation(): void {}
  public beforeQueryExecution(query: QueryBuilder): void {
    if (query instanceof SelectQueryBuilder && query.KeysetConfined === true) query.where('Tenant', 1);
  }
}

/** Refuses an unmarked select of its model, as authz-orm's guard does under `APP_ENV=test`. */
class UnmarkedShiftGuard extends QueryMiddleware {
  public afterQueryCreation(): void {}
  public beforeQueryExecution(query: QueryBuilder): void {
    if (query instanceof SelectQueryBuilder && query.Model === PglGuardedShift && query.KeysetConfined !== true) throw new ShiftRefused('an unmarked select of PglGuardedShift');
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) {
      return err;
    }
    throw err;
  }
  throw new Error('expected a rejection');
}

function withFirstValue(cursor: string, value: unknown): string {
  const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { h: string; v: unknown[] };
  payload.v[0] = value;
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function withValues(cursor: string, values: unknown[]): string {
  const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { h: string; v: unknown[] };
  return Buffer.from(JSON.stringify({ ...payload, v: values })).toString('base64url');
}

describe('paginate() on PGlite', function () {
  this.timeout(60000);

  let orm: Orm | undefined;

  before(async () => {
    DI.clearCache();
    DI.register(PgliteKeysetConf).as(Configuration);
    DI.register(PgliteOrmDriver).as('orm-driver-pglite');
    DI.register(ShiftTenantFilter).as(QueryMiddleware);
    DI.register(MarkedTenantFilter).as(QueryMiddleware);
    DI.register(UnmarkedShiftGuard).as(QueryMiddleware);
    DI.register(KeysetConfineExtension).as(SelectQueryExtension);
    orm = await DI.resolve(Orm);
    const driver = orm.Connections.get('pglite') as PgliteOrmDriver;
    await driver.executeOnDb('CREATE TABLE pgl_keyset ("Id" int PRIMARY KEY, "Score" int NOT NULL, "Name" text NOT NULL)', [], QueryContext.Schema);
    await driver.executeOnDb(`INSERT INTO pgl_keyset ("Id", "Score", "Name") SELECT g, g % 4, 'n' || (g % 3) FROM generate_series(1, 10) g`, [], QueryContext.Insert);
    await driver.executeOnDb(`CREATE TYPE pgl_mood AS ENUM ('calm', 'busy')`, [], QueryContext.Schema);
    await driver.executeOnDb('CREATE TABLE pgl_keyset_mood ("Id" int PRIMARY KEY, "Mood" pgl_mood NOT NULL)', [], QueryContext.Schema);
    await driver.executeOnDb(`INSERT INTO pgl_keyset_mood ("Id", "Mood") VALUES (1, 'calm'), (2, 'busy'), (3, 'calm')`, [], QueryContext.Insert);
    // a NOT NULL domain, so the view's order columns are described as NOT NULL as paginate() requires
    await driver.executeOnDb('CREATE DOMAIN pgl_keyset_key AS int NOT NULL', [], QueryContext.Schema);
    await driver.executeOnDb('CREATE TABLE pgl_keyset_shift_rows ("Id" int PRIMARY KEY, "Tenant" int NOT NULL, "Day" int NOT NULL, "Slot" text NOT NULL, "DeletedAt" timestamptz NULL, "ArchivedAt" timestamptz NULL)', [], QueryContext.Schema);
    await driver.executeOnDb('CREATE VIEW pgl_keyset_shift AS SELECT "Id"::pgl_keyset_key AS "Id", "Tenant", "Day"::pgl_keyset_key AS "Day", "Slot"::int::pgl_keyset_key AS "Slot", "DeletedAt", "ArchivedAt" FROM pgl_keyset_shift_rows', [], QueryContext.Schema);
    await driver.executeOnDb(`INSERT INTO pgl_keyset_shift_rows ("Id", "Tenant", "Day", "Slot") VALUES (10, 1, 1, '1'), (11, 1, 1, '2')`, [], QueryContext.Insert);
    await orm.reloadTableInfo();
  });

  after(async () => {
    await orm?.dispose();
    DI.unregister(ShiftTenantFilter);
    DI.unregister(MarkedTenantFilter);
    DI.unregister(UnmarkedShiftGuard);
    DI.unregister(KeysetConfineExtension);
    DI.unregister(PgliteKeysetConf);
    DI.clearCache();
  });

  async function walk(page: (after: string | undefined) => Promise<{ items: Array<{ Id: number }>; next: string | null }>): Promise<number[]> {
    const ids: number[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 20; pages++) {
      const current = await page(after);
      ids.push(...current.items.map((i) => i.Id));
      if (current.next === null) {
        return ids;
      }
      after = current.next;
    }
    throw new Error('the walk did not end within 20 pages');
  }

  async function sortedIds(column: 'Score' | 'Name'): Promise<number[]> {
    return (await PglKeyset.select().orderByDescending(column).order('Id')).map((i) => i.Id);
  }

  it('walks an int and a text order column', async () => {
    expect(await walk((after) => PglKeyset.select().paginate({ orderBy: [['Score', 'desc']], limit: 3, after }))).to.deep.equal(await sortedIds('Score'));
    expect(await walk((after) => PglKeyset.select().paginate({ orderBy: [['Name', 'desc']], limit: 4, after }))).to.deep.equal(await sortedIds('Name'));
  });

  it('refuses a cursor value an int column cannot hold with InvalidCursor, never a SQL error', async () => {
    const { next } = await PglKeyset.select().paginate({ orderBy: [['Score', 'asc']], limit: 1 });

    for (const value of ['abc', 1.5, true, 2 ** 40, { $d: '2020-01-01' }, { $b: '99999999999999999999999' }, 'x'.repeat(2 * 1024 * 1024)]) {
      await expect(PglKeyset.select().paginate({ orderBy: [['Score', 'asc']], limit: 1, after: withFirstValue(next!, value) }), JSON.stringify(value).slice(0, 40)).to.be.rejectedWith(InvalidCursor);
    }
  });

  it('refuses a number for a text order column', async () => {
    const { next } = await PglKeyset.select().paginate({ orderBy: [['Name', 'asc']], limit: 1 });

    await expect(PglKeyset.select().paginate({ orderBy: [['Name', 'asc']], limit: 1, after: withFirstValue(next!, 5) })).to.be.rejectedWith(InvalidCursor);
  });

  it('adds the order columns to a narrowed select and walks every page', async () => {
    const ids = await walk((after) => PglKeyset.query().select('Id').paginate({ orderBy: [['Score', 'desc']], limit: 3, after }));

    expect(ids).to.deep.equal(await sortedIds('Score'));
  });

  it('turns a cursor value the column refuses into InvalidCursor', async () => {
    const { next } = await PglMood.select().paginate({ orderBy: [['Mood', 'asc']], limit: 1 });

    // a string fits the enum family, but the postgres enum has no such label: SQLSTATE 22P02, for the page and for the probe
    const err = await rejectionOf(PglMood.select().paginate({ orderBy: [['Mood', 'asc']], limit: 1, after: withFirstValue(next!, 'sleepy') }));

    expect(err).to.be.instanceOf(InvalidCursor);
    expect(err.message).to.not.contain('sleepy');
    expect(err.cause).to.be.instanceOf(DataException);
  });

  it('keeps a data error of the query itself, with a valid cursor as without one', async () => {
    const { next } = await PglMood.select().paginate({ orderBy: [['Id', 'asc']], limit: 1 });

    // the filter value is refused (22P02), the cursor is fine: the same error on the first page and on the next
    await expect(PglMood.where('Mood', 'sleepy').paginate({ orderBy: [['Id', 'asc']], limit: 1 })).to.be.rejectedWith(DataException);
    await expect(PglMood.where('Mood', 'sleepy').paginate({ orderBy: [['Id', 'asc']], limit: 1, after: next! })).to.be.rejectedWith(DataException);
  });

  it('asks the database about the cursor alone before it blames the cursor', async () => {
    const driver = orm!.Connections.get('pglite')!;
    const { next } = await PglKeyset.select().paginate({ orderBy: [['Score', 'asc']], limit: 1 });
    const execute = sinon.stub(driver, 'execute').callThrough();
    execute.onFirstCall().rejects(new DataException('value out of range'));
    try {
      // the page fails, the probe of the keyset predicate runs for real and is accepted
      await expect(PglKeyset.select().paginate({ orderBy: [['Score', 'asc']], limit: 1, after: next! })).to.be.rejectedWith(DataException);
      expect(execute.callCount).to.eq(2);
    } finally {
      execute.restore();
    }
  });

  // a column computed at read time can refuse its own row data, which says nothing about the cursor
  it('probes the first keyset column only, not every column of the row', async () => {
    const driver = orm!.Connections.get('pglite')!;
    const { next } = await PglKeyset.select().paginate({ orderBy: [['Score', 'asc']], limit: 1 });
    const execute = sinon.stub(driver, 'execute').callThrough();
    execute.onFirstCall().rejects(new DataException('value out of range'));
    try {
      await expect(PglKeyset.select().paginate({ orderBy: [['Score', 'asc']], limit: 1, after: next! })).to.be.rejectedWith(DataException);
      const compiled = execute.secondCall.args[0].toDB();
      const expression = Array.isArray(compiled) ? compiled.map((c) => c.expression).join('; ') : compiled.expression;

      expect(/^SELECT (.+?) FROM /.exec(expression ?? '')?.[1]).to.eq('"Score"');
    } finally {
      execute.restore();
    }
  });

  describe('a forged cursor whose value is refused per row', () => {
    // PGlite refuses a forged value when it binds it, whatever the rows. A slot stored as text and read through a cast
    // is refused per row instead: the stand-in for a plan under which a database's refusal depends on the rows it reads.
    const refusedSlot = (id: number, tenant: number, hidden: 'DeletedAt' | 'ArchivedAt' | null = null): string =>
      `INSERT INTO pgl_keyset_shift_rows ("Id", "Tenant", "Day", "Slot", "${hidden ?? 'DeletedAt'}") VALUES (${id}, ${tenant}, 2, 'x', ${hidden ? 'now()' : 'NULL'})`;
    const orderBy: Array<['Day' | 'Slot', 'asc']> = [['Day', 'asc'], ['Slot', 'asc']];
    // No row of tenant 1 lies past (2, 0, 0), so a probe confined to it finds none and scans every row it may read.
    let forged: string;
    before(async () => {
      const { next } = await PglShift.query().paginate({ orderBy, limit: 1 });
      forged = withValues(next!, [2, 0, 0]);
    });

    type Page = (after: string) => Promise<unknown>;
    const shifts: Page = (after) => PglShift.query().paginate({ orderBy, limit: 1, after });
    const confined: Page = (after) => PglConfinedShift.query().keysetConfined().paginate({ orderBy, limit: 1, after });
    const guarded: Page = (after) => PglGuardedShift.query().keysetConfined().paginate({ orderBy, limit: 1, after });

    async function answerTo(page: Page = shifts): Promise<string> {
      const execute = sinon.stub(orm!.Connections.get('pglite')!, 'execute').callThrough();
      execute.onFirstCall().rejects(new DataException('conversion failed'));
      try {
        const err = await rejectionOf(page(forged));
        return err instanceof InvalidCursor ? 'InvalidCursor' : err.constructor.name;
      } finally {
        execute.restore();
      }
    }

    async function answerWith(row: string, page: Page = shifts): Promise<string> {
      const driver = orm!.Connections.get('pglite') as PgliteOrmDriver;
      await driver.executeOnDb(row, [], QueryContext.Insert);
      try {
        return await answerTo(page);
      } finally {
        await driver.executeOnDb('DELETE FROM pgl_keyset_shift_rows WHERE "Day" = 2', [], QueryContext.Delete);
      }
    }

    it('blames the cursor when a row the caller may read refuses its value', async () => {
      expect(await answerWith(refusedSlot(1, 1))).to.eq('InvalidCursor');
    });

    it('answers the same whether or not another tenant holds a row that refuses the value', async () => {
      expect(await answerTo()).to.eq('DataException');
      expect(await answerWith(refusedSlot(1, 2))).to.eq('DataException');
    });

    it('answers the same whether or not a soft-deleted row refuses the value', async () => {
      expect(await answerWith(refusedSlot(1, 1, 'DeletedAt'))).to.eq('DataException');
    });

    it('answers the same whether or not an archived row refuses the value', async () => {
      expect(await answerWith(refusedSlot(1, 1, 'ArchivedAt'))).to.eq('DataException');
    });

    it('keeps to the rows a per-query mark of the page lets it read', async () => {
      expect(await answerWith(refusedSlot(1, 1), confined)).to.eq('InvalidCursor');
      expect(await answerWith(refusedSlot(1, 2), confined)).to.eq('DataException');
    });

    it('blames the cursor under a middleware that refuses an unmarked select', async () => {
      expect(await answerWith(refusedSlot(1, 1), guarded)).to.eq('InvalidCursor');
    });

    it('lets a middleware refusal of the probe through instead of answering for the database', async () => {
      const guard = sinon.stub(UnmarkedShiftGuard.prototype, 'beforeQueryExecution').callThrough();
      guard.onSecondCall().throws(new ShiftRefused('the probe'));
      try {
        expect(await answerWith(refusedSlot(1, 1), guarded)).to.eq('ShiftRefused');
      } finally {
        guard.restore();
      }
    });
  });

  it('keeps the data error of a page that aborted its transaction, where the probe cannot run', async () => {
    const driver = orm!.Connections.get('pglite')!;
    const { next } = await PglMood.select().paginate({ orderBy: [['Mood', 'asc']], limit: 1 });

    const err = await rejectionOf(driver.transaction(() => PglMood.select().paginate({ orderBy: [['Mood', 'asc']], limit: 1, after: withFirstValue(next!, 'sleepy') })));

    expect(err).to.be.instanceOf(DataException);
  });

  it('keeps a data error of a page without a cursor as it is, without a probe', async () => {
    const driver = orm!.Connections.get('pglite')!;
    const execute = sinon.stub(driver, 'execute').rejects(new DataException('value out of range'));
    try {
      await expect(PglKeyset.select().paginate({ orderBy: [['Score', 'asc']], limit: 1 })).to.be.rejectedWith(DataException);
      expect(execute.callCount).to.eq(1);
    } finally {
      execute.restore();
    }
  });
});
