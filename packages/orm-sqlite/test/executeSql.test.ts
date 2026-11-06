import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { executeSql, sql } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';
import { bootUow, registerUowConnection, UowTag } from './uowFixture.js';

const expect = chai.expect;

describe('executeSql on sqlite', function () {
  this.timeout(10000);

  before(() => registerUowConnection());

  beforeEach(async () => {
    await bootUow();
  });

  afterEach(() => DI.clearCache());

  it('runs a typed fragment and returns plain rows', async () => {
    await UowTag.insert({ Name: 'red' });
    await UowTag.insert({ Name: 'blue' });

    const rows = await executeSql(sql<{ Name: string }>`SELECT Name FROM uow_tag WHERE Name = ${'red'}`, { connection: 'sqlite' });

    expect(rows).to.deep.equal([{ Name: 'red' }]);
  });

  it('binds a list as one placeholder per value', async () => {
    await UowTag.insert({ Name: 'red' });
    await UowTag.insert({ Name: 'blue' });

    const rows = await executeSql(sql<{ Name: string }>`SELECT Name FROM uow_tag WHERE Name IN (${['red', 'blue']}) ORDER BY Name`, { connection: 'sqlite' });

    expect(rows.map((r) => r.Name)).to.deep.equal(['blue', 'red']);
  });

  it('rejects a connection that does not exist', async () => {
    const err = await executeSql(sql`SELECT 1`, { connection: 'nope' }).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(InvalidOperation);
    expect((err as Error).message).to.equal('executeSql: connection nope does not exist');
  });
});
