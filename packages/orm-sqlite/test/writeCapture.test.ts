import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { DateTime } from 'luxon';
import sinon from 'sinon';
import { InvalidOperation, NotSupported } from '@spinajs/exceptions';
import { Connection, DeleteQueryBuilder, InsertBehaviour, InsertQueryBuilder, Model, ModelBase, Primary, QueryContext, QueryMiddleware, SelectQueryBuilder, SoftDelete, SqlExpressions, UpdateQueryBuilder, ValueConverter, WriteCaptureLimitExceeded, WriteObserver, createQuery, extractModelDescriptor, insertedKeys } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, QueryBuilder, WriteStatement } from '@spinajs/orm';
import { Configuration } from '@spinajs/configuration';
import { db } from './common.js';
import { bootUow, captureStatements, registerUowConnection, rows, UowClient, UowOrder, UowOrderItem, UowOrderTag, UowTag } from './uowFixture.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

// Module state, not instance state: the test does not depend on which instance DI hands the middleware.
const recorder = { writes: [] as CapturedWrite[], failWith: undefined as Error | undefined };
const everything: CapturedWrite[] = [];

class Recorder extends WriteObserver {
  interest({ model }: WriteStatement): CaptureInterest | undefined {
    return model === UowTag ? { columns: ['Name'], transactional: true } : undefined;
  }

  async observe(write: CapturedWrite): Promise<void> {
    if (recorder.failWith) throw recorder.failWith;
    recorder.writes.push(write);
  }
}

class Everything extends WriteObserver {
  interest({ model }: WriteStatement): CaptureInterest | undefined {
    return model === UowTag ? { columns: '*', transactional: true } : undefined;
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

/** Not idempotent on the database form: a key read raw must go through fromDB before a where converts it again. */
class ReversedDigits extends ValueConverter {
  public toDB(value: unknown): unknown {
    return Number(String(value).split('').reverse().join(''));
  }

  public fromDB(value: unknown): unknown {
    return Number(String(value).split('').reverse().join(''));
  }
}

@Connection('sqlite')
@Model('cap_keyed')
class CapKeyed extends ModelBase {
  @Primary()
  public Id: number;

  public Grp: string;

  public Name: string;
}

// A BLOB key holds bytes, which have no key text, and text, which has.
@Connection('sqlite')
@Model('cap_blob')
class CapBlob extends ModelBase {
  @Primary()
  public Id: Buffer | string;

  public Email: string;

  public Name: string;
}

// A text key the database fills: LastInsertId reports the rowid, which is not the key.
@Connection('sqlite')
@Model('cap_gen')
class CapGen extends ModelBase {
  @Primary()
  public Id: string;

  public Name: string;
}

// A CHECK constraint makes OR IGNORE skip a row that has no conflict value to find it by.
@Connection('sqlite')
@Model('cap_note')
class CapNote extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('sqlite')
@Model('cap_trig')
class CapTrig extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

// WITHOUT ROWID: the INTEGER PRIMARY KEY is no rowid alias, so LastInsertId is not its key.
@Connection('sqlite')
@Model('cap_wr')
class CapWr extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('sqlite')
@Model('cap_desc')
class CapDesc extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

const fixture = { writes: [] as CapturedWrite[], inTransaction: [] as boolean[], transactional: true, prepareFails: false, prepared: [] as WriteStatement[] };

class FixtureObserver extends WriteObserver {
  interest({ model }: WriteStatement): CaptureInterest | undefined {
    return [CapMember, CapPair, CapSoft, CapBlob, CapGen, CapNote, CapTrig, CapWr, CapDesc, CapKeyed].some((m) => model === m) ? { columns: '*', transactional: fixture.transactional } : undefined;
  }

  prepare(statement: WriteStatement): void {
    fixture.prepared.push(statement);
    if (fixture.prepareFails) throw new Error('prepare failed');
  }

  async observe(write: CapturedWrite): Promise<void> {
    fixture.writes.push(write);
    fixture.inTransaction.push(write.driver.CurrentTransaction !== undefined);
  }
}

const relationWrites: CapturedWrite[] = [];

class RelationObserver extends WriteObserver {
  interest({ model }: WriteStatement): CaptureInterest | undefined {
    return model === UowOrderItem || model === UowOrderTag ? { columns: '*', transactional: true } : undefined;
  }

  async observe(write: CapturedWrite): Promise<void> {
    relationWrites.push(write);
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
    expect(write.keylessRows).to.eq(0);
    expect(write.rows).to.deep.eq([]);
    expect(await rows('uow_tag')).to.have.length(2);
  });

  it('reports the keys of an insert split into several statements as unknown', () => {
    // The merged result of a split insert holds the last statement's insert id and the summed row count.
    const stub = sinon.stub(db().Connections.get('sqlite')!, 'MaxInsertRows').value(1);
    try {
      const { query } = createQuery(UowTag, InsertQueryBuilder);
      query.values([{ Name: 'a' }, { Name: 'b' }]);
      expect(insertedKeys(query, { LastInsertId: 2, RowsAffected: 2 }, 'Id')).to.eq(undefined);
    } finally {
      stub.restore();
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

  it('sends an update and a delete no observer wants as it compiled them', async () => {
    const { statements, restore } = captureStatements();
    try {
      await UowClient.update({ Name: 'y' }).where('Name', 'x').orWhere('Id', 5);
      await UowClient.destroy().where('Name', 'x').orWhere('Id', 5);
    } finally {
      restore();
    }

    // Recorded on v4 17f9458488, before the capture confined its writes.
    expect(statements.map((s) => [s.expression, s.bindings])).to.deep.eq([
      ['UPDATE `uow_client` SET `Name` = ? WHERE `Name` = ? OR `Id` = ?', ['y', 'x', 5]],
      ['DELETE FROM `uow_client` WHERE `Name` = ? OR `Id` = ?', ['x', 5]],
    ]);
  });

  it('confines a captured update and delete to the keys its key select read', async () => {
    for (const Name of ['red', 'blue', 'green']) await UowTag.insert({ Name });
    const { statements, restore } = captureStatements();
    try {
      await UowTag.update({ Name: 'x' }).where('Name', 'red').orWhere('Name', 'blue');
      await UowTag.destroy().where('Name', 'x').orWhere('Id', 3);
    } finally {
      restore();
    }

    expect(statements.filter((s) => s.context !== QueryContext.Select).map((s) => [s.expression, s.bindings])).to.deep.eq([
      ['UPDATE `uow_tag` SET `Name` = ? WHERE ( `Name` = ? OR `Name` = ? ) AND `Id` IN (?,?)', ['x', 'red', 'blue', 1, 2]],
      ['DELETE FROM `uow_tag` WHERE ( `Name` = ? OR `Id` = ? ) AND `Id` IN (?,?,?)', ['x', 3, 1, 2, 3]],
    ]);
    expect((await rows<{ Name: string }>('uow_tag')).map((r) => r.Name)).to.deep.eq([]);
  });

  it('sends a captured update whose key select read no row as one that matches none', async () => {
    await UowTag.insert({ Name: 'red' });
    const { statements, restore } = captureStatements();
    try {
      await UowTag.update({ Name: 'x' }).where('Name', 'blue');
    } finally {
      restore();
    }

    expect(statements.filter((s) => s.context !== QueryContext.Select).map((s) => [s.expression, s.bindings])).to.deep.eq([['UPDATE `uow_tag` SET `Name` = ? WHERE ( `Name` = ? ) AND 1 = 0', ['x', 'blue']]]);
  });

  it('confines a captured delete with a limit to the keys its key select read', async () => {
    await UowTag.insert({ Name: 'red' });
    const { statements, restore } = captureStatements();
    try {
      // The bundled sqlite has no DELETE ... LIMIT, so only the compiled statement is checked.
      await expect(UowTag.destroy().where('Name', 'red').take(1)).to.be.rejected;
    } finally {
      restore();
    }

    expect(statements.filter((s) => s.context !== QueryContext.Select).map((s) => s.expression)).to.deep.eq(['DELETE FROM `uow_tag` WHERE ( `Name` = ? ) AND `Id` IN (?) LIMIT ?']);
  });

  it('confines each captured statement to its own keys while another one runs between its key select and its write', async () => {
    for (const Name of ['red', 'blue']) await UowTag.insert({ Name });
    let held = false;
    class Between extends QueryMiddleware {
      public order = 92;
      afterQueryCreation(): void {}
      async beforeQueryExecution(query: QueryBuilder): Promise<void> {
        if (held || query.Model !== UowTag || !(query instanceof UpdateQueryBuilder)) return;
        held = true;
        await UowTag.update({ Name: 'b2' }).where('Name', 'blue');
      }
    }
    DI.register(Between).as(QueryMiddleware);
    DI.uncache(Array.ofType(QueryMiddleware));
    try {
      await UowTag.update({ Name: 'a2' }).where('Name', 'red');
    } finally {
      DI.unregister(Between);
      DI.uncache(Array.ofType(QueryMiddleware));
    }

    expect((await rows<{ Name: string }>('uow_tag')).map((r) => r.Name)).to.deep.eq(['a2', 'b2']);
    expect(recorder.writes.slice(-2).map((w) => w.rows.map((r) => [r.id, r.after?.Name]))).to.deep.eq([[['2', 'b2']], [['1', 'a2']]]);
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
      fixture.prepared = [];
    });

    it('confines a write to the keys it read when the key column converts its values', async () => {
      await db().Connections.get('sqlite')!.schema().raw('CREATE TABLE cap_keyed (Id INTEGER PRIMARY KEY, Grp TEXT, Name TEXT)');
      await db().reloadTableInfo();
      extractModelDescriptor(CapKeyed)!.Converters.set('Id', { Class: ReversedDigits });
      await db().Connections.get('sqlite')!.schema().raw("INSERT INTO cap_keyed VALUES (12, 'a', 'one'), (34, 'a', 'two'), (21, 'b', 'three')");
      const { statements, restore } = captureStatements();
      try {
        await CapKeyed.update({ Name: 'mine' }).where('Grp', 'a');
      } finally {
        restore();
        extractModelDescriptor(CapKeyed)!.Converters.delete('Id');
      }

      expect(statements.filter((s) => s.context === QueryContext.Update).map((s): unknown[] => s.bindings)).to.deep.eq([['mine', 'a', 12, 34]]);
      expect((await rows<{ Id: number; Name: string }>('cap_keyed')).map((r) => [r.Id, r.Name])).to.deep.eq([
        [12, 'mine'],
        [21, 'three'],
        [34, 'mine'],
      ]);
    });

    it('hands every hook the kind of the write together with its own builder', async () => {
      await CapMember.insert({ Email: 'b', Name: 'three' });
      await CapMember.update({ Name: 'b' }).where('Id', 1);
      await CapMember.destroy(1);

      expect(fixture.prepared.map((s) => [s.kind, s.query instanceof InsertQueryBuilder, s.query instanceof UpdateQueryBuilder, s.query instanceof DeleteQueryBuilder, s.model])).to.deep.eq([
        ['insert', true, false, false, CapMember],
        ['update', false, true, false, CapMember],
        ['delete', false, false, true, CapMember],
      ]);
      const pairs = fixture.writes.map((w) => fixture.prepared.find((s) => s.query === w.query)?.kind === w.kind);
      expect(pairs).to.deep.eq([true, true, true]);
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

    it('refuses an upsert after it ran when its conflict values then reach more rows than db.WriteCapture.MaxRows', async () => {
      const driver = db().Connections.get('sqlite')!;
      // Id 1 and Email 'x' reach the two existing rows before the statement; the row it inserts is the third after it.
      const upsert = (id: number) =>
        createQuery(CapMember, InsertQueryBuilder)
          .query.values([
            { Id: 1, Email: 'x', Name: 'new' },
            { Id: id, Email: `e${id}`, Name: 'new' },
          ])
          .orIgnore();
      const refusal = 'write capture: an insert of CapMember reaches 3 rows, above db.WriteCapture.MaxRows (2); narrow the statement or raise the limit';
      const ids = async () => (await rows<{ Id: number }>('cap_member')).map((r) => r.Id);
      const config = await DI.resolve(Configuration);
      config.set('db.WriteCapture.MaxRows', 2);
      try {
        await expect(upsert(3)).to.be.rejectedWith(WriteCaptureLimitExceeded, refusal);
        expect(await ids()).to.deep.eq([1, 2]);

        await driver.transaction(async () => {
          await expect(upsert(4)).to.be.rejectedWith(WriteCaptureLimitExceeded, refusal);
        });
        expect(await ids()).to.deep.eq([1, 2, 4]);

        fixture.transactional = false;
        await expect(upsert(5)).to.be.rejectedWith(WriteCaptureLimitExceeded, refusal);
        expect(await ids()).to.deep.eq([1, 2, 4, 5]);
      } finally {
        config.set('db.WriteCapture.MaxRows', 0);
      }

      expect(fixture.writes).to.deep.eq([]);
    });

    it('refuses a delete above db.WriteCapture.MaxRows', async () => {
      const config = await DI.resolve(Configuration);
      config.set('db.WriteCapture.MaxRows', 1);
      try {
        await expect(createQuery(CapMember, DeleteQueryBuilder).query.where('Id', '>', 0)).to.be.rejectedWith(WriteCaptureLimitExceeded, 'write capture: a delete of CapMember reaches 2 rows, above db.WriteCapture.MaxRows (1); narrow the statement or raise the limit');
      } finally {
        config.set('db.WriteCapture.MaxRows', 0);
      }

      expect(await rows('cap_member')).to.have.length(2);
    });

    it('reports an upsert whose unique value has no key text (a date) as unknown', async () => {
      const { query } = createQuery(CapMember, InsertQueryBuilder);
      await query.values({ Email: new Date(Date.UTC(2026, 0, 1)), Name: 'd' }).orIgnore();

      expect(fixture.writes[0].unknownKeys).to.eq(true);
      expect(fixture.writes[0].rows).to.deep.eq([]);
    });

    it('reports no keyless rows for the writes of a model with integer keys', async () => {
      await CapMember.insert({ Email: 'b', Name: 'three' });
      await CapMember.update({ Name: 'b' }).where('Id', 1);
      await CapMember.destroy(1);

      expect(fixture.writes.map((w) => [w.kind, w.rows.length, w.keylessRows])).to.deep.eq([
        ['insert', 1, 0],
        ['update', 1, 0],
        ['delete', 1, 0],
      ]);
    });

    describe('with a single-row insert that returns no keys', () => {
      const insert = (model: typeof ModelBase, values: Record<string, unknown>) => createQuery(model, InsertQueryBuilder).query.values(values);

      beforeEach(async () => {
        const schema = db().Connections.get('sqlite')!.schema();
        await schema.raw('CREATE TABLE cap_gen (Id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))), Name TEXT)');
        await schema.raw("CREATE TABLE cap_note (Id INTEGER PRIMARY KEY, Name TEXT CHECK (Name <> 'skip'))");
        await schema.raw('CREATE TABLE cap_trig (Id INTEGER PRIMARY KEY, Name TEXT)');
        await schema.raw("CREATE TRIGGER cap_trig_ai AFTER INSERT ON cap_trig BEGIN INSERT INTO cap_member (Email, Name) VALUES ('t' || NEW.Id, 'by trigger'); END");
        await schema.raw('CREATE TABLE cap_wr (Id INTEGER PRIMARY KEY DEFAULT (abs(random()) % 1000 + 5000), Name TEXT) WITHOUT ROWID');
        await schema.raw('CREATE TABLE cap_desc (Id INTEGER PRIMARY KEY DESC, Name TEXT)');
        await db().reloadTableInfo();
      });

      it('does not report the row of an earlier insert for an OR IGNORE insert that skipped its row', async () => {
        await insert(CapNote, { Name: 'kept' });
        await insert(CapNote, { Name: 'skip' }).orIgnore();

        expect(fixture.writes.map((w) => [w.unknownKeys, w.rows])).to.deep.eq([
          [false, [{ id: '1', before: undefined, after: { Id: 1, Name: 'kept' } }]],
          [true, []],
        ]);
        expect(await rows('cap_note')).to.have.length(1);
      });

      it("reports the statement's row, not the row its AFTER INSERT trigger inserted into another table", async () => {
        await insert(CapTrig, { Name: 'a' });

        expect(fixture.writes.map((w) => [w.model, w.unknownKeys, w.rows])).to.deep.eq([[CapTrig, false, [{ id: '1', before: undefined, after: { Id: 1, Name: 'a' } }]]]);
        expect((await rows<{ Id: number }>('cap_member')).map((r) => r.Id)).to.deep.eq([1, 2, 3]);
      });

      it('reports the keys as unknown for a WITHOUT ROWID key its column default fills', async () => {
        await insert(CapWr, { Name: 'filled' });

        expect(fixture.writes.map((w) => [w.unknownKeys, w.rows])).to.deep.eq([[true, []]]);
        expect(await rows('cap_wr')).to.have.length(1);
      });

      it('reports the keys as unknown for an INTEGER PRIMARY KEY DESC key, which SQLite stores as NULL', async () => {
        await insert(CapDesc, { Name: 'a' });

        expect(fixture.writes.map((w) => [w.unknownKeys, w.rows])).to.deep.eq([[true, []]]);
        expect(await rows('cap_desc')).to.deep.eq([{ Id: null, Name: 'a' }]);
      });

      it('reports the keys as unknown when the database fills a key that is not an auto-increment integer', async () => {
        // The rowid of the second row is 2, the supplied key of the first.
        await insert(CapGen, { Id: '2', Name: 'supplied' });
        await insert(CapGen, { Name: 'filled' });

        expect(fixture.writes.map((w) => [w.unknownKeys, w.keylessRows, w.rows])).to.deep.eq([
          [false, 0, [{ id: '2', before: undefined, after: { Id: '2', Name: 'supplied' } }]],
          [true, 0, []],
        ]);
        expect(await rows('cap_gen')).to.have.length(2);
      });

      it('reports the row under LastInsertId for an INTEGER PRIMARY KEY AUTOINCREMENT key', async () => {
        await insert(CapMember, { Email: 'b', Name: 'three' });

        expect(fixture.writes.map((w) => [w.unknownKeys, w.keylessRows, w.rows])).to.deep.eq([[false, 0, [{ id: '3', before: undefined, after: { Id: 3, Email: 'b', Name: 'three' } }]]]);
      });
    });

    describe('with keys that have no key text', () => {
      const one = Buffer.from([1]);
      const two = Buffer.from([2]);

      beforeEach(async () => {
        await db().Connections.get('sqlite')!.schema().raw('CREATE TABLE cap_blob (Id BLOB PRIMARY KEY, Email TEXT UNIQUE, Name TEXT)');
        await db().reloadTableInfo();
      });

      const insertRows = async (values: Partial<CapBlob>[]) => {
        await createQuery(CapBlob, InsertQueryBuilder).query.values(values);
        fixture.writes = [];
      };

      it('counts the rows an update and a delete reach', async () => {
        await insertRows([
          { Id: one, Email: 'a', Name: 'one' },
          { Id: two, Email: 'b', Name: 'two' },
        ]);

        await CapBlob.update({ Name: 'x' }).whereIn('Email', ['a', 'b']);
        await createQuery(CapBlob, DeleteQueryBuilder).query.whereIn('Email', ['a', 'b']);

        expect(fixture.writes.map((w) => [w.kind, w.unknownKeys, w.keylessRows, w.rows])).to.deep.eq([
          ['update', false, 2, []],
          ['delete', false, 2, []],
        ]);
        expect(await rows('cap_blob')).to.deep.eq([]);
      });

      it('reports the row with key text of an update next to the count of the other', async () => {
        await insertRows([
          { Id: 'k', Email: 'a', Name: 'one' },
          { Id: two, Email: 'b', Name: 'two' },
        ]);

        await CapBlob.update({ Name: 'x' }).whereIn('Email', ['a', 'b']);

        expect(fixture.writes[0].keylessRows).to.eq(1);
        expect(fixture.writes[0].rows).to.deep.eq([{ id: 'k', before: { Id: 'k', Email: 'a', Name: 'one' }, after: { Id: 'k', Email: 'a', Name: 'x' } }]);
      });

      it('counts the keyless rows of an update towards db.WriteCapture.MaxRows', async () => {
        await insertRows([
          { Id: one, Email: 'a', Name: 'one' },
          { Id: two, Email: 'b', Name: 'two' },
          { Id: 'k', Email: 'c', Name: 'three' },
          { Id: 'm', Email: 'd', Name: 'four' },
        ]);
        const config = await DI.resolve(Configuration);
        config.set('db.WriteCapture.MaxRows', 2);
        try {
          await expect(CapBlob.update({ Name: 'x' }).whereIn('Email', ['a', 'b', 'c', 'd'])).to.be.rejectedWith(WriteCaptureLimitExceeded, 'write capture: an update of CapBlob reaches 3 rows, above db.WriteCapture.MaxRows (2); narrow the statement or raise the limit');
          await CapBlob.update({ Name: 'x' }).whereIn('Email', ['a', 'c']);
        } finally {
          config.set('db.WriteCapture.MaxRows', 0);
        }

        expect(fixture.writes.map((w) => [w.keylessRows, w.rows])).to.deep.eq([[1, [{ id: 'k', before: { Id: 'k', Email: 'c', Name: 'three' }, after: { Id: 'k', Email: 'c', Name: 'x' } }]]]);
        expect((await rows<{ Name: string }>('cap_blob')).map((r) => r.Name)).to.deep.eq(['x', 'two', 'x', 'four']);
      });

      it('counts the keyless rows an upsert reaches through a unique column towards db.WriteCapture.MaxRows', async () => {
        await insertRows([
          { Id: one, Email: 'a', Name: 'one' },
          { Id: two, Email: 'b', Name: 'two' },
          { Id: 'k', Email: 'c', Name: 'three' },
        ]);
        const upsert = (values: Partial<CapBlob>[]) => createQuery(CapBlob, InsertQueryBuilder).query.values(values).orIgnore();
        const config = await DI.resolve(Configuration);
        config.set('db.WriteCapture.MaxRows', 2);
        try {
          await expect(
            upsert([
              { Id: 'k', Email: 'a', Name: 'new' },
              { Id: 'y', Email: 'b', Name: 'new' },
            ]),
          ).to.be.rejectedWith(WriteCaptureLimitExceeded, 'write capture: an insert of CapBlob reaches 3 rows, above db.WriteCapture.MaxRows (2); narrow the statement or raise the limit');
          await upsert([{ Id: 'k', Email: 'a', Name: 'new' }]);
        } finally {
          config.set('db.WriteCapture.MaxRows', 0);
        }

        const k = { Id: 'k', Email: 'c', Name: 'three' };
        expect(fixture.writes.map((w) => [w.unknownKeys, w.keylessRows, w.rows])).to.deep.eq([[false, 1, [{ id: 'k', before: k, after: k }]]]);
        expect((await rows<{ Name: string }>('cap_blob')).map((r) => r.Name)).to.deep.eq(['one', 'two', 'three']);
      });

      it('counts the row a plain insert supplies', async () => {
        await createQuery(CapBlob, InsertQueryBuilder).query.values({ Id: one, Email: 'a', Name: 'one' });

        expect(fixture.writes.map((w) => [w.unknownKeys, w.keylessRows, w.rows])).to.deep.eq([[false, 1, []]]);
      });

      it('counts the row an upsert reaches through a unique column once, next to the row it inserts', async () => {
        await insertRows([{ Id: one, Email: 'a', Name: 'one' }]);

        const { query } = createQuery(CapBlob, InsertQueryBuilder);
        await query
          .values([
            { Id: 'k', Email: 'a', Name: 'new' },
            { Id: 'n', Email: 'z', Name: 'other' },
          ])
          .onDuplicate('Email')
          .update(['Name']);

        expect(fixture.writes[0].unknownKeys).to.eq(false);
        expect(fixture.writes[0].keylessRows).to.eq(1);
        expect(fixture.writes[0].rows).to.deep.eq([{ id: 'n', before: undefined, after: { Id: 'n', Email: 'z', Name: 'other' } }]);
        expect((await rows<{ Name: string }>('cap_blob')).map((r) => r.Name)).to.deep.eq(['new', 'other']);
      });

      it('reports an upsert that supplies a key with no key text as unknown, with no keyless rows', async () => {
        await createQuery(CapBlob, InsertQueryBuilder).query.values({ Id: one, Email: 'a', Name: 'one' }).orIgnore();

        expect(fixture.writes.map((w) => [w.unknownKeys, w.keylessRows, w.rows])).to.deep.eq([[true, 0, []]]);
      });
    });
  });

  describe("on a relation's sync()", () => {
    before(() => DI.register(RelationObserver).as(WriteObserver));

    after(() => DI.unregister(RelationObserver));

    beforeEach(() => {
      relationWrites.length = 0;
    });

    const deletes = () => relationWrites.filter((w) => w.kind === 'delete');

    it('hands the orphan delete of a one-to-many sync the removed child', async () => {
      await UowOrder.insert({ Total: 10 });
      await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
      await UowOrderItem.insert({ Sku: 'B', Qty: 2, order_id: 1 });
      const order = await UowOrder.where({ Id: 1 }).populate('Items').first();
      relationWrites.length = 0;

      order.Items.remove((i) => i.Sku === 'B');
      await order.Items.sync();

      expect(deletes().map((w) => [w.model.name, w.rows])).to.deep.eq([['UowOrderItem', [{ id: '2', before: { Id: 2, Sku: 'B', Qty: 2, order_id: 1 }, after: undefined }]]]);
      expect((await rows<{ Sku: string }>('uow_order_item')).map((r) => r.Sku)).to.deep.eq(['A']);
    });

    it('hands the orphan delete of a many-to-many sync the removed junction rows', async () => {
      await UowOrder.insert({ Total: 10 });
      await UowTag.insert({ Name: 'red' });
      await UowTag.insert({ Name: 'blue' });
      await UowOrderTag.insert({ order_id: 1, tag_id: 1 });
      await UowOrderTag.insert({ order_id: 1, tag_id: 2 });
      const order = await UowOrder.where({ Id: 1 }).populate('Tags').first();
      relationWrites.length = 0;

      order.Tags.remove((t) => t.Name === 'blue');
      await order.Tags.sync();

      expect(deletes().map((w) => [w.model.name, w.rows])).to.deep.eq([['UowOrderTag', [{ id: '2', before: { Id: 2, order_id: 1, tag_id: 2, Note: null }, after: undefined }]]]);
      expect((await rows<{ tag_id: number }>('uow_order_tag')).map((r) => r.tag_id)).to.deep.eq([1]);
    });
  });
});
