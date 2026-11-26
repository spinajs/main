import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ConcurrencyConflict, InvalidOperation } from '@spinajs/exceptions';
import type { TestApp } from '@spinajs/testing';

import { LIFECYCLE_LEASE_MS, TENANTS_TABLE } from '../../src/index.js';
import { claimLifecycle } from '../../src/lifecycle/lease.js';
import { requireRow, tenancyDriver, writeLifecycle } from '../../src/lifecycle/record.js';
import { clearTenants, seedTenant } from '../support/tenants.js';
import { bootRowApp, leaseColumns } from './support/app.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

describe('tenant lifecycle record and lease', function () {
  this.timeout(30_000);
  let app: TestApp;

  before(async () => {
    app = await bootRowApp();
  });

  after(async () => {
    await app?.dispose();
  });

  beforeEach(async () => {
    await clearTenants();
  });

  it('adds the lifecycle columns, empty for a tenant written without them', async () => {
    await seedTenant({ id: 't1' });
    expect((await requireRow('t1')).lifecycleRecord()).to.deep.eq({});
    expect((await requireRow('t1')).suspensionRecord()).to.eq(undefined);
    expect(await leaseColumns('t1')).to.deep.eq({ lifecycle_owner: null, lifecycle_until: null, lifecycle_epoch: 0, suspension: null });
  });

  it('reads back what it wrote under the lease and refuses a record it cannot read', async () => {
    await seedTenant({ id: 't1' });
    const state = { operation: { kind: 'provision' as const, done: ['record'], startedAt: '2026-12-01T00:00:00.000Z' }, migrated: ['Docs_2026_12_01_00_00_01'], bridges: ['@spinajs/tenancy-orm/teams'] };
    const lease = await claimLifecycle('t1', () => Date.now());
    await writeLifecycle('t1', state, lease.fence);
    await lease.release();
    expect((await requireRow('t1')).lifecycleRecord()).to.deep.eq(state);

    await (await tenancyDriver()).update().in(TENANTS_TABLE).update({ lifecycle: '{"operation":{"kind":"merge","done":[]}}' }).where('id', 't1');
    const row = await requireRow('t1');
    expect(() => row.lifecycleRecord()).to.throw(InvalidOperation, 'tenancy-orm: tenant "t1" has an unreadable lifecycle record');

    await (await tenancyDriver()).update().in(TENANTS_TABLE).update({ suspension: '{"reason":7}' }).where('id', 't1');
    const suspended = await requireRow('t1');
    expect(() => suspended.suspensionRecord()).to.throw(InvalidOperation, 'tenancy-orm: tenant "t1" has an unreadable suspension record');
  });

  it('lets one operation hold a tenant, and frees it when released or expired', async () => {
    await seedTenant({ id: 't1' });
    const start = Date.now();
    const first = await claimLifecycle('t1', () => start);
    await expect(claimLifecycle('t1', () => start + 1000)).to.be.rejectedWith(ConcurrencyConflict, 'another lifecycle operation holds tenant "t1"');
    await first.release();

    const second = await claimLifecycle('t1', () => start + 2000);
    await expect(claimLifecycle('t1', () => start + 2000 + LIFECYCLE_LEASE_MS)).to.be.rejectedWith(ConcurrencyConflict, 'another lifecycle operation holds tenant "t1"');
    const late = await claimLifecycle('t1', () => start + 2000 + LIFECYCLE_LEASE_MS + 1);
    await expect(writeLifecycle('t1', {}, second.fence)).to.be.rejectedWith(ConcurrencyConflict, 'was taken over by another lifecycle operation');
    await expect(second.renew()).to.be.rejectedWith(ConcurrencyConflict, 'lost its hold on the tenant');
    await second.release();
    expect((await leaseColumns('t1')).lifecycle_owner).to.be.a('string');
    await writeLifecycle('t1', { migrated: [] }, late.fence);
    await late.release();
    expect(await leaseColumns('t1')).to.include({ lifecycle_owner: null, lifecycle_until: null });
  });

  it('gives the tenant to exactly one of two operations that take it at once, and a renewal moves the expiry', async () => {
    await seedTenant({ id: 't1' });
    let clock = Date.now();
    const taken = await Promise.allSettled([claimLifecycle('t1', () => clock), claimLifecycle('t1', () => clock)]);
    expect(taken.map((t) => t.status).sort()).to.deep.eq(['fulfilled', 'rejected']);
    const winner = taken.find((t) => t.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('no winner');

    clock += LIFECYCLE_LEASE_MS - 1;
    await winner.value.renew();
    await expect(claimLifecycle('t1', () => clock + 2)).to.be.rejectedWith(ConcurrencyConflict, 'another lifecycle operation holds tenant "t1"');
    await winner.value.release();
  });
});
