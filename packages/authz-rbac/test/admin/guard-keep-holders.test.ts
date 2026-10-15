import * as chai from 'chai';
import 'mocha';
import { AUTHZ_CONFIGURATION_SCHEMA, AuthzConfigError, PermissionRegistryImpl, SYSTEM } from '@spinajs/authz';
import type { AuthzCommand, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { bootConfiguration, fakeModelInitContext, userPrincipal, violationPaths } from '@spinajs/authz-testing';

import { AUTHZ_RBAC_GUARD_CONFIGURATION_SCHEMA, AdminMembershipStore, MembershipStore, MemoryAssignmentStore, MemoryMembershipStore, MemoryRoleStore, RbacModel, guardSwitches } from '../../src/index.js';
import type { Assignment, AssignmentSubject, LadderDef, RoleDef } from '../../src/index.js';
import { START, StaticRoleStore, failure, installHost, instance, ok, rbacDomain, rejection, resetHost, uninstallHost } from './support.js';
import type { RbacDomain } from './support.js';

const expect = chai.expect;

const role = (name: string, extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], grants: [], assignable: true, source: 'test', ...extra });
// Teams design §4: team.member is a subject set and the lowest role of the team ladder.
const TEAM_ROLES: RoleDef[] = [role('team.member', { subjectSet: true, scopeTypes: ['team'], ladder: 'team', grants: [{ permission: 'team:read' }] }), role('team.admin', { scopeTypes: ['team'], ladder: 'team', extends: ['team.member'] }), role('team.owner', { scopeTypes: ['team'], ladder: 'team', extends: ['team.admin'] }), role('group.member', { subjectSet: true, scopeTypes: ['group'] })];
const TEAM_LADDERS: LadderDef[] = [{ name: 'team', roles: ['team.member', 'team.admin', 'team.owner'] }];
const KEEP_OWNERS = [{ role: 'team.owner', scopeType: 'team' }];

const alice = userPrincipal('alice');
const user = (id: string): PrincipalRef => ({ type: 'user', id });
const ANN = user('ann');
const BOB = user('bob');
const DAVE = user('dave');
const team = (id: string): ResourceRef => ({ type: 'team', id });
const group = (id: string): ResourceRef => ({ type: 'group', id });
const T1 = team('t1');
const groupSet = (id: string): AssignmentSubject => ({ set: { role: 'group.member', scope: group(id) } });
const OWNER_ANN: Assignment = { id: 'own-ann', subject: ANN, role: 'team.owner', scope: T1, tags: [], expiresAt: null, source: 'test' };

const revoke = (id: string): AuthzCommand => ({ kind: 'assignment.revoke', id });
const grantOwner = (subject: AssignmentSubject): AuthzCommand => ({ kind: 'assignment.grant', subject, role: 'team.owner', scope: T1 });
const join = (u: PrincipalRef, g: string): AuthzCommand => ({ kind: 'set.addMember', set: { role: 'group.member', scope: group(g) }, member: u });
const leave = (u: PrincipalRef, g: string): AuthzCommand => ({ kind: 'set.removeMember', set: { role: 'group.member', scope: group(g) }, member: u });
const nest = (inner: string, outer: string): AuthzCommand => ({ kind: 'assignment.grant', subject: groupSet(inner), role: 'group.member', scope: group(outer) });

describe('authz.admin.guard.keepHolders (teams design §5)', () => {
  const base = { preventSelfLockout: false, preventLastPrivilegedRemoval: false };

  it('guardSwitches reads keepHolders: absent is none, a malformed value is refused', () => {
    expect(guardSwitches(base, 'here').keepHolders).to.deep.equal([]);
    expect(guardSwitches({ ...base, keepHolders: KEEP_OWNERS }, 'here').keepHolders).to.deep.equal(KEEP_OWNERS);
    for (const bad of [{ role: 'team.owner' }, [{ role: 'team.owner' }], [{ role: '', scopeType: 'team' }], [{ role: 'team.owner', scopeType: 'team', at: 'x' }]]) {
      expect(() => guardSwitches({ ...base, keepHolders: bad }, 'here'), JSON.stringify(bad)).to.throw(AuthzConfigError, /^here: authz\.admin\.guard\.keepHolders must be an array of \{ role, scopeType \}/);
    }
  });

  it('the authz-rbac guard schema checks keepHolders', async () => {
    const boot = (keepHolders: unknown) => bootConfiguration({ authz: { admin: { guard: { privilegedPermission: 'users:update', keepHolders } } } }, [AUTHZ_CONFIGURATION_SCHEMA, AUTHZ_RBAC_GUARD_CONFIGURATION_SCHEMA]);
    const booted = await boot(KEEP_OWNERS);
    expect(booted.configuration.get(['authz', 'admin', 'guard', 'keepHolders'])).to.deep.equal(KEEP_OWNERS);
    await booted.child.dispose();
    for (const bad of [{ role: 'team.owner' }, [{ role: 'team.owner' }], [{ role: 'team.owner', scopeType: 'team', at: 'x' }]]) {
      expect(
        (await violationPaths(boot(bad))).some((p) => p.startsWith('authz.admin.guard.keepHolders')),
        JSON.stringify(bad),
      ).to.equal(true);
    }
  });

  it('compiles the teams roles: a subjectSet role may be a ladder role (teams design §4)', async () => {
    const registry = new PermissionRegistryImpl();
    registry.register([{ name: 'team:read', types: ['team'] }], 'test');
    registry.freeze();
    const model = new RbacModel({ roles: new MemoryRoleStore(TEAM_ROLES, TEAM_LADDERS), assignments: new MemoryAssignmentStore(), log: { warn: () => undefined } });
    await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
    expect(model.grantIndex().granted('team:read')).to.equal(true);
  });

  describe('in an admin batch', function () {
    this.timeout(20000);
    let d: RbacDomain;

    before(async () => {
      await installHost();
    });
    after(async () => {
      await uninstallHost();
    });
    beforeEach(async () => {
      await resetHost();
    });

    // Only keepHolders on: the other guard rules have their own suites.
    async function domain(keepHolders: unknown = KEEP_OWNERS): Promise<RbacDomain> {
      const m = new MemoryMembershipStore();
      d = await rbacDomain('test', {
        roleStores: [new StaticRoleStore('teams', TEAM_ROLES, TEAM_LADDERS)],
        assignments: [OWNER_ANN],
        admin: { backend: 'TestBackend', guard: { service: 'DefaultAdminGuard', protectSystemRole: true, preventEscalation: false, preventSelfLockout: false, preventLastPrivilegedRemoval: false, keepHolders } },
        permissions: { 'authz:assignments.manage': { types: ['org', 'project', 'file', 'group', 'team'] } },
        register: (c) => {
          c.register(instance(m)).as(MembershipStore);
          c.register(instance(m)).as(AdminMembershipStore);
        },
      });
      return d;
    }

    const owners = async () =>
      (await d.assignments.find({ scope: T1, role: 'team.owner', at: START })).items
        .filter((a) => !('set' in a.subject))
        .map((a) => (a.subject as PrincipalRef).id)
        .sort();

    it('refuses to revoke, demote or revokeWhere the last owner of a team (last_holder)', async () => {
      await domain();
      expect(failure(await d.admin.execute(alice, [revoke('own-ann')]))).to.deep.equal({ at: 0, code: 'last_holder', field: 'id' });
      expect(failure(await d.admin.execute(alice, [{ kind: 'assignment.grant', subject: ANN, role: 'team.admin', scope: T1, replaceLadder: true }]))).to.include({ at: 0, code: 'last_holder' });
      expect(failure(await d.admin.execute(alice, [{ kind: 'assignment.revokeWhere', scope: T1, subject: ANN }]))).to.include({ at: 0, code: 'last_holder' });
      expect(await owners()).to.deep.equal(['ann']);
    });

    it('with a second owner the revoke goes through', async () => {
      await domain();
      ok(await d.admin.execute(alice, [grantOwner(BOB)]));
      ok(await d.admin.execute(alice, [revoke('own-ann')]));
      expect(await owners()).to.deep.equal(['bob']);
    });

    it('an owner held only through a group holds while the group keeps a live member', async () => {
      await domain();
      ok(await d.admin.execute(alice, [join(DAVE, 'g1'), grantOwner(groupSet('g1'))]));
      ok(await d.admin.execute(alice, [revoke('own-ann')]));
      expect(failure(await d.admin.execute(alice, [leave(DAVE, 'g1')]))).to.include({ at: 0, code: 'last_holder' });
      // A member through a nested group keeps g1 live, so dave may leave.
      ok(await d.admin.execute(alice, [join(BOB, 'g2'), nest('g2', 'g1')]));
      ok(await d.admin.execute(alice, [leave(DAVE, 'g1')]));
      expect(failure(await d.admin.execute(alice, [leave(BOB, 'g2')]))).to.include({ at: 0, code: 'last_holder' });
      expect(failure(await d.admin.execute(alice, [{ kind: 'assignment.revokeWhere', scope: group('g1'), subject: groupSet('g2'), role: 'group.member' }]))).to.include({ at: 0, code: 'last_holder' });
      expect(failure(await d.admin.execute(alice, [{ kind: 'assignment.revokeWhere', scope: T1, subject: groupSet('g1'), role: 'team.owner' }]))).to.include({ at: 0, code: 'last_holder' });
    });

    it('a transfer in one batch goes through when the grant comes first', async () => {
      await domain();
      ok(await d.admin.execute(alice, [grantOwner(BOB), revoke('own-ann')]));
      expect(await owners()).to.deep.equal(['bob']);
      const [bobRow] = (await d.assignments.find({ scope: T1, subject: BOB, at: START })).items;
      expect(failure(await d.admin.execute(alice, [revoke(bobRow.id), grantOwner(ANN)]))).to.deep.equal({ at: 0, code: 'last_holder', field: 'id' });
      expect(await owners()).to.deep.equal(['bob']);
    });

    it('SYSTEM skips it, like every guard rule', async () => {
      await domain();
      ok(await d.admin.execute(SYSTEM, [revoke('own-ann')]));
      expect(await owners()).to.deep.equal([]);
    });

    it('does not check scopes the command takes no holder path from', async () => {
      await domain();
      ok(await d.admin.execute(alice, [{ kind: 'assignment.grant', subject: BOB, role: 'team.member', scope: team('t2') }, join(BOB, 'g1')]));
      const rows = (await d.assignments.find({ subject: BOB, at: START })).items;
      ok(
        await d.admin.execute(
          alice,
          rows.map((r) => revoke(r.id)),
        ),
      );
    });

    it('a keepHolders role no RoleStore defines is a configuration error', async () => {
      await domain([{ role: 'team.boss', scopeType: 'team' }]);
      const err = await rejection(d.admin.execute(alice, [revoke('own-ann')]));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.match(/authz\.admin\.guard\.keepHolders names role "team\.boss", which no RoleStore defines/);
    });
  });
});
