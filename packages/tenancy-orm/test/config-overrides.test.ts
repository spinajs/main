import 'mocha';
import * as chai from 'chai';
import { Configuration, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import type { TestApp } from '@spinajs/testing';
import { admitTenant, runInTenant, tenantRegistry } from '@spinajs/tenancy';
import { TENANCY_CONNECTION, TENANTS_TABLE } from '../src/index.js';
import { bootApp } from './support/app.js';
import { clearTenants, seedTenant } from './support/tenants.js';

const expect = chai.expect;

const MAIL_SCHEMA = { $id: 'test-tenancy-orm-mail', $configurationModule: 'mail', type: 'object', properties: { from: { type: 'string', pattern: '@' }, enabled: { type: 'boolean' } } };
registerConfigurationSchemaAtImport(MAIL_SCHEMA);

const CACHE_MS = 500;

describe('configuration overrides from the tenant table', function () {
  this.timeout(30_000);

  let app: TestApp;
  let config: Configuration;

  // Written past the model and past checkTenantSettings, as SQL or another process would leave it.
  async function writeSettings(id: string, settings: Record<string, unknown>): Promise<void> {
    const driver = (await app.resolve(Orm)).Connections.get(TENANCY_CONNECTION);
    await driver?.update().in(TENANTS_TABLE).update({ settings: JSON.stringify(settings) }).where('id', id);
  }

  const read = (path: string) => runInTenant('acme', async () => config.get(path));

  before(async () => {
    app = await bootApp({ registry: 'DbTenantRegistry', registryCacheMs: CACHE_MS, config: { overridable: ['mail.enabled', 'mail.from'] } });
    config = app.config;
  });

  after(async () => {
    await app?.dispose();
  });

  beforeEach(async () => {
    await clearTenants();
    await seedTenant({ id: 'acme' });
    await writeSettings('acme', { mail: { enabled: 'false', from: 'billing@acme.test' }, authn: { cookie: { secret: 'chosen-by-the-tenant' } } });
    (await tenantRegistry()).invalidate();
  });

  it('serves a row written by SQL as the schema accepted it, and never a path outside the list', async () => {
    await admitTenant('acme');

    expect(await read('mail.enabled')).to.equal(false);
    expect(await read('mail.from')).to.equal('billing@acme.test');
    expect(await read('authn.cookie.secret')).to.equal(undefined);
    expect(config.get('mail.enabled')).to.equal(undefined);
  });

  it('serves a row changed by another process once the registry cache lets it through', async () => {
    await admitTenant('acme');
    await writeSettings('acme', { mail: { from: 'next@acme.test' } });

    await admitTenant('acme');
    expect(await read('mail.from')).to.equal('billing@acme.test');

    await new Promise((resolve) => setTimeout(resolve, CACHE_MS * 2));
    await admitTenant('acme');
    expect(await read('mail.from')).to.equal('next@acme.test');
    expect(await read('mail.enabled')).to.equal(undefined);
  });
});
