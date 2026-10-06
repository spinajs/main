import * as chai from 'chai';
import 'mocha';
import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';
import { bindConfiguration, bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';

import { DefaultAdminGuard } from '../../src/index.js';
import type { AdminGuardConfig } from '../../src/index.js';

const expect = chai.expect;

describe('DefaultAdminGuard reads authz.admin.guard through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(guard: unknown): Promise<IContainer> {
    const booted = await bootConfiguration({ authz: { admin: { guard } } }, [AUTHZ_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.child;
  }

  const guardOf = async (guard: unknown) => (bindConfiguration(new DefaultAdminGuard(), await boot(guard)) as unknown as { Guard: AdminGuardConfig }).Guard;

  it('from the Configuration of its container, with every absent switch on', async () => {
    expect(await guardOf({ service: 'DefaultAdminGuard', privilegedPermission: 'users:update', preventEscalation: false })).to.deep.include({
      privilegedPermission: 'users:update',
      preventEscalation: false,
      protectSystemRole: true,
      preventSelfLockout: true,
      preventLastPrivilegedRemoval: true,
    });
  });

  it('needs no privilegedPermission while both checks that read it are off', async () => {
    expect((await guardOf({ preventSelfLockout: false, preventLastPrivilegedRemoval: false })).privilegedPermission).to.equal(undefined);
  });

  it('refuses at boot what readGuardConfig refused at the first command', async () => {
    expect(await violationPaths(boot({ privilegedPermission: 'users:update', preventEscalation: 'no' }))).to.include('authz.admin.guard.preventEscalation');
    expect(await violationPaths(boot({ service: 'DefaultAdminGuard' }))).to.include('authz.admin.guard.privilegedPermission');
    expect(await violationPaths(boot({ privilegedPermission: 'users' }))).to.include('authz.admin.guard.privilegedPermission');
  });
});
