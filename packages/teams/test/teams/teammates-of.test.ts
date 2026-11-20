import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { AccessDenied, SYSTEM } from '@spinajs/authz';
import type { Principal, PrincipalRef } from '@spinajs/authz';
import { userPrincipal } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';

import { GroupService, TeamService } from '../../src/index.js';
import type { Teammates, TeamView } from '../../src/index.js';
import { execute } from '../../src/host.js';
import { principalTeammates } from '../../src/membership.js';
import { teamRef } from '../../src/refs.js';
import { failure, person, refOf, teamCreator } from '../support/people.js';
import { teamsStack } from '../support/stack.js';

const expect = chai.expect;
const slug = (s: string) => `${s}-${randomUUID().slice(0, 8)}`;

/** Per team id, each member's [id, roles]. */
const shape = (of: readonly Teammates[]) => Object.fromEntries(of.map((t) => [t.teamId, t.members.map((m) => [m.subject.id, m.roles])]));
const sortedIds = (...ps: PrincipalRef[]) => ps.map((p) => p.id).sort();

describe('TeamService.teammatesOf', function () {
  let teams: TeamService;
  let groups: GroupService;

  before(async () => {
    await teamsStack();
    teams = await DI.resolve<TeamService>(TeamService);
    groups = await DI.resolve<GroupService>(GroupService);
  });

  async function ownedTeam(name = 'T', parentId?: string): Promise<{ owner: Principal; team: TeamView }> {
    const owner = await teamCreator('owner');
    return { owner, team: await teams.createTeam(owner, { slug: slug('t'), name, ...(parentId ? { parentId } : {}) }) };
  }

  it('lists the other members of each of the principal’s teams', async () => {
    const one = await ownedTeam('One');
    const two = await ownedTeam('Two');
    const [m, a, b, c] = [person('m'), person('a'), person('b'), person('c')];
    for (const p of [m, a, b]) await teams.addTeamMember(one.owner, one.team.id, refOf(p));
    for (const p of [m, c]) await teams.addTeamMember(two.owner, two.team.id, refOf(p));

    const of = await teams.teammatesOf(refOf(m));
    expect(of.map((t) => t.teamId)).to.deep.equal([one.team.id, two.team.id]);
    expect(of[0].members.map((e) => e.subject.id)).to.deep.equal(sortedIds(a, b));
    expect(of[0].members.every((e) => e.subject.type === 'user' && e.roles.length === 1 && e.roles[0] === 'team.member')).to.equal(true);
    expect(shape(of)[two.team.id]).to.deep.equal([[c.id, ['team.member']]]);
    expect(Object.isFrozen(of)).to.equal(true);
    expect(Object.isFrozen(of[0].members[0])).to.equal(true);
  });

  it('excludes owners and admins unless roles asks for them', async () => {
    const { owner, team } = await ownedTeam();
    const [m, admin, peer] = [person('m'), person('admin'), person('peer')];
    await teams.addTeamMember(owner, team.id, refOf(m));
    await teams.addTeamMember(owner, team.id, refOf(peer));
    await teams.addTeamMember(owner, team.id, refOf(admin), 'team.admin');

    expect(shape(await teams.teammatesOf(refOf(m)))).to.deep.equal({ [team.id]: [[peer.id, ['team.member']]] });
    const all = await teams.teammatesOf(refOf(m), { roles: ['team.owner', 'team.admin', 'team.member'] });
    expect(new Map(all[0].members.map((e) => [e.subject.id, e.roles]))).to.deep.equal(
      new Map([
        [owner.id, ['team.owner']],
        [admin.id, ['team.admin']],
        [peer.id, ['team.member']],
      ]),
    );
    // An owner's teams are its teams too.
    expect((await teams.teammatesOf(refOf(owner)))[0].members.map((e) => e.subject.id)).to.deep.equal(sortedIds(m, peer));
    expect(await failure(teams.teammatesOf(refOf(m), { roles: ['not a role'] }))).to.be.instanceOf(InvalidArgument);
  });

  it('expands groups and sub-teams holding the role, through nested sets', async () => {
    const { owner, team } = await ownedTeam('Top');
    const sub = await teams.createTeam(owner, { slug: slug('sub'), name: 'Sub', parentId: team.id });
    const outer = await groups.createGroup(owner, team.id, { slug: slug('g'), name: 'Outer' });
    const inner = await groups.createGroup(owner, team.id, { slug: slug('g'), name: 'Inner', parentId: outer.id });
    const [m, g, s] = [person('m'), person('g'), person('s')];
    await teams.addTeamMember(owner, team.id, refOf(m));
    await groups.addGroupMember(owner, inner.id, refOf(g));
    await teams.addTeamMember(owner, sub.id, refOf(s));

    const top = (await teams.teammatesOf(refOf(m))).find((t) => t.teamId === team.id)!;
    // The owner of Sub is a member of Sub's set, so of Top through it.
    expect(top.members.map((e) => e.subject.id)).to.deep.equal(sortedIds(g, s, owner));
    expect(top.members.every((e) => e.roles.join() === 'team.member')).to.equal(true);
    // Symmetric: the group member's teams (through the closure) list the direct member.
    const viaGroup = await teams.teammatesOf(refOf(g));
    expect(viaGroup.map((t) => t.teamId)).to.deep.equal([team.id]);
    expect(viaGroup[0].members.map((e) => e.subject.id)).to.deep.equal(sortedIds(m, s, owner));
  });

  it('skips soft-deleted teams; archived ones count, as in teamsOf', async () => {
    const kept = await ownedTeam('Kept');
    const gone = await ownedTeam('Gone');
    const [m, a, b] = [person('m'), person('a'), person('b')];
    await teams.addTeamMember(kept.owner, kept.team.id, refOf(m));
    await teams.addTeamMember(kept.owner, kept.team.id, refOf(a));
    await teams.addTeamMember(gone.owner, gone.team.id, refOf(m));
    await teams.addTeamMember(gone.owner, gone.team.id, refOf(b));
    await teams.archiveTeam(kept.owner, kept.team.id);
    await teams.deleteTeam(gone.owner, gone.team.id);

    expect(shape(await teams.teammatesOf(refOf(m)))).to.deep.equal({ [kept.team.id]: [[a.id, ['team.member']]] });
  });

  it('skips expired assignments', async () => {
    const { owner, team } = await ownedTeam();
    const [m, lasting, expiring] = [person('m'), person('lasting'), person('expiring')];
    await teams.addTeamMember(owner, team.id, refOf(m));
    await teams.addTeamMember(owner, team.id, refOf(lasting));
    const inAnHour = new Date(Date.now() + 3600_000);
    await execute(SYSTEM, [{ kind: 'assignment.grant', subject: refOf(expiring), role: 'team.member', scope: teamRef(team.id), expiresAt: inAnHour }], 'test: expiring member');

    expect((await teams.teammatesOf(refOf(m)))[0].members.map((e) => e.subject.id)).to.deep.equal(sortedIds(lasting, expiring));
    const later = await principalTeammates(refOf(m), ['team.member'], new Date(inAnHour.getTime() + 60_000));
    expect(shape(later)).to.deep.equal({ [team.id]: [[lasting.id, ['team.member']]] });
  });

  it('answers a principal whose ceiling drops its team roles, where members() is denied', async () => {
    const { owner, team } = await ownedTeam();
    const [m, peer] = [person('m'), person('peer')];
    await teams.addTeamMember(owner, team.id, refOf(m));
    await teams.addTeamMember(owner, team.id, refOf(peer));
    const capped = userPrincipal(m.id, { ceiling: { roles: ['some.other.role'] } });

    expect(await failure(teams.members(capped, team.id))).to.be.instanceOf(AccessDenied);
    expect(shape(await teams.teammatesOf(capped))).to.deep.equal({ [team.id]: [[peer.id, ['team.member']]] });
  });

  it('is empty for a principal in no team', async () => {
    expect(await teams.teammatesOf(refOf(person('loner')))).to.deep.equal([]);
  });
});
