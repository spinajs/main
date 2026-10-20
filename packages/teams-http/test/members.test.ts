import 'mocha';
import { expect } from 'chai';

import { as, grantAt, ownedTeam, send, subjectPath, teamRef, uniq } from './support/client.js';

const roles = (items: any[]) => items.map((m) => ({ subject: m.subject, role: m.role }));

describe('team members routes', function () {
  this.timeout(30_000);

  it('adds a member, who then reads the team; the list shows owner and member with their roles, paged', async () => {
    const { owner, team } = await ownedTeam();
    const alice = uniq('alice');
    expect((await as(alice).get(`/teams/${team.id}`)).status).to.eq(403);
    const added = await as(owner).post(`/teams/${team.id}/members`, { subject: `user:${alice}` });
    expect(added.status).to.eq(200);
    expect(added.body).to.deep.eq({ ok: true });
    expect((await as(alice).get(`/teams/${team.id}`)).status).to.eq(200);

    const list = await as(alice).get(`/teams/${team.id}/members`);
    expect(list.status).to.eq(200);
    expect(roles(list.body.items)).to.deep.include({ subject: `user:${alice}`, role: 'team.member' });
    expect(roles(list.body.items)).to.deep.include({ subject: `user:${owner}`, role: 'team.owner' });
    expect(list.body.items[0].assignmentId).to.be.a('string');
    const page = await as(alice).get(`/teams/${team.id}/members?size=1&page=1`);
    expect(page.body.items).to.have.length(1);
    expect(page.body.total).to.eq(list.body.total);
    expect((await as(alice).get(`/teams/${team.id}/members?size=0`)).status).to.eq(400);
  });

  it('adds a member with a role', async () => {
    const { owner, team } = await ownedTeam();
    const alice = uniq('alice');
    expect((await as(owner).post(`/teams/${team.id}/members`, { subject: `user:${alice}`, role: 'team.admin' })).status).to.eq(200);
    expect((await as(alice).patch(`/teams/${team.id}`, { name: 'By admin' })).status).to.eq(200);
  });

  it("changes a member's role", async () => {
    const { owner, team } = await ownedTeam();
    const alice = uniq('alice');
    await grantAt(alice, 'team.member', teamRef(team.id));
    expect((await as(alice).patch(`/teams/${team.id}`, { name: 'x' })).status).to.eq(403);
    const res = await as(owner).patch(`/teams/${team.id}/members/${subjectPath(alice)}`, { role: 'team.admin' });
    expect(res.status).to.eq(200);
    expect((await as(alice).patch(`/teams/${team.id}`, { name: 'By admin' })).status).to.eq(200);
    const list = roles((await as(owner).get(`/teams/${team.id}/members`)).body.items);
    expect(list).to.deep.include({ subject: `user:${alice}`, role: 'team.admin' });
    expect(list).to.not.deep.include({ subject: `user:${alice}`, role: 'team.member' });
  });

  it('refuses a plain member every write', async () => {
    const { owner, team } = await ownedTeam();
    const alice = uniq('alice');
    await grantAt(alice, 'team.member', teamRef(team.id));
    expect((await as(alice).post(`/teams/${team.id}/members`, { subject: `user:${uniq('bob')}` })).status).to.eq(403);
    expect((await as(alice).patch(`/teams/${team.id}/members/${subjectPath(owner)}`, { role: 'team.member' })).status).to.eq(403);
    expect((await as(alice).del(`/teams/${team.id}/members/${subjectPath(owner)}`)).status).to.eq(403);
  });

  it('refuses a malformed subject and an unknown role with 400', async () => {
    const { owner, team } = await ownedTeam();
    expect((await as(owner).post(`/teams/${team.id}/members`, { subject: 'alice' })).status).to.eq(400);
    expect((await as(owner).post(`/teams/${team.id}/members`, {})).status).to.eq(400);
    const badPath = await as(owner).del(`/teams/${team.id}/members/alice`);
    expect(badPath.status).to.eq(400);
    expect(badPath.body.error).to.include({ code: 'invalid_request', field: 'subject' });
    expect((await as(owner).post(`/teams/${team.id}/members`, { subject: `user:${uniq('bob')}`, role: 'no.such.role' })).status).to.eq(400);
  });

  it("refuses a role above the caller's own (escalation)", async () => {
    const { team } = await ownedTeam();
    const alice = uniq('alice');
    const bob = uniq('bob');
    await grantAt(alice, 'team.admin', teamRef(team.id));
    await grantAt(bob, 'team.member', teamRef(team.id));
    const res = await as(alice).patch(`/teams/${team.id}/members/${subjectPath(bob)}`, { role: 'team.owner' });
    expect(res.status).to.eq(403);
    expect(res.body.error.code).to.eq('escalation');
  });

  it('keeps the last owner (last_holder)', async () => {
    const { owner, team } = await ownedTeam();
    const res = await as(owner).del(`/teams/${team.id}/members/${subjectPath(owner)}`);
    expect(res.status).to.eq(403);
    expect(res.body.error.code).to.eq('last_holder');
    expect((await as(owner).get(`/teams/${team.id}`)).status).to.eq(200);
  });

  it('removes a member, who can no longer read the team', async () => {
    const { owner, team } = await ownedTeam();
    const alice = uniq('alice');
    await grantAt(alice, 'team.member', teamRef(team.id));
    const res = await as(owner).del(`/teams/${team.id}/members/${subjectPath(alice)}`);
    expect(res.status).to.eq(200);
    expect((await as(alice).get(`/teams/${team.id}`)).status).to.eq(403);
  });

  it('answers 401 without a principal and 403 to an outsider listing members', async () => {
    const { team } = await ownedTeam();
    expect((await send('GET', `/teams/${team.id}/members`)).status).to.eq(401);
    expect((await as(uniq('bob')).get(`/teams/${team.id}/members`)).status).to.eq(403);
  });
});
