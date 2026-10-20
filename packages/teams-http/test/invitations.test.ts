import 'mocha';
import { expect } from 'chai';

import { RecordingInvitationMailer } from './support/app.js';
import { as, createGroup, createTeam, grantAt, ownedTeam, platformUser, send, teamRef, uniq } from './support/client.js';

const invite = (owner: string, teamId: string, body: Record<string, unknown> = {}) => as(owner).post(`/teams/${teamId}/invitations`, { role: 'team.member', ...body });
const lastMailTo = (address: string) => RecordingInvitationMailer.sent.filter((m) => m.to === address).pop();

describe('invitation routes', function () {
  this.timeout(30_000);

  it('creates a link invitation: the token is shown once, never stored by caches, never listed', async () => {
    const { owner, team } = await ownedTeam();
    const res = await invite(owner, team.id, { expiresInHours: 1 });
    expect(res.status).to.eq(200);
    expect(res.headers['cache-control']).to.eq('no-store');
    expect(res.body.token).to.be.a('string').that.is.not.empty;
    expect(res.body.invitation).to.include({ teamId: team.id, groupId: null, role: 'team.member', email: null, maxUses: null, uses: 0, revokedAt: null });
    expect(res.body.invitation).to.not.have.any.keys('token', 'tokenHash', 'token_hash');

    const list = await as(owner).get(`/teams/${team.id}/invitations`);
    expect(list.status).to.eq(200);
    expect(list.body.items.map((i: any) => i.id)).to.deep.eq([res.body.invitation.id]);
    expect(list.body.total).to.eq(1);
    expect(JSON.stringify(list.body)).to.not.include(res.body.token);
  });

  it('is for managers only', async () => {
    const { team } = await ownedTeam();
    const alice = uniq('alice');
    await grantAt(alice, 'team.member', teamRef(team.id));
    expect((await as(alice).get(`/teams/${team.id}/invitations`)).status).to.eq(403);
    expect((await invite(alice, team.id)).status).to.eq(403);
  });

  it('accepting joins the team, idempotently, and answers no-store', async () => {
    const { owner, team } = await ownedTeam();
    const { body } = await invite(owner, team.id);
    const dave = uniq('dave');
    const accepted = await as(dave).post('/invitations/accept', { token: body.token });
    expect(accepted.status).to.eq(200);
    expect(accepted.headers['cache-control']).to.eq('no-store');
    expect(accepted.body).to.deep.eq({ invitationId: body.invitation.id, teamId: team.id, groupId: null, role: 'team.member' });
    expect((await as(dave).get(`/teams/${team.id}`)).status).to.eq(200);
    expect((await as(dave).post('/invitations/accept', { token: body.token })).status).to.eq(200);
  });

  it('refuses a use beyond maxUses', async () => {
    const { owner, team } = await ownedTeam();
    const { body } = await invite(owner, team.id, { maxUses: 1 });
    expect((await as(uniq('dave')).post('/invitations/accept', { token: body.token })).status).to.eq(200);
    const second = await as(uniq('erin')).post('/invitations/accept', { token: body.token });
    expect(second.status).to.eq(409);
    expect(second.body.error.code).to.eq('invitation_used_up');
  });

  it('revokes an invitation, only through its own team', async () => {
    const owner = await platformUser();
    const team = await createTeam(owner);
    const other = await createTeam(owner);
    const { body } = await invite(owner, team.id);
    const id = body.invitation.id;

    const wrongTeam = await as(owner).del(`/teams/${other.id}/invitations/${id}`);
    expect(wrongTeam.status).to.eq(404);
    expect((await as(owner).del(`/teams/${team.id}/invitations/${id}`)).body).to.deep.eq({ ok: true });
    const refused = await as(uniq('dave')).post('/invitations/accept', { token: body.token });
    expect(refused.status).to.eq(409);
    expect(refused.body.error.code).to.eq('invitation_revoked');
    expect((await as(owner).get(`/teams/${team.id}/invitations`)).body.items[0].revokedAt).to.be.a('string');
  });

  it('answers an unknown token 404, no principal 401, no token 400', async () => {
    const unknown = await as(uniq('dave')).post('/invitations/accept', { token: 'not-a-token' });
    expect(unknown.status).to.eq(404);
    expect(unknown.body.error.code).to.eq('invitation_unknown');
    expect((await send('POST', '/invitations/accept', { body: { token: 'x' } })).status).to.eq(401);
    expect((await as(uniq('dave')).post('/invitations/accept', {})).status).to.eq(400);
  });

  it('a group invitation makes the user a group member', async () => {
    const { owner, team } = await ownedTeam();
    const group = await createGroup(owner, team.id);
    const { body } = await invite(owner, team.id, { groupId: group.id, role: 'group.member' });
    const frank = uniq('frank');
    const accepted = await as(frank).post('/invitations/accept', { token: body.token });
    expect(accepted.body).to.include({ teamId: team.id, groupId: group.id, role: 'group.member' });
    expect((await as(frank).get(`/groups/${group.id}`)).status).to.eq(200);
    expect((await as(frank).get(`/teams/${team.id}`)).status).to.eq(200);
  });

  it("cannot invite to a role above the inviter's own", async () => {
    const { team } = await ownedTeam();
    const alice = uniq('alice');
    await grantAt(alice, 'team.admin', teamRef(team.id));
    expect((await invite(alice, team.id)).status).to.eq(200);
    expect((await invite(alice, team.id, { role: 'team.owner' })).status).to.eq(403);
  });

  it('an email invitation is mailed and opens only for that verified email', async () => {
    const { owner, team } = await ownedTeam();
    const address = `${uniq('invitee')}@example.com`;
    const created = await invite(owner, team.id, { email: address });
    expect(created.status).to.eq(200);
    expect(created.body.invitation).to.include({ email: address, maxUses: 1 });
    expect(lastMailTo(address)?.token).to.eq(created.body.token);

    const refused = await as(uniq('gina')).post('/invitations/accept', { token: created.body.token });
    expect(refused.status).to.eq(403);
    expect(refused.body.error.code).to.eq('invitation_email_mismatch');
    const hal = uniq('hal');
    expect((await as(hal, address).post('/invitations/accept', { token: created.body.token })).status).to.eq(200);
    expect((await as(hal).get(`/teams/${team.id}`)).status).to.eq(200);
  });

  it('resending mails a new token; the old one stops working', async () => {
    const { owner, team } = await ownedTeam();
    const address = `${uniq('invitee')}@example.com`;
    const created = await invite(owner, team.id, { email: address });
    const resent = await as(owner).post(`/teams/${team.id}/invitations/${created.body.invitation.id}/resend`);
    expect(resent.status).to.eq(200);
    expect(resent.body.lastSentAt).to.be.a('string');
    expect(resent.body).to.not.have.any.keys('token', 'tokenHash', 'token_hash');

    const fresh = lastMailTo(address)!.token;
    expect(fresh).to.not.eq(created.body.token);
    const old = await as(uniq('ian'), address).post('/invitations/accept', { token: created.body.token });
    expect(old.status).to.eq(404);
    expect(old.body.error.code).to.eq('invitation_unknown');
    expect((await as(uniq('ian'), address).post('/invitations/accept', { token: fresh })).status).to.eq(200);
  });

  it('validates the body', async () => {
    const { owner, team } = await ownedTeam();
    expect((await invite(owner, team.id, { expiresInHours: 0 })).status).to.eq(400);
    expect((await invite(owner, team.id, { maxUses: 0 })).status).to.eq(400);
    expect((await invite(owner, team.id, { email: 'not an email' })).status).to.eq(400);
    expect((await invite(owner, team.id, { teamId: team.id })).status).to.eq(400);
    expect((await as(owner).post(`/teams/${team.id}/invitations`, {})).status).to.eq(400);
  });
});
