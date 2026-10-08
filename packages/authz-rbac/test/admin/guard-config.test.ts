import * as chai from 'chai';
import 'mocha';
import { AUTHZ_CONFIGURATION_SCHEMA, AuthzConfigError } from '@spinajs/authz';
import type { AuthzCommand } from '@spinajs/authz';
import { bootConfiguration, configurationOf, userPrincipal, violationPaths } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';

import { guardSwitches } from '../../src/index.js';
import type { Assignment } from '../../src/index.js';
import { P1, config, failure, installHost, ok, rbacDomain, resetHost, uninstallHost } from './support.js';

const expect = chai.expect;

describe('DefaultAdminGuard reads authz.admin.guard', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(guard: unknown): Promise<IContainer> {
    const booted = await bootConfiguration({ authz: { admin: { guard } } }, [AUTHZ_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.child;
  }

  it('with every absent switch on', () => {
    expect(guardSwitches({ service: 'DefaultAdminGuard', privilegedPermission: 'users:update', preventEscalation: false }, 'here')).to.deep.include({
      privilegedPermission: 'users:update',
      preventEscalation: false,
      protectSystemRole: true,
      preventSelfLockout: true,
      preventLastPrivilegedRemoval: true,
    });
  });

  it('needs no privilegedPermission while both checks that read it are off', () => {
    expect(guardSwitches({ preventSelfLockout: false, preventLastPrivilegedRemoval: false }, 'here').privilegedPermission).to.equal(undefined);
  });

  it('names the reader it is given when a check is on without privilegedPermission', () => {
    expect(() => guardSwitches({ preventSelfLockout: true }, 'users-http AccountGuard')).to.throw(AuthzConfigError, /^users-http AccountGuard: authz\.admin\.guard\.privilegedPermission/);
  });

  it('refuses at boot what readGuardConfig refused at the first command', async () => {
    expect(await violationPaths(boot({ privilegedPermission: 'users:update', preventEscalation: 'no' }))).to.include('authz.admin.guard.preventEscalation');
    expect(await violationPaths(boot({ service: 'DefaultAdminGuard' }))).to.include('authz.admin.guard.privilegedPermission');
    expect(await violationPaths(boot({ privilegedPermission: 'users' }))).to.include('authz.admin.guard.privilegedPermission');
  });

  describe('from the Configuration of the domain the admin call runs in', function () {
    this.timeout(20000);

    const OFF = { service: 'DefaultAdminGuard', protectSystemRole: false, preventEscalation: false, preventSelfLockout: false, preventLastPrivilegedRemoval: false };
    const SYSTEM_ROW: Assignment = { id: 's1', subject: { type: 'user', id: 'dave' }, role: 'package', scope: P1, tags: [], expiresAt: null, source: 'test' };
    const revoke: AuthzCommand = { kind: 'assignment.revoke', id: 's1' };

    before(installHost);
    after(uninstallHost);
    beforeEach(resetHost);

    async function domain(own?: Record<string, unknown>) {
      const d = await rbacDomain('test', { assignments: [SYSTEM_ROW], admin: { backend: 'TestBackend', guard: OFF } });
      if (own) {
        const authz = { ...(config().get<Record<string, unknown>>('authz') ?? {}) };
        authz.admin = { ...(authz.admin as Record<string, unknown>), guard: own };
        d.container.register(configurationOf({ authz })).as(Configuration);
        await d.container.resolve(Configuration);
      }
      return d;
    }

    it('a domain whose own Configuration turns protectSystemRole on is guarded under a root that turns it off', async () => {
      const d = await domain({ ...OFF, protectSystemRole: true });
      expect(failure(await d.admin.execute(userPrincipal('alice'), [revoke])).code).to.equal('protected_role');
    });

    it('a domain without a Configuration of its own reads the root one', async () => {
      const d = await domain();
      ok(await d.admin.execute(userPrincipal('alice'), [revoke]));
    });
  });
});
