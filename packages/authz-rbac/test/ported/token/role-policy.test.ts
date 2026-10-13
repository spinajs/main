import { GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { fakeEvaluationContext, fakeModelInitContext, fixtureDsl, sealPrincipal, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, OwnRolesTokenRolePolicy, RbacModel, RbacService, TokenRolePolicy, TokenRoleRules, tokenRoleExtension } from '../../../src/index.js';
import { tokenPrincipal } from '../../token/token-handle.js';

const expect = chai.expect;
const { assignment, role } = fixtureDsl;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const alice = userPrincipal('alice');

const PERMISSIONS = ['doc:read', 'doc:admin', 'doc:extra', 'report:read', 'report:write'];
const ROLES = [role('user', ['doc:read']), role('admin', ['doc:admin']), role('extra', ['doc:extra']), role('reports.read', ['report:read']), role('reports.write', ['report:write'])];

/** Answers per profile; the '' key is the answer without one, so the owner-wide set and a profile's set can differ. */
class ScriptedPolicy extends TokenRolePolicy {
  answers: Record<string, readonly string[]> = {};
  profiles: readonly string[] = [];

  allowedRoles(_owner: Principal, roles: readonly string[], profile?: string): readonly string[] {
    return this.answers[profile ?? ''] ?? roles;
  }

  override allowedProfiles(): readonly string[] {
    return this.profiles;
  }
}

/** The owner holds `held` at GLOBAL; the model runs the token rules of `policy`. */
async function fixture(held: readonly string[], policy: TokenRolePolicy = new OwnRolesTokenRolePolicy()) {
  const store = new MemoryAssignmentStore(held.map((r) => assignment(`a-${r}`, alice, r)));
  const rules = new TokenRoleRules([], policy);
  const registry = new PermissionRegistryImpl();
  registry.register(
    PERMISSIONS.map((name) => ({ name })),
    'test',
  );
  registry.freeze();
  const options = { roles: new MemoryRoleStore(ROLES), assignments: store, log: { warn: () => undefined } };
  const model = new RbacModel({ ...options, extensions: [tokenRoleExtension(options, { rules })] });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
  const service = new RbacService(model);
  return {
    /** What a revoke does: the row goes and the cached assignments are dropped. */
    revoke(held: string) {
      store.remove(`a-${held}`);
      model.invalidate(['*']);
    },
    rules,
    permits: async (p: Principal, permission: string) => (await model.evaluate({ principal: p, permission, resource: GLOBAL }, fakeEvaluationContext({ now: NOW }))).permitWhen.op === 'true',
    effective: async (p: Principal) => (await service.rolesOf(p, GLOBAL, { ceiling: true })).map((h) => h.role).sort(),
    ownerRoles: async () => (await service.rolesOf(alice, GLOBAL, { ceiling: false })).map((h) => h.role),
  };
}

/** alice through a token; `roles` and `profile` as the token was created with. */
const token = (roles?: readonly string[], profile?: string): Principal => sealPrincipal(tokenPrincipal({ owner: alice, ...(roles ? { roles } : {}), ...(profile !== undefined ? { profile } : {}) }, 'tok', NOW));

describe('authz-rbac ported token: role policy at check time', () => {
  describe('the token carries what the owner holds', () => {
    it('keeps only the carried role: admin is held by the owner but not by the token (validate 1)', async () => {
      const f = await fixture(['user', 'admin']);
      expect(await f.effective(token(['user']))).to.deep.equal(['user']);
      expect(await f.permits(token(['user']), 'doc:admin')).to.equal(false);
      expect(await f.permits(alice, 'doc:admin')).to.equal(true);
    });

    it('shrinks when the owner loses an assignment, with no new token (validate 9)', async () => {
      const f = await fixture(['user', 'admin']);
      const t = token(['user', 'admin']);
      expect(await f.effective(t)).to.deep.equal(['admin', 'user']);
      expect(await f.permits(t, 'doc:admin')).to.equal(true);
      f.revoke('admin');
      expect(await f.effective(t)).to.deep.equal(['user']);
      expect(await f.permits(t, 'doc:admin')).to.equal(false);
      expect(await f.permits(t, 'doc:read')).to.equal(true);
    });

    it('an empty intersection is a principal with no roles: RBAC denies, nothing throws (validate 10)', async () => {
      const f = await fixture(['user', 'admin']);
      const t = token(['admin']);
      f.revoke('admin');
      expect(await f.effective(t)).to.deep.equal([]);
      for (const permission of PERMISSIONS) expect(await f.permits(t, permission), permission).to.equal(false);
      expect(await f.permits(alice, 'doc:read')).to.equal(true);
    });

    it('a token role the owner lacks grants nothing, not even next to roles the owner holds (crud 3, controller 4)', async () => {
      const f = await fixture(['user']);
      const t = token(['user', 'admin']);
      expect(await f.effective(t)).to.deep.equal(['user']);
      expect(await f.permits(t, 'doc:admin')).to.equal(false);
      expect(await f.permits(t, 'doc:read')).to.equal(true);
    });
  });

  describe('a policy that answers a role the owner lacks', () => {
    it('does not put it on the token: never above the owner (policy-actions 1; changed from 2.x, item 16 / r6 D3 / 18.3(g))', async () => {
      const policy = new ScriptedPolicy();
      policy.answers = { '': ['reports.read', 'reports.write', 'user'] };
      const f = await fixture(['user'], policy);
      const t = token(['reports.read']);
      expect(await f.effective(t)).to.deep.equal([]);
      expect(await f.permits(t, 'report:read')).to.equal(false);
      expect(await f.effective(token())).to.deep.equal(['user']);
    });

    it('answers the policy set cut to the owner roles, not the policy answer alone (controller-roles 8, 9; changed from 2.x, item 16 / r6 D3 / 18.3(g))', async () => {
      const policy = new ScriptedPolicy();
      policy.answers = { '': ['admin'] };
      const f = await fixture(['user'], policy);
      expect(f.rules.allowedRoles(alice, await f.ownerRoles())).to.deep.equal([]);
      const minted = token(['admin']);
      expect(await f.permits(minted, 'doc:admin')).to.equal(false);
      expect(await f.permits(minted, 'doc:read')).to.equal(false);
    });

    it('answers the policy set when the owner holds that role too (controller-roles 1)', async () => {
      const policy = new ScriptedPolicy();
      policy.answers = { '': ['user'] };
      const f = await fixture(['user', 'admin'], policy);
      expect(f.rules.allowedRoles(alice, await f.ownerRoles())).to.deep.equal(['user']);
    });
  });

  describe('a policy that narrows', () => {
    it('refuses a role the policy does not allow; the same owner via session keeps it (policy-actions 2)', async () => {
      const policy = new ScriptedPolicy();
      policy.answers = { '': ['reports.read'] };
      const f = await fixture(['reports.read', 'reports.write'], policy);
      const t = token(['reports.read', 'reports.write']);
      expect(await f.effective(t)).to.deep.equal(['reports.read']);
      expect(await f.permits(t, 'report:write')).to.equal(false);
      expect(await f.permits(alice, 'report:write')).to.equal(true);
    });

    it('follows a policy that narrows after the token was made (policy-actions 4)', async () => {
      const policy = new ScriptedPolicy();
      const f = await fixture(['reports.read', 'reports.write'], policy);
      const t = token(['reports.read', 'reports.write']);
      expect(await f.effective(t)).to.deep.equal(['reports.read', 'reports.write']);
      policy.answers = { '': ['reports.read'] };
      expect(await f.effective(t)).to.deep.equal(['reports.read']);
      expect(await f.permits(t, 'report:write')).to.equal(false);
      expect(await f.permits(alice, 'report:write')).to.equal(true);
    });

    it('a policy that allows nothing leaves a principal with no roles and denies, without throwing (policy-actions 5)', async () => {
      const policy = new ScriptedPolicy();
      const f = await fixture(['reports.read'], policy);
      const t = token(['reports.read']);
      expect(await f.permits(t, 'report:read')).to.equal(true);
      policy.answers = { '': [] };
      expect(await f.effective(t)).to.deep.equal([]);
      expect(await f.permits(t, 'report:read')).to.equal(false);
      expect(await f.permits(alice, 'report:read')).to.equal(true);
    });
  });

  describe('names that are not roles', () => {
    it('a role the policy returns but RBAC does not know never reaches the token (policy-actions 6)', async () => {
      const policy = new ScriptedPolicy();
      policy.answers = { '': ['reports.read', 'ghost-role'] };
      const f = await fixture(['reports.read', 'ghost-role'], policy);
      expect(f.rules.allowedRoles(alice, ['reports.read'])).to.deep.equal(['reports.read']);
      const t = token(['reports.read', 'ghost-role']);
      expect(await f.effective(alice)).to.deep.equal(['reports.read']);
      expect(await f.effective(t)).to.deep.equal(['reports.read']);
      expect(await f.permits(t, 'report:read')).to.equal(true);
    });

    it('prototype-chain names are never roles (policy-actions 7)', async () => {
      const names = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'];
      const policy = new ScriptedPolicy();
      policy.answers = { '': ['reports.read', ...names] };
      const f = await fixture(['reports.read', ...names], policy);
      expect(f.rules.allowedRoles(alice, ['reports.read'])).to.deep.equal(['reports.read']);
      expect(await f.effective(alice)).to.deep.equal(['reports.read']);
      expect(await f.effective(token(['reports.read', ...names]))).to.deep.equal(['reports.read']);
      expect(await f.effective(token(names))).to.deep.equal([]);
      expect(await f.permits(token(names), 'report:read')).to.equal(false);
    });

    it('a role the policy starts to return later never enters the effective roles (policy-actions 8)', async () => {
      const policy = new ScriptedPolicy();
      policy.answers = { '': ['reports.read'] };
      const f = await fixture(['reports.read', 'ghost-role'], policy);
      const t = token(['reports.read']);
      expect(await f.effective(t)).to.deep.equal(['reports.read']);
      policy.answers = { '': ['reports.read', 'ghost-role'] };
      expect(await f.effective(t)).to.deep.equal(['reports.read']);
    });
  });

  describe('profiles', () => {
    const profiled = async () => {
      const policy = new ScriptedPolicy();
      policy.profiles = ['admin'];
      policy.answers = { '': ['user', 'extra'], admin: ['user'] };
      return { policy, f: await fixture(['user', 'extra'], policy) };
    };

    it('the policy offers the profile and a token pinned to it gets the answer for that profile (crud 8, controller-roles 10)', async () => {
      const { f } = await profiled();
      const pinned = token(['user'], 'admin');
      expect(pinned.attributes.profile).to.equal('admin');
      expect(await f.effective(pinned)).to.deep.equal(['user']);
      expect(await f.permits(pinned, 'doc:read')).to.equal(true);
    });

    // The profile gate lives in authn-token, not here: see authn-token/test/v3/token-service.test.ts
    // 'fails a pinned token once its profile is no longer allowed'. RBAC never reads allowedProfiles.
    it('RBAC keeps the roles of a token pinned to a profile the policy does not offer; authn-token rejects such a token (crud 9)', async () => {
      const { f } = await profiled();
      const pinned = token(['user'], 'nope');
      expect(await f.effective(pinned)).to.deep.equal(['user']);
      expect(await f.permits(pinned, 'doc:read')).to.equal(true);
    });

    it('validates roles against the profile, not the owner union (crud 10, controller-roles 14)', async () => {
      const { f } = await profiled();
      const owned = await f.ownerRoles();
      expect(f.rules.allowedRoles(alice, ['extra'])).to.deep.equal(['extra']);
      expect(f.rules.allowedRoles(alice, ['extra'], 'admin')).to.deep.equal([]);
      expect(f.rules.allowedRoles(alice, owned, 'admin')).to.deep.equal(['user']);
      expect(await f.permits(token(['extra']), 'doc:extra')).to.equal(true);
      expect(await f.permits(token(['extra'], 'admin'), 'doc:extra')).to.equal(false);
    });

    it('answers the roles of the profile named in the query, the owner union without one (controller-roles 11)', async () => {
      const { f } = await profiled();
      const owned = await f.ownerRoles();
      expect([...f.rules.allowedRoles(alice, owned)].sort()).to.deep.equal(['extra', 'user']);
      expect(f.rules.allowedRoles(alice, owned, 'admin')).to.deep.equal(['user']);
    });

    it('intersects against the profile-relative set, while the owner-wide set still covers both (validate 14)', async () => {
      const { f } = await profiled();
      const t = token(['user', 'extra'], 'admin');
      expect(await f.effective(t)).to.deep.equal(['user']);
      expect(await f.permits(t, 'doc:extra')).to.equal(false);
      expect(await f.effective(token(['user', 'extra']))).to.deep.equal(['extra', 'user']);
    });

    it('RBAC keeps the roles when the owner no longer passes the profile; the gate is in authn-token (validate 13)', async () => {
      const { f, policy } = await profiled();
      const t = token(['user'], 'admin');
      policy.profiles = [];
      policy.answers = { '': ['user', 'extra'], admin: ['user', 'extra'] };
      expect(await f.effective(t)).to.deep.equal(['user']);
      expect(await f.permits(t, 'doc:read')).to.equal(true);
      expect(await f.permits(alice, 'doc:read')).to.equal(true);
    });

    it('a token without a profile ignores the profile gate (validate 15)', async () => {
      const { f, policy } = await profiled();
      policy.profiles = [];
      policy.answers = { '': ['user', 'extra'], admin: [] };
      const legacy = token(['extra']);
      expect(legacy.attributes.profile).to.equal(undefined);
      expect(await f.effective(legacy)).to.deep.equal(['extra']);
      expect(await f.permits(legacy, 'doc:extra')).to.equal(true);
    });

    it('the default policy offers no profile and ignores one (controller-roles 4)', async () => {
      const f = await fixture(['user']);
      expect(await f.rules.allowedProfiles(alice)).to.deep.equal([]);
      expect(f.rules.allowedRoles(alice, ['user'], 'admin')).to.deep.equal(['user']);
    });
  });
});
