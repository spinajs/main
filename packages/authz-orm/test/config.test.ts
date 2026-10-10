import * as chai from 'chai';
import 'mocha';
import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';
import { bindConfiguration, bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_ORM_CONFIGURATION_SCHEMA, DbScopeAttributeStore } from '../src/index.js';
import { OrmAuthzContributor } from '../src/contributor.js';
import { AuthzQueryMiddleware } from '../src/middleware.js';

const expect = chai.expect;

describe('authz-orm configuration through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(authz: Record<string, unknown>): Promise<IContainer> {
    const booted = await bootConfiguration({ authz }, [AUTHZ_CONFIGURATION_SCHEMA, AUTHZ_ORM_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.child;
  }

  it('AuthzQueryMiddleware reads authz.orm.domain of its container, root by default', async () => {
    const domainOf = (child: IContainer) => (bindConfiguration(new AuthzQueryMiddleware(), child) as unknown as { Domain: string }).Domain;
    expect(domainOf(await boot({ orm: { domain: 'tenant' } }))).to.equal('tenant');
    expect(domainOf(await boot({}))).to.equal('root');
  });

  it('refuses an empty authz.orm.domain at boot', async () => {
    expect(await violationPaths(boot({ orm: { domain: '' } }))).to.include('authz.orm.domain');
  });

  it('authz.orm.allowJit defaults to false for the middleware and the contributor', async () => {
    const child = await boot({});
    expect((bindConfiguration(new AuthzQueryMiddleware(), child) as unknown as { AllowJit: unknown }).AllowJit).to.equal(false);
    expect((bindConfiguration(new OrmAuthzContributor(), child) as unknown as { AllowJit: unknown }).AllowJit).to.equal(false);
    expect((bindConfiguration(new AuthzQueryMiddleware(), await boot({ orm: { allowJit: true } })) as unknown as { AllowJit: unknown }).AllowJit).to.equal(true);
  });

  it('refuses an authz.orm.allowJit that is no boolean at boot', async () => {
    expect(await violationPaths(boot({ orm: { allowJit: { on: true } } }))).to.include('authz.orm.allowJit');
  });

  it('DbScopeAttributeStore reads authz.admin.connection of the container it is given', async () => {
    const connectionOf = (store: DbScopeAttributeStore) => (store as unknown as { Connection: string }).Connection;
    expect(connectionOf(new DbScopeAttributeStore({ container: await boot({ admin: { connection: 'attrs' } }) }))).to.equal('attrs');
    expect(connectionOf(new DbScopeAttributeStore({ container: await boot({}) }))).to.equal('default');
  });
});
