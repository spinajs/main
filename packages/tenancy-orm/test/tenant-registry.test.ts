import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ConcurrencyConflict, InvalidOperation } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import type { TestApp } from '@spinajs/testing';
import { admitTenant, tenantRegistry } from '@spinajs/tenancy';
import type { TenantRecord, TenantState } from '@spinajs/tenancy';
import { DateTime } from 'luxon';
import { DbTenantRegistry, TENANCY_CONNECTION, TENANTS_TABLE, TenantModel, TenantStateService, tenantModels } from '../src/index.js';
import { bootApp } from './support/app.js';
import { everywhere, inTenant } from './support/scope.js';
import { clearTenants, seedTenant } from './support/tenants.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

class SmallPages extends DbTenantRegistry {
  protected override pageSize = 2;
}

// Another worker suspends the tenant between the read and the update, past the service.
class LosesRace extends TenantStateService {
  protected override async current(id: string): Promise<TenantModel> {
    const row = await super.current(id);
    await TenantModel.update({ state: 'suspended', updated_at: DateTime.utc() }).where('id', id);
    return row;
  }
}

async function idsOf(records: AsyncIterable<TenantRecord>): Promise<string[]> {
  const ids: string[] = [];
  for await (const record of records) ids.push(record.id);
  return ids;
}

describe('DbTenantRegistry', function () {
  this.timeout(30_000);

  let app: TestApp;
  let registry: DbTenantRegistry;

  // A row written past the model, as another tool or a broken migration would leave it.
  async function writeRaw(id: string, values: Record<string, string>): Promise<void> {
    const driver = (await app.resolve(Orm)).Connections.get(TENANCY_CONNECTION);
    await driver?.update().in(TENANTS_TABLE).update(values).where('id', id);
  }

  before(async () => {
    app = await bootApp({ registry: 'DbTenantRegistry' });
    registry = await app.resolve(DbTenantRegistry);
  });

  after(async () => {
    await app?.dispose();
  });

  beforeEach(async () => {
    await clearTenants();
    await seedTenant({ id: 't1', slug: 'acme', name: 'Acme', domains: ['acme.example', 'www.acme.example'] });
    await seedTenant({ id: 't2', slug: 'globex', name: 'Globex', state: 'suspended', placement: { kind: 'schema', schema: 't_t2' } });
    // The rows were written past the registry.
    (await tenantRegistry()).invalidate();
  });

  it('is the registry tenancy.registry names, read through the cache of @spinajs/tenancy', async () => {
    const cached = await tenantRegistry();
    expect(cached.inner).to.be.instanceOf(DbTenantRegistry);
    expect(cached.inner.cacheable).to.eq(true);
    expect((await cached.get('t2'))?.state).to.eq('suspended');
  });

  it('shows a transition at once through the cached registry', async () => {
    const cached = await tenantRegistry();
    expect((await cached.get('t1'))?.state).to.eq('active');
    expect((await cached.find({ domain: 'acme.example' }))?.state).to.eq('active');

    // A write past the service: the cache still answers, which shows it is in play.
    await TenantModel.update({ name: 'Acme Ltd', updated_at: DateTime.utc() }).where('id', 't1');
    expect((await cached.get('t1'))?.name).to.eq('Acme');

    await (await app.resolve(TenantStateService)).transition('t1', 'suspended');
    expect(await cached.get('t1')).to.include({ state: 'suspended', name: 'Acme Ltd' });
    expect((await cached.find({ domain: 'acme.example' }))?.state).to.eq('suspended');
  });

  it('leaves the cache alone when a transition fails', async () => {
    const cached = await tenantRegistry();
    expect((await cached.get('t1'))?.name).to.eq('Acme');
    await TenantModel.update({ name: 'Acme Ltd', updated_at: DateTime.utc() }).where('id', 't1');

    await expect((await app.resolve(TenantStateService)).transition('t1', 'deleted')).to.be.rejectedWith(InvalidOperation);
    expect((await cached.get('t1'))?.name).to.eq('Acme');
    await expect(new LosesRace().transition('t1', 'suspended')).to.be.rejectedWith(ConcurrencyConflict);
    expect((await cached.get('t1'))?.name).to.eq('Acme');
  });

  it('still moves a tenant whose row it cannot read, drops it from the cache, then refuses the row', async () => {
    const cached = await tenantRegistry();
    expect((await cached.get('t1'))?.state).to.eq('active');
    await writeRaw('t1', { settings: '[]' });

    const message = 'tenancy-orm: tenant "t1" has unreadable settings (an array)';
    await expect((await app.resolve(TenantStateService)).transition('t1', 'suspended')).to.be.rejectedWith(InvalidOperation, message);
    const [row] = await TenantModel.where('id', 't1');
    expect(row.state).to.eq('suspended');
    await expect(cached.get('t1')).to.be.rejectedWith(InvalidOperation, message);
  });

  it('gets a tenant by id, with no tenant scope although tenant models are declared', async () => {
    expect(tenantModels().length).to.be.greaterThan(0);
    expect(tenantModels().map((entry) => entry.model)).not.to.include(TenantModel);
    expect(await registry.get('t1')).to.deep.eq({ id: 't1', slug: 'acme', name: 'Acme', state: 'active', domains: ['acme.example', 'www.acme.example'], settings: {} });
    expect((await registry.get('t2'))?.placement).to.deep.eq({ kind: 'schema', schema: 't_t2' });
    expect(await registry.get('nope')).to.eq(undefined);
  });

  it('reads and moves tenants inside a tenant scope and in the all-tenants scope, any tenant from any tenant', async () => {
    expect((await inTenant('t2', () => registry.get('t1')))?.id).to.eq('t1');
    expect((await inTenant('t1', () => registry.find({ slug: 'globex' })))?.id).to.eq('t2');
    expect((await inTenant('t1', () => registry.find({ domain: 'acme.example' })))?.id).to.eq('t1');
    expect(await inTenant('t1', () => idsOf(registry.list()))).to.deep.eq(['t1', 't2']);
    expect((await everywhere(() => registry.get('t2')))?.id).to.eq('t2');
    expect((await inTenant('t1', () => admitTenant({ domain: 'acme.example' }))).id).to.eq('t1');

    const states = await app.resolve(TenantStateService);
    expect((await inTenant('t1', () => states.transition('t2', 'active'))).state).to.eq('active');
    expect((await everywhere(() => states.transition('t2', 'suspended'))).state).to.eq('suspended');
  });

  it('finds a tenant by slug and by domain', async () => {
    expect((await registry.find({ slug: 'globex' }))?.id).to.eq('t2');
    expect((await registry.find({ domain: 'www.acme.example' }))?.id).to.eq('t1');
    expect((await registry.find({ domain: '  WWW.Acme.Example ' }))?.id).to.eq('t1');
    expect((await registry.find({ slug: 'globex', domain: 'acme.example' }))?.id).to.eq('t2');
    expect(await registry.find({ slug: 'nope' })).to.eq(undefined);
    expect(await registry.find({ domain: 'me.example' })).to.eq(undefined);
    expect(await registry.find({ domain: 'acme.example,www.acme.example' })).to.eq(undefined);
    expect(await registry.find({ domain: '%' })).to.eq(undefined);
    expect(await registry.find({})).to.eq(undefined);
  });

  it('matches a host exactly, never one that contains or ends with a tenant domain', async () => {
    for (const host of ['evil-acme.example', 'acme.example.evil.test', 'cme.example', 'example', 'acme', 'w.acme.example', 'acme.example.', '%.example', 'acme_example', 'acme.exampl_', 'acme.exampl%']) {
      expect(await registry.find({ domain: host }), host).to.eq(undefined);
    }
  });

  it('matches a slug exactly, wildcards included', async () => {
    await seedTenant({ id: 't3', slug: 'a%' });
    await seedTenant({ id: 't4', slug: 'b_c' });
    for (const slug of ['acm', 'acme ', 'ACME', 'ac_e', 'ac%', '%', '_lobex', 'a_', 'b%', 'bxc']) {
      expect(await registry.find({ slug }), slug).to.eq(undefined);
    }
    expect((await registry.find({ slug: 'a%' }))?.id).to.eq('t3');
    expect((await registry.find({ slug: 'b_c' }))?.id).to.eq('t4');
    expect((await registry.find({ slug: 'acme' }))?.id).to.eq('t1');
  });

  it('refuses a domain that two tenants list', async () => {
    await seedTenant({ id: 't3', domains: ['acme.example'] });
    await expect(registry.find({ domain: 'acme.example' })).to.be.rejectedWith(InvalidOperation, 'tenancy-orm: domain "acme.example" is listed by tenants "t1" and "t3"; a domain belongs to one tenant');
  });

  it('never hands out a row whose state it does not know, through the cache neither', async () => {
    await writeRaw('t1', { state: 'frozen' });
    const cached = await tenantRegistry();
    const message = 'tenancy-orm: tenant "t1" has the unknown state "frozen"';
    await expect(registry.get('t1')).to.be.rejectedWith(InvalidOperation, message);
    await expect(registry.find({ slug: 'acme' })).to.be.rejectedWith(InvalidOperation, message);
    await expect(registry.find({ domain: 'acme.example' })).to.be.rejectedWith(InvalidOperation, message);
    await expect(idsOf(registry.list())).to.be.rejectedWith(InvalidOperation, message);
    await expect(cached.get('t1')).to.be.rejectedWith(InvalidOperation, message);
    await expect(cached.get('t1')).to.be.rejectedWith(InvalidOperation, message);
    await expect(admitTenant('t1')).to.be.rejectedWith(InvalidOperation, message);
  });

  it('never hands out a row whose JSON does not parse', async () => {
    await writeRaw('t1', { settings: '{"intl.defaultLocale":' });
    await writeRaw('t2', { placement: 'not json' });
    const cached = await tenantRegistry();
    await expect(registry.get('t1')).to.be.rejected;
    await expect(cached.get('t1')).to.be.rejected;
    await expect(admitTenant({ domain: 'acme.example' })).to.be.rejected;
    await expect(cached.find({ slug: 'globex' })).to.be.rejected;
  });

  it('never hands out an active tenant whose placement it cannot read, the cache and admitTenant included', async () => {
    await writeRaw('t1', { placement: '{"kind":"other"}' });
    const cached = await tenantRegistry();
    const message = 'tenancy-orm: tenant "t1" has unreadable placement (an object of kind "other")';
    await expect(registry.get('t1')).to.be.rejectedWith(InvalidOperation, message);
    await expect(cached.get('t1')).to.be.rejectedWith(InvalidOperation, message);
    await expect(admitTenant({ domain: 'acme.example' })).to.be.rejectedWith(InvalidOperation, message);
  });

  it('takes an id that is not a tenant id as no tenant, and never hands out a row that has one', async () => {
    await seedTenant({ id: 'T3', slug: 'upper' });
    expect(await registry.get('T3')).to.eq(undefined);
    await expect(registry.find({ slug: 'upper' })).to.be.rejectedWith(InvalidOperation, 'tenancy-orm: the tenant row "T3" has an id that is not a tenant id');
  });

  it('keeps a slug to one tenant', async () => {
    await expect(seedTenant({ id: 't3', slug: 'acme' })).to.be.rejected;
    expect(await idsOf(registry.list())).to.deep.eq(['t1', 't2']);
  });

  it('neither repeats nor skips a tenant whose state changes between two pages', async () => {
    await seedTenant({ id: 't3' });
    await seedTenant({ id: 't4' });
    await seedTenant({ id: 't5' });
    const seen: string[] = [];
    for await (const record of new SmallPages().list({ states: ['active'] })) {
      seen.push(record.id);
      // The first page was t1 and t3; t1 leaves the filter after it was read, t4 before.
      if (record.id === 't3') await TenantModel.update({ state: 'suspended', updated_at: DateTime.utc() }).whereIn('id', ['t1', 't4']);
    }
    expect(seen).to.deep.eq(['t1', 't3', 't5']);
  });

  it('lists tenants page by page, in id order, by state', async () => {
    await seedTenant({ id: 't3', state: 'provisioning' });
    await seedTenant({ id: 't4' });
    await seedTenant({ id: 't5', state: 'deleted' });

    expect(await idsOf(new SmallPages().list())).to.deep.eq(['t1', 't2', 't3', 't4', 't5']);
    expect(await idsOf(registry.list())).to.deep.eq(['t1', 't2', 't3', 't4', 't5']);

    const active: TenantState[] = ['active'];
    expect(await idsOf(new SmallPages().list({ states: active }))).to.deep.eq(['t1', 't4']);
    expect(await idsOf(registry.list({ states: ['suspended', 'deleted'] }))).to.deep.eq(['t2', 't5']);
    expect(await idsOf(registry.list({ states: [] }))).to.deep.eq([]);
  });
});
