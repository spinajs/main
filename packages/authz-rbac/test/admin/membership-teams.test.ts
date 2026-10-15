import * as chai from 'chai';
import 'mocha';
import { MemoryAuthzAdminBackend } from '@spinajs/authz';
import type { AuthzCommand, AuthzService, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { userPrincipal } from '@spinajs/authz-testing';

import { AdminMembershipStore, MembershipStore, MembershipVerifyCommand, MemoryMembershipStore, loadRoleIndex } from '../../src/index.js';
import type { AssignmentSubject, LadderDef, RoleDef } from '../../src/index.js';
import { capture } from '../cli/fixture.js';
import { START, StaticRoleStore, failure, installHost, instance, ok, rbacDomain, resetHost, uninstallHost } from './support.js';
import type { RbacDomain } from './support.js';

const expect = chai.expect;

const role = (name: string, extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], grants: [], assignable: true, source: 'test', ...extra });
// Teams design §4 without grants: membership reads only subjectSet, extends, ladders and scopeTypes.
const TEAM_ROLES: RoleDef[] = [
  role('team.member', { subjectSet: true, scopeTypes: ['team'], ladder: 'team' }),
  role('team.admin', { scopeTypes: ['team'], ladder: 'team', extends: ['team.member'] }),
  role('team.owner', { scopeTypes: ['team'], ladder: 'team', extends: ['team.admin'] }),
  role('group.member', { subjectSet: true, scopeTypes: ['group'] }),
  role('group.manager', { scopeTypes: ['group'], extends: ['group.member'] }),
];
const TEAM_LADDERS: LadderDef[] = [{ name: 'team', roles: ['team.member', 'team.admin', 'team.owner'] }];

const alice = userPrincipal('alice');
const user = (id: string): PrincipalRef => ({ type: 'user', id });
const team = (id: string): ResourceRef => ({ type: 'team', id });
const group = (id: string): ResourceRef => ({ type: 'group', id });
const teamSet = (id: string): AssignmentSubject => ({ set: { role: 'team.member', scope: team(id) } });
const groupSet = (id: string): AssignmentSubject => ({ set: { role: 'group.member', scope: group(id) } });
const TK = (id: string) => `team:${id}#team.member`;
const GK = (id: string) => `group:${id}#group.member`;

const joinGroup = (u: string, g: string): AuthzCommand => ({ kind: 'set.addMember', set: { role: 'group.member', scope: group(g) }, member: user(u) });
const joinTeam = (u: string, t: string): AuthzCommand => ({ kind: 'set.addMember', set: { role: 'team.member', scope: team(t) }, member: user(u) });
const groupInGroup = (inner: string, outer: string): AuthzCommand => ({ kind: 'assignment.grant', subject: groupSet(inner), role: 'group.member', scope: group(outer) });
const groupInTeam = (g: string, t: string): AuthzCommand => ({ kind: 'assignment.grant', subject: groupSet(g), role: 'team.member', scope: team(t) });
const teamInTeam = (child: string, parent: string): AuthzCommand => ({ kind: 'assignment.grant', subject: teamSet(child), role: 'team.member', scope: team(parent) });
const unlinkGroup = (g: string, t: string): AuthzCommand => ({ kind: 'assignment.revokeWhere', scope: team(t), subject: groupSet(g), role: 'team.member' });

const passThrough = { runAs: (_p: unknown, _r: unknown, fn: () => Promise<unknown>) => fn() } as unknown as AuthzService;

describe('set-in-set membership for teams (teams design §3)', function () {
  this.timeout(20000);
  let d: RbacDomain;
  let m: MemoryMembershipStore;

  before(async () => {
    await installHost();
  });
  after(async () => {
    await uninstallHost();
  });
  beforeEach(async () => {
    await resetHost();
    m = new MemoryMembershipStore();
    d = await rbacDomain('test', {
      roleStores: [new StaticRoleStore('teams', TEAM_ROLES, TEAM_LADDERS)],
      permissions: { 'authz:assignments.manage': { types: ['org', 'project', 'file', 'group', 'team'] } },
      register: (c) => {
        c.register(instance(m)).as(MembershipStore);
        c.register(instance(m)).as(AdminMembershipStore);
      },
    });
  });

  const run = async (...commands: AuthzCommand[]) => ok(await d.admin.execute(alice, commands));
  const depths = async (memberKey: string) => (await m.rowsOf([memberKey])).map((r) => [r.setKey, r.depth]);
  const members = (setKey: string) => m.membersOf(setKey, START);

  /** authz:membership-verify over the domain's stores reports no difference. */
  async function verified(): Promise<void> {
    const cmd = new MembershipVerifyCommand();
    cmd.Authz = passThrough;
    cmd.Membership = { roles: await loadRoleIndex(d.container, 'test'), assignments: d.assignments, memberships: m, backend: new MemoryAuthzAdminBackend(), maxDepth: 8 };
    const io = capture();
    try {
      await cmd.execute();
      expect({ out: [...io.out], err: [...io.err], exitCode: io.exitCode() }).to.deep.equal({ out: ['OK: authz_subject_membership matches the assignments'], err: [], exitCode: undefined });
    } finally {
      io.restore();
    }
  }

  it('team ⊃ group ⊃ group ⊃ user, whatever the order of the writes', async () => {
    await run(joinGroup('dave', 'g2'), groupInGroup('g2', 'g1'), groupInTeam('g1', 't1'));
    expect(await depths('user:dave')).to.deep.equal([[GK('g1'), 2], [GK('g2'), 1], [TK('t1'), 3]]);
    expect(await members(TK('t1'))).to.deep.equal([GK('g1'), GK('g2'), 'user:dave']);
    await run(groupInTeam('g3', 't2'));
    await run(groupInGroup('g4', 'g3'));
    await run(joinGroup('erin', 'g4'));
    expect(await depths('user:erin')).to.deep.equal([[GK('g3'), 2], [GK('g4'), 1], [TK('t2'), 3]]);
    await verified();
  });

  it('a sub-team set inside its parent team set; a cycle through teams is refused', async () => {
    await run(joinTeam('ann', 't1'), joinGroup('dave', 'g1'), groupInTeam('g1', 't1'), teamInTeam('t1', 'tp'));
    expect(await depths('user:ann')).to.deep.equal([[TK('t1'), 1], [TK('tp'), 2]]);
    expect(await depths('user:dave')).to.deep.equal([[GK('g1'), 1], [TK('t1'), 2], [TK('tp'), 3]]);
    expect(await members(TK('tp'))).to.deep.equal([GK('g1'), TK('t1'), 'user:ann', 'user:dave']);
    expect(failure(await d.admin.execute(alice, [teamInTeam('tp', 't1')]))).to.include({ at: 0, code: 'set_cycle' });
    await run({ kind: 'assignment.revokeWhere', scope: team('tp'), subject: teamSet('t1'), role: 'team.member' });
    expect(await depths('user:ann')).to.deep.equal([[TK('t1'), 1]]);
    expect(await members(TK('tp'))).to.deep.equal([]);
    await verified();
  });

  it('membership through a role that extends a subject-set role, held by a user or by a set', async () => {
    await run({ kind: 'assignment.grant', subject: user('erin'), role: 'team.admin', scope: team('t1') });
    expect(await depths('user:erin')).to.deep.equal([[TK('t1'), 1]]);
    await run({ kind: 'assignment.grant', subject: user('erin'), role: 'team.owner', scope: team('t1'), replaceLadder: true });
    expect((await d.assignments.find({ subject: user('erin'), at: START })).items.map((a) => a.role)).to.deep.equal(['team.owner']);
    expect(await depths('user:erin')).to.deep.equal([[TK('t1'), 1]]);
    await run(joinGroup('dave', 'g1'), { kind: 'assignment.grant', subject: groupSet('g1'), role: 'team.admin', scope: team('t1') });
    expect(await depths('user:dave')).to.deep.equal([[GK('g1'), 1], [TK('t1'), 2]]);
    await run({ kind: 'assignment.grant', subject: user('fay'), role: 'group.manager', scope: group('g1') });
    expect(await depths('user:fay')).to.deep.equal([[GK('g1'), 1], [TK('t1'), 2]]);
    await run({ kind: 'assignment.revokeWhere', scope: team('t1'), subject: user('erin') });
    expect(await depths('user:erin')).to.deep.equal([]);
    expect(await members(TK('t1'))).to.deep.equal([GK('g1'), 'user:dave', 'user:fay']);
    await verified();
  });

  it('moving a group set to another team in one batch (remove + add) leaves the closure exact', async () => {
    await run(joinGroup('dave', 'g2'), groupInGroup('g2', 'g1'), groupInTeam('g1', 't1'), joinTeam('ann', 't1'));
    await run(unlinkGroup('g1', 't1'), groupInTeam('g1', 't2'));
    expect(await depths('user:dave')).to.deep.equal([[GK('g1'), 2], [GK('g2'), 1], [TK('t2'), 3]]);
    expect(await depths(GK('g1'))).to.deep.equal([[TK('t2'), 1]]);
    expect(await members(TK('t1'))).to.deep.equal(['user:ann']);
    expect(await members(TK('t2'))).to.deep.equal([GK('g1'), GK('g2'), 'user:dave']);
    await verified();
    // Add first, then remove: the same end state on the other team.
    await run(groupInTeam('g1', 't1'), unlinkGroup('g1', 't2'));
    expect(await depths('user:dave')).to.deep.equal([[GK('g1'), 2], [GK('g2'), 1], [TK('t1'), 3]]);
    expect(await members(TK('t2'))).to.deep.equal([]);
    await verified();
  });
});
