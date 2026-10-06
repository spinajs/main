import * as chai from 'chai';
import 'mocha';
import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';
import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_RBAC_CONFIGURATION_SCHEMA, DbAuthzAdminBackend } from '../../../src/index.js';

const expect = chai.expect;

describe('DbAuthzAdminBackend reads authz.admin.connection through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(authz: Record<string, unknown>): Promise<IContainer> {
    const booted = await bootConfiguration({ authz }, [AUTHZ_CONFIGURATION_SCHEMA, AUTHZ_RBAC_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.child;
  }

  const connectionOf = (backend: DbAuthzAdminBackend) => (backend as unknown as { Connection: string }).Connection;

  it('from the Configuration of the container its options name', async () => {
    expect(connectionOf(new DbAuthzAdminBackend({ container: await boot({ admin: { connection: 'authz' } }) }))).to.equal('authz');
  });

  it('the default connection when the app names none', async () => {
    expect(connectionOf(new DbAuthzAdminBackend({ container: await boot({}) }))).to.equal('default');
  });

  it('refuses an empty authz.rbac.connection at boot; it has no default, so storeConnection can fall back to authz.admin.connection', async () => {
    expect(await violationPaths(boot({ rbac: { connection: '' } }))).to.include('authz.rbac.connection');
    const configuration = (await boot({ admin: { connection: 'authz' } })).get(Configuration);
    expect(configuration?.get('authz.rbac.connection')).to.equal(undefined);
  });
});
