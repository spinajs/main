import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ConcurrencyConflict, InvalidArgument, InvalidOperation, NotSupported, ResourceDuplicated } from '@spinajs/exceptions';
import type { TestApp } from '@spinajs/testing';
import { TenantSwitchDenied, currentTenant, runInTenant, tenantRegistry } from '@spinajs/tenancy';

import { DefaultTenantLifecycle, LIFECYCLE_LEASE_MS, TenantLifecycle, TenantSeeder } from '../../src/index.js';
import { claimLifecycle } from '../../src/lifecycle/lease.js';
import type { LifecycleLease } from '../../src/lifecycle/lease.js';
import { requireRow } from '../../src/lifecycle/record.js';
import { clearTenants, seedTenant } from '../support/tenants.js';
import { bootRowApp, leaseColumns, seedLifecycle } from './support/app.js';
import { LcCustomer } from './support/models.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const ran: string[] = [];

class Customers extends TenantSeeder {
  public readonly name = 'customers';
  public override readonly order = 1;

  public async seed(): Promise<void> {
    ran.push(`${this.name}@${currentTenant()?.id ?? '-'}`);
    await LcCustomer.insert({ name: 'first' });
  }
}

class Flaky extends TenantSeeder {
  public static failures = 0;
  /** Runs inside the seed: what another process does meanwhile. */
  public static during: (() => Promise<void>) | undefined;
  public readonly name = 'flaky';
  public override readonly order = 2;

  public async seed(): Promise<void> {
    ran.push(`${this.name}@${currentTenant()?.id ?? '-'}`);
    await Flaky.during?.();
    if (Flaky.failures === 0) return;
    Flaky.failures -= 1;
    throw new Error('the seed failed');
  }
}

// Same order as Flaky and registered after it: the name decides.
class Audit extends TenantSeeder {
  public readonly name = 'audit';
  public override readonly order = 2;

  public seed(): Promise<void> {
    ran.push(`${this.name}@${currentTenant()?.id ?? '-'}`);
    return Promise.resolve();
  }
}

class Later extends DefaultTenantLifecycle {
  protected override now(): number {
    return Date.now() + LIFECYCLE_LEASE_MS + 60_000;
  }
}

/** Another process finishes the provisioning after this one checked the row and before it takes the lease. */
class Overtaken extends DefaultTenantLifecycle {
  protected override async leased<T>(id: string, fn: (lease: LifecycleLease) => Promise<T>): Promise<T> {
    await new DefaultTenantLifecycle().provision(ACME);
    ran.length = 0;
    return super.leased(id, fn);
  }
}

const ACME = { id: 'acme', slug: 'acme', name: 'Acme Ltd', domains: ['ACME.example ', 'acme.example'] };
const customers = (): Promise<number> => runInTenant('acme', async () => (await LcCustomer.all()).length);

describe('provisioning a row-mode tenant', function () {
  this.timeout(30_000);
  let app: TestApp;
  let lifecycle: TenantLifecycle;

  before(async () => {
    app = await bootRowApp({}, (c) => {
      c.register(Flaky).as(TenantSeeder);
      c.register(Audit).as(TenantSeeder);
      c.register(Customers).as(TenantSeeder);
    });
    lifecycle = await app.resolve(TenantLifecycle);
  });

  after(async () => {
    await app?.dispose();
  });

  beforeEach(async () => {
    await clearTenants();
    await LcCustomer.destroy().where('Id', '>', 0).acrossTenants('test cleanup');
    ran.length = 0;
    Flaky.failures = 0;
    Flaky.during = undefined;
  });

  it('writes the row, runs the seeders inside the tenant by order and name, then makes it active', async () => {
    const acme = await lifecycle.provision(ACME);

    expect(acme).to.deep.eq({ id: 'acme', slug: 'acme', name: 'Acme Ltd', state: 'active', domains: ['acme.example'], settings: {} });
    expect(ran).to.deep.eq(['customers@acme', 'audit@acme', 'flaky@acme']);
    expect((await runInTenant('acme', async () => await LcCustomer.all())).map((c) => c.tenant_id)).to.deep.eq(['acme']);
    expect((await requireRow('acme')).lifecycleRecord()).to.deep.eq({});
    expect((await (await tenantRegistry()).find({ domain: 'acme.example' }))?.id).to.eq('acme');
  });

  it('leaves a failed provisioning inactive and free, names the seeder, and does not run the finished seeders again', async () => {
    Flaky.failures = 1;
    await expect(lifecycle.provision(ACME)).to.be.rejectedWith(InvalidOperation, 'the tenant seeder "flaky" failed for tenant "acme": the seed failed');

    const half = await requireRow('acme');
    expect(half.state).to.eq('provisioning');
    expect(half.lifecycleRecord().operation).to.deep.include({ kind: 'provision', done: ['record', 'seed:customers', 'seed:audit'] });
    expect(half.lifecycleRecord().operation?.failed).to.include({ step: 'seed:flaky' });
    expect(await leaseColumns('acme')).to.include({ lifecycle_owner: null, lifecycle_until: null });

    expect((await lifecycle.provision(ACME)).state).to.eq('active');
    expect(ran).to.deep.eq(['customers@acme', 'audit@acme', 'flaky@acme', 'flaky@acme']);
    expect(await customers()).to.eq(1);
  });

  it('refuses a retry with other input, an active or suspended tenant, a taken slug and a taken domain', async () => {
    Flaky.failures = 1;
    await expect(lifecycle.provision(ACME)).to.be.rejected;
    await expect(lifecycle.provision({ ...ACME, name: 'ACME' })).to.be.rejectedWith(InvalidArgument, 'is being provisioned with another slug, name or placement');
    await lifecycle.provision(ACME);

    await expect(lifecycle.provision(ACME)).to.be.rejectedWith(ResourceDuplicated, 'tenant "acme" exists and is active');
    expect(await customers()).to.eq(1);
    await expect(lifecycle.provision({ id: 'other', slug: 'acme', name: 'Other' })).to.be.rejectedWith(ResourceDuplicated, 'the slug "acme" belongs to another tenant');
    await expect(lifecycle.provision({ id: 'other', slug: 'other', name: 'Other', domains: ['acme.example'] })).to.be.rejectedWith(ResourceDuplicated, 'the domain "acme.example" belongs to tenant "acme"');
    await seedTenant({ id: 'paused', state: 'suspended' });
    await expect(lifecycle.provision({ id: 'paused', slug: 'paused', name: 'paused' })).to.be.rejectedWith(InvalidOperation, 'only a provisioning that did not finish is provisioned again');
  });

  it('refuses ids, slugs, names and domains it cannot store, and a placement before schema mode', async () => {
    await expect(lifecycle.provision({ id: 'Acme', slug: 'acme', name: 'A' })).to.be.rejectedWith(InvalidArgument, 'a tenant id is 1 to 64 characters');
    await expect(lifecycle.provision({ id: 'acme', slug: 'Acme Ltd', name: 'A' })).to.be.rejectedWith(InvalidArgument, 'a slug is 1 to 64 characters');
    await expect(lifecycle.provision({ id: 'acme', slug: 'acme', name: ' ' })).to.be.rejectedWith(InvalidArgument, 'a tenant name is 1 to 128 characters');
    await expect(lifecycle.provision({ ...ACME, domains: ['*.acme.example'] })).to.be.rejectedWith(InvalidArgument, 'is not a host name a tenant can answer to');
    await expect(lifecycle.provision({ ...ACME, placement: { kind: 'schema', schema: 't_acme' } })).to.be.rejectedWith(NotSupported, 'v4-tl-02b-provision-schema');
    expect(await (await tenantRegistry()).get('acme')).to.eq(undefined);
  });

  it('migrates nothing for a tenant without a placement and refuses one on its way out', async () => {
    await seedTenant({ id: 'acme' });
    await seedTenant({ id: 'gone', state: 'deleting' });
    expect(await lifecycle.migrate('acme')).to.deep.eq({ tenant: 'acme', status: 'skipped', executed: [] });
    await expect(lifecycle.migrate('gone')).to.be.rejectedWith(InvalidOperation, 'a tenant on its way out is not migrated');
  });

  it('refuses to run inside a tenant scope', async () => {
    await seedTenant({ id: 'globex' });
    await expect(runInTenant('globex', () => lifecycle.provision(ACME))).to.be.rejectedWith(TenantSwitchDenied, 'provision acts on the tenant it names');
  });

  it('waits for the lease of an operation whose process died', async () => {
    await seedTenant({ id: 'acme', slug: 'acme', name: 'Acme Ltd', state: 'provisioning', domains: ['acme.example'] });
    await seedLifecycle('acme', { operation: { kind: 'provision', done: ['record'], startedAt: '2026-12-01T00:00:00.000Z' } });
    await claimLifecycle('acme', () => Date.now());

    await expect(lifecycle.provision(ACME)).to.be.rejectedWith(ConcurrencyConflict, 'another lifecycle operation holds tenant "acme"');
    expect((await new Later().provision(ACME)).state).to.eq('active');
  });

  it('stops an operation whose lease was taken over while a seeder ran, before it writes another step', async () => {
    let taker: LifecycleLease | undefined;
    Flaky.during = async () => {
      Flaky.during = undefined;
      taker = await claimLifecycle('acme', () => Date.now() + LIFECYCLE_LEASE_MS + 1);
    };
    await expect(lifecycle.provision(ACME)).to.be.rejectedWith(ConcurrencyConflict, 'tenant "acme" was taken over by another lifecycle operation');

    const row = await requireRow('acme');
    expect(row.state).to.eq('provisioning');
    expect(row.lifecycleRecord().operation?.done).to.deep.eq(['record', 'seed:customers', 'seed:audit']);
    await taker?.release();
    expect((await lifecycle.provision(ACME)).state).to.eq('active');
    expect(ran).to.deep.eq(['customers@acme', 'audit@acme', 'flaky@acme', 'flaky@acme']);
  });

  it('runs one of two provisionings that start together, and checks the tenant again once it holds the lease', async () => {
    const both = await Promise.allSettled([lifecycle.provision(ACME), lifecycle.provision(ACME)]);
    expect(both.map((r) => r.status).sort()).to.deep.eq(['fulfilled', 'rejected']);
    expect(await customers()).to.eq(1);

    await clearTenants();
    Flaky.failures = 1;
    await expect(lifecycle.provision(ACME)).to.be.rejected;
    await expect(new Overtaken().provision(ACME)).to.be.rejectedWith(ResourceDuplicated, 'tenant "acme" exists and is active');
    expect(ran).to.deep.eq([]);
  });
});
