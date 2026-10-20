/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { ResourceDuplicated } from '@spinajs/exceptions';
import { Connection, ConstraintViolation, Model, ModelBase, Primary, UniqueViolation } from '@spinajs/orm';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

@Connection('pg')
@Model('pg_gap_unique')
class PgGapUnique extends ModelBase {
  @Primary()
  public Id: number;

  public Email: string;
}

async function failure(work: PromiseLike<unknown>): Promise<any> {
  try {
    await work;
  } catch (err) {
    return err;
  }

  throw new Error('expected the statement to fail');
}

describe('postgres constraint errors (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('constraint_errors');
    await pgdb.driver.schema().createTable('pg_gap_unique', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Email').notNull().unique();
    });
    await pgdb.orm.reloadTableInfo();
  });

  beforeEach(async () => {
    await pgdb!.driver.truncate('pg_gap_unique');
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('maps a duplicate primary key on a plain insert to UniqueViolation', async () => {
    await pgdb!.driver.insert().into('pg_gap_unique').values({ Id: 1, Email: 'a@x' });
    const err = await failure(pgdb!.driver.insert().into('pg_gap_unique').values({ Id: 1, Email: 'b@x' }));

    expect(err).to.be.instanceOf(UniqueViolation);
    expect(err).to.be.instanceOf(ResourceDuplicated);
    expect(err.table).to.eq('pg_gap_unique');
    expect(err.columns).to.deep.eq(['Id']);
    expect(err.inner.code).to.eq('23505');
  });

  it('maps a duplicate on the RETURNING path of Model.insert to UniqueViolation', async () => {
    await PgGapUnique.insert({ Email: 'a@x' });
    const err = await failure(PgGapUnique.insert({ Email: 'a@x' }));

    expect(err).to.be.instanceOf(UniqueViolation);
    expect(err.columns).to.deep.eq(['Email']);
  });

  it('maps NOT NULL to ConstraintViolation', async () => {
    const err = await failure(pgdb!.driver.insert().into('pg_gap_unique').values({ Id: 1, Email: null }));

    expect(err).to.be.instanceOf(ConstraintViolation);
    expect(err).to.not.be.instanceOf(ResourceDuplicated);
    expect(err.kind).to.eq('not_null');
    expect(err.columns).to.deep.eq(['Email']);
    expect(err.inner.code).to.eq('23502');
  });
});
