import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';
import { RowLease, RowLeaseTarget } from '../src/index.js';
import { bootDb } from './support/env.js';
import { describeRowLease, LeaseRow, LEASE_TABLE } from './support/row-lease-cases.js';

async function createTable(driver: OrmDriver) {
  await driver.schema().createTable(LEASE_TABLE, (t) => {
    t.text('Id').primaryKey();
    t.text('Status');
    t.text('ClaimedBy');
    t.bigint('ClaimedUntil');
    t.int('ClaimEpoch').notNull().default().value(0);
  });
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
    await driver.schema().createTable('custom_lease', (t) => {
      t.text('Name').primaryKey();
      t.text('Owner');
      t.bigint('Until');
      t.int('Fence').notNull().default().value(0);
    });
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
