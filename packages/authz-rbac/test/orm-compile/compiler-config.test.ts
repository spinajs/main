import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';
import { AUTHZ_ORM_CONFIGURATION_SCHEMA } from '@spinajs/authz-orm';
import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';

import { RbacOrmCompiler, RbacThresholdOrmCompiler } from '../../src/orm/index.js';

const whereOf = (compiler: object, type: string): string => (compiler as { where(type: string): string }).where(type);

describe('authz-rbac orm-compile: the compilers read authz.orm.domain through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(authz: Record<string, unknown>): Promise<IContainer> {
    const booted = await bootConfiguration({ authz }, [AUTHZ_CONFIGURATION_SCHEMA, AUTHZ_ORM_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.child;
  }

  it('names the domain of the container they are given in refusals, root by the schema default', async () => {
    const tenant = await boot({ orm: { domain: 'tenant' } });
    expect(whereOf(new RbacOrmCompiler(tenant), 'doc')).to.equal(`native:rbac.assignment (domain "tenant", type 'doc')`);
    expect(whereOf(new RbacThresholdOrmCompiler(tenant), 'doc')).to.equal(`native:rbac.threshold (domain "tenant", type 'doc')`);
    expect(whereOf(new RbacThresholdOrmCompiler(await boot({})), 'file')).to.equal(`native:rbac.threshold (domain "root", type 'file')`);
  });

  it('an empty domain fails the boot (the schema, not a code default)', async () => {
    expect(await violationPaths(boot({ orm: { domain: '' } }))).to.include('authz.orm.domain');
  });
});
