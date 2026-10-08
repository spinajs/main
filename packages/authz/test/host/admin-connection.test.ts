import 'mocha';
import { expect } from 'chai';
import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';
import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';

describe('authz.admin.connection', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(authz: Record<string, unknown>) {
    const booted = await bootConfiguration({ authz }, [AUTHZ_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.configuration;
  }

  it('is the default ORM connection when the app names none', async () => {
    expect((await boot({})).get('authz.admin.connection')).to.equal('default');
    expect((await boot({ admin: { maxBatch: 5 } })).get('authz.admin.connection')).to.equal('default');
  });

  it('keeps a named connection', async () => {
    expect((await boot({ admin: { connection: 'authz' } })).get('authz.admin.connection')).to.equal('authz');
  });

  it('refuses an empty name at boot', async () => {
    expect(await violationPaths(boot({ admin: { connection: '' } }))).to.include('authz.admin.connection');
  });
});
