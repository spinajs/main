import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { AccessDenied } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { InvalidArgument, ResourceDuplicated, ResourceNotFound } from '@spinajs/exceptions';

import { GroupService, TeamService } from '../../src/index.js';
import type { TeamView } from '../../src/index.js';
import { groupRef, teamRef } from '../../src/refs.js';
import { failure, person, refOf, teamCreator } from '../support/people.js';
import { teamsStack } from '../support/stack.js';
import type { TeamsStack } from '../support/stack.js';

const expect = chai.expect;
const slug = (s: string) => `${s}-${randomUUID().slice(0, 8)}`;

describe('GroupService', function () {
  let stack: TeamsStack;
  let teams: TeamService;
  let groups: GroupService;

  before(async () => {
    stack = await teamsStack();
    teams = (await DI.resolve(TeamService)) as TeamService;
    groups = (await DI.resolve(GroupService)) as GroupService;
  });

  async function ownedTeam(): Promise<{ owner: Principal; team: TeamView }> {
    const owner = await teamCreator('owner');
    return { owner, team: await teams.createTeam(owner, { slug: slug('t'), name: 'T' }) };
  }

  it('creates groups and nested groups; membership flows up to the team', async () => {
    const { owner, team } = await ownedTeam();
    const outer = await groups.createGroup(owner, team.id, { slug: slug('outer'), name: 'Outer' });
    const inner = await groups.createGroup(owner, team.id, { slug: slug('inner'), name: 'Inner', parentId: outer.id });
    expect(inner).to.include({ teamId: team.id, parentId: outer.id });
    const u = person('u');
    await groups.addGroupMember(owner, inner.id, refOf(u));
    expect(await stack.authz.can(u, 'group:read', groupRef(inner.id))).to.equal(true);
    expect(await stack.authz.can(u, 'group:read', groupRef(outer.id))).to.equal(true);
    expect(await stack.authz.can(u, 'team:read', teamRef(team.id))).to.equal(true);
    expect(await stack.authz.can(u, 'group:update', groupRef(inner.id))).to.equal(false);
    // Team roles cover the team's groups (scope tree).
    expect(await stack.authz.can(owner, 'group:update', groupRef(inner.id))).to.equal(true);
  });

  it('refuses a parent group of another team, a taken slug and a stranger', async () => {
    const a = await ownedTeam();
    const b = await ownedTeam();
    const gb = await groups.createGroup(b.owner, b.team.id, { slug: slug('gb'), name: 'GB' });
    expect(await failure(groups.createGroup(a.owner, a.team.id, { slug: slug('x'), name: 'X', parentId: gb.id }))).to.be.instanceOf(InvalidArgument);
    const s = slug('same');
    await groups.createGroup(a.owner, a.team.id, { slug: s, name: 'S' });
    expect(await failure(groups.createGroup(a.owner, a.team.id, { slug: s, name: 'S2' }))).to.be.instanceOf(ResourceDuplicated);
    expect(await failure(groups.createGroup(person('stranger'), a.team.id, { slug: slug('x'), name: 'X' }))).to.be.instanceOf(AccessDenied);
  });

  it('a group manager manages members but not the team', async () => {
    const { owner, team } = await ownedTeam();
    const g = await groups.createGroup(owner, team.id, { slug: slug('g'), name: 'G' });
    const mgr = person('mgr');
    await teams.grant(owner, refOf(mgr), 'group.manager', groupRef(g.id));
    const u = person('u');
    await groups.addGroupMember(mgr, g.id, refOf(u));
    expect((await groups.members(mgr, g.id)).items.map((e) => e.subject)).to.deep.include(refOf(u));
    await groups.removeGroupMember(mgr, g.id, refOf(u));
    expect(await stack.authz.can(u, 'group:read', groupRef(g.id))).to.equal(false);
    expect(await failure(groups.createGroup(mgr, team.id, { slug: slug('x'), name: 'X' }))).to.be.instanceOf(AccessDenied);
  });

  it('a group of one team can be a member of another team’s group and hold roles on another team', async () => {
    const a = await ownedTeam();
    const b = await ownedTeam();
    const ga = await groups.createGroup(a.owner, a.team.id, { slug: slug('ga'), name: 'GA' });
    const gb = await groups.createGroup(b.owner, b.team.id, { slug: slug('gb'), name: 'GB' });
    const u = person('u');
    await groups.addGroupMember(a.owner, ga.id, refOf(u));
    await groups.addGroupMember(b.owner, gb.id, { group: ga.id });
    expect(await stack.authz.can(u, 'group:read', groupRef(gb.id))).to.equal(true);
    await teams.grant(b.owner, { group: ga.id }, 'team.admin', teamRef(b.team.id));
    expect(await stack.authz.can(u, 'team:update', teamRef(b.team.id))).to.equal(true);
    await groups.removeGroupMember(b.owner, gb.id, { group: ga.id });
    expect(await stack.authz.can(u, 'group:read', groupRef(gb.id))).to.equal(true);
  });

  it('moves a group inside its team and to another team; the subtree follows and the links move', async () => {
    const a = await ownedTeam();
    const b = await ownedTeam();
    const top = await groups.createGroup(a.owner, a.team.id, { slug: slug('top'), name: 'Top' });
    const g = await groups.createGroup(a.owner, a.team.id, { slug: slug('g'), name: 'G' });
    const child = await groups.createGroup(a.owner, a.team.id, { slug: slug('child'), name: 'Child', parentId: g.id });
    const u = person('u');
    await groups.addGroupMember(a.owner, child.id, refOf(u));

    expect((await groups.moveGroup(a.owner, g.id, { parentId: top.id })).parentId).to.equal(top.id);
    expect(await stack.authz.can(u, 'group:read', groupRef(top.id))).to.equal(true);
    expect(await failure(groups.moveGroup(a.owner, top.id, { parentId: child.id }))).to.be.instanceOf(InvalidArgument);

    // The owner of A is not an admin of B: group:create there is refused.
    expect(await failure(groups.moveGroup(a.owner, g.id, { teamId: b.team.id, parentId: null }))).to.be.instanceOf(AccessDenied);
    await teams.addTeamMember(b.owner, b.team.id, refOf(a.owner), 'team.admin');
    const moved = await groups.moveGroup(a.owner, g.id, { teamId: b.team.id, parentId: null });
    expect(moved).to.include({ teamId: b.team.id, parentId: null });
    expect((await groups.getGroup(a.owner, child.id)).teamId).to.equal(b.team.id);
    expect(await stack.authz.can(u, 'team:read', teamRef(b.team.id))).to.equal(true);
    expect(await stack.authz.can(u, 'team:read', teamRef(a.team.id))).to.equal(false);
    expect(await stack.authz.can(u, 'group:read', groupRef(top.id))).to.equal(false);
  });

  it('deletes a leaf group; refuses one with sub-groups; lists with .within(team)', async () => {
    const { owner, team } = await ownedTeam();
    const p = await groups.createGroup(owner, team.id, { slug: slug('p'), name: 'P' });
    const c = await groups.createGroup(owner, team.id, { slug: slug('c'), name: 'C', parentId: p.id });
    expect((await groups.listGroups(owner, team.id)).items.map((g) => g.name)).to.deep.equal(['C', 'P']);
    expect(await groups.listGroups(owner, team.id, { limit: 1, offset: 1 })).to.deep.include({ total: 2 });
    expect((await groups.listGroups(owner, team.id, { limit: 1, offset: 1 })).items.map((g) => g.name)).to.deep.equal(['P']);
    expect(await failure(groups.deleteGroup(owner, p.id))).to.be.instanceOf(InvalidArgument);
    const u = person('u');
    await groups.addGroupMember(owner, c.id, refOf(u));
    await groups.deleteGroup(owner, c.id);
    expect(await failure(groups.getGroup(owner, c.id))).to.be.instanceOf(ResourceNotFound);
    expect(await stack.authz.can(u, 'team:read', teamRef(team.id))).to.equal(false);
    expect(await stack.rows('authz_assignment', { scope_type: 'group', scope_id: c.id })).to.deep.equal([]);
    expect(await groups.listGroups(person('stranger'), team.id)).to.deep.equal({ items: [], total: 0 });
  });

  it('an archived team’s groups are frozen', async () => {
    const { owner, team } = await ownedTeam();
    const g = await groups.createGroup(owner, team.id, { slug: slug('g'), name: 'G' });
    await teams.archiveTeam(owner, team.id);
    expect(await failure(groups.updateGroup(owner, g.id, { name: 'X' }))).to.be.instanceOf(AccessDenied);
    expect(await failure(groups.createGroup(owner, team.id, { slug: slug('n'), name: 'N' }))).to.be.instanceOf(AccessDenied);
    expect((await groups.getGroup(owner, g.id)).name).to.equal('G');
  });
});
