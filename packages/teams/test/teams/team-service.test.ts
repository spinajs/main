import * as chai from 'chai';
import 'mocha';

import { AccessDenied, SYSTEM } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { InvalidArgument, ResourceDuplicated } from '@spinajs/exceptions';
import { randomUUID } from 'node:crypto';

import { TeamService } from '../../src/index.js';
import { asSystem, execute } from '../../src/host.js';
import { teamRef } from '../../src/refs.js';
import { failure, person, refOf, teamCreator } from '../support/people.js';
import { TestProject } from '../support/project.js';
import { teamsStack } from '../support/stack.js';
import type { TeamsStack } from '../support/stack.js';

const expect = chai.expect;
const slug = (s: string) => `${s}-${randomUUID().slice(0, 8)}`;

describe('TeamService: create, update, move, archive', function () {
  let stack: TeamsStack;
  let teams: TeamService;

  before(async () => {
    stack = await teamsStack();
    teams = (await DI.resolve(TeamService)) as TeamService;
  });

  const addMember = (teamId: string, who: { type: string; id: string }) => execute(SYSTEM, [{ kind: 'assignment.grant', subject: who, role: 'team.member', scope: teamRef(teamId) }], 'test');

  it('a creator creates a root team and owns it; a stranger may not', async () => {
    const creator = await teamCreator();
    const t = await teams.createTeam(creator, { slug: slug('core'), name: 'Core', description: 'd' });
    expect(t).to.include({ parentId: null, name: 'Core', description: 'd', archivedAt: null, deletedAt: null });
    expect(await stack.authz.can(creator, 'team:delete', teamRef(t.id))).to.equal(true);
    expect(await failure(teams.createTeam(person('stranger'), { slug: slug('x'), name: 'X' }))).to.be.instanceOf(AccessDenied);
  });

  it('writes authz first: a failed insert leaves no owner assignment behind', async () => {
    const creator = await teamCreator();
    const s = slug('race');
    await teams.createTeam(creator, { slug: s, name: 'First' });
    // Same slug past the service's check: the unique index refuses the insert after the batch ran.
    const service = teams as unknown as { assertSlugFree(slug: string): Promise<void> };
    const check = service.assertSlugFree;
    service.assertSlugFree = async () => undefined;
    try {
      expect(await failure(teams.createTeam(creator, { slug: s, name: 'Second' }))).to.be.instanceOf(Error);
    } finally {
      service.assertSlugFree = check;
    }
    const owners = await stack.rows('authz_assignment', { subject_type: 'user', subject_id: creator.id, role: 'team.owner' });
    expect(owners).to.have.length(1);
  });

  it('team roles reach app resources below the team (the ladder has no resourceTypes)', async () => {
    const creator = await teamCreator();
    const t = await teams.createTeam(creator, { slug: slug('app'), name: 'App' });
    const project = new TestProject({ id: randomUUID(), team_id: t.id, name: 'P' });
    await asSystem(() => project.insert());
    const m = person('m');
    await addMember(t.id, refOf(m));
    const ref = { type: 'project', id: project.id };
    expect(await stack.authz.can(m, 'project:read', ref)).to.equal(true);
    expect(await stack.authz.can(m, 'project:update', ref)).to.equal(false);
    expect(await stack.authz.can(creator, 'project:update', ref)).to.equal(true);
    expect(await stack.authz.can(person('stranger'), 'project:read', ref)).to.equal(false);
  });

  it('refuses a taken slug and a bad one; a SYSTEM caller must name the owner', async () => {
    const creator = await teamCreator();
    const s = slug('dup');
    await teams.createTeam(creator, { slug: s, name: 'A' });
    expect(await failure(teams.createTeam(creator, { slug: s, name: 'B' }))).to.be.instanceOf(ResourceDuplicated);
    expect(await failure(teams.createTeam(creator, { slug: 'Bad Slug', name: 'B' }))).to.be.instanceOf(InvalidArgument);
    expect(await failure(teams.createTeam(SYSTEM, { slug: slug('sys'), name: 'S' }))).to.be.instanceOf(InvalidArgument);
    const owner = person('owner');
    const t = await teams.createTeam(SYSTEM, { slug: slug('sys'), name: 'S', owner: refOf(owner) });
    expect(await stack.authz.can(owner, 'team:delete', teamRef(t.id))).to.equal(true);
  });

  it('an owner creates sub-teams; sub-team members are members of the parent unless switched off', async () => {
    const creator = await teamCreator();
    const parent = await teams.createTeam(creator, { slug: slug('p'), name: 'P' });
    const sub = await teams.createTeam(creator, { slug: slug('s'), name: 'S', parentId: parent.id });
    const m = person('m');
    await addMember(sub.id, refOf(m));
    expect(await stack.authz.can(m, 'team:read', teamRef(parent.id))).to.equal(true);

    stack.config.set(['teams', 'membership', 'subTeamsInParent'], false);
    try {
      const lone = await teams.createTeam(creator, { slug: slug('l'), name: 'L', parentId: parent.id });
      const n = person('n');
      await addMember(lone.id, refOf(n));
      expect(await stack.authz.can(n, 'team:read', teamRef(parent.id))).to.equal(false);
    } finally {
      stack.config.set(['teams', 'membership', 'subTeamsInParent'], true);
    }
    expect(await failure(teams.createTeam(person('stranger'), { slug: slug('x'), name: 'X', parentId: parent.id }))).to.be.instanceOf(AccessDenied);
  });

  it('updates a team; only with team:update', async () => {
    const creator = await teamCreator();
    const t = await teams.createTeam(creator, { slug: slug('u'), name: 'U' });
    const s = slug('renamed');
    expect(await teams.updateTeam(creator, t.id, { name: 'Renamed', slug: s, description: null })).to.include({ name: 'Renamed', slug: s, description: null });
    expect(await failure(teams.updateTeam(person('stranger'), t.id, { name: 'X' }))).to.be.instanceOf(AccessDenied);
  });

  it('moves a team: the sub-team set is re-linked; a team cannot move below itself', async () => {
    const creator = await teamCreator();
    const a = await teams.createTeam(creator, { slug: slug('a'), name: 'A' });
    const b = await teams.createTeam(creator, { slug: slug('b'), name: 'B' });
    const s = await teams.createTeam(creator, { slug: slug('s'), name: 'S', parentId: a.id });
    const m = person('m');
    await addMember(s.id, refOf(m));
    expect((await teams.moveTeam(creator, s.id, b.id)).parentId).to.equal(b.id);
    expect(await stack.authz.can(m, 'team:read', teamRef(b.id))).to.equal(true);
    expect(await stack.authz.can(m, 'team:read', teamRef(a.id))).to.equal(false);
    expect(await failure(teams.moveTeam(creator, b.id, s.id))).to.be.instanceOf(InvalidArgument);
    expect((await teams.moveTeam(creator, s.id, null)).parentId).to.equal(null);
    expect(await stack.authz.can(m, 'team:read', teamRef(b.id))).to.equal(false);
  });

  it('archive freezes writes on the team (deny policy), keeps reads and deleting the team; unarchive thaws', async () => {
    const creator = await teamCreator();
    const t = await teams.createTeam(creator, { slug: slug('arch'), name: 'Arch' });
    expect((await teams.archiveTeam(creator, t.id)).archivedAt).to.be.instanceOf(Date);
    expect(await stack.authz.can(creator, 'team:delete', teamRef(t.id))).to.equal(true);
    const denied = await failure(teams.updateTeam(creator, t.id, { name: 'X' }));
    expect(denied).to.be.instanceOf(AccessDenied);
    expect((denied as AccessDenied).decision.reason?.code).to.equal('team_archived');
    expect(await stack.authz.can(creator, 'team:read', teamRef(t.id))).to.equal(true);
    expect(await failure(teams.createTeam(creator, { slug: slug('sub'), name: 'Sub', parentId: t.id }))).to.be.instanceOf(AccessDenied);
    expect((await teams.unarchiveTeam(creator, t.id)).archivedAt).to.equal(null);
    expect((await teams.updateTeam(creator, t.id, { name: 'Thawed' })).name).to.equal('Thawed');
  });

  it('lists the live teams the actor may read', async () => {
    const creator = await teamCreator();
    const p = await teams.createTeam(creator, { slug: slug('lp'), name: 'LP' });
    const c = await teams.createTeam(creator, { slug: slug('lc'), name: 'LC', parentId: p.id });
    const mine = await teams.listTeams(creator);
    expect(mine.items.map((t) => t.id)).to.include.members([p.id, c.id]);
    expect(mine.total).to.equal(mine.items.length);
    expect(await teams.listTeams(creator, { parentId: p.id })).to.deep.include({ total: 1 });
    expect((await teams.listTeams(creator, { parentId: p.id })).items.map((t) => t.id)).to.deep.equal([c.id]);
    const first = await teams.listTeams(creator, { page: { limit: 1, offset: 0 } });
    expect(first.items).to.have.length(1);
    expect(first.total).to.equal(mine.total);
    expect((await teams.listTeams(person('stranger'))).items.map((t) => t.id)).to.not.include(p.id);
    expect((await teams.teamsOf(refOf(creator))).teams.map((t) => t.id)).to.include.members([p.id, c.id]);
  });
});
