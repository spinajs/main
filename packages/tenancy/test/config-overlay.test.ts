import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Configuration, ConfigurationOverlay, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';
import type { IConfigLike } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { MemoryTenantRegistry, TenantConfigurationOverlay, TenantRegistry, TenantSettingsUnavailable, TenantUnavailable, admitTenant, checkTenantSettings, forEachTenant, loadTenantSettings, runAcrossTenants, runInTenant, tenantRegistry } from '../src/index.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };

const MAIL_SCHEMA = { $id: 'test-tenancy-mail', $configurationModule: 'mail', type: 'object', properties: { from: { type: 'string', pattern: '@' }, enabled: { type: 'boolean' } } };

const OVERRIDABLE = ['mail.from', 'mail.enabled', 'limits.exports', 'limits.hosts'];

/** Stands for a registry over a database: its reads go through the cache of tenantRegistry(). */
class CachedMemoryTenantRegistry extends MemoryTenantRegistry {
  public override get cacheable(): boolean {
    return true;
  }
}

function overlayApp(tenancy: Record<string, unknown> = {}): Promise<TestApp> {
  return createTestApp({
    bootstrap: false,
    schemas: [MAIL_SCHEMA],
    register: (container) => container.register(CachedMemoryTenantRegistry).as(TenantRegistry),
    config: {
      logger: SILENT,
      tenancy: { registry: 'MemoryTenantRegistry', config: { overridable: OVERRIDABLE }, ...tenancy },
      mail: { from: 'noreply@app.test', retries: 3 },
      limits: { exports: 10, uploads: 5, hosts: ['a.test', 'b.test', 'c.test'] },
      intl: { defaultLocale: 'en' },
    },
  });
}

async function memory(): Promise<MemoryTenantRegistry> {
  const inner = (await tenantRegistry()).inner;
  if (!(inner instanceof MemoryTenantRegistry)) throw new Error('expected the memory registry');
  return inner;
}

// This suite loads no Log implementation; queue.test.ts stubs Log the same way.
function watchWarnings(app: TestApp | undefined): Array<{ data: Record<string, unknown>; message: string }> {
  const warnings: Array<{ data: Record<string, unknown>; message: string }> = [];
  const warn = (data: Record<string, unknown>, message: string) => void warnings.push({ data, message });
  Object.defineProperty(app?.container.get(ConfigurationOverlay), 'Log', { value: { warn } });
  return warnings;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('tenant configuration overrides', () => {
  let app: TestApp | undefined;
  let config: Configuration;

  afterEach(async () => {
    await app?.dispose();
    app = undefined;
  });

  describe('with overridable paths', () => {
    let warnings: Array<{ data: Record<string, unknown>; message: string }>;

    beforeEach(async () => {
      app = await overlayApp();
      config = app.config;
      warnings = watchWarnings(app);
      const registry = await memory();
      registry.add({ id: 'acme', settings: { mail: { from: 'billing@acme.test' }, limits: { exports: 50 }, plan: 'pro' } });
      registry.add({ id: 'globex', settings: { 'mail.from': 'ops@globex.test' } });
      registry.add({ id: 'plain' });
      for (const id of ['acme', 'globex', 'plain']) await admitTenant(id);
    });

    it("answers an admitted tenant's value for an overridable path and the shared value elsewhere", async () => {
      expect(await runInTenant('acme', async () => config.get('mail.from'))).to.equal('billing@acme.test');
      expect(await runInTenant('acme', async () => config.get(['mail', 'from']))).to.equal('billing@acme.test');
      expect(await runInTenant('acme', async () => config.get('mail.retries'))).to.equal(3);
      expect(await runInTenant('globex', async () => config.get('mail.from'))).to.equal('ops@globex.test');
      expect(await runInTenant('plain', async () => config.get('mail.from'))).to.equal('noreply@app.test');
    });

    it('answers the shared value with no scope and across all tenants', async () => {
      expect(config.get('mail.from')).to.equal('noreply@app.test');
      expect(await runAcrossTenants('report', async () => config.get('mail.from'))).to.equal('noreply@app.test');
    });

    it('never answers one tenant with another tenant’s value, nor code outside a tenant with the last tenant’s', async () => {
      const readTwice = (tenant: string) =>
        runInTenant(tenant, async () => {
          const first = config.get('mail.from');
          await wait(5);
          return [first, config.get<Record<string, unknown>>('mail').from];
        });

      const [plain, acme, globex] = await Promise.all([readTwice('plain'), readTwice('acme'), readTwice('globex')]);

      expect(acme).to.deep.equal(['billing@acme.test', 'billing@acme.test']);
      expect(globex).to.deep.equal(['ops@globex.test', 'ops@globex.test']);
      expect(plain).to.deep.equal(['noreply@app.test', 'noreply@app.test']);
      expect(config.get('mail.from')).to.equal('noreply@app.test');
    });

    it("lays the tenant's value into the object a read of a parent path returns", async () => {
      expect(await runInTenant('acme', async () => config.get('limits'))).to.deep.equal({ exports: 50, uploads: 5, hosts: ['a.test', 'b.test', 'c.test'] });
      expect(config.get('limits')).to.deep.equal({ exports: 10, uploads: 5, hosts: ['a.test', 'b.test', 'c.test'] });
    });

    it('takes from a parent object in the settings only the listed child, and replaces a listed array whole', async () => {
      (await memory()).add({ id: 'wide', settings: { mail: { from: 'x@wide.test', retries: 99 }, 'limits.uploads': 99, limits: { hosts: ['x.test'] } } });
      await admitTenant('wide');

      expect(await runInTenant('wide', async () => config.get('mail.retries'))).to.equal(3);
      expect(await runInTenant('wide', async () => config.get('mail'))).to.deep.equal({ from: 'x@wide.test', retries: 3 });
      expect(await runInTenant('wide', async () => config.get('limits.uploads'))).to.equal(5);
      expect(await runInTenant('wide', async () => config.get('limits.hosts'))).to.deep.equal(['x.test']);
      expect(await runInTenant('wide', async () => config.get('limits.hosts.1'))).to.equal(undefined);
    });

    it('never serves a stored value outside tenancy.config.overridable, throws nothing for it and warns once', async () => {
      // Stored past checkTenantSettings, as a row written by SQL or before a path left the list.
      const stored = { mail: { retries: 0 }, 'intl.defaultLocale': 'de', authn: { cookie: { secret: 'chosen-by-the-tenant' } }, db: { Connections: [] }, plan: 'pro' };
      const registry = await memory();
      registry.add({ id: 'sneaky', settings: stored });
      await admitTenant('sneaky');

      const paths = ['mail.retries', 'intl.defaultLocale', 'authn.cookie.secret', 'db', 'plan', 'mail.from'];
      const reads = () => runInTenant('sneaky', async () => paths.map((path) => config.get(path)));
      // Other suites of the package may have registered defaults under db.
      const shared = paths.map((path) => config.get(path));
      expect(shared.slice(0, 3)).to.deep.equal([3, 'en', undefined]);
      expect(await reads()).to.deep.equal(shared);
      expect(await reads()).to.deep.equal(shared);
      registry.set('sneaky', { settings: { ...stored } });
      await loadTenantSettings('sneaky');
      expect(await reads()).to.deep.equal(shared);

      expect(warnings.map((w) => w.data)).to.deep.equal([{ tenant: 'sneaky', paths: 'mail.retries, intl.defaultLocale, authn, db' }]);
    });

    // The overlay serves what check() returned, never the stored input.
    it("serves the value the schema accepted: a stored 'false' at a boolean path reads as false", async () => {
      (await memory()).add({ id: 'coerced', settings: { mail: { enabled: 'false' } } });
      await admitTenant('coerced');

      expect(await runInTenant('coerced', async () => config.get('mail.enabled'))).to.equal(false);
      expect(await runInTenant('coerced', async () => config.get<Record<string, unknown>>('mail'))).to.include({ enabled: false, from: 'noreply@app.test' });
    });

    // InvalidOperation from check() means "the configuration is loading", not "refused".
    it('keeps the values checked before while check() cannot judge, logs nothing, and keeps no refusal', async () => {
      if (!(config instanceof FrameworkConfiguration)) throw new Error('expected a FrameworkConfiguration');
      const registry = await memory();
      expect(await runInTenant('acme', async () => config.get('mail.from'))).to.equal('billing@acme.test');

      config.check = () => {
        throw new InvalidOperation('Configuration mail.from cannot be checked while the configuration loads');
      };
      registry.set('acme', { settings: { mail: { from: 'next@acme.test' } } });
      await loadTenantSettings('acme');
      registry.add({ id: 'late', settings: { mail: { from: 'x@late.test' } } });
      await loadTenantSettings('late');

      expect(await runInTenant('acme', async () => config.get('mail.from'))).to.equal('billing@acme.test');
      await expect(runInTenant('late', async () => config.get('mail.from'))).to.be.rejectedWith(TenantSettingsUnavailable);

      Reflect.deleteProperty(config, 'check'); // the prototype's check() answers again
      expect(await runInTenant('acme', async () => config.get('mail.from'))).to.equal('next@acme.test');
      expect(await runInTenant('late', async () => config.get('mail.from'))).to.equal('x@late.test');
      expect(warnings).to.deep.equal([]);
    });

    it('throws for a tenant whose settings this process has not loaded, until loadTenantSettings', async () => {
      (await memory()).add({ id: 'fresh', settings: { mail: { from: 'x@fresh.test' } } });

      await expect(runInTenant('fresh', async () => config.get('mail.from'))).to.be.rejectedWith(TenantSettingsUnavailable);
      expect(await runInTenant('fresh', async () => config.get('intl.defaultLocale'))).to.equal('en');

      await loadTenantSettings('fresh');
      expect(await runInTenant('fresh', async () => config.get('mail.from'))).to.equal('x@fresh.test');
    });

    // plan h's lifecycle steps run inside tenants that admission refuses
    it('loadTenantSettings loads a tenant that is not active; only an unknown tenant is refused', async () => {
      (await memory()).add({ id: 'frozen', state: 'suspended', settings: { mail: { from: 'x@frozen.test' } } });

      await expect(admitTenant('frozen')).to.be.rejectedWith(TenantUnavailable);
      await loadTenantSettings('frozen');
      expect(await runInTenant('frozen', async () => config.get('mail.from'))).to.equal('x@frozen.test');
      await expect(loadTenantSettings('nobody')).to.be.rejectedWith(TenantUnavailable);
    });

    it("drops a stored value the configuration schema refuses, with one warning, and keeps the tenant's other values", async () => {
      (await memory()).add({ id: 'broken', settings: { mail: { from: 'not an address' }, limits: { exports: 70 } } });
      await admitTenant('broken');

      expect(await runInTenant('broken', async () => config.get('mail.from'))).to.equal('noreply@app.test');
      expect(await runInTenant('broken', async () => config.get('mail.from'))).to.equal('noreply@app.test');
      expect(await runInTenant('broken', async () => config.get('limits.exports'))).to.equal(70);
      expect(warnings.map((w) => [w.data.tenant, w.data.path])).to.deep.equal([['broken', 'mail.from']]);
    });

    it('forEachTenant loads the settings of every tenant it visits', async () => {
      (await memory()).add({ id: 'fresh', settings: { mail: { from: 'x@fresh.test' } } });
      const seen = new Map<string, unknown>();

      const report = await forEachTenant(async (tenant) => {
        seen.set(tenant.id, config.get('mail.from'));
      });

      expect(report.failed).to.deep.equal([]);
      expect(seen.get('fresh')).to.equal('x@fresh.test');
      expect(seen.get('plain')).to.equal('noreply@app.test');
    });

    it('checkTenantSettings refuses an overridable value the schema refuses and passes free-form keys', async () => {
      await expect(checkTenantSettings({ mail: { from: 'nope' } })).to.be.rejectedWith(InvalidConfiguration);
      await expect(checkTenantSettings({ 'mail.enabled': 'maybe' })).to.be.rejectedWith(InvalidConfiguration);
      await checkTenantSettings({ mail: { from: 'ok@acme.test', enabled: 'false' }, plan: 'pro', db: { Connections: [] } });
    });

    it('refuses to attach to a Configuration that is not a FrameworkConfiguration', async () => {
      // An application may register a Configuration class of its own.
      class OwnConfiguration extends Configuration {
        public get RootConfig(): IConfigLike {
          return {};
        }
        public get<T>(): T {
          throw new Error('read before the class was checked');
        }
        public set(): void {}
        public merge(): void {}
        public async mergeSource(): Promise<void> {}
        public async load(): Promise<void> {}
        protected onLoad(): unknown {
          return {};
        }
      }
      const overlay = await app?.container.resolve(TenantConfigurationOverlay);

      expect(() => overlay?.attach(new OwnConfiguration())).to.throw(InvalidOperation, 'FrameworkConfiguration.check');
    });
  });

  it('reads a changed tenant again once its settings are older than tenancy.registryCacheMs', async () => {
    app = await overlayApp({ registryCacheMs: 20 });
    config = app.config;
    const registry = await memory();
    registry.add({ id: 'acme', settings: { mail: { from: 'old@acme.test' } } });
    await admitTenant('acme');
    registry.set('acme', { settings: { mail: { from: 'new@acme.test' } } });

    await wait(40);
    expect(await runInTenant('acme', async () => config.get('mail.from'))).to.equal('old@acme.test');
    await wait(10);
    expect(await runInTenant('acme', async () => config.get('mail.from'))).to.equal('new@acme.test');
  });

  it('picks up a tenant changed by another process once the registry cache of tenancy.registryCacheMs lets it through', async () => {
    app = await overlayApp({ registry: 'CachedMemoryTenantRegistry', registryCacheMs: 30 });
    config = app.config;
    const registry = (await tenantRegistry()).inner;
    if (!(registry instanceof CachedMemoryTenantRegistry)) throw new Error('expected the cached memory registry');
    registry.add({ id: 'acme', settings: { mail: { from: 'old@acme.test' } } });
    await admitTenant('acme');
    registry.set('acme', { settings: { mail: { from: 'new@acme.test' } } });

    // Admissions within the bound answer from the registry cache.
    await admitTenant('acme');
    expect(await runInTenant('acme', async () => config.get('mail.from'))).to.equal('old@acme.test');
    await wait(70);
    await admitTenant('acme');
    expect(await runInTenant('acme', async () => config.get('mail.from'))).to.equal('new@acme.test');
  });

  it('answers every path from the shared configuration without overridable paths', async () => {
    app = await overlayApp({ config: { overridable: [] } });
    config = app.config;
    (await memory()).add({ id: 'acme', settings: { mail: { from: 'billing@acme.test' } } });
    await admitTenant('acme');

    expect(await runInTenant('acme', async () => config.get('mail.from'))).to.equal('noreply@app.test');
    expect(config.isOverlaid('mail.from')).to.equal(false);
  });

  it('refuses at boot an overridable path under a closed root, naming the entry and the root', async () => {
    await expect(overlayApp({ config: { overridable: ['mail.from', 'db.Connections'] } })).to.be.rejectedWith('tenancy.config.overridable[1] db.Connections: a tenant cannot override db.*');
    for (const path of ['authn.cookie.secret', 'https.key', 'logger.targets', 'telemetry.endpoint', 'otel.exporter', 'cache.connection']) {
      await expect(overlayApp({ config: { overridable: [path] } })).to.be.rejectedWith(`${path}: a tenant cannot override ${path.split('.')[0]}.*`);
    }
  });

  it('refuses at boot a reserved segment and a malformed tenancy.config', async () => {
    for (const path of ['mail.__proto__', 'constructor.name', 'mail.prototype.from']) {
      const segment = path.split('.').find((s) => ['__proto__', 'constructor', 'prototype'].includes(s));
      await expect(overlayApp({ config: { overridable: [path] } })).to.be.rejectedWith(`tenancy.config.overridable[0] ${path}: '${segment}' is not a configuration key`);
    }
    await expect(overlayApp({ config: { overridable: ['mail..from'] } })).to.be.rejectedWith('overridable');
    await expect(overlayApp({ config: { overridable: 'mail.from' } })).to.be.rejectedWith('overridable');
  });
});
