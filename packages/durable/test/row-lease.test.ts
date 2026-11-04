import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import { RowLease, RowLeaseTarget } from '../src/index.js';
import { bootDb, RawDriver } from './support/env.js';
import { describeRowLease, LeaseRow, LEASE_TABLE } from './support/row-lease-cases.js';

async function createTable(driver: RawDriver) {
  await driver.executeOnDb(`CREATE TABLE ${LEASE_TABLE} (Id TEXT PRIMARY KEY, Status TEXT, ClaimedBy TEXT, ClaimedUntil BIGINT, ClaimEpoch INTEGER NOT NULL DEFAULT 0)`, [], QueryContext.Schema);
}

describe('RowLease (sqlite)', () => {
  after(() => DI.dispose());

  describeRowLease(async () => {
    const driver = await bootDb();
    await createTable(driver);
    return driver;
  });

  it('takes custom column names', async () => {
    const driver = await bootDb();
    await driver.executeOnDb('CREATE TABLE custom_lease (Name TEXT PRIMARY KEY, Owner TEXT, Until BIGINT, Fence INTEGER NOT NULL DEFAULT 0)', [], QueryContext.Schema);
    await driver.insert().into('custom_lease').values({ Name: 'n1' });
    const lease = new RowLease(driver, { owner: 'Owner', until: 'Until', epoch: 'Fence' });
    const target: RowLeaseTarget = { table: 'custom_lease', key: { Name: 'n1' } };
    expect(await lease.claim(target, 'a', 1000, 0)).to.deep.eq({ epoch: 1 });
    expect(lease.fenced(target, 'a', 1)).to.deep.eq({ Name: 'n1', Owner: 'a', Fence: 1 });
    const rows = (await driver.select().from('custom_lease').where({ Name: 'n1' })) as Array<Record<string, unknown>>;
    expect(rows[0]).to.include({ Owner: 'a', Until: 1000, Fence: 1 });
  });

  it('claims inside an open transaction', async () => {
    const driver = await bootDb();
    await createTable(driver);
    await driver.insert().into(LEASE_TABLE).values({ Id: 'tx' });
    const lease = new RowLease(driver);
    const claim = await driver.transaction(() => lease.claim({ table: LEASE_TABLE, key: { Id: 'tx' } }, 'a', 1000, 0));
    expect(claim).to.deep.eq({ epoch: 1 });
    const rows = (await driver.select().from(LEASE_TABLE).where({ Id: 'tx' })) as LeaseRow[];
    expect(rows[0].ClaimedBy).to.eq('a');
  });
});
