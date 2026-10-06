import { AuthzConfigError, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, Principal } from '@spinajs/authz';
import { Container, DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { bootConfiguration, fakeModelInitContext, userPrincipal, violationPaths } from '@spinajs/authz-testing';
import type { Configuration } from '@spinajs/configuration';
import * as chai from 'chai';
import 'mocha';

import { AUTHZ_TOKEN_CONFIGURATION_SCHEMA, DEFAULT_TOKEN_ROLE_POLICY, MemoryAssignmentStore, MemoryRoleStore, OwnRolesTokenRolePolicy, RbacModel, RbacService, TokenRolePolicy, TokenRoleRules, isTokenPrincipal, loadTokenRoleRules, roleExcluded } from '../../src/index.js';
import type { RoleDef } from '../../src/index.js';

const expect = chai.expect;

const role = (name: string): RoleDef => ({ name, extends: [], assignable: true, source: 'test', grants: [] });
const assignment = (id: string, who: { type: string; id: string }, roleName: string): Assignment => ({ id, subject: { type: who.type, id: who.id }, role: roleName, scope: GLOBAL, source: 'test' });

const config = (values: Record<string, unknown> = {}) => ({
  get<T>(path: string | string[], dflt?: T): T {
    let cur: unknown = { authz: { token: values } };
    for (const seg of Array.isArray(path) ? path : path.split('.')) {
      if (cur === null || typeof cur !== 'object' || !(seg in cur)) return dflt as T;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return (cur === undefined ? dflt : cur) as T;
  },
});

/** The owner's roles as the role switch reads them: RBAC assignments, without the ceiling. */
async function ownerRoles(owner: Principal, roles: readonly string[]): Promise<string[]> {
  const registry = new PermissionRegistryImpl();
  registry.freeze();
  const model = new RbacModel({ roles: new MemoryRoleStore(['user', 'admin', 'viewer'].map(role)), assignments: new MemoryAssignmentStore(roles.map((r, i) => assignment(`a${i}`, owner, r))), log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
  return (await new RbacService(model).rolesOf(owner, GLOBAL, { ceiling: false })).map((h) => h.role);
}

class RefuseAdminTokenRolePolicy extends TokenRolePolicy {
  allowedRoles(_owner: Principal, roles: readonly string[]): readonly string[] {
    return roles.filter((r) => r !== 'admin');
  }
}

class WideningTokenRolePolicy extends TokenRolePolicy {
  allowedRoles(): readonly string[] {
    return ['admin', 'route.home', 'viewer'];
  }
}

class ProfilesTokenRolePolicy extends TokenRolePolicy {
  allowedRoles(_owner: Principal, roles: readonly string[]): readonly string[] {
    return roles;
  }

  override allowedProfiles(): readonly string[] {
    return ['ci'];
  }
}

describe('authz-rbac token: role rules', () => {
  const owner = userPrincipal('alice');

  describe('OwnRolesTokenRolePolicy', () => {
    it('allows exactly the roles the owner holds', async () => {
      const rules = new TokenRoleRules([], new OwnRolesTokenRolePolicy());
      expect(rules.allowedRoles(owner, await ownerRoles(owner, ['user', 'admin']))).to.deep.equal(['user', 'admin']);
    });

    it('allows nothing for an owner with no roles', async () => {
      const rules = new TokenRoleRules([], new OwnRolesTokenRolePolicy());
      expect(rules.allowedRoles(owner, await ownerRoles(owner, []))).to.deep.equal([]);
    });

    it('ignores the profile argument - answer stays the owner roles', async () => {
      const rules = new TokenRoleRules([], new OwnRolesTokenRolePolicy());
      expect(rules.allowedRoles(owner, await ownerRoles(owner, ['user', 'admin']), 'admin')).to.deep.equal(['user', 'admin']);
    });

    it('offers no profiles by default - the feature is opt-in per application', async () => {
      const rules = new TokenRoleRules([], new OwnRolesTokenRolePolicy());
      expect(await rules.allowedProfiles(owner)).to.deep.equal([]);
    });
  });

  describe('roleExcluded', () => {
    it('matches an exact name', () => {
      expect(roleExcluded('route.home', ['route.home'])).to.equal(true);
      expect(roleExcluded('route.admin', ['route.home'])).to.equal(false);
    });

    it('matches a prefix pattern and everything under it', () => {
      expect(roleExcluded('route.home', ['route.*'])).to.equal(true);
      expect(roleExcluded('route.admin.users', ['route.*'])).to.equal(true);
    });

    it('does not treat the prefix as a bare string match', () => {
      expect(roleExcluded('routes.read', ['route.*'])).to.equal(false);
    });

    it('excludes nothing when no patterns are given', () => {
      expect(roleExcluded('route.home', [])).to.equal(false);
    });

    it('does not match the bare prefix', () => {
      expect(roleExcluded('route', ['route.*'])).to.equal(false);
    });
  });

  describe('isTokenPrincipal', () => {
    const facts = { strategy: 'token', assurance: 'aal1', mfa: [], authenticatedAt: new Date(0) };

    it('is true only for authn.method token', () => {
      expect(isTokenPrincipal({ ...owner, authn: { ...facts, method: 'token' } } as Principal)).to.equal(true);
      expect(isTokenPrincipal({ ...owner, authn: { ...facts, method: 'password' } } as Principal)).to.equal(false);
      expect(isTokenPrincipal(owner)).to.equal(false);
      expect(isTokenPrincipal(undefined)).to.equal(false);
    });

    it('fails closed: an authn that cannot be read, or is not an object, counts as a token', () => {
      const throwing = Object.defineProperty({ ...owner }, 'authn', {
        get() {
          throw new Error('unreadable');
        },
      }) as Principal;
      expect(isTokenPrincipal(throwing)).to.equal(true);
      expect(isTokenPrincipal({ ...owner, authn: 'token' } as unknown as Principal)).to.equal(true);
    });
  });

  describe('TokenRoleRules', () => {
    it('cuts excluded roles before the policy sees them, and every answer to the roles it was given', () => {
      const seen: (readonly string[])[] = [];
      const policy = new (class extends TokenRolePolicy {
        allowedRoles(_owner: Principal, roles: readonly string[]): readonly string[] {
          seen.push(roles);
          return ['admin', 'route.home', 'viewer', 'viewer', 'user'];
        }
      })();
      const rules = new TokenRoleRules(['route.*'], policy);
      expect(rules.allowedRoles(owner, ['user', 'route.home', 'viewer', 'user'])).to.deep.equal(['user', 'viewer']);
      expect(seen).to.deep.equal([['user', 'viewer']]);
    });

    it('throws when the policy throws or answers anything but an array (fail closed)', () => {
      const throwing = new (class extends TokenRolePolicy {
        allowedRoles(): readonly string[] {
          throw new Error('policy down');
        }
      })();
      const promising = new (class extends TokenRolePolicy {
        allowedRoles(): readonly string[] {
          return Promise.resolve(['user']) as unknown as readonly string[];
        }
      })();
      expect(() => new TokenRoleRules([], throwing).allowedRoles(owner, ['user'])).to.throw('policy down');
      expect(() => new TokenRoleRules([], promising).allowedRoles(owner, ['user'])).to.throw(/TokenRolePolicy/);
    });

    it('is trivial only without excluded roles and with exactly the default policy', () => {
      class OwnRolesSubclass extends OwnRolesTokenRolePolicy {}
      expect(new TokenRoleRules([], new OwnRolesTokenRolePolicy()).trivial).to.equal(true);
      expect(new TokenRoleRules(['route.*'], new OwnRolesTokenRolePolicy()).trivial).to.equal(false);
      expect(new TokenRoleRules([], new OwnRolesSubclass()).trivial).to.equal(false);
      expect(new TokenRoleRules([], new RefuseAdminTokenRolePolicy()).trivial).to.equal(false);
    });

    it('gives the policy profiles', async () => {
      expect(await new TokenRoleRules([], new ProfilesTokenRolePolicy()).allowedProfiles(owner)).to.deep.equal(['ci']);
    });

    it('is immutable', () => {
      const rules = new TokenRoleRules(['route.*'], new OwnRolesTokenRolePolicy());
      expect(Object.isFrozen(rules)).to.equal(true);
      expect(Object.isFrozen(rules.excludedRoles)).to.equal(true);
    });
  });

  describe('loadTokenRoleRules', () => {
    let container: IContainer;

    beforeEach(() => {
      container = DI.RootContainer.child();
    });

    afterEach(async () => {
      await container.dispose();
    });

    it('defaults to no excluded roles and OwnRolesTokenRolePolicy', async () => {
      const rules = await loadTokenRoleRules(config(), container);
      expect(rules.excludedRoles).to.deep.equal([]);
      expect(rules.policy).to.be.instanceOf(OwnRolesTokenRolePolicy);
      expect(rules.trivial).to.equal(true);
    });

    it('reads authz.token.excludedRoles', async () => {
      const rules = await loadTokenRoleRules(config({ excludedRoles: ['route.*', 'admin'] }), container);
      expect(rules.excludedRoles).to.deep.equal(['route.*', 'admin']);
      expect(rules.excluded('route.home')).to.equal(true);
      expect(rules.excluded('admin')).to.equal(true);
      expect(rules.excluded('routes.read')).to.equal(false);
      expect(rules.trivial).to.equal(false);
    });

    const failOpen: [string, unknown][] = [
      ['not an array', 'route.*'],
      ['a non-string entry', [1]],
      ['a full glob', ['*']],
      ['a star before the end', ['route.*.admin']],
    ];
    for (const [title, value] of failOpen) {
      it(`refuses authz.token.excludedRoles with ${title} on a configuration no schema validated`, async () => {
        const err = await loadTokenRoleRules(config({ excludedRoles: value }), container).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).to.be.instanceOf(AuthzConfigError);
        expect((err as Error).message).to.contain('authz.token.excludedRoles');
      });
    }

    const failOpenPolicy: [string, unknown][] = [
      ['a rolePolicy that is a string', 'RefuseAdminTokenRolePolicy'],
      ['a rolePolicy that is null', null],
      ['a rolePolicy that is an array', ['RefuseAdminTokenRolePolicy']],
      ['a service that is not a string', { service: 3 }],
      ['an empty service', { service: '' }],
    ];
    for (const [title, value] of failOpenPolicy) {
      it(`refuses ${title} on a configuration no schema validated`, async () => {
        const err = await loadTokenRoleRules(config({ rolePolicy: value }), container).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).to.be.instanceOf(AuthzConfigError);
        expect((err as Error).message).to.contain('authz.token.rolePolicy.service');
      });
    }

    it('refuses a service name no TokenRolePolicy class carries, naming the key and the service', async () => {
      const err = await loadTokenRoleRules(config({ rolePolicy: { service: 'NoSuchPolicy' } }), container).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect((err as Error).message)
        .to.contain('authz.token.rolePolicy.service')
        .and.to.contain('NoSuchPolicy');
    });

    it('picks a registered policy by its class name', async () => {
      container.register(RefuseAdminTokenRolePolicy).as(TokenRolePolicy);
      container.register(ProfilesTokenRolePolicy).as(TokenRolePolicy);
      const rules = await loadTokenRoleRules(config({ rolePolicy: { service: 'RefuseAdminTokenRolePolicy' } }), container);
      expect(rules.policy).to.be.instanceOf(RefuseAdminTokenRolePolicy);
      expect(rules.allowedRoles(owner, ['user', 'admin'])).to.deep.equal(['user']);
      expect(rules.trivial).to.equal(false);
    });

    it('never widens: a policy answer outside the given roles, or an excluded one, is cut', async () => {
      container.register(WideningTokenRolePolicy).as(TokenRolePolicy);
      const rules = await loadTokenRoleRules(config({ rolePolicy: { service: 'WideningTokenRolePolicy' }, excludedRoles: ['route.*'] }), container);
      expect(rules.allowedRoles(owner, ['user', 'viewer', 'route.home'])).to.deep.equal(['viewer']);
    });

    it('falls back to OwnRolesTokenRolePolicy when the default name has no registration', async () => {
      const bare = new Container();
      const rules = await loadTokenRoleRules(config(), bare);
      expect(rules.policy.constructor).to.equal(OwnRolesTokenRolePolicy);
      const err = await loadTokenRoleRules(config({ rolePolicy: { service: 'RefuseAdminTokenRolePolicy' } }), bare).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).to.be.instanceOf(AuthzConfigError);
    });

    describe('the authz.token schema', () => {
      const children: IContainer[] = [];

      afterEach(async () => {
        for (const c of children.splice(0)) await c.dispose();
      });

      async function boot(token: unknown): Promise<Configuration> {
        const booted = await bootConfiguration({ authz: { token } }, [AUTHZ_TOKEN_CONFIGURATION_SCHEMA]);
        children.push(booted.child);
        return booted.configuration;
      }

      const refused = (token: unknown) => violationPaths(boot(token));

      it('defaults to no excluded roles and OwnRolesTokenRolePolicy', async () => {
        expect((await boot(undefined)).get('authz.token')).to.deep.equal({ excludedRoles: [], rolePolicy: { service: DEFAULT_TOKEN_ROLE_POLICY } });
      });

      it('feeds loadTokenRoleRules', async () => {
        const rules = await loadTokenRoleRules(await boot({ excludedRoles: ['route.*'] }), container);
        expect(rules.excludedRoles).to.deep.equal(['route.*']);
        expect(rules.policy).to.be.instanceOf(OwnRolesTokenRolePolicy);
      });

      const badExcluded: [string, unknown][] = [
        ['not an array', 'route.*'],
        ['an empty name', ['']],
        ['a full glob', ['*']],
        ['a star inside a name', ['route*']],
        ['a star before the end', ['route.*.admin']],
        ['two stars', ['route.*.*']],
        ['an empty prefix', ['.*']],
      ];
      for (const [title, value] of badExcluded) {
        it(`refuses authz.token.excludedRoles with ${title} at boot`, async () => {
          expect((await refused({ excludedRoles: value })).some((p) => p.startsWith('authz.token.excludedRoles'))).to.equal(true);
        });
      }

      it('refuses a rolePolicy that is not an object, or an empty service name, at boot', async () => {
        expect(await refused({ rolePolicy: 'OwnRolesTokenRolePolicy' })).to.include('authz.token.rolePolicy');
        expect(await refused({ rolePolicy: { service: '' } })).to.include('authz.token.rolePolicy.service');
      });
    });
  });
});
