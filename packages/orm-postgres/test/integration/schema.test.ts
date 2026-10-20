/* eslint-disable @typescript-eslint/no-explicit-any */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { RawQuery } from '@spinajs/orm';

import './migrations/PgDownProbeMigration_2026_10_15_00_03_00.js';
import { IPgSuite, openSuite, sqlState } from './harness.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const failure = (p: PromiseLike<unknown>) =>
  Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );

describe('postgres integration - schema builder and migrations', function () {
  let suite: IPgSuite;

  const columns = async (table: string) => Object.fromEntries((await suite.driver.tableInfo(table)).map((c) => [c.Name, c]));

  before(async function () {
    suite = await openSuite(this, { name: 'schema' });
  });

  after(async () => {
    await suite?.close();
  });

  it('creates every schema builder type and reflects it', async () => {
    await suite.driver.schema().createTable('pg_all_types', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.bigint('Big');
      t.smallint('Small');
      t.tinyint('Tiny');
      t.string('Str', 40);
      t.text('Txt');
      t.boolean('Flag');
      t.float('F');
      t.double('D');
      t.decimal('Dec', 10, 3);
      t.date('Day');
      t.time('Clock');
      t.dateTime('At');
      t.timestamp('Ts');
      t.json('Doc');
      t.binary('Bin', 16);
      t.enum('Kind', ['a', 'b']);
      t.uuid('Ref');
    });

    const info = await suite.driver.tableInfo('pg_all_types');
    expect(Object.fromEntries(info.map((c) => [c.Name, c.Type]))).to.deep.equal({
      Id: 'int4',
      Big: 'int8',
      Small: 'int2',
      Tiny: 'int2',
      Str: 'varchar',
      Txt: 'text',
      Flag: 'bool',
      F: 'float4',
      D: 'float8',
      Dec: 'numeric',
      Day: 'date',
      Clock: 'time',
      At: 'timestamptz',
      Ts: 'timestamptz',
      Doc: 'jsonb',
      Bin: 'bytea',
      Kind: 'text',
      Ref: 'bytea',
    });
    expect(info[0].AutoIncrement).to.equal(true);
    expect(info[0].PrimaryKey).to.equal(true);
  });

  it('creates IF NOT EXISTS without failing on an existing table', async () => {
    const create = () =>
      suite.driver.schema().createTable('pg_twice', (t) => {
        t.int('Id').primaryKey().autoIncrement();
        t.ifExists();
      });
    await create();
    await create();

    expect(await suite.driver.schema().tableExists('pg_twice')).to.equal(true);
  });

  it('enforces a unique index', async () => {
    await suite.driver.schema().createTable('pg_idx', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Email');
    });
    await suite.driver.index().unique().table('pg_idx').name('pg_idx_email').columns(['Email']);
    await suite.raw('INSERT INTO "pg_idx" ("Email") VALUES (?)', ['a']);

    expect(sqlState(await failure(suite.raw('INSERT INTO "pg_idx" ("Email") VALUES (?)', ['a'])))).to.equal('23505');
  });

  it('enforces a foreign key and cascades a delete', async () => {
    await suite.driver.schema().createTable('pg_fk_parent', (t) => {
      t.int('Id').primaryKey().autoIncrement();
    });
    await suite.driver.schema().createTable('pg_fk_child', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.int('parent_id');
      t.foreignKey('parent_id').references('pg_fk_parent', 'Id').cascade();
    });

    expect(sqlState(await failure(suite.raw('INSERT INTO "pg_fk_child" ("parent_id") VALUES (?)', [99])))).to.equal('23503');

    await suite.raw('INSERT INTO "pg_fk_parent" DEFAULT VALUES');
    await suite.raw('INSERT INTO "pg_fk_child" ("parent_id") VALUES (?)', [1]);
    await suite.raw('DELETE FROM "pg_fk_parent" WHERE "Id" = ?', [1]);

    expect(await suite.raw('SELECT * FROM "pg_fk_child"')).to.deep.equal([]);
  });

  it('adds, modifies, renames and drops columns', async () => {
    await suite.driver.schema().createTable('pg_alter', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Name', 20).notNull();
      t.int('Legacy');
      t.string('Gone');
    });

    await suite.driver.schema().alterTable('pg_alter', (t) => {
      t.string('Nick', 30).addColumn();
    });
    await suite.driver.schema().alterTable('pg_alter', (t) => {
      t.string('Name', 200).modify();
    });
    await suite.driver.schema().alterTable('pg_alter', (t) => {
      t.int('Legacy').rename('Score');
    });
    await suite.driver.schema().alterTable('pg_alter', (t) => {
      t.dropColumn('Gone');
    });

    const c = await columns('pg_alter');
    expect(Object.keys(c)).to.deep.equal(['Id', 'Name', 'Score', 'Nick']);
    // MODIFY semantics: an omitted NOT NULL is dropped
    expect(c.Name.Nullable).to.equal(true);
    const [len] = await suite.raw<{ n: number }[]>(`SELECT character_maximum_length AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = 'pg_alter' AND column_name = 'Name'`, [suite.schema]);
    expect(len.n).to.equal(200);
  });

  it('renames a table', async () => {
    await suite.driver.schema().createTable('pg_old_name', (t) => {
      t.int('Id').primaryKey().autoIncrement();
    });
    await suite.driver.schema().alterTable('pg_old_name', (t) => {
      t.rename('pg_new_name');
    });

    expect([await suite.driver.schema().tableExists('pg_old_name'), await suite.driver.schema().tableExists('pg_new_name')]).to.deep.equal([false, true]);
  });

  it('drops a table', async () => {
    await suite.driver.schema().createTable('pg_drop_me', (t) => {
      t.int('Id').primaryKey().autoIncrement();
    });
    await suite.driver.schema().dropTable('pg_drop_me');

    expect(await suite.driver.schema().tableExists('pg_drop_me')).to.equal(false);
  });

  it('creates a view that can be read', async () => {
    await suite.driver.schema().createView('pg_view_one', (v) => v.orReplace().as(new RawQuery('SELECT 1 AS one')));

    expect(await suite.raw('SELECT one FROM "pg_view_one"')).to.deep.equal([{ one: 1 }]);
  });

  it('refuses MySQL-only DDL before it reaches the server', async () => {
    const err = await failure(
      suite.driver.schema().createTable('pg_history', (t) => {
        t.int('Id').primaryKey().autoIncrement();
        t.trackHistory();
      }),
    );

    expect(err).to.be.instanceOf(Error);
    expect(await suite.driver.schema().tableExists('pg_history__history')).to.equal(false);
  });

  it('rolls a migration down and up again', async () => {
    expect(await suite.driver.schema().tableExists('pg_down_probe')).to.equal(true);

    await suite.orm.Migration.down('PgDownProbeMigration_2026_10_15_00_03_00');
    expect(await suite.driver.schema().tableExists('pg_down_probe')).to.equal(false);

    await suite.orm.Migration.up();
    expect(await suite.driver.schema().tableExists('pg_down_probe')).to.equal(true);
  });
});
