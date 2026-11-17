import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { DateTime } from 'luxon';
import sinon from 'sinon';
import { InvalidOperation, NotSupported } from '@spinajs/exceptions';
import { Connection, InsertBehaviour, InsertQueryBuilder, Model, ModelBase, Primary, QueryContext, SelectQueryBuilder, SoftDelete, SqlExpressions, WriteCaptureLimitExceeded, WriteObserver, createQuery, extractModelDescriptor, insertedKeys } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, QueryBuilder } from '@spinajs/orm';
import { Configuration } from '@spinajs/configuration';
import { db } from './common.js';
import { bootUow, captureStatements, registerUowConnection, rows, UowClient, UowTag } from './uowFixture.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

// Module state, not instance state: the test does not depend on which instance DI hands the middleware.
const recorder = { writes: [] as CapturedWrite[], failWith: undefined as Error | undefined };
const everything: CapturedWrite[] = [];

class Recorder extends WriteObserver {
  interest(query: QueryBuilder): CaptureInterest | undefined {
    return query.Model === UowTag ? { columns: ['Name'], transactional: true } : undefined;
  }

  async observe(write: CapturedWrite): Promise<void> {
    if (recorder.failWith) throw recorder.failWith;
    recorder.writes.push(write);
  }
}

class Everything extends WriteObserver {
  interest(query: QueryBuilder): CaptureInterest | undefined {
    return query.Model === UowTag ? { columns: '*', transactional: true } : undefined;
  }

  async observe(write: CapturedWrite): Promise<void> {
    everything.push(write);
  }
}

@Connection('sqlite')
@Model('cap_member')
class CapMember extends ModelBase {
  @Primary()
  public Id: number;

  public Email: string;

  public Name: string;
}

@Connection('sqlite')
@Model('cap_pair')
class CapPair extends ModelBase {
  @Primary()
  public A: number;

  @Primary()
  public B: number;

  public Name: string;
}

@Connection('sqlite')
@Model('cap_soft')
class CapSoft extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @SoftDelete()
  public DeletedAt: DateTime;
}

const fixture = { writes: [] as CapturedWrite[], inTransaction: [] as boolean[], transactional: true, prepareFails: false };

class FixtureObserver extends WriteObserver {
  interest(query: QueryBuilder): CaptureInterest | undefined {
    return [CapMember, CapPair, CapSoft].some((m) => query.Model === m) ? { columns: '*', transactional: fixture.transactional } : undefined;
  }

  prepare(): void {
    if (fixture.prepareFails) throw new Error('prepare failed');
  }

  async observe(write: CapturedWrite): Promise<void> {
    fixture.writes.push(write);
    fixture.inTransaction.push(write.driver.CurrentTransaction !== undefined);
  }
}

const selectsOn = (statements: { context: QueryContext; expression: string }[], table: string) => statements.filter((s) => s.context === QueryContext.Select && s.expression.includes(table)).length;

describe('write capture on sqlite', function () {
  // Each test boots the ORM again, which takes several seconds on a loaded machine.
  this.timeout(60000);

  before(() => {
    registerUowConnection();
    DI.register(Recorder).as(WriteObserver);
  });

  after(() => {
    DI.unregister(Recorder);
  });

  beforeEach(async () => {
    await bootUow();
    recorder.writes = [];
    recorder.failWith = undefined;
    everything.length = 0;
  });

  afterEach(() => DI.clearCache());

  it('hands an insert its new row', async () => {
    await UowTag.insert({ Name: 'red' });

    expect(recorder.writes).to.have.length(1);
    expect(recorder.writes[0].kind).to.eq('insert');
    expect(recorder.writes[0].unknownKeys).to.eq(false);
    expect(recorder.writes[0].rows).to.deep.eq([{ id: '1', before: undefined, after: { Id: 1, Name: 'red' } }]);
  });

  it('hands an update the before and after values of the rows it reached', async () => {
    await UowTag.insert({ Name: 'red' });
    await UowTag.insert({ Name: 'blue' });
    recorder.writes = [];

    await UowTag.update({ Name: 'green' }).where('Name', 'red');

    expect(recorder.writes[0].kind).to.eq('update');
    expect(recorder.writes[0].rows).to.deep.eq([{ id: '1', before: { Id: 1, Name: 'red' }, after: { Id: 1, Name: 'green' } }]);
  });

  it('hands a delete the rows that are gone', async () => {
    await UowTag.insert({ Name: 'red' });
    recorder.writes = [];

    await UowTag.destroy(1);

    expect(recorder.writes[0].rows).to.deep.eq([{ id: '1', before: { Id: 1, Name: 'red' }, after: undefined }]);
  });

  it('reads once before and once after for two observers', async () => {
    DI.register(Everything).as(WriteObserver);
    try {
      await UowTag.insert({ Name: 'red' });
      const { statements, restore } = captureStatements();
      try {
        await UowTag.update({ Name: 'green' }).where('Id', 1);
      } finally {
        restore();
      }

      // key select + before + after
      expect(selectsOn(statements, 'uow_tag')).to.eq(3);
      expect(everything.at(-1)!.rows[0].after).to.deep.eq({ Id: 1, Name: 'green' });
      expect(recorder.writes.at(-1)!.rows[0].after).to.deep.eq({ Id: 1, Name: 'green' });
    } finally {
      DI.unregister(Everything);
    }
  });

  it('treats a replaced row as an existing one', async () => {
    await UowTag.insert({ Name: 'red' });
    recorder.writes = [];

    await UowTag.insert({ Id: 1, Name: 'blue' }, InsertBehaviour.InsertOrReplace);

    expect(recorder.writes[0].rows).to.deep.eq([{ id: '1', before: { Id: 1, Name: 'red' }, after: { Id: 1, Name: 'blue' } }]);
  });

  it('reads the keys of a multi-row insert from RETURNING', async () => {
    await UowTag.insert([{ Name: 'a' }, { Name: 'b' }]);

    const write = recorder.writes[0];
    expect(write.unknownKeys).to.eq(false);
    expect(write.rows.map((r) => r.id)).to.deep.eq(['1', '2']);
    expect(write.rows.map((r) => r.after?.Name)).to.deep.eq(['a', 'b']);
  });

  it('reports a multi-row insert whose keys the driver does not report', async () => {
    // Built without ModelBase.insert, so no RETURNING is added; sqlite reports only the last rowid.
    const { query } = createQuery(UowTag, InsertQueryBuilder);
    await query.values([{ Name: 'a' }, { Name: 'b' }]);

    const write = recorder.writes[0];
    expect(write.unknownKeys).to.eq(true);
    expect(write.rows).to.deep.eq([]);
    expect(await rows('uow_tag')).to.have.length(2);
  });

  it('reports the keys of an insert split into several statements as unknown', () => {
    // The merged result of a split insert holds the last statement's insert id and the summed row count.
    const driver = db().Connections.get('sqlite')!;
    const features = { ...driver.supportedFeatures(), insertIdIsFirstOfBatch: true };
    const stubs = [sinon.stub(driver, 'MaxInsertRows').value(1), sinon.stub(driver, 'supportedFeatures').returns(features)];
    try {
      const { query } = createQuery(UowTag, InsertQueryBuilder);
      query.values([{ Name: 'a' }, { Name: 'b' }]);
      expect(insertedKeys(query, { LastInsertId: 2, RowsAffected: 2 }, 'Id')).to.eq(undefined);
    } finally {
      for (const s of stubs) s.restore();
    }
  });

  it('rolls the statement back when an observer throws', async () => {
    recorder.failWith = new Error('observer failed');

    await expect(UowTag.insert({ Name: 'red' })).to.be.rejectedWith('observer failed');

    expect(await rows('uow_tag')).to.have.length(0);
  });

  it('refuses a statement above db.WriteCapture.MaxRows', async () => {
    await UowTag.insert({ Name: 'a' });
    await UowTag.insert({ Name: 'b' });
    (await DI.resolve(Configuration)).set('db.WriteCapture.MaxRows', 1);
    try {
      await expect(UowTag.update({ Name: 'c' }).where('Id', '>', 0)).to.be.rejectedWith(WriteCaptureLimitExceeded, 'write capture: an update of UowTag reaches 2 rows, above db.WriteCapture.MaxRows (1); narrow the statement or raise the limit');
      expect((await rows<{ Name: string }>('uow_tag')).map((r) => r.Name)).to.deep.eq(['a', 'b']);
    } finally {
      (await DI.resolve(Configuration)).set('db.WriteCapture.MaxRows', 0);
    }
  });

  it('adds nothing to a write no observer wants', async () => {
    const { statements, restore } = captureStatements();
    try {
      await UowClient.insert({ Name: 'x' });
    } finally {
      restore();
    }
    expect(statements).to.have.length(1);
    expect(recorder.writes).to.have.length(0);
  });

  describe('on models of its own', () => {
    before(() => DI.register(FixtureObserver).as(WriteObserver));

    after(() => DI.unregister(FixtureObserver));

    beforeEach(async () => {
      const schema = db().Connections.get('sqlite')!.schema();
      // Id is the primary key only, so the upsert of Model.insert conflicts on Email, its one unique column.
      await schema.createTable('cap_member', (t) => {
        t.int('Id').primaryKey().autoIncrement();
        t.string('Email').unique();
        t.string('Name');
      });
      await schema.createTable('cap_pair', (t) => {
        t.int('A').notNull().primaryKey();
        t.int('B').notNull().primaryKey();
        t.string('Name');
      });
      await schema.createTable('cap_soft', (t) => {
        t.int('Id').primaryKey().autoIncrement();
        t.string('Name');
        t.dateTime('DeletedAt');
      });
      await db().reloadTableInfo();
      fixture.transactional = true;
      fixture.prepareFails = false;
      await CapMember.insert({ Email: 'a', Name: 'one' });
      await CapMember.insert({ Email: 'x', Name: 'two' });
      fixture.writes = [];
      fixture.inTransaction = [];
    });

    it('locks the rows of the key select and the before read inside a transaction, and not without one', async () => {
      const driver = db().Connections.get('sqlite')!;
      const locks: string[] = [];
      const execute = driver.execute.bind(driver);
      const stub = sinon.stub(driver, 'execute').callsFake((builder) => {
        if (builder instanceof SelectQueryBuilder) locks.push(`${builder.Model === CapMember ? 'keys' : 'rows'}:${builder.RowLock ?? 'none'}`);
        return execute(builder);
      });
      try {
        await CapMember.update({ Name: 'b' }).where('Id', 1);
        fixture.transactional = false;
        await CapMember.update({ Name: 'c' }).where('Id', 1);
      } finally {
        stub.restore();
      }

      // keys, before, after: twice
      expect(locks).to.deep.eq(['keys:update', 'rows:update', 'rows:none', 'keys:none', 'rows:none', 'rows:none']);
      expect(fixture.writes.map((w) => w.rows[0].after?.Name)).to.deep.eq(['b', 'c']);
      expect(fixture.inTransaction).to.deep.eq([true, false]);
    });

    it('takes no row lock where the dialect has none, and does not hide another failure of the lookup', async () => {
      const expressions = db().Connections.get('sqlite')!.Container.resolve(SqlExpressions);
      const unsupported = sinon.stub(expressions, 'rowLock').throws(new NotSupported('no row lock'));
      try {
        await CapMember.update({ Name: 'b' }).where('Id', 1);
      } finally {
        unsupported.restore();
      }
      const broken = sinon.stub(expressions, 'rowLock').throws(new Error('broken lookup'));
      try {
        await expect(CapMember.update({ Name: 'c' }).where('Id', 1)).to.be.rejectedWith('broken lookup');
      } finally {
        broken.restore();
      }

      expect(fixture.writes.map((w) => w.rows[0].after?.Name)).to.deep.eq(['b']);
    });

    it('refuses a model with a composite primary key', async () => {
      await expect(CapPair.insert({ A: 1, B: 2, Name: 'x' })).to.be.rejectedWith(InvalidOperation, 'write capture: CapPair needs a single-column primary key, it has 2');
      expect(await rows('cap_pair')).to.deep.eq([]);
    });

    it('hands a soft delete over as an update', async () => {
      await CapSoft.insert({ Name: 'a' });
      fixture.writes = [];

      await CapSoft.destroy(1);

      expect(fixture.writes[0].kind).to.eq('update');
      expect(fixture.writes[0].rows[0].before?.DeletedAt).to.eq(null);
      expect(fixture.writes[0].rows[0].after?.DeletedAt).to.be.a('string');
    });

    it('aborts the statement when prepare throws, before any capture read', async () => {
      fixture.prepareFails = true;
      const { statements, restore } = captureStatements();
      try {
        await expect(CapMember.update({ Name: 'b' }).where('Id', 1)).to.be.rejectedWith('prepare failed');
      } finally {
        restore();
      }

      expect(statements.filter((s) => s.expression.includes('cap_member'))).to.deep.eq([]);
      expect(fixture.writes).to.deep.eq([]);
    });

    it("observes an update inside the caller's transaction, which the caller then rolls back", async () => {
      const driver = db().Connections.get('sqlite')!;
      await expect(
        driver.transaction(async () => {
          await CapMember.update({ Name: 'b' }).where('Id', 1);
          throw new Error('roll back');
        }),
      ).to.be.rejectedWith('roll back');

      expect(fixture.inTransaction).to.deep.eq([true]);
      expect(fixture.writes[0].rows[0].after?.Name).to.eq('b');
      expect((await rows<{ Name: string }>('cap_member')).map((r) => r.Name)).to.deep.eq(['one', 'two']);
    });

    it('skips the after read of a delete that removed every row it reached', async () => {
      const { statements, restore } = captureStatements();
      try {
        await CapMember.destroy(1);
      } finally {
        restore();
      }

      // key select + before read
      expect(selectsOn(statements, 'cap_member')).to.eq(2);
      expect(fixture.writes[0].rows).to.deep.eq([{ id: '1', before: { Id: 1, Email: 'a', Name: 'one' }, after: undefined }]);
    });

    it('bounds the key select by db.WriteCapture.MaxRows and refuses an insert of more rows', async () => {
      const config = await DI.resolve(Configuration);
      config.set('db.WriteCapture.MaxRows', 1);
      const { statements, restore } = captureStatements();
      try {
        await expect(CapMember.update({ Name: 'c' }).where('Id', '>', 0)).to.be.rejectedWith(WriteCaptureLimitExceeded, 'write capture: an update of CapMember reaches 2 rows, above db.WriteCapture.MaxRows (1); narrow the statement or raise the limit');
        await expect(CapMember.insert([{ Email: 'p', Name: 'p' }, { Email: 'q', Name: 'q' }])).to.be.rejectedWith(WriteCaptureLimitExceeded, 'write capture: an insert of CapMember reaches 2 rows, above db.WriteCapture.MaxRows (1); narrow the statement or raise the limit');
      } finally {
        restore();
        config.set('db.WriteCapture.MaxRows', 0);
      }

      const selects = statements.filter((s) => s.context === QueryContext.Select).map((s) => s.expression);
      expect(selects).to.have.length(1);
      expect(selects[0]).to.match(/LIMIT/i);
      expect(await rows('cap_member')).to.have.length(2);
    });

    it('reports the row an upsert updates through a unique column as an update', async () => {
      await CapMember.insert({ Id: 5, Email: 'x', Name: 'new' }, InsertBehaviour.InsertOrUpdate);

      expect(fixture.writes[0].unknownKeys).to.eq(false);
      expect(fixture.writes[0].rows).to.deep.eq([{ id: '2', before: { Id: 2, Email: 'x', Name: 'two' }, after: { Id: 2, Email: 'x', Name: 'new' } }]);
    });

    it('reports the row an upsert without a key updates as an update with its before values', async () => {
      await CapMember.insert({ Email: 'x', Name: 'new' }, InsertBehaviour.InsertOrUpdate);

      expect(fixture.writes[0].rows).to.deep.eq([{ id: '2', before: { Id: 2, Email: 'x', Name: 'two' }, after: { Id: 2, Email: 'x', Name: 'new' } }]);
    });

    it('reports a row a replace deletes through a unique column as gone, and the new row as inserted', async () => {
      await CapMember.insert({ Id: 5, Email: 'x', Name: 'new' }, InsertBehaviour.InsertOrReplace);

      expect(fixture.writes[0].rows).to.deep.eq([
        { id: '2', before: { Id: 2, Email: 'x', Name: 'two' }, after: undefined },
        { id: '5', before: undefined, after: { Id: 5, Email: 'x', Name: 'new' } },
      ]);
    });

    it('reports an upsert that may conflict on a composite unique index as unknown, though its columns are marked unique', async () => {
      await db().Connections.get('sqlite')!.schema().raw('CREATE UNIQUE INDEX cap_member_pair ON cap_member (Name, Email)');
      // As PostgreSQL and MySQL report a member of a composite unique index.
      const name = extractModelDescriptor(CapMember)!.Columns.find((c) => c.Name === 'Name')!;
      name.Unique = true;
      const { statements, restore } = captureStatements();
      try {
        await CapMember.insert({ Email: 'z', Name: 'one' }, InsertBehaviour.InsertOrIgnore);
      } finally {
        restore();
        name.Unique = false;
      }

      expect(statements.filter((s) => s.context === QueryContext.Select)).to.deep.eq([]);
      expect(fixture.writes[0].unknownKeys).to.eq(true);
      expect(fixture.writes[0].rows).to.deep.eq([]);
    });

    it('reports an upsert that may conflict through an expression index as unknown', async () => {
      await db().Connections.get('sqlite')!.schema().raw('CREATE UNIQUE INDEX cap_member_lower ON cap_member (lower(Email))');

      await CapMember.insert({ Id: 5, Email: 'X', Name: 'new' }, InsertBehaviour.InsertOrReplace);

      expect(fixture.writes[0].unknownKeys).to.eq(true);
      expect(fixture.writes[0].rows).to.deep.eq([]);
      expect((await rows<{ Id: number }>('cap_member')).map((r) => r.Id)).to.deep.eq([1, 5]);
    });

    it('reads an upsert by its ON CONFLICT target alone, whatever other unique indexes the table has', async () => {
      await db().Connections.get('sqlite')!.schema().raw('CREATE UNIQUE INDEX cap_member_pair ON cap_member (Name, Email)');
      const { query } = createQuery(CapMember, InsertQueryBuilder);
      query.values({ Id: 5, Email: 'x', Name: 'new' }).onDuplicate('Email').update(['Name']);
      await query;

      expect(fixture.writes[0].unknownKeys).to.eq(false);
      expect(fixture.writes[0].rows).to.deep.eq([{ id: '2', before: { Id: 2, Email: 'x', Name: 'two' }, after: { Id: 2, Email: 'x', Name: 'new' } }]);
    });

    it('reads an upserted row again by its key when the statement changed its conflict value', async () => {
      await db().Connections.get('sqlite')!.schema().raw("CREATE TRIGGER cap_member_mark AFTER UPDATE OF Name ON cap_member BEGIN UPDATE cap_member SET Email = NEW.Email || '!' WHERE Id = NEW.Id; END");

      await CapMember.insert({ Id: 5, Email: 'x', Name: 'new' }, InsertBehaviour.InsertOrUpdate);

      expect(fixture.writes[0].rows).to.deep.eq([{ id: '2', before: { Id: 2, Email: 'x', Name: 'two' }, after: { Id: 2, Email: 'x!', Name: 'new' } }]);
    });

    it('reads the index list of a table once until the ORM reloads it', async () => {
      const driver = db().Connections.get('sqlite')!;
      const spy = sinon.spy(driver, 'tableIndexes');
      try {
        await CapMember.insert({ Email: 'p', Name: 'p' }, InsertBehaviour.InsertOrIgnore);
        await CapMember.insert({ Email: 'q', Name: 'q' }, InsertBehaviour.InsertOrIgnore);
        await db().reloadTableInfo();
        await CapMember.insert({ Email: 'r', Name: 'r' }, InsertBehaviour.InsertOrIgnore);
      } finally {
        spy.restore();
      }

      expect(spy.callCount).to.eq(2);
    });

    it('bounds the rows an upsert reads by db.WriteCapture.MaxRows', async () => {
      const config = await DI.resolve(Configuration);
      config.set('db.WriteCapture.MaxRows', 1);
      try {
        await expect(CapMember.insert({ Id: 1, Email: 'x', Name: 'new' }, InsertBehaviour.InsertOrReplace)).to.be.rejectedWith(WriteCaptureLimitExceeded, 'write capture: an insert of CapMember reaches 2 rows, above db.WriteCapture.MaxRows (1); narrow the statement or raise the limit');
      } finally {
        config.set('db.WriteCapture.MaxRows', 0);
      }

      expect((await rows<{ Name: string }>('cap_member')).map((r) => r.Name)).to.deep.eq(['one', 'two']);
    });

    it('reports an upsert whose unique value has no key text (a date) as unknown', async () => {
      const { query } = createQuery(CapMember, InsertQueryBuilder);
      await query.values({ Email: new Date(Date.UTC(2026, 0, 1)), Name: 'd' }).orIgnore();

      expect(fixture.writes[0].unknownKeys).to.eq(true);
      expect(fixture.writes[0].rows).to.deep.eq([]);
    });
  });
});
