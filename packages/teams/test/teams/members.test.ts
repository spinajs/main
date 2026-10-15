import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { AccessDenied, AuthzAdminFailure, GLOBAL } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';

import { TeamService } from '../../src/index.js';
import type { TeamView } from '../../src/index.js';
import { teamRef } from '../../src/refs.js';
import { failure, person, refOf, teamCreator } from '../support/people.js';
import { teamsStack } from '../support/stack.js';
import type { TeamsStack } from '../support/stack.js';

const expect = chai.expect;
const slug = (s: string) => `${s}-${randomUUID().slice(0, 8)}`;
const code = (e: Error) => (e instanceof AuthzAdminFailure ? e.code : e.name);

describe('TeamService: members and roles', function () {
  let stack: TeamsStack;
  let teams: TeamService;

  before(async () => {
    stack = await teamsStack();
    teams = (await DI.resolve(TeamService)) as TeamService;
  });

  async function ownedTeam(): Promise<{ owner: Principal; team: TeamView }> {
    const owner = await teamCreator('owner');
    return { owner, team: await teams.createTeam(owner, { slug: slug('t'), name: 'T' }) };
  }

  it('adds and lists members; only with team:members.manage / team:read', async () => {
    const { owner, team } = await ownedTeam();
    const m = person('m');
    await teams.addTeamMember(owner, team.id, refOf(m));
    expect(await stack.authz.can(m, 'team:read', teamRef(team.id))).to.equal(true);
    const list = await teams.members(owner, team.id);
    expect(list.items.map((e) => [e.subject, e.role])).to.deep.include.members([
      [refOf(owner), 'team.owner'],
      [refOf(m), 'team.member'],
    ]);
    expect(await failure(teams.members(person('stranger'), team.id))).to.be.instanceOf(AccessDenied);
    expect(await failure(teams.addTeamMember(m, team.id, refOf(person('x'))))).to.be.instanceOf(AccessDenied);
    expect(await failure(teams.addTeamMember(owner, team.id, { team: team.id }))).to.be.instanceOf(InvalidArgument);
  });

  it('removes a member', async () => {
    const { owner, team } = await ownedTeam();
    const m = person('m');
    await teams.addTeamMember(owner, team.id, refOf(m));
    await teams.removeTeamMember(owner, team.id, refOf(m));
    expect(await stack.authz.can(m, 'team:read', teamRef(team.id))).to.equal(false);
  });

  it('setTeamRole replaces the subject’s roles; the guard refuses escalation', async () => {
    const { owner, team } = await ownedTeam();
    const m = person('m');
    await teams.addTeamMember(owner, team.id, refOf(m));
    await teams.setTeamRole(owner, team.id, refOf(m), 'team.admin');
    expect(await stack.authz.can(m, 'team:update', teamRef(team.id))).to.equal(true);
    expect((await teams.members(owner, team.id)).items.filter((e) => 'id' in e.subject && e.subject.id === m.id).map((e) => e.role)).to.deep.equal(['team.admin']);

    const x = person('x');
    await teams.addTeamMember(m, team.id, refOf(x));
    expect(code(await failure(teams.setTeamRole(m, team.id, refOf(x), 'team.owner')))).to.equal('escalation');
    expect(code(await failure(teams.removeTeamMember(m, team.id, refOf(owner))))).to.equal('escalation');
  });

  it('keeps one owner per team (keepHolders)', async () => {
    const { owner, team } = await ownedTeam();
    expect(code(await failure(teams.setTeamRole(owner, team.id, refOf(owner), 'team.member')))).to.equal('last_holder');
    expect(code(await failure(teams.removeTeamMember(owner, team.id, refOf(owner))))).to.equal('last_holder');
    expect(await stack.authz.can(owner, 'team:delete', teamRef(team.id))).to.equal(true);
  });

  it('transfers ownership: the previous owner stays as team.admin by default', async () => {
    const { owner, team } = await ownedTeam();
    const n = person('n');
    await teams.transferOwnership(owner, team.id, refOf(n));
    expect(await stack.authz.can(n, 'team:delete', teamRef(team.id))).to.equal(true);
    expect(await stack.authz.can(owner, 'team:delete', teamRef(team.id))).to.equal(false);
    expect(await stack.authz.can(owner, 'team:update', teamRef(team.id))).to.equal(true);
    expect(await failure(teams.transferOwnership(owner, team.id, refOf(owner)))).to.be.instanceOf(AccessDenied);
    expect(await failure(teams.transferOwnership(n, team.id, { group: 'g' } as never))).to.be.instanceOf(InvalidArgument);
    // Round trip: the first owner already holds team.admin, so the second transfer adds no second row.
    await teams.transferOwnership(n, team.id, refOf(owner));
    await teams.transferOwnership(owner, team.id, refOf(n));
    expect(await stack.rows('authz_assignment', { subject_type: 'user', subject_id: owner.id, scope_type: 'team', scope_id: team.id, role: 'team.admin' })).to.have.length(1);
  });

  it('transfers ownership keeping a custom role, or nothing', async () => {
    const a = await ownedTeam();
    await teams.transferOwnership(a.owner, a.team.id, refOf(person('n')), { keepAs: 'team.member' });
    expect(await stack.authz.can(a.owner, 'team:read', teamRef(a.team.id))).to.equal(true);
    expect(await stack.authz.can(a.owner, 'team:update', teamRef(a.team.id))).to.equal(false);

    const b = await ownedTeam();
    expect(await failure(teams.transferOwnership(b.owner, b.team.id, refOf(person('x')), { keepAs: 'bad role' }))).to.be.instanceOf(InvalidArgument);
    await teams.transferOwnership(b.owner, b.team.id, refOf(person('n')), { keepAs: null });
    expect(await stack.authz.can(b.owner, 'team:read', teamRef(b.team.id))).to.equal(false);
  });

  it('a whole team holds roles on another team (cross-team), granted and revoked', async () => {
    const a = await ownedTeam();
    const b = await ownedTeam();
    const ma = person('ma');
    await teams.addTeamMember(a.owner, a.team.id, refOf(ma));
    await teams.addTeamMember(b.owner, b.team.id, { team: a.team.id });
    expect(await stack.authz.can(ma, 'team:read', teamRef(b.team.id))).to.equal(true);
    expect(await stack.authz.can(ma, 'team:update', teamRef(b.team.id))).to.equal(false);

    await teams.grant(b.owner, { team: a.team.id }, 'team.admin', teamRef(b.team.id));
    expect(await stack.authz.can(ma, 'team:update', teamRef(b.team.id))).to.equal(true);
    await teams.revoke(b.owner, { team: a.team.id }, 'team.admin', teamRef(b.team.id));
    expect(await stack.authz.can(ma, 'team:update', teamRef(b.team.id))).to.equal(false);

    expect(await failure(teams.grant(ma, { team: a.team.id }, 'team.admin', teamRef(b.team.id)))).to.be.instanceOf(AccessDenied);
    expect(code(await failure(teams.grant(b.owner, refOf(ma), 'teams.creator', GLOBAL)))).to.equal('forbidden');
  });
});
