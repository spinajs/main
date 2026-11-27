import 'mocha';
import * as chai from 'chai';
import { DateTime } from 'luxon';
import { Orm, RawQuery } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import type { TestApp } from '@spinajs/testing';
import { bootApp } from './support/app.js';
import { Memo } from './support/models.js';
import { everywhere, inTenant } from './support/scope.js';

const expect = chai.expect;

const titles = (rows: readonly Memo[]): string[] => rows.map((row) => row.title).sort();

// Per tenant: a live, b soft-deleted, c archived.
describe('TenantScopeMiddleware on a soft-delete and archive model', function () {
  this.timeout(30_000);

  let app: TestApp;
  let driver: OrmDriver;

  before(async () => {
    app = await bootApp();
    const connection = (await app.resolve(Orm)).Connections.get('default');
    if (!connection) throw new Error('no default connection');
    driver = connection;
  });

  after(async () => {
    await app?.dispose();
  });

  beforeEach(async () => {
    const stamp = DateTime.utc().toISO();
    await everywhere(async () => {
      await driver.del().from('memo').where(true);
      for (const tenant of ['t1', 't2']) {
        await driver
          .insert()
          .into('memo')
          .values([
            { tenant_id: tenant, title: `${tenant}-a`, DeletedAt: null, ArchivedAt: null },
            { tenant_id: tenant, title: `${tenant}-b`, DeletedAt: stamp, ArchivedAt: null },
            { tenant_id: tenant, title: `${tenant}-c`, DeletedAt: null, ArchivedAt: stamp },
          ]);
      }
    });
  });

  it('an orWhere returns neither another tenant nor a deleted or archived row', async () => {
    const query = () => Memo.where('title', 't1-a').orWhere('title', 't1-b').orWhere('title', 't2-a').orWhere('title', 't2-c');
    expect(titles(await inTenant('t1', query))).to.deep.eq(['t1-a']);
    expect(titles(await inTenant('t2', query))).to.deep.eq(['t2-a']);
  });

  it('a raw OR 1 = 1 returns only the live rows of the tenant', async () => {
    expect(titles(await inTenant('t1', () => Memo.where(RawQuery.create('1 = 0 OR 1 = 1'))))).to.deep.eq(['t1-a']);
    expect(titles(await inTenant('t2', () => Memo.where(RawQuery.create('1 = 0 OR 1 = 1'))))).to.deep.eq(['t2-a']);
  });

  it('withDeleted() lets the deleted rows of the tenant in, still none of another tenant', async () => {
    expect(titles(await inTenant('t1', () => Memo.query().withDeleted().where('title', 't1-b').orWhere('title', 't2-b').orWhere('title', 't1-c')))).to.deep.eq(['t1-b']);
    expect(titles(await everywhere(() => Memo.query().withDeleted().withArchived()))).to.have.length(6);
  });
});
