import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Builder, Connection, InsertBehaviour, Model, ModelBase, Orm, Primary, QueryContext, SelectQueryBuilder, SoftDelete, WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, WriteStatement } from '@spinajs/orm';
import { expect } from 'chai';
import _ from 'lodash';
import { DateTime } from 'luxon';
import 'mocha';
import sinon from 'sinon';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

class AttachedConf extends ConnectionConf {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.set(this.Config, 'db.Connections[0].Database', 's');
  }
}

@Connection('sqlite')
@Model('cdb_row')
class CdbRow extends ModelBase<CdbRow> {
  @Primary()
  public Id: number;

  public Name: string;

  public Code: string;
}

@Connection('sqlite')
@Model('cdb_soft')
class CdbSoft extends ModelBase<CdbSoft> {
  @Primary()
  public Id: number;

  public Name: string;

  @SoftDelete()
  public DeletedAt: DateTime;
}

const writes: CapturedWrite[] = [];

class CdbObserver extends WriteObserver {
  interest({ model }: WriteStatement): CaptureInterest | undefined {
    return model === CdbRow || model === CdbSoft ? { columns: '*', transactional: true } : undefined;
  }

  async observe(write: CapturedWrite): Promise<void> {
    writes.push(write);
    return Promise.resolve();
  }
}

const sqlite = () => db().Connections.get('sqlite') as SqliteOrmDriver;
const run = (stmt: string, params: unknown[] = []) => sqlite().executeOnDb(stmt, params, QueryContext.Schema);
const rowsOf = (stmt: string) => sqlite().executeOnDb(stmt, [], QueryContext.Select) as Promise<Array<Record<string, unknown>>>;

const DDL = (schema: string) => [`CREATE TABLE ${schema}.cdb_row (Id INTEGER PRIMARY KEY, Name TEXT, Code TEXT UNIQUE)`, `CREATE TABLE ${schema}.cdb_soft (Id INTEGER PRIMARY KEY, Name TEXT, DeletedAt TEXT)`];

// Same keys as the rows of `s`, other values: a capture that reads `main` hands these over.
const DECOYS = ["INSERT INTO main.cdb_row VALUES (1, 'main-1', 'm1'), (2, 'main-2', 'm2'), (3, 'main-3', 'm3')", "INSERT INTO main.cdb_soft VALUES (1, 'main-1', NULL)"];

const seedS = async () => {
  await run("INSERT INTO s.cdb_row VALUES (1, 'a', 'a'), (2, 'b', 'b')");
  await run("INSERT INTO s.cdb_soft VALUES (1, 'a', NULL)");
};

/** The selects the driver ran during `fn`, as SQL text. */
async function selectsDuring(fn: () => PromiseLike<unknown>): Promise<string[]> {
  const driver = sqlite();
  const original = driver.execute.bind(driver);
  const seen: string[] = [];
  const stub = sinon.stub(driver, 'execute').callsFake((builder: Builder<unknown>) => {
    if (builder instanceof SelectQueryBuilder) {
      const out = builder.toDB();
      seen.push((Array.isArray(out) ? out[0] : out).expression);
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

type Layout = 'main and s' | 'main and s, main empty' | 's only';

describe('write capture on a connection that names an attached database', function () {
  this.timeout(60000);

  let sandbox: string;
  let files = 0;

  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'spinajs-capture-db-'));
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(CdbObserver).as(WriteObserver);
  });

  after(() => {
    DI.unregister(CdbObserver);
    rmSync(sandbox, { recursive: true, force: true });
  });

  async function boot(conf: typeof ConnectionConf, layout?: Layout) {
    DI.register(conf).as(Configuration);
    await DI.resolve(Orm);
    if (layout) {
      files += 1;
      await run('ATTACH DATABASE ? AS s', [join(sandbox, `s-${files}.sqlite`)]);
      for (const ddl of DDL('s')) await run(ddl);
      if (layout !== 's only') for (const ddl of DDL('main')) await run(ddl);
      if (layout === 'main and s') for (const decoy of DECOYS) await run(decoy);
      await seedS();
    } else {
      for (const ddl of DDL('main')) await run(ddl);
      await run("INSERT INTO main.cdb_row VALUES (1, 'a', 'a'), (2, 'b', 'b')");
    }
    await db().reloadTableInfo();
    writes.length = 0;
  }

  async function shutdown(conf: typeof ConnectionConf, attached: boolean) {
    if (attached) await run('DETACH DATABASE s');
    DI.unregister(Configuration, conf);
    DI.clearCache();
  }

  const rowsOfLastWrite = () => writes.at(-1)?.rows;

  for (const layout of ['main and s', 'main and s, main empty', 's only'] as const) {
    describe(`table in ${layout}`, () => {
      beforeEach(() => boot(AttachedConf, layout));
      afterEach(() => shutdown(AttachedConf, true));

      it('hands an insert the row it wrote into s', async () => {
        await CdbRow.insert(new CdbRow({ Name: 'c', Code: 'c' }));

        expect(rowsOfLastWrite()).to.deep.equal([{ id: '3', before: undefined, after: { Id: 3, Name: 'c', Code: 'c' } }]);
      });

      it('hands a multi-row insert the rows it wrote into s', async () => {
        await CdbRow.insert([new CdbRow({ Name: 'c', Code: 'c' }), new CdbRow({ Name: 'd', Code: 'd' })]);

        expect(rowsOfLastWrite()).to.deep.equal([
          { id: '3', before: undefined, after: { Id: 3, Name: 'c', Code: 'c' } },
          { id: '4', before: undefined, after: { Id: 4, Name: 'd', Code: 'd' } },
        ]);
      });

      it('hands an update the before and after images from s', async () => {
        await CdbRow.update({ Name: 'z' }).where('Code', 'a');

        expect(rowsOfLastWrite()).to.deep.equal([{ id: '1', before: { Id: 1, Name: 'a', Code: 'a' }, after: { Id: 1, Name: 'z', Code: 'a' } }]);
      });

      it('hands an update of a model instance its row from s', async () => {
        const row = await CdbRow.where('Id', 2).firstOrFail();
        row.Name = 'y';
        await row.update();

        expect(rowsOfLastWrite()).to.deep.equal([{ id: '2', before: { Id: 2, Name: 'b', Code: 'b' }, after: { Id: 2, Name: 'y', Code: 'b' } }]);
      });

      it('hands an update of several rows their rows from s', async () => {
        await CdbRow.update({ Name: 'z' }).where('Id', '>', 0);

        expect(rowsOfLastWrite()).to.deep.equal([
          { id: '1', before: { Id: 1, Name: 'a', Code: 'a' }, after: { Id: 1, Name: 'z', Code: 'a' } },
          { id: '2', before: { Id: 2, Name: 'b', Code: 'b' }, after: { Id: 2, Name: 'z', Code: 'b' } },
        ]);
      });

      it('hands a delete the row it removed from s', async () => {
        await CdbRow.destroy(1);

        expect(rowsOfLastWrite()).to.deep.equal([{ id: '1', before: { Id: 1, Name: 'a', Code: 'a' }, after: undefined }]);
      });

      it('hands a delete of several rows the rows it removed from s', async () => {
        await CdbRow.destroy([1, 2]);

        expect(rowsOfLastWrite()).to.deep.equal([
          { id: '1', before: { Id: 1, Name: 'a', Code: 'a' }, after: undefined },
          { id: '2', before: { Id: 2, Name: 'b', Code: 'b' }, after: undefined },
        ]);
      });

      it('hands an upsert that updates its row from s', async () => {
        await CdbRow.insert({ Id: 1, Name: 'u', Code: 'a' }, InsertBehaviour.InsertOrUpdate);

        expect(rowsOfLastWrite()).to.deep.equal([{ id: '1', before: { Id: 1, Name: 'a', Code: 'a' }, after: { Id: 1, Name: 'u', Code: 'a' } }]);
      });

      it('hands a replace its row from s', async () => {
        await CdbRow.insert({ Id: 2, Name: 'r', Code: 'b' }, InsertBehaviour.InsertOrReplace);

        expect(rowsOfLastWrite()).to.deep.equal([{ id: '2', before: { Id: 2, Name: 'b', Code: 'b' }, after: { Id: 2, Name: 'r', Code: 'b' } }]);
      });

      it('hands a soft delete its row from s', async () => {
        await CdbSoft.destroy(1);

        expect(writes.at(-1)?.kind).to.equal('update');
        expect(rowsOfLastWrite()).to.have.length(1);
        const [change] = rowsOfLastWrite() ?? [];
        expect(change.before).to.deep.equal({ Id: 1, Name: 'a', DeletedAt: null });
        expect(change.after?.Name).to.equal('a');
        expect(change.after?.DeletedAt).to.be.a('string');
      });

      it('leaves main untouched', async () => {
        await CdbRow.insert(new CdbRow({ Name: 'c', Code: 'c' }));
        await CdbRow.update({ Name: 'z' }).where('Id', 1);
        await CdbRow.destroy(2);

        const main = layout === 's only' ? [] : await rowsOf('SELECT * FROM main.cdb_row ORDER BY Id');
        expect(main.map((r) => r.Name)).to.deep.equal(layout === 'main and s' ? ['main-1', 'main-2', 'main-3'] : []);
      });
    });
  }

  describe('connection without a database', () => {
    beforeEach(() => boot(ConnectionConf));
    afterEach(() => shutdown(ConnectionConf, false));

    // Byte-identical before and after the fix: no database, no qualifier.
    it('reads an insert back from the bare table', async () => {
      expect(await selectsDuring(() => CdbRow.insert(new CdbRow({ Name: 'c', Code: 'c' })))).to.deep.equal(['SELECT * FROM `cdb_row` WHERE `Id` IN (?)']);
      expect(rowsOfLastWrite()?.map((r) => r.after?.Name)).to.deep.equal(['c']);
    });

    it('reads an update from the bare table', async () => {
      expect(await selectsDuring(() => CdbRow.update({ Name: 'z' }).where('Code', 'a'))).to.deep.equal(['SELECT `Id` FROM `cdb_row` WHERE `Code` = ?', 'SELECT * FROM `cdb_row` WHERE `Id` IN (?)', 'SELECT * FROM `cdb_row` WHERE `Id` IN (?)']);
      expect(rowsOfLastWrite()?.map((r) => r.after?.Name)).to.deep.equal(['z']);
    });

    it('reads a delete from the bare table', async () => {
      expect(await selectsDuring(() => CdbRow.destroy(1))).to.deep.equal(['SELECT `Id` FROM `cdb_row` WHERE `Id` IN (?)', 'SELECT * FROM `cdb_row` WHERE `Id` IN (?)']);
      expect(rowsOfLastWrite()?.map((r) => r.before?.Name)).to.deep.equal(['a']);
    });
  });

  describe('compiled capture reads with a database', () => {
    beforeEach(() => boot(AttachedConf, 'main and s'));
    afterEach(() => shutdown(AttachedConf, true));

    it('qualifies every read of an update like the key select', async () => {
      expect(await selectsDuring(() => CdbRow.update({ Name: 'z' }).where('Code', 'a'))).to.deep.equal(['SELECT `Id` FROM `s`.`cdb_row` WHERE `Code` = ?', 'SELECT * FROM `s`.`cdb_row` WHERE `Id` IN (?)', 'SELECT * FROM `s`.`cdb_row` WHERE `Id` IN (?)']);
    });
  });
});
