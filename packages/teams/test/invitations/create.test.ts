import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { AccessDenied, AuthzAdminFailure, AuthzConfigError } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { InvalidArgument, InvalidOperation, ResourceNotFound } from '@spinajs/exceptions';

import { DefaultInvitationService, GroupService, InvitationService, TeamService } from '../../src/index.js';
import type { TeamView } from '../../src/index.js';
import { INVITATION_SECRET, teamsStack } from '../support/stack.js';
import type { TeamsStack } from '../support/stack.js';
import { failure, person, refOf, teamCreator } from '../support/people.js';

const expect = chai.expect;
const slug = (s: string) => `${s}-${randomUUID().slice(0, 8)}`;

describe('InvitationService: create, list, revoke, resend', function () {
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
    return { owner, team: await teams.createTeam(owner, { slug: slug('t'), name: 'Core' }) };
  }

  it('creates a link invitation: the token once, only its hash stored', async () => {
    const { owner, team } = await ownedTeam();
    const { invitation, token } = await invitations.create(owner, { teamId: team.id, role: 'team.member' });
    expect(token).to.match(/^[A-Za-z0-9_-]{43}$/);
    expect(invitation).to.include({ teamId: team.id, groupId: null, role: 'team.member', email: null, maxUses: null, uses: 0, revokedAt: null, lastSentAt: null });
    expect(invitation.expiresAt.getTime() - Date.now()).to.be.within(167 * 3600_000, 168 * 3600_000);
    const [row] = await stack.rows('team_invitations', { id: invitation.id });
    expect(String(row.token_hash)).to.match(/^v1:/);
    expect(JSON.stringify(row)).to.not.include(token);
  });

  it('mails an email invitation (one use by default) and records the send', async () => {
    const { owner, team } = await ownedTeam();
    const before = stack.mailer.sent.length;
    const { invitation, token } = await invitations.create(owner, { teamId: team.id, role: 'team.member', email: 'Ann@Example.com', expiresInHours: 24 });
    expect(invitation).to.include({ email: 'ann@example.com', maxUses: 1 });
    expect(invitation.lastSentAt).to.be.instanceOf(Date);
    const sent = stack.mailer.sent.slice(before);
    expect(sent.map((m) => [m.to, m.token, m.team.id, m.role])).to.deep.equal([['ann@example.com', token, team.id, 'team.member']]);
  });

  it('refuses what the inviter could not grant, strangers, foreign groups and bad input', async () => {
    const { owner, team } = await ownedTeam();
    const admin = person('admin');
    await teams.addTeamMember(owner, team.id, refOf(admin), 'team.admin');
    const escalation = await failure(invitations.create(admin, { teamId: team.id, role: 'team.owner' }));
    expect(escalation).to.be.instanceOf(AuthzAdminFailure);
    expect((escalation as AuthzAdminFailure).code).to.equal('escalation');
    expect((await invitations.create(admin, { teamId: team.id, role: 'team.admin' })).invitation.role).to.equal('team.admin');
    expect(await failure(invitations.create(person('stranger'), { teamId: team.id, role: 'team.member' }))).to.be.instanceOf(AccessDenied);
    const other = await ownedTeam();
    const foreign = await groups.createGroup(other.owner, other.team.id, { slug: slug('g'), name: 'G' });
    expect(await failure(invitations.create(owner, { teamId: team.id, groupId: foreign.id, role: 'group.member' }))).to.be.instanceOf(InvalidArgument);
    expect(await failure(invitations.create(owner, { teamId: team.id, role: 'team.member', maxUses: 0 }))).to.be.instanceOf(InvalidArgument);
    expect(await failure(invitations.create(owner, { teamId: team.id, role: 'team.member', expiresInHours: 0 }))).to.be.instanceOf(InvalidArgument);
    const mine = await groups.createGroup(owner, team.id, { slug: slug('g'), name: 'G' });
    expect((await invitations.create(owner, { teamId: team.id, groupId: mine.id, role: 'group.member' })).invitation.groupId).to.equal(mine.id);
  });

  it('lists, revokes and resends (a new token each time)', async () => {
    const { owner, team } = await ownedTeam();
    const link = await invitations.create(owner, { teamId: team.id, role: 'team.member' });
    const mail = await invitations.create(owner, { teamId: team.id, role: 'team.member', email: 'bob@example.com' });
    const listed = await invitations.list(owner, team.id);
    expect(listed.items.map((i) => i.id)).to.have.members([link.invitation.id, mail.invitation.id]);
    expect(listed.total).to.equal(2);
    expect((await invitations.list(owner, team.id, { limit: 1, offset: 0 })).items).to.have.length(1);
    expect(await failure(invitations.list(person('stranger'), team.id))).to.be.instanceOf(AccessDenied);

    const other = await ownedTeam();
    expect(await failure(invitations.revoke(other.owner, other.team.id, link.invitation.id))).to.be.instanceOf(ResourceNotFound);
    expect(await failure(invitations.resend(other.owner, other.team.id, mail.invitation.id))).to.be.instanceOf(ResourceNotFound);

    const before = stack.mailer.sent.length;
    await invitations.resend(owner, team.id, mail.invitation.id);
    const resent = stack.mailer.sent.slice(before);
    expect(resent).to.have.length(1);
    expect(resent[0].token).to.not.equal(mail.token);
    expect(await failure(invitations.resend(owner, team.id, link.invitation.id))).to.be.instanceOf(InvalidArgument);

    await invitations.revoke(owner, team.id, link.invitation.id);
    const revoked = (await invitations.list(owner, team.id)).items.find((i) => i.id === link.invitation.id);
    expect(revoked?.revokedAt).to.be.instanceOf(Date);
  });

  it('refuses email invitations while the app registered no VerifiedEmailSource; links still work', async () => {
    const { owner, team } = await ownedTeam();
    class NoEmailSource extends DefaultInvitationService {
      protected override async emailSource(): Promise<never> {
        throw new InvalidOperation('test: no VerifiedEmailSource');
      }
    }
    const service = new NoEmailSource();
    expect(await failure(service.create(owner, { teamId: team.id, role: 'team.member', email: 'x@example.com' }))).to.be.instanceOf(InvalidOperation);
    expect((await service.create(owner, { teamId: team.id, role: 'team.member' })).invitation.email).to.equal(null);
  });

  it('invitations and their uses go with their group and with their purged team', async () => {
    const { owner, team } = await ownedTeam();
    const group = await groups.createGroup(owner, team.id, { slug: slug('g'), name: 'G' });
    const intoGroup = await invitations.create(owner, { teamId: team.id, groupId: group.id, role: 'group.member' });
    await stack.driver.insert().into('team_invitation_uses').values({ invitation_id: intoGroup.invitation.id, principal: 'user:someone', used_at: new Date().toISOString() });
    await groups.deleteGroup(owner, group.id);
    expect(await stack.rows('team_invitations', { id: intoGroup.invitation.id })).to.deep.equal([]);
    expect(await stack.rows('team_invitation_uses', { invitation_id: intoGroup.invitation.id })).to.deep.equal([]);

    const intoTeam = await invitations.create(owner, { teamId: team.id, role: 'team.member' });
    await teams.deleteTeam(owner, team.id);
    await teams.purgeTeam(owner, team.id);
    expect(await stack.rows('team_invitations', { id: intoTeam.invitation.id })).to.deep.equal([]);
  });

  it('a failed mail leaves no invitation; no secret, no invitation', async () => {
    const { owner, team } = await ownedTeam();
    stack.mailer.fail = true;
    try {
      expect(await failure(invitations.create(owner, { teamId: team.id, role: 'team.member', email: 'cy@example.com' }))).to.be.instanceOf(Error);
    } finally {
      stack.mailer.fail = false;
    }
    expect(await invitations.list(owner, team.id)).to.deep.equal({ items: [], total: 0 });

    stack.config.set(['teams', 'invitations', 'secret'], undefined);
    try {
      expect(await failure(invitations.create(owner, { teamId: team.id, role: 'team.member' }))).to.be.instanceOf(AuthzConfigError);
    } finally {
      stack.config.set(['teams', 'invitations', 'secret'], INVITATION_SECRET);
    }
  });
});
