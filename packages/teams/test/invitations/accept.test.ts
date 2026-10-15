import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import type { Principal } from '@spinajs/authz';
import { anonymousPrincipal, userPrincipal } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { DateTime } from 'luxon';

import { GroupService, InvitationRefused, InvitationService, TeamInvitation, TeamService } from '../../src/index.js';
import type { TeamView } from '../../src/index.js';
import { groupRef, teamRef } from '../../src/refs.js';
import { failure, person, refOf, teamCreator } from '../support/people.js';
import { teamsStack } from '../support/stack.js';
import type { TeamsStack } from '../support/stack.js';

const expect = chai.expect;
const slug = (s: string) => `${s}-${randomUUID().slice(0, 8)}`;
const refusal = async (p: Promise<unknown>) => {
  const e = await failure(p);
  expect(e).to.be.instanceOf(InvitationRefused);
  return (e as InvitationRefused).code;
};

describe('InvitationService.accept', function () {
  let stack: TeamsStack;
  let teams: TeamService;
  let groups: GroupService;
  let invitations: InvitationService;

  before(async () => {
    stack = await teamsStack();
    teams = (await DI.resolve(TeamService)) as TeamService;
    groups = (await DI.resolve(GroupService)) as GroupService;
    invitations = (await DI.resolve(InvitationService)) as InvitationService;
  });

  async function ownedTeam(): Promise<{ owner: Principal; team: TeamView }> {
    const owner = await teamCreator('owner');
    return { owner, team: await teams.createTeam(owner, { slug: slug('t'), name: 'T' }) };
  }

  it('a link invitation makes each accepting user a member, once per user', async () => {
    const { owner, team } = await ownedTeam();
    const { invitation, token } = await invitations.create(owner, { teamId: team.id, role: 'team.member' });
    const u = person('u');
    const v = person('v');
    expect(await invitations.accept(u, token)).to.deep.equal({ invitationId: invitation.id, teamId: team.id, groupId: null, role: 'team.member' });
    expect(await stack.authz.can(u, 'team:read', teamRef(team.id))).to.equal(true);
    await invitations.accept(u, token);
    await invitations.accept(v, token);
    expect((await invitations.list(owner, team.id)).items[0].uses).to.equal(2);
  });

  it('does not grant a role the user already holds', async () => {
    const { owner, team } = await ownedTeam();
    const u = person('u');
    await teams.addTeamMember(owner, team.id, refOf(u));
    const { token } = await invitations.create(owner, { teamId: team.id, role: 'team.member' });
    await invitations.accept(u, token);
    expect(await stack.rows('authz_assignment', { subject_type: 'user', subject_id: u.id, scope_type: 'team', scope_id: team.id })).to.have.length(1);
  });

  it('refuses used-up, revoked, expired and unknown invitations', async () => {
    const { owner, team } = await ownedTeam();
    const single = await invitations.create(owner, { teamId: team.id, role: 'team.member', maxUses: 1 });
    await invitations.accept(person('u'), single.token);
    expect(await refusal(invitations.accept(person('v'), single.token))).to.equal('used_up');

    const revoked = await invitations.create(owner, { teamId: team.id, role: 'team.member' });
    await invitations.revoke(owner, team.id, revoked.invitation.id);
    expect(await refusal(invitations.accept(person('u'), revoked.token))).to.equal('revoked');

    const expired = await invitations.create(owner, { teamId: team.id, role: 'team.member' });
    const row = (await TeamInvitation.where('id', expired.invitation.id).first())!;
    await row.update({ expires_at: DateTime.now().minus({ hours: 1 }) });
    expect(await refusal(invitations.accept(person('u'), expired.token))).to.equal('expired');

    expect(await refusal(invitations.accept(person('u'), 'no-such-token'))).to.equal('unknown');
    expect(await refusal(invitations.accept(person('u'), ''))).to.equal('unknown');
  });

  it('an email invitation needs the same verified address', async () => {
    const { owner, team } = await ownedTeam();
    const { token } = await invitations.create(owner, { teamId: team.id, role: 'team.member', email: 'dana@example.com' });
    expect(await refusal(invitations.accept(person('other', { email: 'eve@example.com', emailVerified: true }), token))).to.equal('email_mismatch');
    expect(await refusal(invitations.accept(person('unverified', { email: 'dana@example.com', emailVerified: false }), token))).to.equal('email_mismatch');
    const dana = person('dana', { email: 'Dana@Example.com', emailVerified: true });
    await invitations.accept(dana, token);
    expect(await stack.authz.can(dana, 'team:read', teamRef(team.id))).to.equal(true);
  });

  it('a group invitation adds a member or grants the group role', async () => {
    const { owner, team } = await ownedTeam();
    const g = await groups.createGroup(owner, team.id, { slug: slug('g'), name: 'G' });
    const member = await invitations.create(owner, { teamId: team.id, groupId: g.id, role: 'group.member' });
    const manager = await invitations.create(owner, { teamId: team.id, groupId: g.id, role: 'group.manager' });
    const u = person('u');
    const m = person('m');
    await invitations.accept(u, member.token);
    await invitations.accept(m, manager.token);
    expect(await stack.authz.can(u, 'team:read', teamRef(team.id))).to.equal(true);
    expect(await stack.authz.can(u, 'group:members.manage', groupRef(g.id))).to.equal(false);
    expect(await stack.authz.can(m, 'group:members.manage', groupRef(g.id))).to.equal(true);
  });

  it('only a signed-in user accepts; a resent invitation drops the old token', async () => {
    const { owner, team } = await ownedTeam();
    const link = await invitations.create(owner, { teamId: team.id, role: 'team.member' });
    expect(await refusal(invitations.accept(anonymousPrincipal(), link.token))).to.equal('not_a_user');
    expect(await refusal(invitations.accept(userPrincipal(`x-${randomUUID()}`, { authenticated: false }), link.token))).to.equal('not_a_user');

    const mailed = await invitations.create(owner, { teamId: team.id, role: 'team.member', email: 'fay@example.com' });
    const before = stack.mailer.sent.length;
    await invitations.resend(owner, team.id, mailed.invitation.id);
    const fresh = stack.mailer.sent[before].token;
    const fay = person('fay', { email: 'fay@example.com', emailVerified: true });
    expect(await refusal(invitations.accept(fay, mailed.token))).to.equal('unknown');
    await invitations.accept(fay, fresh);
    expect(await stack.authz.can(fay, 'team:read', teamRef(team.id))).to.equal(true);
  });
});
