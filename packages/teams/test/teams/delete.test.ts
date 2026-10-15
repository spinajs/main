import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { AccessDenied } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { InvalidArgument, InvalidOperation, ResourceNotFound } from '@spinajs/exceptions';

import { GroupService, TeamService } from '../../src/index.js';
import { teamRef } from '../../src/refs.js';
import { failure, person, refOf, teamCreator } from '../support/people.js';
import { teamsStack } from '../support/stack.js';
import type { TeamsStack } from '../support/stack.js';

const expect = chai.expect;
const slug = (s: string) => `${s}-${randomUUID().slice(0, 8)}`;
const DAY = 86_400_000;

describe('TeamService: delete, restore, purge', function () {
  let stack: TeamsStack;
  let teams: TeamService;
  let groups: GroupService;

  before(async () => {
    stack = await teamsStack();
    teams = (await DI.resolve(TeamService)) as TeamService;
    groups = (await DI.resolve(GroupService)) as GroupService;
  });

  it('soft delete hides the team and freezes it; restore brings it back', async () => {
    const owner = await teamCreator();
    const t = await teams.createTeam(owner, { slug: slug('d'), name: 'D' });
    await teams.deleteTeam(owner, t.id);
    expect(await failure(teams.getTeam(owner, t.id))).to.be.instanceOf(ResourceNotFound);
    expect((await teams.listTeams(owner)).items.map((x) => x.id)).to.not.include(t.id);
    expect(await stack.authz.can(owner, 'team:update', teamRef(t.id))).to.equal(false);
    const back = await teams.restoreTeam(owner, t.id);
    expect(back.deletedAt).to.equal(null);
    expect((await teams.updateTeam(owner, t.id, { name: 'Back' })).name).to.equal('Back');
    // Restoring a live team is a no-op that checks nothing.
    expect((await teams.restoreTeam(person('stranger'), t.id)).id).to.equal(t.id);
  });

  it('refuses a team with live sub-teams and a stranger; deletes an archived team without unarchiving', async () => {
    const owner = await teamCreator();
    const p = await teams.createTeam(owner, { slug: slug('p'), name: 'P' });
    const c = await teams.createTeam(owner, { slug: slug('c'), name: 'C', parentId: p.id });
    const g = await groups.createGroup(owner, c.id, { slug: slug('g'), name: 'G' });
    expect(await failure(teams.deleteTeam(owner, p.id))).to.be.instanceOf(InvalidArgument);
    expect(await failure(teams.deleteTeam(person('stranger'), c.id))).to.be.instanceOf(AccessDenied);
    await teams.archiveTeam(owner, c.id);
    // teams.archived.delete covers groups, not the team.
    expect(await failure(groups.deleteGroup(owner, g.id))).to.be.instanceOf(AccessDenied);
    await teams.deleteTeam(owner, c.id);
    await teams.deleteTeam(owner, p.id);
    expect(await failure(teams.restoreTeam(owner, c.id))).to.be.instanceOf(InvalidArgument);
    const back = await teams.restoreTeam(owner, p.id);
    expect(back.deletedAt).to.equal(null);
    expect((await teams.restoreTeam(owner, c.id)).archivedAt).to.be.instanceOf(Date);
    expect(await stack.authz.can(owner, 'team:update', teamRef(c.id))).to.equal(false);
  });

  it('purges after the grace: rows, scopes, memberships and ancestors go; TeamPurged is published', async () => {
    const owner = await teamCreator();
    const p = await teams.createTeam(owner, { slug: slug('pp'), name: 'PP' });
    const c = await teams.createTeam(owner, { slug: slug('pc'), name: 'PC', parentId: p.id });
    const outer = await groups.createGroup(owner, c.id, { slug: slug('o'), name: 'O' });
    const inner = await groups.createGroup(owner, c.id, { slug: slug('i'), name: 'I', parentId: outer.id });
    const u = person('u');
    await groups.addGroupMember(owner, inner.id, refOf(u));
    await teams.deleteTeam(owner, c.id);
    await teams.deleteTeam(owner, p.id);

    expect(await teams.purgeDue(new Date())).to.deep.equal([]);
    expect(await failure(teams.purgeTeam(owner, randomUUID()))).to.be.instanceOf(ResourceNotFound);
    const live = await teams.createTeam(owner, { slug: slug('live'), name: 'Live' });
    expect(await failure(teams.purgeTeam(owner, live.id))).to.be.instanceOf(InvalidOperation);
    expect(await failure(teams.purgeTeam(person('stranger'), p.id))).to.be.instanceOf(AccessDenied);

    const purged = await teams.purgeDue(new Date(Date.now() + 31 * DAY));
    expect(purged).to.include.members([p.id, c.id]);
    expect(await stack.rows('teams', { id: p.id })).to.deep.equal([]);
    expect(await stack.rows('teams', { id: c.id })).to.deep.equal([]);
    expect(await stack.rows('groups', { team_id: c.id })).to.deep.equal([]);
    expect(await stack.rows('authz_assignment', { scope_type: 'team', scope_id: p.id })).to.deep.equal([]);
    expect(await stack.rows('authz_resource_ancestor', { resource_type: 'group', resource_id: inner.id })).to.deep.equal([]);
    expect((await teams.teamsOf(refOf(u))).teams).to.deep.equal([]);

    const event = stack.events.events.find((e) => e.type === 'TeamPurged' && e.data.team === p.id);
    expect(event?.data).to.deep.include({ team: p.id, slug: p.slug });
    expect(event?.data.teams).to.deep.equal([p.id, c.id]);
    expect(event?.data.groups).to.have.members([outer.id, inner.id]);

    // The slug is free again.
    expect((await teams.createTeam(owner, { slug: p.slug, name: 'Again' })).slug).to.equal(p.slug);
  });

  it('an owner purges a deleted team at once', async () => {
    const owner = await teamCreator();
    const t = await teams.createTeam(owner, { slug: slug('now'), name: 'Now' });
    await teams.deleteTeam(owner, t.id);
    expect(await teams.purgeTeam(owner, t.id)).to.deep.equal([t.id]);
    expect(await stack.rows('teams', { id: t.id })).to.deep.equal([]);
  });
});
