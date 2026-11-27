import 'mocha';
import * as chai from 'chai';
import { ConfigurationOverlay, ScopedConfigurationSource } from '@spinajs/configuration';
import type { Configuration } from '@spinajs/configuration';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { MemoryTenantRegistry, admitTenant, runAcrossTenants, runInTenant, tenantRegistry } from '../src/index.js';

const expect = chai.expect;

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };

class FixedScoped extends ScopedConfigurationSource {
  public static rows = new Map<string, ReadonlyMap<string, unknown>>();

  public valuesOf(scope: string): ReadonlyMap<string, unknown> | undefined {
    return FixedScoped.rows.get(scope);
  }
}

describe('tenant configuration overrides from scoped sources', () => {
  let app: TestApp;
  let config: Configuration;
  let warnings: string[];

  beforeEach(async () => {
    FixedScoped.rows = new Map([
      ['tenant:acme', new Map<string, unknown>([['mail.from', 'row@acme.test'], ['mail.enabled', 'false'], ['mail', { from: 'whole@acme.test' }], ['intl.defaultLocale', 'de'], ['limits.uploads', 99]])],
      ['tenant:globex', new Map<string, unknown>([['mail.from', 'row@globex.test']])],
      ['tenant:initech', new Map<string, unknown>([['mail.from', 'row@initech.test'], ['mail.enabled', { __proto__: null, constructor: { prototype: true } }]])],
    ]);
    app = await createTestApp({
      bootstrap: false,
      schemas: [{ $id: 'test-scoped-mail', $configurationModule: 'mail', type: 'object', properties: { from: { type: 'string' }, enabled: { type: 'boolean' } } }],
      register: (container) => container.register(FixedScoped).as(ScopedConfigurationSource),
      config: { logger: SILENT, tenancy: { registry: 'MemoryTenantRegistry', config: { overridable: ['mail.from', 'mail.enabled', 'limits.exports'] } }, mail: { from: 'noreply@app.test', enabled: true }, intl: { defaultLocale: 'en' }, limits: { exports: 10, uploads: 5 } },
    });
    config = app.config;
    warnings = [];
    // This suite loads no Log implementation; config-overlay.test.ts stubs it the same way.
    Object.defineProperty(app.container.get(ConfigurationOverlay), 'Log', { value: { warn: (_data: unknown, message: string) => void warnings.push(message) } });
    const registry = (await tenantRegistry()).inner;
    if (!(registry instanceof MemoryTenantRegistry)) throw new Error('expected the memory registry');
    registry.add({ id: 'acme' });
    registry.add({ id: 'globex', settings: { mail: { from: 'own@globex.test' } } });
    registry.add({ id: 'initech' });
    registry.add({ id: 'hooli' });
    for (const id of ['acme', 'globex', 'initech', 'hooli']) await admitTenant(id);
  });

  afterEach(async () => {
    await app?.dispose();
  });

  it("answers a scoped row of the tenant's scope for an overridable path", async () => {
    expect(await runInTenant('acme', async () => config.get('mail.from'))).to.equal('row@acme.test');
  });

  it("never answers another tenant's scoped row, nor one outside a tenant or across all tenants", async () => {
    const [acme, hooli] = await Promise.all([runInTenant('acme', async () => config.get('mail.from')), runInTenant('hooli', async () => config.get('mail.from'))]);
    expect(acme).to.equal('row@acme.test');
    expect(hooli).to.equal('noreply@app.test');
    expect(config.get('mail.from')).to.equal('noreply@app.test');
    expect(await runAcrossTenants('report', async () => config.get('mail.from'))).to.equal('noreply@app.test');
  });

  it("lets the tenant's own settings win over a scoped row", async () => {
    expect(await runInTenant('globex', async () => config.get('mail.from'))).to.equal('own@globex.test');
  });

  it('ignores scoped rows at a path that is not overridable, above one included', async () => {
    expect(await runInTenant('acme', async () => config.get('intl.defaultLocale'))).to.equal('en');
    expect(await runInTenant('acme', async () => config.get('mail'))).to.deep.equal({ from: 'row@acme.test', enabled: false });
    expect(await runInTenant('acme', async () => config.get('limits'))).to.deep.equal({ exports: 10, uploads: 5 });
  });

  // a scoped row is a string column; the overlay serves what check() made of it
  it("serves a scoped row as the schema accepted it: 'false' at a boolean path reads as false", async () => {
    expect(await runInTenant('acme', async () => config.get('mail.enabled'))).to.equal(false);
  });

  it('refuses a scoped row holding a reserved key, with one warning, and keeps the shared value there', async () => {
    expect(await runInTenant('initech', async () => config.get('mail.enabled'))).to.equal(true);
    expect(await runInTenant('initech', async () => config.get('mail.from'))).to.equal('row@initech.test');
    expect(warnings).to.have.length(1);
  });

  it('answers a changed scoped row once the source holds a new map', async () => {
    expect(await runInTenant('acme', async () => config.get('mail.from'))).to.equal('row@acme.test');
    FixedScoped.rows.set('tenant:acme', new Map<string, unknown>([['mail.from', 'next@acme.test']]));
    expect(await runInTenant('acme', async () => config.get('mail.from'))).to.equal('next@acme.test');
  });
});
