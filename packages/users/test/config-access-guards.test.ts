import 'mocha';
import { expect } from 'chai';
import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';
import { CONFIGURATION_CONTAINER_KEY } from '@spinajs/configuration';

import { AccessResponseExtension, AuthzImpersonationGuard, AuthzTargetGuard, DEFAULT_ACCESS_DOMAIN, DEFAULT_IMPERSONATION_PERMISSION, DEFAULT_PROTECTED_ROLES, RbacRoleSource, USERS_ACCESS_CONFIGURATION_SCHEMA } from '../src/index.js';
import { bootChild, disposeChildren, violationPaths } from './support/child-config.js';

const SCHEMAS = [AUTHZ_CONFIGURATION_SCHEMA, USERS_ACCESS_CONFIGURATION_SCHEMA];

const read = (instance: object, property: string): unknown => (instance as unknown as Record<string, unknown>)[property];

describe('users access domain and impersonation configuration', () => {
  afterEach(disposeChildren);

  describe('defaults', () => {
    it('gives an unconfigured app the values the code defaults used to give', async () => {
      const { config } = await bootChild({}, ...SCHEMAS);

      expect(config.get('authz.impersonation')).to.deep.equal({ permission: DEFAULT_IMPERSONATION_PERMISSION, protectedRoles: [...DEFAULT_PROTECTED_ROLES] });
      expect(config.get('authz.http.access.domain')).to.equal(DEFAULT_ACCESS_DOMAIN);
    });

    it('keeps an empty protectedRoles list, which turns the protected-role rule off', async () => {
      const { config } = await bootChild({ authz: { impersonation: { protectedRoles: [] } } }, ...SCHEMAS);

      expect(config.get('authz.impersonation.protectedRoles')).to.deep.equal([]);
    });

    it('protects a 2.x role name that holds an inner space, as authz.rbac.roles accepts it', async () => {
      const { config } = await bootChild({ authz: { impersonation: { protectedRoles: ['Stock editor'] } } }, ...SCHEMAS);

      expect(config.get('authz.impersonation.protectedRoles')).to.deep.equal(['Stock editor']);
    });
  });

  describe('a bad value fails the boot with the full path of the bad key', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['an empty permission', { authz: { impersonation: { permission: '' } } }, 'authz.impersonation.permission'],
      ['a permission that is not a string', { authz: { impersonation: { permission: {} } } }, 'authz.impersonation.permission'],
      ['protectedRoles that is not a list', { authz: { impersonation: { protectedRoles: 'admin' } } }, 'authz.impersonation.protectedRoles'],
      ['an empty role name', { authz: { impersonation: { protectedRoles: ['admin', ''] } } }, 'authz.impersonation.protectedRoles.1'],
      ['a role name that is not a string', { authz: { impersonation: { protectedRoles: [{}] } } }, 'authz.impersonation.protectedRoles.0'],
      ['a number that coerces to a role name', { authz: { impersonation: { protectedRoles: [5] } } }, 'authz.impersonation.protectedRoles.0'],
      ['a boolean that coerces to a role name', { authz: { impersonation: { protectedRoles: [true] } } }, 'authz.impersonation.protectedRoles.0'],
      ['a role name with edge whitespace', { authz: { impersonation: { protectedRoles: ['admin '] } } }, 'authz.impersonation.protectedRoles.0'],
      ['a role name of true', { authz: { impersonation: { protectedRoles: ['true'] } } }, 'authz.impersonation.protectedRoles.0'],
      ['protectedRoles set to null', { authz: { impersonation: { protectedRoles: null } } }, 'authz.impersonation.protectedRoles'],
      ['impersonation set to null', { authz: { impersonation: null } }, 'authz.impersonation'],
      ['an empty access domain', { authz: { http: { access: { domain: '' } } } }, 'authz.http.access.domain'],
      ['an access domain that is not a string', { authz: { http: { access: { domain: [] } } } }, 'authz.http.access.domain'],
    ];

    for (const [label, values, path] of cases) {
      it(`for ${label}`, async () => {
        expect(await violationPaths(values, ...SCHEMAS)).to.include(path);
      });
    }
  });

  describe('@Config reads the configuration of the container the instance is handed', () => {
    const configured = { authz: { http: { access: { domain: 'tenant' } }, impersonation: { permission: 'user:take-over', protectedRoles: ['member'] } } };

    // These classes are root singletons, so DI hands them the root container; the test hands them the child's instead.
    const builtIn = async <T extends object>(make: () => T): Promise<T> => {
      const { child } = await bootChild(configured, ...SCHEMAS);
      const instance = make();
      (instance as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = child;
      return instance;
    };

    it('AuthzImpersonationGuard', async () => {
      const guard = await builtIn(() => new AuthzImpersonationGuard());

      expect(read(guard, 'AccessDomain')).to.equal('tenant');
      expect(read(guard, 'Permission')).to.equal('user:take-over');
    });

    it('AccessResponseExtension and RbacRoleSource', async () => {
      expect(read(await builtIn(() => new AccessResponseExtension()), 'AccessDomain')).to.equal('tenant');
      expect(read(await builtIn(() => new RbacRoleSource()), 'AccessDomain')).to.equal('tenant');
    });

    it('AuthzTargetGuard', async () => {
      const guard = await builtIn(() => new AuthzTargetGuard());

      expect(read(guard, 'AccessDomain')).to.equal('tenant');
      expect(read(guard, 'ProtectedRoles')).to.deep.equal(['member']);
    });
  });
});
