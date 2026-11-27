import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Configuration, ConfigurationOverlay, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';
import type { IConfigLike } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import type { TenantRecord } from '../src/index.js';
import { MemoryTenantRegistry, TENANT_STATES, TenantConfigurationOverlay, TenantRegistry, TenantSettings, TenantSettingsUnavailable, TenantUnavailable, admitTenant, checkTenantSettings, forEachTenant, loadTenantSettings, runAcrossTenants, runInTenant, tenantRegistry } from '../src/index.js';

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

    it('names at most 20 unserved paths in its warning and counts the rest', async () => {
      (await memory()).add({ id: 'wide', settings: { mail: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i])) } });
      await admitTenant('wide');
      await runInTenant('wide', async () => config.get('mail.from'));

      expect(warnings.map((w) => w.data.paths)).to.deep.equal([`${Array.from({ length: 20 }, (_, i) => `mail.k${i}`).join(', ')} and 5 more`]);
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

    // plan h: seeders run while provisioning, exports while suspended, the data parts of a deletion while deleting
    it('in every state but unknown loadTenantSettings loads what admission refuses, and an unknown tenant reads no registry', async () => {
      const registry = await memory();
      let calls = 0;
      const get = registry.get.bind(registry);
      registry.get = (id) => {
        calls += 1;
        return get(id);
      };
      const outcome = (run: Promise<unknown>) => run.catch((error: unknown) => (error instanceof TenantUnavailable ? error.reason : error instanceof TenantSettingsUnavailable ? 'unavailable' : error));
      const read = (id: string) => outcome(runInTenant(id, async () => config.get('mail.from')));
      const rows: unknown[][] = [];
      for (const state of [...TENANT_STATES, 'unknown'] as const) {
        const id = `lc-${state}`;
        if (state !== 'unknown') registry.add({ id, state, settings: { mail: { from: `x@${state}.test` } } });
        calls = 0;
        const admission = await outcome(admitTenant(id).then(() => 'admitted'));
        const before = await read(id);
        const load = await outcome(loadTenantSettings(id).then(() => 'loaded'));
        rows.push([state, admission, before, load, await read(id), await read(id), calls]);
      }

      expect(rows).to.deep.equal([
        ['provisioning', 'inactive', 'unavailable', 'loaded', 'x@provisioning.test', 'x@provisioning.test', 2],
        ['active', 'admitted', 'x@active.test', 'loaded', 'x@active.test', 'x@active.test', 2],
        ['suspended', 'inactive', 'unavailable', 'loaded', 'x@suspended.test', 'x@suspended.test', 2],
        ['deleting', 'inactive', 'unavailable', 'loaded', 'x@deleting.test', 'x@deleting.test', 2],
        ['deleted', 'inactive', 'unavailable', 'loaded', 'x@deleted.test', 'x@deleted.test', 2],
        ['unknown', 'unknown', 'unavailable', 'unknown', 'unavailable', 'unavailable', 2],
      ]);
      expect(warnings).to.deep.equal([]);
    });

    it("drops a stored value the configuration schema refuses, with one warning, and keeps the tenant's other values", async () => {
      (await memory()).add({ id: 'broken', settings: { mail: { from: 'not an address' }, limits: { exports: 70 } } });
      await admitTenant('broken');

      expect(await runInTenant('broken', async () => config.get('mail.from'))).to.equal('noreply@app.test');
      expect(await runInTenant('broken', async () => config.get('mail.from'))).to.equal('noreply@app.test');
      expect(await runInTenant('broken', async () => config.get('limits.exports'))).to.equal(70);
      expect(warnings.map((w) => [w.data.tenant, w.data.path])).to.deep.equal([['broken', 'mail.from']]);
    });

    it('refuses a stored value that holds a __proto__, constructor or prototype key at any depth, touching no prototype', async () => {
      const stored: Record<string, unknown> = JSON.parse('{"mail":{"from":"ok@evil.test"},"limits":{"hosts":["x.test",{"__proto__":{"polluted":true}}],"exports":{"a":{"constructor":{"prototype":{"polluted":true}}}}}}');
      (await memory()).add({ id: 'evil', settings: stored });
      await admitTenant('evil');

      const limits = await runInTenant('evil', async () => config.get<Record<string, unknown>>('limits'));
      expect(limits).to.deep.equal({ exports: 10, uploads: 5, hosts: ['a.test', 'b.test', 'c.test'] });
      expect(await runInTenant('evil', async () => [config.get('limits.hosts'), config.get('limits.exports'), config.get('mail.from')])).to.deep.equal([['a.test', 'b.test', 'c.test'], 10, 'ok@evil.test']);
      expect([Object.getPrototypeOf(limits), Object.hasOwn(Object.prototype, 'polluted'), Reflect.get(Object.assign({}, limits), 'polluted')]).to.deep.equal([Object.prototype, false, undefined]);
      expect(warnings.map((w) => [w.data.tenant, w.data.path])).to.deep.equal([['evil', 'limits.exports'], ['evil', 'limits.hosts']]);
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

    it('checkTenantSettings refuses an overridable value the schema refuses or the serving path would refuse, and passes free-form keys', async () => {
      await expect(checkTenantSettings({ mail: { from: 'nope' } })).to.be.rejectedWith(InvalidConfiguration);
      await expect(checkTenantSettings({ 'mail.enabled': 'maybe' })).to.be.rejectedWith(InvalidConfiguration);
      for (const json of ['{"limits":{"hosts":["x.test",{"__proto__":{"polluted":true}}]}}', '{"limits.exports":{"a":{"constructor":{"prototype":{}}}}}']) {
        const settings: Record<string, unknown> = JSON.parse(json);
        await expect(checkTenantSettings(settings)).to.be.rejectedWith(InvalidConfiguration, 'reserved key');
      }
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

  it('reads a failing registry again one tenancy.registryCacheMs after a failed refresh, once per interval also for reads a microtask apart, with one warning per failure', async () => {
    class FailingRegistry extends MemoryTenantRegistry {
      public down = false;
      public calls = 0;
      public override get(id: string): Promise<TenantRecord | undefined> {
        this.calls += 1;
        return this.down ? Promise.reject(new Error('registry down')) : super.get(id);
      }
    }
    const registry = new FailingRegistry();
    registry.add({ id: 'acme', settings: { plan: 'pro' } });
    let now = 0;
    const failures: string[] = [];
    const settings = new TenantSettings(registry, () => 100, (tenant) => void failures.push(tenant), () => now);
    await settings.load('acme');
    registry.down = true;
    const readFor = async (n: number, tick: () => Promise<unknown> = () => new Promise(setImmediate)) => {
      for (let i = 0; i < n; i++) {
        expect(settings.settingsOf('acme')).to.deep.equal({ plan: 'pro' });
        await tick();
      }
    };

    now = 100;
    await readFor(50);
    now = 199;
    await readFor(50);
    expect([registry.calls, failures.length]).to.deep.equal([2, 1]);
    now = 200;
    await readFor(50);
    expect([registry.calls, failures.length]).to.deep.equal([3, 2]);
    now = 300;
    await readFor(50, () => Promise.resolve());
    await new Promise(setImmediate);
    expect([registry.calls, failures.length]).to.deep.equal([4, 3]);
  });

  it('refreshes a stale tenant in any state once per tenancy.registryCacheMs, and stops reading one the registry no longer knows after one warning', async () => {
    class CountingRegistry extends MemoryTenantRegistry {
      public calls = 0;
      public readonly gone = new Set<string>();
      public override get(id: string): Promise<TenantRecord | undefined> {
        this.calls += 1;
        return this.gone.has(id) ? Promise.resolve(undefined) : super.get(id);
      }
    }
    const registry = new CountingRegistry();
    let now = 0;
    const failures: unknown[][] = [];
    const settings = new TenantSettings(registry, () => 100, (tenant, error) => void failures.push([tenant, error instanceof TenantUnavailable ? error.reason : error]), () => now);
    const ids = [...TENANT_STATES, 'vanished'];
    for (const id of ids) {
      registry.add({ id, state: TENANT_STATES.find((state) => state === id), settings: { plan: id } });
      await settings.load(id);
    }
    registry.gone.add('vanished');
    registry.calls = 0;
    const readAll = async () => {
      for (let i = 0; i < 20; i++) {
        ids.forEach((id) => settings.settingsOf(id));
        await new Promise(setImmediate);
      }
    };

    now = 100;
    await readAll();
    expect([registry.calls, failures]).to.deep.equal([6, [['vanished', 'unknown']]]);
    now = 200;
    await readAll();
    expect(registry.calls).to.equal(11);
    expect(ids.map((id) => settings.settingsOf(id))).to.deep.equal([...TENANT_STATES.map((plan) => ({ plan })), undefined]);
    expect(failures).to.have.length(1);
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

  it('refuses at boot a misspelt tenancy.config key, naming it, and boots with the right one', async () => {
    await expect(overlayApp({ config: { overrideable: ['mail.from'] } })).to.be.rejectedWith('tenancy.config.overrideable');
    app = await overlayApp({ config: { overridable: ['mail.from'] } });
  });
});
