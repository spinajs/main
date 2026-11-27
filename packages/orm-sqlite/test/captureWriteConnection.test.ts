import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Builder, Connection, DeleteQueryBuilder, Model, ModelBase, Orm, Primary, QueryContext, SelectQueryBuilder, UpdateQueryBuilder, WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, WriteStatement } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import _ from 'lodash';
import 'mocha';
import sinon from 'sinon';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';
import { bootUow, UowOrder, UowOrderItem } from './uowFixture.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

class AttachedConf extends ConnectionConf {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.set(this.Config, 'db.Connections[0].Database', 's');
  }
}

// One file attached as `s` on both connections plays one server: `sqlite-shared` names `s`, and its models' writes in
// a save run on `sqlite`, inside the save's transaction.
class SharedServerConf extends ConnectionConf {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.set(this.Config, 'db.Connections[0].SharedServer', 'memory');
    _.set(this.Config, 'db.Connections[1]', { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite-shared', SharedServer: 'memory', Database: 's' });
  }
}

@Connection('sqlite')
@Model('kwc_row')
class KwcRow extends ModelBase<KwcRow> {
  @Primary()
  public Id: number;

  public Name: string;

  public Code: string;
}

const writes: CapturedWrite[] = [];

class Recorder extends WriteObserver {
  interest({ model }: WriteStatement): CaptureInterest | undefined {
    return model === KwcRow || model === UowOrderItem ? { columns: '*', transactional: true } : undefined;
  }

  async observe(write: CapturedWrite): Promise<void> {
    writes.push(write);
    return Promise.resolve();
  }
}

const connection = (name = 'sqlite') => db().Connections.get(name) as SqliteOrmDriver;
const run = (stmt: string, params: unknown[] = [], name = 'sqlite') => connection(name).executeOnDb(stmt, params, QueryContext.Schema);
const rowsOf = (stmt: string) => connection().executeOnDb(stmt, [], QueryContext.Select) as Promise<Array<Record<string, unknown>>>;
const captured = () => writes.map((w) => [w.kind, w.rows]);

/** The selects, updates and deletes a connection ran during `fn`, as SQL text. */
async function statementsDuring(fn: () => PromiseLike<unknown>, name = 'sqlite'): Promise<string[]> {
  const driver = connection(name);
  const original = driver.execute.bind(driver);
  const seen: string[] = [];
  const stub = sinon.stub(driver, 'execute').callsFake((builder: Builder<unknown>) => {
    if (builder instanceof SelectQueryBuilder || builder instanceof UpdateQueryBuilder || builder instanceof DeleteQueryBuilder) {
      const { expression } = builder.toDB();
      if (expression !== null) seen.push(expression);
    }
    return original(builder);
  });
  try {
    await fn();
  } finally {
    stub.restore();
  }
  return seen;
}

describe('write capture: the key select runs where the write runs', function () {
  this.timeout(60000);

  let sandbox: string;
  let files = 0;
  const nextFile = () => join(sandbox, `s-${String(++files)}.sqlite`);

  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'spinajs-capture-connection-'));
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(Recorder).as(WriteObserver);
  });

  after(() => {
    DI.unregister(Recorder);
    rmSync(sandbox, { recursive: true, force: true });
  });

  async function shutdown(conf: typeof ConnectionConf, attachedOn: readonly string[]) {
    for (const name of attachedOn) await run('DETACH DATABASE s', [], name);
    DI.unregister(Configuration, conf);
    DI.clearCache();
  }

  describe('a save that writes a model of another connection on the same server', () => {
    let order: UowOrder;
    let item: UowOrderItem;

    beforeEach(async () => {
      DI.register(SharedServerConf).as(Configuration);
      await bootUow();
      const file = nextFile();
      for (const name of ['sqlite', 'sqlite-shared']) await run('ATTACH DATABASE ? AS s', [file], name);
      // The table lives in `s` only, so an insert lands there whether or not it is qualified.
      await run('DROP TABLE main.uow_order_item');
      await run('CREATE TABLE s.uow_order_item (Id INTEGER PRIMARY KEY, Sku TEXT, Qty INTEGER, order_id INTEGER)');
      order = new UowOrder({ Total: 1 });
      item = new UowOrderItem({ Sku: 'A', Qty: 1 });
      order.attach(item);
      writes.length = 0;
    });
    afterEach(() => shutdown(SharedServerConf, ['sqlite', 'sqlite-shared']));

    async function onSharedConnection<T>(fn: () => Promise<T>): Promise<T> {
      const descriptor = UowOrderItem.getModelDescriptor();
      descriptor.Connection = 'sqlite-shared';
      try {
        return await fn();
      } finally {
        descriptor.Connection = 'sqlite';
      }
    }

    const inserted = { id: '1', before: undefined, after: { Id: 1, Sku: 'A', Qty: 1, order_id: 1 } };
    const updated = { id: '1', before: { Id: 1, Sku: 'A', Qty: 1, order_id: 1 }, after: { Id: 1, Sku: 'A', Qty: 5, order_id: 1 } };
    const deleted = { id: '1', before: { Id: 1, Sku: 'A', Qty: 1, order_id: 1 }, after: undefined };
    const items = () => rowsOf('SELECT * FROM s.uow_order_item ORDER BY Id');

    it('updates a committed row in a later save (control)', async () => {
      await onSharedConnection(async () => {
        await order.save();
        item.Qty = 5;
        await order.save();
      });

      expect(captured()).to.deep.equal([
        ['insert', [inserted]],
        ['update', [updated]],
      ]);
      expect(await items()).to.deep.equal([{ Id: 1, Sku: 'A', Qty: 5, order_id: 1 }]);
    });

    it('updates a row the same transaction inserted', async () => {
      const onShared = await statementsDuring(
        () =>
          onSharedConnection(() =>
            connection().transaction(async () => {
              await order.save();
              item.Qty = 5;
              await order.save();
            }),
          ),
        'sqlite-shared',
      );

      expect(onShared).to.deep.equal([]);
      expect(captured()).to.deep.equal([
        ['insert', [inserted]],
        ['update', [updated]],
      ]);
      expect(await items()).to.deep.equal([{ Id: 1, Sku: 'A', Qty: 5, order_id: 1 }]);
    });

    it('deletes as an orphan a row the same transaction inserted', async () => {
      await onSharedConnection(() =>
        connection().transaction(async () => {
          await order.save();
          order.Items.empty();
          await order.save();
        }),
      );

      expect(captured()).to.deep.equal([
        ['insert', [inserted]],
        ['delete', [deleted]],
      ]);
      expect(await items()).to.deep.equal([]);
    });

    it('hands the observer the rows of a transaction that then rolls back, and leaves nothing', async () => {
      await expect(
        onSharedConnection(() =>
          connection().transaction(async () => {
            await order.save();
            item.Qty = 5;
            await order.save();
            throw new Error('undo');
          }),
        ),
      ).to.be.rejectedWith('undo');

      expect(captured()).to.deep.equal([
        ['insert', [inserted]],
        ['update', [updated]],
      ]);
      expect(await items()).to.deep.equal([]);
    });
  });

  const DDL = (schema: string) => `CREATE TABLE ${schema}.kwc_row (Id INTEGER PRIMARY KEY, Name TEXT, Code TEXT)`;

  async function bootAttached(conf: typeof ConnectionConf) {
    DI.register(conf).as(Configuration);
    await DI.resolve(Orm);
    await run('ATTACH DATABASE ? AS s', [nextFile()]);
    for (const schema of ['main', 's']) await run(DDL(schema));
    await run("INSERT INTO main.kwc_row VALUES (1, 'main-1', 'm1'), (2, 'main-2', 'm2'), (3, 'main-3', 'm3')");
    await run("INSERT INTO s.kwc_row VALUES (1, 'a', 'a'), (2, 'b', 'b')");
    await db().reloadTableInfo();
    writes.length = 0;
  }

  const names = async (schema: string) => (await rowsOf(`SELECT Name FROM ${schema}.kwc_row ORDER BY Id`)).map((r) => r.Name);

  describe('a write that names another database than its connection', () => {
    beforeEach(() => bootAttached(AttachedConf));
    afterEach(() => shutdown(AttachedConf, ['sqlite']));

    it('keys, reads and updates in the database the update names', async () => {
      await KwcRow.update({ Name: 'z' }).where('Code', 'm2').database('main');

      expect(captured()).to.deep.equal([['update', [{ id: '2', before: { Id: 2, Name: 'main-2', Code: 'm2' }, after: { Id: 2, Name: 'z', Code: 'm2' } }]]]);
      expect(await names('main')).to.deep.equal(['main-1', 'z', 'main-3']);
      expect(await names('s')).to.deep.equal(['a', 'b']);
    });

    it('keys, reads and deletes in the database the delete names', async () => {
      await KwcRow.destroy().where('Code', 'm2').database('main');

      expect(captured()).to.deep.equal([['delete', [{ id: '2', before: { Id: 2, Name: 'main-2', Code: 'm2' }, after: undefined }]]]);
      expect(await names('main')).to.deep.equal(['main-1', 'main-3']);
      expect(await names('s')).to.deep.equal(['a', 'b']);
    });
  });

  describe('a write that names a database on a connection without one', () => {
    beforeEach(() => bootAttached(ConnectionConf));
    afterEach(() => shutdown(ConnectionConf, ['sqlite']));

    it('keys, reads and updates in the database the update names', async () => {
      await KwcRow.update({ Name: 'z' }).where('Code', 'a').database('s');

      expect(captured()).to.deep.equal([['update', [{ id: '1', before: { Id: 1, Name: 'a', Code: 'a' }, after: { Id: 1, Name: 'z', Code: 'a' } }]]]);
      expect(await names('s')).to.deep.equal(['z', 'b']);
      expect(await names('main')).to.deep.equal(['main-1', 'main-2', 'main-3']);
    });

    it('keys, reads and deletes in the database the delete names', async () => {
      await KwcRow.destroy().where('Code', 'a').database('s');

      expect(captured()).to.deep.equal([['delete', [{ id: '1', before: { Id: 1, Name: 'a', Code: 'a' }, after: undefined }]]]);
      expect(await names('s')).to.deep.equal(['b']);
      expect(await names('main')).to.deep.equal(['main-1', 'main-2', 'main-3']);
    });
  });

  // Byte-identical before and after the fix: one connection, no database.
  describe('a write on its own connection without a database', () => {
    beforeEach(async () => {
      DI.register(ConnectionConf).as(Configuration);
      await DI.resolve(Orm);
      await run(DDL('main'));
      await run("INSERT INTO main.kwc_row VALUES (1, 'a', 'a'), (2, 'b', 'b')");
      await db().reloadTableInfo();
      writes.length = 0;
    });
    afterEach(() => shutdown(ConnectionConf, []));

    it('compiles an update by its where as before', async () => {
      expect(await statementsDuring(() => KwcRow.update({ Name: 'z' }).where('Code', 'a'))).to.deep.equal([
        'SELECT `Id` FROM `kwc_row` WHERE `Code` = ?',
        'SELECT * FROM `kwc_row` WHERE `Id` IN (?)',
        'UPDATE `kwc_row` SET `Name` = ? WHERE ( `Code` = ? ) AND `Id` IN (?)',
        'SELECT * FROM `kwc_row` WHERE `Id` IN (?)',
      ]);
    });

    it('compiles a delete by key as before', async () => {
      expect(await statementsDuring(() => KwcRow.destroy(1))).to.deep.equal(['SELECT `Id` FROM `kwc_row` WHERE `Id` IN (?)', 'SELECT * FROM `kwc_row` WHERE `Id` IN (?)', 'DELETE FROM `kwc_row` WHERE ( `Id` IN (?) ) AND `Id` IN (?)']);
    });

    it('compiles an update of a model instance as before', async () => {
      const row = await KwcRow.where('Id', 2).firstOrFail();
      row.Name = 'y';
      expect(await statementsDuring(() => row.update())).to.deep.equal([
        'SELECT `Id` FROM `kwc_row` WHERE `Id` = ?',
        'SELECT * FROM `kwc_row` WHERE `Id` IN (?)',
        'UPDATE `kwc_row` SET `Name` = ? WHERE ( `Id` = ? ) AND `Id` IN (?)',
        'SELECT * FROM `kwc_row` WHERE `Id` IN (?)',
      ]);
    });
  });
});
