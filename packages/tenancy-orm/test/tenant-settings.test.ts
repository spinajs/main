import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { InvalidConfiguration, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { DI } from '@spinajs/di';
import { CachedTenantRegistry, TenancyServices, TenantMismatch, TenantSettings, TenantUnavailable, admitTenant, runAcrossTenants, runInTenant } from '@spinajs/tenancy';
import type { TestApp } from '@spinajs/testing';
import { DbTenantRegistry, TenantModel, TenantSettingsService } from '../src/index.js';
import { bootApp } from './support/app.js';
import { clearTenants, seedTenant } from './support/tenants.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

// The same schema as config-overrides.test.ts: one $id is registered once per process.
const MAIL_SCHEMA = { $id: 'test-tenancy-orm-mail', $configurationModule: 'mail', type: 'object', properties: { from: { type: 'string', pattern: '@' }, enabled: { type: 'boolean' } } };
const LIMITS_SCHEMA = {
  $id: 'test-tenancy-orm-limits',
  $configurationModule: 'limits',
  type: 'object',
  properties: { export: { type: 'object', properties: { limit: { type: 'integer', minimum: 1 }, windowSeconds: { type: 'integer', minimum: 1 } } } },
};
registerConfigurationSchemaAtImport(MAIL_SCHEMA);
registerConfigurationSchemaAtImport(LIMITS_SCHEMA);

const CACHE_MS = 300;

const PARALLEL_PATHS = Array.from({ length: 10 }, (_, i) => `p${i}.v`);

// Holds the first read of one tenant's row until `release()`: a write of that tenant is then in flight.
class HeldSettingsService extends TenantSettingsService {
  public held?: string;

  private gate = Promise.withResolvers<void>();

  public release(): void {
    this.held = undefined;
    this.gate.resolve();
  }

  protected override async current(id: string): Promise<TenantModel> {
    if (id === this.held) await this.gate.promise;
    return super.current(id);
  }
}

describe('TenantSettingsService', function () {
  this.timeout(30_000);

  let app: TestApp;
  let service: TenantSettingsService;

  before(async () => {
    // `notes.text` is listed and no schema declares it.
    app = await bootApp({ registry: 'DbTenantRegistry', registryCacheMs: CACHE_MS, config: { overridable: ['mail.from', 'limits.export', 'notes.text', ...PARALLEL_PATHS] } });
    service = await app.container.resolve(TenantSettingsService);
  });

  after(async () => {
    await app?.dispose();
  });

  beforeEach(async () => {
    await clearTenants();
    await seedTenant({ id: 'acme', settings: { plan: 'pro', 'mail.from': 'old@acme.test' } });
    await seedTenant({ id: 'globex', settings: { mail: { from: 'globex@globex.test' } } });
  });

  const stored = async (id = 'acme') => (await TenantModel.where('id', id).first())?.settings;
  const read = (id: string, path: string) => runInTenant(id, async () => app.config.get<unknown>(path));

  it('writes a setting in the configuration shape and keeps the other settings', async () => {
    const record = await service.set('acme', 'mail.from', 'billing@acme.test');

    expect(record.settings).to.deep.equal({ plan: 'pro', mail: { from: 'billing@acme.test' } });
    expect(await stored()).to.deep.equal({ plan: 'pro', mail: { from: 'billing@acme.test' } });
  });

  it('removes a setting, the dotted form included', async () => {
    await service.set('acme', 'mail.from', 'billing@acme.test');

    const record = await service.unset('acme', 'mail.from');

    expect(record.settings).to.deep.equal({ plan: 'pro', mail: {} });
  });

  it('refuses a path that tenancy.config.overridable does not list, also a free-form key and a parent of a listed path', async () => {
    await expect(service.set('acme', 'mail.enabled', false)).to.be.rejectedWith(InvalidArgument, 'mail.enabled is not listed in tenancy.config.overridable');
    await expect(service.set('acme', 'plan', 'free')).to.be.rejectedWith(InvalidArgument, 'plan is not listed');
    await expect(service.set('acme', 'mail', { from: 'x@acme.test', enabled: false })).to.be.rejectedWith(InvalidArgument, 'mail is not listed');
    await expect(service.unset('acme', 'plan')).to.be.rejectedWith(InvalidArgument, 'plan is not listed');

    expect(await stored()).to.deep.equal({ plan: 'pro', 'mail.from': 'old@acme.test' });
  });

  it('refuses a path under a closed configuration root', async () => {
    await expect(service.set('acme', 'db.DefaultConnection', 'other')).to.be.rejectedWith(InvalidArgument, 'a tenant cannot override db.*');
    await expect(service.set('acme', 'authn.cookie.secret', 'chosen')).to.be.rejectedWith(InvalidArgument, 'a tenant cannot override authn.*');
    await expect(service.unset('acme', 'tenancy.config')).to.be.rejectedWith(InvalidArgument, 'a tenant cannot override tenancy.*');

    expect(await stored()).to.deep.equal({ plan: 'pro', 'mail.from': 'old@acme.test' });
  });

  it('refuses a value the configuration schema refuses and writes nothing, not even the valid keys of the same value', async () => {
    await expect(service.set('acme', 'mail.from', 'not an address')).to.be.rejectedWith(InvalidConfiguration);
    await expect(service.set('acme', 'limits.export', { limit: 10, windowSeconds: 0 })).to.be.rejectedWith(InvalidConfiguration);

    expect(await stored()).to.deep.equal({ plan: 'pro', 'mail.from': 'old@acme.test' });
  });

  it('refuses a value holding a __proto__, constructor or prototype key at any depth', async () => {
    const polluted: unknown = JSON.parse('{ "text": "hi", "__proto__": { "admin": true } }');

    await expect(service.set('acme', 'notes.text', polluted)).to.be.rejectedWith(InvalidConfiguration, "the reserved key '__proto__'");
    await expect(service.set('acme', 'notes.text', { list: [{ constructor: { prototype: {} } }] })).to.be.rejectedWith(InvalidConfiguration, "the reserved key 'constructor'");

    expect(await stored()).to.deep.equal({ plan: 'pro', 'mail.from': 'old@acme.test' });
  });

  it('checks and stores the JSON form of a value; a listed path no schema declares is stored as written', async () => {
    const value = { text: 'hello', at: new Date('2026-01-02T03:04:05.000Z'), skip: undefined };

    const record = await service.set('acme', 'notes.text', value);

    expect(record.settings).to.deep.equal({ plan: 'pro', 'mail.from': 'old@acme.test', notes: { text: { text: 'hello', at: '2026-01-02T03:04:05.000Z' } } });
    await expect(service.set('acme', 'notes.text', undefined)).to.be.rejectedWith(InvalidArgument, 'unset()');
    // Valid as an object, refused in the form the column would store.
    await expect(service.set('acme', 'limits.export', { limit: 5, toJSON: () => ({ limit: 0 }) })).to.be.rejectedWith(InvalidConfiguration);
    expect(await stored()).to.deep.equal(record.settings);
  });

  it('refuses settings over 65,535 bytes of JSON, counted in UTF-8 bytes over the whole stored object; an unset still passes', async () => {
    const seed = { plan: 'pro', 'mail.from': 'old@acme.test' };
    const bytes = (text: string) => Buffer.byteLength(JSON.stringify({ ...seed, notes: { text } }));
    const multiByte = 'ż'.repeat(40_000);
    expect(multiByte.length).to.be.below(65_535);

    await expect(service.set('acme', 'notes.text', 'x'.repeat(70_000))).to.be.rejectedWith(InvalidArgument, 'the limit is 65535');
    await expect(service.set('acme', 'notes.text', multiByte)).to.be.rejectedWith(InvalidArgument, `would take ${bytes(multiByte)} bytes of JSON; the limit is 65535`);
    expect(await stored()).to.deep.equal(seed);

    await service.set('acme', 'notes.text', 'x'.repeat(60_000));
    await seedTenant({ id: 'oversized', settings: { notes: { text: 'x'.repeat(70_000) } } });
    expect((await service.unset('oversized', 'notes.text')).settings).to.deep.equal({ notes: {} });
  });

  it('refuses an unknown tenant and a malformed path', async () => {
    await expect(service.set('nobody', 'mail.from', 'x@y.test')).to.be.rejectedWith(TenantUnavailable);
    await expect(service.set('acme', 'mail..from', 'x@y.test')).to.be.rejectedWith(InvalidArgument);
  });

  it('refuses a tenant that is deleting or deleted; a provisioning or suspended tenant is written', async () => {
    for (const state of ['deleting', 'deleted'] as const) {
      await seedTenant({ id: state, state, settings: {} });
      await expect(service.set(state, 'mail.from', 'x@acme.test')).to.be.rejectedWith(InvalidOperation, `tenant "${state}" is ${state}`);
      await expect(service.unset(state, 'mail.from')).to.be.rejectedWith(InvalidOperation, `tenant "${state}" is ${state}`);
      expect(await stored(state)).to.deep.equal({});
    }
    for (const state of ['provisioning', 'suspended'] as const) {
      await seedTenant({ id: state, state, settings: {} });
      await service.set(state, 'mail.from', 'x@acme.test');
      expect(await stored(state)).to.deep.equal({ mail: { from: 'x@acme.test' } });
    }
  });

  it('inside a tenant scope writes only that tenant; with no scope or across all tenants it writes the tenant it names', async () => {
    await expect(runInTenant('globex', () => service.set('acme', 'mail.from', 'x@globex.test'))).to.be.rejectedWith(TenantMismatch);
    expect(await stored()).to.deep.equal({ plan: 'pro', 'mail.from': 'old@acme.test' });

    await runInTenant('acme', () => service.set('acme', 'mail.from', 'own@acme.test'));
    expect(await stored()).to.deep.equal({ plan: 'pro', mail: { from: 'own@acme.test' } });

    await service.set('acme', 'mail.from', 'platform@acme.test');
    await runAcrossTenants('test', () => service.unset('acme', 'mail.from'));
    expect(await stored()).to.deep.equal({ plan: 'pro', mail: {} });
  });

  it("a write for one tenant changes neither another tenant's values nor the shared configuration", async () => {
    await admitTenant('acme');
    await admitTenant('globex');

    await service.set('acme', 'mail.from', 'new@acme.test');

    expect(await read('acme', 'mail.from')).to.equal('new@acme.test');
    expect(await read('globex', 'mail.from')).to.equal('globex@globex.test');
    expect(app.config.get('mail.from')).to.equal(undefined);
    expect(await stored('globex')).to.deep.equal({ mail: { from: 'globex@globex.test' } });
  });

  it('concurrent writes of one tenant in this process take turns: every change is kept', async () => {
    await Promise.all(PARALLEL_PATHS.map((path, i) => service.set('acme', path, i)));

    expect(await stored()).to.deep.equal({ plan: 'pro', 'mail.from': 'old@acme.test', ...Object.fromEntries(PARALLEL_PATHS.map((path, i) => [path.split('.')[0], { v: i }])) });
  });

  it('a refused write neither fails nor blocks the writes of the tenant queued behind it, and the queue is emptied', async () => {
    const results = await Promise.allSettled([service.set('acme', 'p0.v', 0), service.set('acme', 'mail.from', 'not an address'), service.set('acme', 'p1.v', 1)]);

    expect(results.map((result) => result.status)).to.deep.equal(['fulfilled', 'rejected', 'fulfilled']);
    expect(await stored()).to.deep.equal({ plan: 'pro', 'mail.from': 'old@acme.test', p0: { v: 0 }, p1: { v: 1 } });
    expect(service['writing'].size).to.equal(0);
  });

  it('a write of one tenant does not wait for a write of another tenant', async () => {
    const held = await app.container.resolve(HeldSettingsService);
    held.held = 'acme';

    const acme = held.set('acme', 'p0.v', 0);
    await held.set('globex', 'p0.v', 0);
    expect(await stored()).to.deep.equal({ plan: 'pro', 'mail.from': 'old@acme.test' });

    held.release();
    await acme;
    expect(await stored()).to.deep.include({ p0: { v: 0 } });
  });

  it('the next configuration read in this process sees the new value', async () => {
    await admitTenant('acme');
    expect(await read('acme', 'mail.from')).to.equal('old@acme.test');

    await service.set('acme', 'mail.from', 'new@acme.test');

    expect(await read('acme', 'mail.from')).to.equal('new@acme.test');
  });

  it('the next read in this process sees the new value also when a refresh that read the old row was still running', async () => {
    const services = await DI.resolve(TenancyServices);
    await admitTenant('acme');
    services.registry.invalidate('acme');
    const { registry: { inner }, settings } = services;
    const [get, load] = [inner.get.bind(inner), settings.load.bind(settings)];
    const oldRowRead = Promise.withResolvers<void>();
    const hold = Promise.withResolvers<void>();
    let loads = 0;
    inner.get = async (id) => {
      const record = await get(id);
      oldRowRead.resolve();
      await hold.promise;
      return record;
    };
    // The refresh is held until the write asks for the settings: the write then finds it running.
    settings.load = (tenant) => {
      const loading = load(tenant);
      if (++loads === 2) hold.resolve();
      return loading;
    };

    try {
      const refresh = settings.load('acme');
      await oldRowRead.promise;
      await service.set('acme', 'mail.from', 'new@acme.test');
      await refresh;

      expect(await read('acme', 'mail.from')).to.equal('new@acme.test');
    } finally {
      inner.get = get;
      settings.load = load;
    }
  });

  it('another process sees the new value once its settings are older than tenancy.registryCacheMs', async () => {
    // Another process: its own registry cache and settings snapshot over the same table.
    const other = new TenantSettings(new CachedTenantRegistry(new DbTenantRegistry(), () => CACHE_MS), () => CACHE_MS, () => undefined);
    await other.load('acme');

    await service.set('acme', 'mail.from', 'new@acme.test');

    expect(other.settingsOf('acme')).to.deep.equal({ plan: 'pro', 'mail.from': 'old@acme.test' });
    await new Promise((resolve) => setTimeout(resolve, CACHE_MS + 50));
    // The first read past the interval still answers the old settings and starts the refresh.
    expect(other.settingsOf('acme')).to.deep.equal({ plan: 'pro', 'mail.from': 'old@acme.test' });
    await other.load('acme');
    expect(other.settingsOf('acme')).to.deep.equal({ plan: 'pro', mail: { from: 'new@acme.test' } });
  });
});
