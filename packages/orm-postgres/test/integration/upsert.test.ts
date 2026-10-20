/* eslint-disable @typescript-eslint/no-explicit-any */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { InsertBehaviour } from '@spinajs/orm';

import './migrations/PgTypesMigration_2026_10_15_00_02_00.js';
import { IPgSuite, openSuite } from './harness.js';
import { PgAccount, PgSetting } from './models/types.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

describe('postgres integration - upserts', function () {
  let suite: IPgSuite;

  const accounts = () => suite.raw<{ Email: string; Name: string }[]>('SELECT "Email", "Name" FROM "pg_account" ORDER BY "Email"');

  before(async function () {
    suite = await openSuite(this, { name: 'upsert' });
  });

  beforeEach(async () => {
    await suite.reset('pg_account', 'pg_setting');
  });

  after(async () => {
    await suite?.close();
  });

  it('upserts on an explicit conflict column and returns the row', async () => {
    await suite.driver.insert().into('pg_account').values({ Email: 'a@x.io', Name: 'A' }).onDuplicate('Email').update(['Name']);
    const second = (await suite.driver.insert().into('pg_account').values({ Email: 'a@x.io', Name: 'A2' }).onDuplicate('Email').update(['Name'])) as any;

    expect(second.Returning.map((r: { Name: string }) => r.Name)).to.deep.equal(['A2']);
    expect(await accounts()).to.deep.equal([{ Email: 'a@x.io', Name: 'A2' }]);
  });

  it('applies each row its own values in a multi-row upsert', async () => {
    const rows = [
      { Email: 'a@x.io', Name: '1' },
      { Email: 'b@x.io', Name: '2' },
    ];
    await suite.driver.insert().into('pg_account').values(rows).onDuplicate('Email').update(['Name']);
    await suite.driver
      .insert()
      .into('pg_account')
      .values(rows.map((r) => ({ ...r, Name: `${r.Name}!` })))
      .onDuplicate('Email')
      .update(['Name']);

    expect((await accounts()).map((r) => r.Name)).to.deep.equal(['1!', '2!']);
  });

  it('skips a conflicting row with insert-or-ignore', async () => {
    await suite.driver.insert().into('pg_account').values({ Email: 'a@x.io', Name: 'A' });
    const result = (await suite.driver.insert().into('pg_account').values({ Email: 'a@x.io', Name: 'B' }).orIgnore()) as any;

    expect(result.RowsAffected).to.equal(0);
    expect(await accounts()).to.deep.equal([{ Email: 'a@x.io', Name: 'A' }]);
  });

  it('upserts a model with an assigned key', async () => {
    await new PgSetting({ Name: 'k', Value: '1' }).insert(InsertBehaviour.InsertOrUpdate);
    await new PgSetting({ Name: 'k', Value: '2' }).insert(InsertBehaviour.InsertOrUpdate);

    expect((await PgSetting.all()).map((s) => [s.Name, s.Value])).to.deep.equal([['k', '2']]);
  });

  it('upserts a model by its unique business key and learns the row key', async () => {
    const first = new PgAccount({ Email: 'm@x.io', Name: 'M' });
    await first.insert(InsertBehaviour.InsertOrUpdate);
    const second = new PgAccount({ Email: 'm@x.io', Name: 'M2' });
    await second.insert(InsertBehaviour.InsertOrUpdate);

    expect(first.Id).to.equal(1);
    expect(second.Id).to.equal(1);
    expect(await accounts()).to.deep.equal([{ Email: 'm@x.io', Name: 'M2' }]);
  });

  it('ignores a duplicate model with InsertOrIgnore', async () => {
    await new PgAccount({ Email: 'i@x.io', Name: 'I' }).insert(InsertBehaviour.InsertOrIgnore);
    await new PgAccount({ Email: 'i@x.io', Name: 'I2' }).insert(InsertBehaviour.InsertOrIgnore);

    expect(await accounts()).to.deep.equal([{ Email: 'i@x.io', Name: 'I' }]);
  });
});
