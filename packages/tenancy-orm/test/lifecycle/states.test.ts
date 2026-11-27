import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DbTimeSource, SqlDbTimeSource } from '@spinajs/durable';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import type { TestApp } from '@spinajs/testing';
import { CachedTenantRegistry, TenantSwitchDenied, TenantUnavailable, admitTenant, runInTenant, tenantRegistry } from '@spinajs/tenancy';

import { TENANTS_TABLE, TenantLifecycle, TenantSeeder } from '../../src/index.js';
import { claimLifecycle } from '../../src/lifecycle/lease.js';
import { requireRow, tenancyDriver, writeLifecycle } from '../../src/lifecycle/record.js';
import { clearTenants, seedTenant } from '../support/tenants.js';
import { bootRowApp, seedLifecycle } from './support/app.js';
import { LcCustomer } from './support/models.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const HOUR = 3_600_000;

/** The database's clock, an hour behind the clock of this process. */
class HourBehind extends SqlDbTimeSource {
  public override async read(): Promise<number> {
    return (await super.read()) - HOUR;
  }
}

/** Holds the provisioning inside its seeder until `release()`. */
class Held extends TenantSeeder {
  public static hold: (() => Promise<void>) | undefined;
  public readonly name = 'held';

  public async seed(): Promise<void> {
    await Held.hold?.();
  }
}

function latch(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function rawLifecycle(id: string): Promise<unknown> {
  const rows: unknown = await (await tenancyDriver()).select().from(TENANTS_TABLE).columns(['lifecycle']).where('id', id);
  const first: unknown = Array.isArray(rows) ? rows[0] : undefined;
  return first !== null && typeof first === 'object' && 'lifecycle' in first ? first.lifecycle : undefined;
}

describe('suspending and resuming a tenant', function () {
  this.timeout(30_000);
  let app: TestApp;
  let lifecycle: TenantLifecycle;

  before(async () => {
    // The registry cache is on, as in production: what this process remembered must go at the suspension.
    app = await bootRowApp({ registryCacheMs: 60_000 }, (c) => {
      c.register(Held).as(TenantSeeder);
      c.register(HourBehind).as(DbTimeSource, { replace: true });
    });
    lifecycle = await app.resolve(TenantLifecycle);
  });

  after(async () => {
    await app?.dispose();
  });

  beforeEach(async () => {
    await clearTenants();
    await LcCustomer.destroy().where('Id', '>', 0).acrossTenants('test cleanup');
    (await tenantRegistry()).invalidate();
    Held.hold = undefined;
  });

  it('suspends with a reason in database time, refuses admission, and resumes', async () => {
    await seedTenant({ id: 'acme' });
    expect((await admitTenant('acme')).state).to.eq('active');
    await lifecycle.suspend('acme', ' unpaid invoice ');

    const row = await requireRow('acme');
    expect(row.state).to.eq('suspended');
    expect(row.suspensionRecord()?.reason).to.eq('unpaid invoice');
    expect(Date.parse(row.suspensionRecord()?.at ?? '')).to.be.closeTo(Date.now() - HOUR, 60_000);
    await expect(admitTenant('acme')).to.be.rejectedWith(TenantUnavailable, 'tenant "acme" is suspended');

    await lifecycle.resume('acme');
    expect((await requireRow('acme')).suspensionRecord()).to.eq(undefined);
    expect((await admitTenant('acme')).state).to.eq('active');
  });

  it('suspends while another operation holds the tenant, and leaves what that operation wrote as it was', async () => {
    await seedTenant({ id: 'acme' });
    const lease = await claimLifecycle('acme', () => Date.now());
    await writeLifecycle('acme', { migrated: ['Docs_2026_12_01_00_00_01'], exports: [{ fs: 'exports', path: 'acme-final', at: '2026-12-01T00:00:00.000Z' }] }, lease.fence);
    const before = await rawLifecycle('acme');

    await lifecycle.suspend('acme', 'unpaid');
    expect(await rawLifecycle('acme')).to.deep.eq(before);
    await lifecycle.resume('acme');
    expect(await rawLifecycle('acme')).to.deep.eq(before);

    await writeLifecycle('acme', { ...(await requireRow('acme')).lifecycleRecord(), migrated: ['Docs_2026_12_01_00_00_01', 'Docs_2026_12_05_00_00_00'] }, lease.fence);
    await lease.release();
    expect((await requireRow('acme')).lifecycleRecord().exports).to.have.length(1);
  });

  it('refuses a suspension without a reason, a second one, a resume of a tenant that is not suspended, and a tenant scope', async () => {
    await seedTenant({ id: 'acme' });
    await seedTenant({ id: 'fresh', state: 'provisioning' });
    await expect(lifecycle.suspend('acme', '  ')).to.be.rejectedWith(InvalidArgument, 'suspend needs a reason');
    await expect(lifecycle.suspend('fresh', 'x')).to.be.rejectedWith(InvalidOperation, 'cannot go from provisioning to suspended');
    await expect(lifecycle.resume('acme')).to.be.rejectedWith(InvalidOperation, 'tenant "acme" is active; only a suspended tenant resumes');
    await expect(lifecycle.resume('fresh')).to.be.rejectedWith(InvalidOperation, 'tenant "fresh" is provisioning; only a suspended tenant resumes');

    await lifecycle.suspend('acme', 'first');
    await expect(lifecycle.suspend('acme', 'second')).to.be.rejectedWith(InvalidOperation, 'tenant "acme" is already suspended');
    expect((await requireRow('acme')).suspensionRecord()?.reason).to.eq('first');
    await expect(runInTenant('acme', () => lifecycle.resume('acme'))).to.be.rejectedWith(TenantSwitchDenied, 'resume acts on the tenant it names');
  });

  it('suspends a tenant once when two calls suspend it at once, and tells the other one', async () => {
    await seedTenant({ id: 'acme' });
    const both = await Promise.allSettled([lifecycle.suspend('acme', 'by one'), lifecycle.suspend('acme', 'by two')]);
    expect(both.map((r) => r.status).sort()).to.deep.eq(['fulfilled', 'rejected']);
    const lost = both.find((r) => r.status === 'rejected');
    expect(lost?.status === 'rejected' ? lost.reason : undefined).to.be.instanceOf(InvalidOperation).with.property('message').that.contains('tenant "acme" is already suspended');
    expect((await requireRow('acme')).suspensionRecord()?.reason).to.eq(both[0].status === 'fulfilled' ? 'by one' : 'by two');

    const resumed = await Promise.allSettled([lifecycle.resume('acme'), lifecycle.resume('acme')]);
    expect(resumed.map((r) => r.status).sort()).to.deep.eq(['fulfilled', 'rejected']);
    expect((await requireRow('acme')).state).to.eq('active');
  });

  it('refuses to suspend a tenant that is being provisioned, and lets the provisioning finish', async () => {
    const started = latch();
    const release = latch();
    Held.hold = async () => {
      started.open();
      await release.promise;
    };
    const provisioning = lifecycle.provision({ id: 'acme', slug: 'acme', name: 'Acme' });
    await started.promise;

    await expect(lifecycle.suspend('acme', 'too early')).to.be.rejectedWith(InvalidOperation, 'tenant "acme" cannot go from provisioning to suspended');
    release.open();
    expect((await provisioning).state).to.eq('active');
    expect((await requireRow('acme')).suspensionRecord()).to.eq(undefined);
  });

  it('never resumes a tenant whose deletion started', async () => {
    await seedTenant({ id: 'gone', state: 'deleting' });
    await seedTenant({ id: 'closing', state: 'suspended' });
    await seedLifecycle('closing', { operation: { kind: 'delete', done: [], startedAt: '2026-12-01T00:00:00.000Z', reason: 'contract ended' } });

    await expect(lifecycle.resume('gone')).to.be.rejectedWith(InvalidOperation, 'tenant "gone" is deleting; only a suspended tenant resumes');
    await expect(lifecycle.resume('closing')).to.be.rejectedWith(InvalidOperation, 'the deletion of tenant "closing" started at 2026-12-01T00:00:00.000Z');
    expect((await requireRow('gone')).state).to.eq('deleting');
    expect((await requireRow('closing')).state).to.eq('suspended');
    await expect(admitTenant('closing')).to.be.rejectedWith(TenantUnavailable, 'is suspended');
  });

  it('writes the state and its reason in one statement, and a repeated suspension announces what a dead process did not', async () => {
    await seedTenant({ id: 'acme' });
    expect((await admitTenant('acme')).state).to.eq('active');
    // What a process that died right after its write leaves: the row moved, no cache was told.
    expect(await (await requireRow('acme')).writeSuspension('suspended', { reason: 'unpaid', at: '2026-12-01T00:00:00.000Z' })).to.eq(true);
    expect((await admitTenant('acme')).state).to.eq('active');

    await expect(lifecycle.suspend('acme', 'unpaid')).to.be.rejectedWith(InvalidOperation, 'tenant "acme" is already suspended');
    await expect(admitTenant('acme')).to.be.rejectedWith(TenantUnavailable, 'tenant "acme" is suspended');
    expect((await requireRow('acme')).suspensionRecord()).to.deep.eq({ reason: 'unpaid', at: '2026-12-01T00:00:00.000Z' });
  });

  const illegal = [
    { to: 'suspended', from: ['provisioning', 'suspended', 'deleting', 'deleted'] },
    { to: 'active', from: ['provisioning', 'active', 'deleting', 'deleted'] },
  ] as const;
  for (const { to, from } of illegal) {
    for (const state of from) {
      it(`refuses through the model to move a tenant from ${state} to ${to}, and leaves its row as it was`, async () => {
        await seedTenant({ id: 'acme', state });
        const row = await requireRow('acme');
        const suspension = to === 'suspended' ? { reason: 'unpaid', at: '2026-12-01T00:00:00.000Z' } : null;

        expect(await row.writeSuspension(to, suspension)).to.eq(false);
        expect(row.state).to.eq(state);
        const after = await requireRow('acme');
        expect(after.state).to.eq(state);
        expect(after.suspensionRecord()).to.eq(undefined);
      });
    }
  }

  it('lets a request admitted before the suspension run to its end, and admits no new one', async () => {
    await seedTenant({ id: 'acme' });
    const inside = latch();
    const go = latch();
    const admitted = await admitTenant('acme');
    const request = runInTenant(admitted.id, async () => {
      await LcCustomer.insert({ name: 'before' });
      inside.open();
      await go.promise;
      await LcCustomer.insert({ name: 'after' });
      return (await LcCustomer.all()).length;
    });
    await inside.promise;

    await lifecycle.suspend('acme', 'unpaid');
    await expect(admitTenant('acme')).to.be.rejectedWith(TenantUnavailable, 'tenant "acme" is suspended');
    go.open();
    expect(await request).to.eq(2);
  });

  it('is refused by another process once its registry cache entry expires', async () => {
    await seedTenant({ id: 'acme' });
    let clock = 0;
    const other = new CachedTenantRegistry((await tenantRegistry()).inner, () => 5000, () => clock);
    expect((await other.get('acme'))?.state).to.eq('active');

    await lifecycle.suspend('acme', 'unpaid');
    await expect(admitTenant('acme')).to.be.rejectedWith(TenantUnavailable, 'is suspended');
    clock = 4999;
    expect((await other.get('acme'))?.state).to.eq('active');
    clock = 5000;
    expect((await other.get('acme'))?.state).to.eq('suspended');
  });
});
