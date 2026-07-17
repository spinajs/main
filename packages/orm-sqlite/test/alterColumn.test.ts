/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-floating-promises */
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver, SqliteColumnCompiler, SqliteAlterColumnQueryCompiler } from './../src/index.js';
import { Bootstrapper, DI } from '@spinajs/di';
import { Orm, ICompilerOutput, ColumnQueryCompiler, AlterColumnQueryCompiler, AlterColumnQueryBuilder, OrmDriver, ColumnType } from '@spinajs/orm';
import * as chai from 'chai';
import * as sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import '@spinajs/log';
import { ConnectionConf, db } from './common.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

function connection(): OrmDriver {
  return db().Connections.get('sqlite')!;
}

/**
 * Schema query builder bound to the REAL sqlite connection's container - not a
 * fake driver registering orm-sql's compilers (the mistake in orm-sql's suite).
 * `resolves the driver's own column compiler` below asserts exactly that.
 */
function schqb() {
  return connection().schema();
}

describe('Sqlite alter column', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Orm);
    await db().migrateUp();
    await db().reloadTableInfo();

    await connection().schema().createTable('alter_test', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Status').notNull();
    });
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('resolves the drivers own column compiler, not orm-sqls', () => {
    // guards against the orm-sql suite's mistake: asserting MySQL output under a
    // sqlite label because the container held orm-sql's compilers all along
    const builder = new AlterColumnQueryBuilder(connection().Container as any, 'Status', ColumnType.ENUM, ['a', 'b', 'c']);
    const compiler = connection().Container.resolve<ColumnQueryCompiler>(ColumnQueryCompiler, [builder]);

    expect(compiler).to.be.instanceOf(SqliteColumnCompiler);
  });

  it('add column renders the sqlite column body, not mysql', () => {
    // behavioural proof of the same thing: mysql renders enum as ENUM('a','b','c'),
    // sqlite as unconstrained TEXT
    const result = schqb()
      .alterTable('alter_test', (table) => {
        table.enum('NewStatus', ['a', 'b', 'c']);
      })
      .toDB() as ICompilerOutput[];

    expect(result).to.have.lengthOf(1);
    expect(result[0].expression).to.match(/TEXT/);
    expect(result[0].expression).to.not.match(/ENUM/i);
  });

  it('modify column should be a no-op on sqlite', () => {
    // sqlite renders enum as unconstrained TEXT and cannot MODIFY a column type;
    // the alter must emit nothing rather than invalid SQL
    const result = schqb()
      .alterTable('alter_test', (table) => {
        // note: `.default().value()` returns the column builder, so `.modify()`
        // cannot be chained off it - it must be called on the column itself
        const c = table.enum('Status', ['a', 'b', 'c']).notNull();
        c.default().value('a');
        c.modify();
      })
      .toDB() as ICompilerOutput[];

    expect(result.filter((r) => /MODIFY/i.test(r.expression as string))).to.be.empty;
    // returning null from _modify must drop the statement entirely - emitting it
    // would leave a dangling `ALTER TABLE \`alter_test\``
    expect(result).to.be.empty;
  });

  it('widening the queue Status enum is a no-op on sqlite (queue migration)', () => {
    // Mirrors @spinajs/queue's Queue_2026_07_17_00_00_00 migration exactly - it
    // replicates the SAME alterTable(...) builder call the migration emits and
    // compiles THAT (not the migration's up(), which needs a live DB). sqlite
    // renders enum as unconstrained TEXT and cannot MODIFY, so widening to the six
    // states must emit nothing rather than invalid SQL.
    const result = schqb()
      .alterTable('queue_jobs', (table) => {
        const c = table.enum('Status', ['error', 'success', 'created', 'executing', 'retrying', 'dead']).notNull();
        c.default().value('created');
        c.modify();
      })
      .toDB() as ICompilerOutput[];

    expect(result).to.be.empty;
  });

  it('modify column warns, naming the column and what was skipped', () => {
    // the no-op is only defensible if it is loud: a silently skipped NOT NULL /
    // DEFAULT change would be a data-integrity surprise
    const builder = new AlterColumnQueryBuilder(connection().Container as any, 'Status', ColumnType.ENUM, ['a', 'b', 'c']);
    builder.modify();

    const compiler = connection().Container.resolve(AlterColumnQueryCompiler, [builder]) as unknown as SqliteAlterColumnQueryCompiler;
    const spy = sinon.spy((compiler as any).Log, 'warn');

    const output = compiler.compile();

    expect(output.expression).to.eq('');
    expect(spy.calledOnce).to.be.true;
    expect(spy.firstCall.args[0]).to.match(/Status/);
    expect(spy.firstCall.args[0]).to.match(/NOT NULL/i);
  });

  it('add column should not emit MySQL AFTER clause on sqlite', () => {
    const result = schqb()
      .alterTable('alter_test', (table) => {
        table.int('NewCol').after('Id');
      })
      .toDB() as ICompilerOutput[];

    expect(result.every((r) => !/AFTER/i.test(r.expression as string))).to.be.true;
  });

  it('modify column should not throw against real sqlite', async () => {
    // exercise the real driver end-to-end, not just the compiler
    await expect(
      connection().schema().alterTable('alter_test', (table) => {
        const c = table.enum('Status', ['a', 'b', 'c']).notNull();
        c.default().value('a');
        c.modify();
      }),
    ).to.be.fulfilled;

    // the table must still be usable afterwards
    await connection().insert().into('alter_test').values({ Status: 'a' });
  });

  it('add int column should work against real sqlite (production migration case)', async () => {
    // @spinajs/queue's Queue_2026_06_30_00_00_00 migration adds an int column -
    // this is the one alter operation with a real production caller
    await expect(
      connection().schema().alterTable('alter_test', (table) => {
        table.int('Counter');
      }),
    ).to.be.fulfilled;

    await connection().insert().into('alter_test').values({ Status: 'a', Counter: 5 });
    const rows = (await connection().select().from('alter_test')) as any[];
    expect(rows[0].Counter).to.eq(5);
  });

  it('add boolean column should work against a table that already has rows', async () => {
    // THE TRAP: CREATE TABLE bakes an unconditional NOT NULL into a boolean body.
    // sqlite refuses to ADD a NOT NULL column without a non-null default, so this
    // fails once the table holds data - an empty table hides the bug entirely.
    await connection().insert().into('alter_test').values({ Status: 'a' });

    await expect(
      connection().schema().alterTable('alter_test', (table) => {
        table.boolean('IsActive');
      }),
    ).to.be.fulfilled;
  });

  it('add boolean column keeps enforcing the 0/1 domain', async () => {
    // dropping NOT NULL from the add path must not cost us the CHECK constraint
    await connection().schema().alterTable('alter_test', (table) => {
      table.boolean('IsActive');
    });

    await expect(connection().insert().into('alter_test').values({ Status: 'a', IsActive: 7 })).to.be.rejected;
    await expect(connection().insert().into('alter_test').values({ Status: 'a', IsActive: 1 })).to.be.fulfilled;
  });

  it('add primary key column still surfaces sqlites own error', async () => {
    // sqlite cannot add a PRIMARY KEY / UNIQUE column at all - it rejects the mysql
    // spelling (`INT PRIMARY KEY AUTO_INCREMENT`) just as it rejects the sqlite one,
    // so this is not a dialect bug and predates the alter-path fix. We deliberately
    // do NOT strip the clause: that would silently create a column lacking the
    // constraint the caller asked for. Let the driver's error speak instead.
    await expect(
      connection().schema().alterTable('alter_test', (table) => {
        table.int('OtherId').primaryKey().autoIncrement();
      }),
    ).to.be.rejected;
  });

  it('add boolean column honours an explicit notNull + default', async () => {
    await connection().insert().into('alter_test').values({ Status: 'a' });

    await expect(
      connection().schema().alterTable('alter_test', (table) => {
        const c = table.boolean('IsActive').notNull();
        c.default().value(0);
      }),
    ).to.be.fulfilled;
  });
});
