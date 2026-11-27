import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, ICompilerOutput, InsertQueryBuilder, Model, ModelBase, Orm, Primary, QueryContext, RawQuery } from '@spinajs/orm';
import { expect } from 'chai';
import _ from 'lodash';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

class AttachedConnectionConf extends ConnectionConf {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.set(this.Config, 'db.Connections[0].Database', 's');
  }
}

@Connection('sqlite')
@Model('insert_db_row')
class InsertDbRow extends ModelBase<InsertDbRow> {
  @Primary()
  public Id: number;

  public A: number;
}

const sqlite = () => db().Connections.get('sqlite') as SqliteOrmDriver;
const insert = () => sqlite().insert();
const sql = (output: ICompilerOutput | ICompilerOutput[]) => (Array.isArray(output) ? output[0] : output).expression;
const run = (stmt: string) => sqlite().executeOnDb(stmt, [], QueryContext.Schema);
const rows = (stmt: string) => sqlite().executeOnDb(stmt, [], QueryContext.Select) as Promise<Array<{ id: number; a: number }>>;

// ATTACH reaches only the writer handle; a ':memory:' connection opens no read handles, so every statement sees `s`.
async function attach(ddl: (schema: string) => string) {
  await run(`ATTACH DATABASE ':memory:' AS s`);
  await run(ddl('main'));
  await run(ddl('s'));
}

describe('sqlite insert into a database', function () {
  this.timeout(10000);

  afterEach(() => {
    DI.clearCache();
  });

  describe('compiled', () => {
    beforeEach(async () => {
      DI.register(ConnectionConf).as(Configuration);
      DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
      await DI.resolve(Orm);
    });

    const forms: Array<[string, (q: InsertQueryBuilder) => ICompilerOutput | ICompilerOutput[], string]> = [
      ['plain', (q) => q.values({ a: 1 }).toDB(), 'INSERT INTO `s`.`t` (`a`) VALUES (?)'],
      ['multi-row', (q) => q.values([{ a: 1 }, { a: 2 }]).toDB(), 'INSERT INTO `s`.`t` (`a`) VALUES (?),(?)'],
      ['or ignore', (q) => q.values({ a: 1 }).orIgnore().toDB(), 'INSERT OR IGNORE INTO `s`.`t` (`a`) VALUES (?)'],
      ['or replace', (q) => q.values({ a: 1 }).orReplace().toDB(), 'INSERT OR REPLACE INTO `s`.`t` (`a`) VALUES (?)'],
      ['returning', (q) => q.values({ a: 1 }).returning(['id']).toDB(), 'INSERT INTO `s`.`t` (`a`) VALUES (?)  RETURNING `id`'],
      ['upsert', (q) => q.values({ id: 1, a: 1 }).onDuplicate('id').update(['a']).toDB(), 'INSERT INTO `s`.`t` (`id`,`a`) VALUES (?,?) ON CONFLICT(`id`) DO UPDATE SET `a` = excluded.`a` RETURNING *;'],
    ];

    for (const [name, build, expected] of forms) {
      it(`qualifies the ${name} form with database()`, () => {
        expect(sql(build(insert().into('t').database('s')))).to.equal(expected);
      });

      it(`qualifies the ${name} form with the schema given to into()`, () => {
        expect(sql(build(insert().into('t', 's')))).to.equal(expected);
      });

      it(`leaves the ${name} form without a database unqualified`, () => {
        expect(sql(build(insert().into('t')))).to.equal(expected.replace('`s`.', ''));
      });
    }

    it('quotes a table name through the dialect quoter', () => {
      expect(sql(insert().into('t`x').values({ a: 1 }).toDB())).to.equal('INSERT INTO `t``x` (`a`) VALUES (?)');
    });

    it('renders the alias set with setAlias()', () => {
      expect(sql(insert().into('t').setAlias('x').values({ a: 1 }).toDB())).to.equal('INSERT INTO `t` as `x` (`a`) VALUES (?)');
    });
  });

  describe('on an attached database', () => {
    beforeEach(async () => {
      DI.register(ConnectionConf).as(Configuration);
      DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
      await DI.resolve(Orm);
      await attach((schema) => `CREATE TABLE ${schema}.t (id INTEGER PRIMARY KEY, a INTEGER)`);
    });

    it('writes the row into the attached table, where select().database() reads it', async () => {
      await insert().into('t').database('s').values({ id: 1, a: 1 });
      await insert().into('t', 's').values({ id: 2, a: 2 });

      const read = (await sqlite().select().from('t').database('s')) as Array<{ id: number }>;
      expect(read.map((r) => r.id)).to.deep.equal([1, 2]);
      expect(await rows('SELECT * FROM main.t')).to.deep.equal([]);
    });

    it('upserts into the attached table', async () => {
      await insert().into('t', 's').values({ id: 1, a: 1 }).onDuplicate('id').update(['a']);
      await insert().into('t', 's').values({ id: 1, a: 5 }).onDuplicate('id').update(['a']);

      expect(await rows('SELECT * FROM s.t')).to.deep.equal([{ id: 1, a: 5 }]);
      expect(await rows('SELECT * FROM main.t')).to.deep.equal([]);
    });

    it('writes an insert without a database into main', async () => {
      await insert().into('t').values({ id: 1, a: 1 });

      expect(await rows('SELECT * FROM main.t')).to.deep.equal([{ id: 1, a: 1 }]);
      expect(await rows('SELECT * FROM s.t')).to.deep.equal([]);
    });

    it('lets an upsert read the alias set with setAlias()', async () => {
      await insert().into('t').values({ id: 1, a: 1 });
      await insert()
        .into('t')
        .setAlias('x')
        .values({ id: 1, a: 1 })
        .onDuplicate('id')
        .update([RawQuery.create('a = x.a + 10')]);

      expect(await rows('SELECT * FROM main.t')).to.deep.equal([{ id: 1, a: 11 }]);
    });
  });

  describe('model on a connection that names a database', () => {
    beforeEach(async () => {
      DI.register(AttachedConnectionConf).as(Configuration);
      DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
      await DI.resolve(Orm);
      await attach((schema) => `CREATE TABLE ${schema}.insert_db_row (Id INTEGER PRIMARY KEY, A INTEGER)`);
      await db().reloadTableInfo();
    });

    // A later file's register() of ConnectionConf does not displace this one.
    afterEach(() => {
      DI.unregister(Configuration, AttachedConnectionConf);
    });

    it('inserts into the table its selects read', async () => {
      await InsertDbRow.insert(new InsertDbRow({ Id: 1, A: 1 }));

      expect((await InsertDbRow.all()).map((r) => r.Id)).to.deep.equal([1]);
      expect(await rows('SELECT * FROM main.insert_db_row')).to.deep.equal([]);
    });
  });
});
