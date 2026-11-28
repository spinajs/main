import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { BelongsTo, Connection, Ignore, Model, ModelBase, Primary, QueryContext, QueryMiddleware, UpdatedAt, Version, WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, QueryBuilder, SingleRelation, WriteStatement } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DateTime } from 'luxon';
import 'mocha';
import { SqliteOrmDriver } from '../src/index.js';
import { db } from './common.js';
import { bootUow, captureStatements, registerUowConnection, rows, UowOrder, UowOrderTag, UowTag } from './uowFixture.js';
import type { ICapturedStatement } from './uowFixture.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

@Connection('sqlite')
@Model('upd_owner')
class UpdOwner extends ModelBase<UpdOwner> {
  @Primary()
  public Id: number;
}

@Connection('sqlite')
@Model('upd_plain')
class UpdPlain extends ModelBase<UpdPlain> {
  @Primary()
  public Id: number;

  public Name: string | undefined;

  @Ignore()
  public Scratch: string;
}

@Connection('sqlite')
@Model('upd_stamped')
class UpdStamped extends ModelBase<UpdStamped> {
  @Primary()
  public Id: number;

  public Name: string | undefined;

  @UpdatedAt()
  public UpdatedAt: DateTime;
}

@Connection('sqlite')
@Model('upd_versioned')
class UpdVersioned extends ModelBase<UpdVersioned> {
  @Primary()
  public Id: number;

  public Name: string | undefined;

  @Version()
  public Ver: number;
}

@Connection('sqlite')
@Model('upd_owned')
class UpdOwned extends ModelBase<UpdOwned> {
  @Primary()
  public Id: number;

  public owner_id: number | null | undefined;

  @BelongsTo(UpdOwner, 'owner_id')
  public Owner: SingleRelation<UpdOwner>;
}

// Module state: the test does not depend on which instance DI hands out.
const seen = { hooks: [] as string[], writes: [] as CapturedWrite[] };

class HookRecorder extends QueryMiddleware {
  public afterQueryCreation(query: QueryBuilder): void {
    seen.hooks.push(`created ${query.QueryContext}`);
  }

  public beforeQueryExecution(query: QueryBuilder): void {
    seen.hooks.push(`before ${query.QueryContext}`);
  }

  public afterQueryExecution(query: QueryBuilder): void {
    seen.hooks.push(`after ${query.QueryContext}`);
  }
}

class WriteRecorder extends WriteObserver {
  public interest({ model }: WriteStatement): CaptureInterest | undefined {
    return model === UpdPlain || model === UpdOwned ? { columns: '*', transactional: true } : undefined;
  }

  public observe(write: CapturedWrite): Promise<void> {
    seen.writes.push(write);
    return Promise.resolve();
  }
}

async function run(sql: string): Promise<void> {
  const connection = db().Connections.get('sqlite');
  if (!(connection instanceof SqliteOrmDriver)) {
    throw new Error('the sqlite connection is not booted');
  }
  await connection.executeOnDb(sql, [], QueryContext.Schema);
}

const updates = (statements: ICapturedStatement[]) => statements.filter((s) => s.context === QueryContext.Update).map((s) => [s.expression, s.bindings]);

/** What one call sends and which hooks and captures it triggers, from a clean record. */
async function observed<T>(fn: () => PromiseLike<T>) {
  seen.hooks.length = 0;
  seen.writes.length = 0;
  const capture = captureStatements();
  try {
    const result = await fn();
    return { result, statements: capture.statements.map((s) => s.expression), hooks: [...seen.hooks], writes: seen.writes.length };
  } finally {
    capture.restore();
  }
}

describe('sqlite update with no column to write', function () {
  this.timeout(30000);

  before(async () => {
    registerUowConnection();
    DI.register(HookRecorder).as(QueryMiddleware);
    DI.register(WriteRecorder).as(WriteObserver);

    await bootUow();
    await run('CREATE TABLE upd_owner (Id INTEGER PRIMARY KEY)');
    await run('CREATE TABLE upd_plain (Id INTEGER PRIMARY KEY, Name TEXT NULL)');
    await run('CREATE TABLE upd_stamped (Id INTEGER PRIMARY KEY, Name TEXT NULL, UpdatedAt TEXT NULL)');
    await run('CREATE TABLE upd_versioned (Id INTEGER PRIMARY KEY, Name TEXT NULL, Ver INTEGER NOT NULL DEFAULT 1)');
    await run('CREATE TABLE upd_owned (Id INTEGER PRIMARY KEY, owner_id INTEGER NULL)');
    await db().reloadTableInfo();
  });

  beforeEach(async () => {
    for (const table of ['upd_owner', 'upd_plain', 'upd_stamped', 'upd_versioned', 'upd_owned', 'uow_order_tag', 'uow_tag', 'uow_order']) {
      await run(`DELETE FROM ${table}`);
    }
    await run('INSERT INTO upd_owner VALUES (1)');
    await run("INSERT INTO upd_plain VALUES (1, 'a')");
    await run("INSERT INTO upd_stamped VALUES (1, 'a', NULL)");
    await run("INSERT INTO upd_versioned VALUES (1, 'a', 1)");
    await run('INSERT INTO upd_owned VALUES (1, 1)');
  });

  after(() => {
    DI.unregister(HookRecorder);
    DI.unregister(WriteRecorder);
    DI.clearCache();
  });

  describe('a model update whose changes all vanish from the payload behaves as "nothing changed"', () => {
    it('update() with nothing changed sends nothing (the precedent)', async () => {
      const plain = (await UpdPlain.where('Id', 1).first())!;

      const seenNow = await observed(() => plain.update());

      expect(seenNow).to.deep.eq({ result: { RowsAffected: 0, LastInsertId: 0 }, statements: [], hooks: [], writes: 0 });
    });

    it('update() after model.Name = undefined resolves without a statement and keeps the row', async () => {
      const plain = (await UpdPlain.where('Id', 1).first())!;
      plain.Name = undefined;

      const seenNow = await observed(() => plain.update());

      expect(seenNow).to.deep.eq({ result: { RowsAffected: 0, LastInsertId: 0 }, statements: [], hooks: [], writes: 0 });
      expect(plain.Snapshot!.Columns.get('Name')).to.eq('a');
      expect(await rows('upd_plain')).to.deep.eq([{ Id: 1, Name: 'a' }]);
    });

    it('update() after a relation-managed foreign key was set to undefined resolves without a statement', async () => {
      const owned = (await UpdOwned.where('Id', 1).first())!;
      owned.owner_id = undefined;

      const seenNow = await observed(() => owned.update());

      expect(seenNow).to.deep.eq({ result: { RowsAffected: 0, LastInsertId: 0 }, statements: [], hooks: [], writes: 0 });
      expect(await rows('upd_owned')).to.deep.eq([{ Id: 1, owner_id: 1 }]);
    });

    it('insertOrUpdate() of a loaded model after model.Name = undefined resolves without a statement', async () => {
      const plain = (await UpdPlain.where('Id', 1).first())!;
      plain.Name = undefined;

      const seenNow = await observed(() => plain.insertOrUpdate());

      expect(seenNow.statements).to.deep.eq([]);
      expect(seenNow.result).to.deep.eq({ RowsAffected: 0, LastInsertId: 0 });
    });

    it('save() after model.Name = undefined writes nothing, as save() with nothing changed', async () => {
      const plain = (await UpdPlain.where('Id', 1).first())!;
      const unchanged = await observed(() => plain.save());
      plain.Name = undefined;

      const seenNow = await observed(() => plain.save());

      expect(seenNow).to.deep.eq(unchanged);
      expect(seenNow.result.Updated).to.eq(0);
      expect(await rows('upd_plain')).to.deep.eq([{ Id: 1, Name: 'a' }]);
    });

    it('save() after a junction column was set to undefined writes no junction row', async () => {
      await UowOrder.insert({ Total: 10 });
      await UowTag.insert({ Name: 'red' });
      await UowOrderTag.insert({ order_id: 1, tag_id: 1, Note: 'first red' });
      const order = (await UowOrder.where({ Id: 1 }).populate('Tags').first())!;
      order.Tags.junction<UowOrderTag>(order.Tags[0])!.Note = undefined as unknown as string;

      const seenNow = await observed(() => order.save());

      expect(seenNow.statements).to.deep.eq([]);
      expect(seenNow.result.JunctionUpdated).to.eq(0);
      expect(await rows('uow_order_tag')).to.deep.eq([{ Id: 1, order_id: 1, tag_id: 1, Note: 'first red' }]);
    });
  });

  describe('an explicit update with no column is refused as an insert with no column is', () => {
    it('the precedent: Model.insert({}) rejects with InvalidArgument before anything is sent', async () => {
      const seenNow = observed(() => UpdPlain.insert({}));

      await expect(seenNow).to.be.rejectedWith(InvalidArgument, 'invalid column count');
    });

    it('Model.update({}).where() rejects with InvalidArgument naming the table, no UPDATE is sent', async () => {
      const capture = captureStatements();
      try {
        await expect(UpdPlain.update({}).where('Id', 1)).to.be.rejectedWith(InvalidArgument, 'update of upd_plain sets no column');
        expect(updates(capture.statements)).to.deep.eq([]);
      } finally {
        capture.restore();
      }
    });

    it('Model.update() with only an @Ignore() property rejects the same way', async () => {
      await expect(UpdPlain.update({ Scratch: 'x' }).where('Id', 1)).to.be.rejectedWith(InvalidArgument, 'update of upd_plain sets no column');
    });

    it('a query-builder update without values rejects the same way', async () => {
      const connection = db().Connections.get('sqlite')!;

      await expect(connection.update().in('upd_plain').update({}).where('Id', 1)).to.be.rejectedWith(InvalidArgument, 'update of upd_plain sets no column');
      await expect(connection.update().in('upd_plain').where('Id', 1)).to.be.rejectedWith(InvalidArgument, 'update of upd_plain sets no column');
      expect(await rows('upd_plain')).to.deep.eq([{ Id: 1, Name: 'a' }]);
    });
  });

  describe('an update with at least one column sends the same SQL as before', () => {
    it('a changed column', async () => {
      const plain = (await UpdPlain.where('Id', 1).first())!;
      plain.Name = 'b';
      const capture = captureStatements();
      try {
        await plain.update();
      } finally {
        capture.restore();
      }

      // write capture reads the row around the update, so only the update itself is pinned
      expect(updates(capture.statements)).to.deep.eq([['UPDATE `upd_plain` SET `Name` = ? WHERE `Id` = ?', ['b', 1]]]);
    });

    it('a changed column on an @UpdatedAt model, and an undefined one, which still stamps UpdatedAt', async () => {
      const stamped = (await UpdStamped.where('Id', 1).first())!;
      stamped.Name = 'b';
      const capture = captureStatements();
      try {
        await stamped.update();
        stamped.Name = undefined;
        await stamped.update();
      } finally {
        capture.restore();
      }

      const stamps = capture.statements.map((s) => s.bindings.find((b: unknown) => typeof b === 'string' && b.includes('T')) as string);
      expect(updates(capture.statements)).to.deep.eq([
        ['UPDATE `upd_stamped` SET `Name` = ?,`UpdatedAt` = ? WHERE `Id` = ?', ['b', stamps[0], 1]],
        ['UPDATE `upd_stamped` SET `UpdatedAt` = ? WHERE `Id` = ?', [stamps[1], 1]],
      ]);
    });

    it('an undefined column on an @Version model still moves the version', async () => {
      const versioned = (await UpdVersioned.where('Id', 1).first())!;
      versioned.Name = undefined;
      const capture = captureStatements();
      try {
        await versioned.update();
      } finally {
        capture.restore();
      }

      expect(updates(capture.statements)).to.deep.eq([['UPDATE `upd_versioned` SET `Ver` = ? WHERE `Id` = ? AND `Ver` = ?', [2, 1, 1]]]);
    });
  });
});
