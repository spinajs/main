import 'mocha';
import { expect } from 'chai';

import { as, createGroup, createTeam, grantAt, ownedTeam, platformUser, subjectPath, teamRef, uniq } from './support/client.js';

describe('groups routes', function () {
  this.timeout(30_000);

  it('creates a group in a team; a team member reads it, an outsider is refused', async () => {
    const { owner, team } = await ownedTeam();
    const slug = uniq('group');
    const res = await as(owner).post(`/teams/${team.id}/groups`, { slug, name: 'Devs' });
    expect(res.status).to.eq(200);
    expect(res.body).to.include({ teamId: team.id, parentId: null, slug, name: 'Devs', description: null });

    const alice = uniq('alice');
    await grantAt(alice, 'team.member', teamRef(team.id));
    expect((await as(alice).get(`/groups/${res.body.id}`)).body).to.deep.eq(res.body);
    expect((await as(uniq('bob')).get(`/groups/${res.body.id}`)).status).to.eq(403);
  });

  it('creates a nested group and refuses a parent group of another team', async () => {
    const owner = await platformUser();
    const team = await createTeam(owner);
    const other = await createTeam(owner);
    const outer = await createGroup(owner, team.id);
    const inner = await as(owner).post(`/teams/${team.id}/groups`, { slug: uniq('group'), name: 'Inner', parentId: outer.id });
    expect(inner.status).to.eq(200);
    expect(inner.body.parentId).to.eq(outer.id);
    const foreign = await createGroup(owner, other.id);
    expect((await as(owner).post(`/teams/${team.id}/groups`, { slug: uniq('group'), name: 'x', parentId: foreign.id })).status).to.eq(400);
  });

  it('refuses group creation to a plain member and validates the body', async () => {
    const { owner, team } = await ownedTeam();
    const alice = uniq('alice');
    await grantAt(alice, 'team.member', teamRef(team.id));
    expect((await as(alice).post(`/teams/${team.id}/groups`, { slug: uniq('group'), name: 'x' })).status).to.eq(403);
    expect((await as(owner).post(`/teams/${team.id}/groups`, { name: 'no slug' })).status).to.eq(400);
    expect((await as(owner).post(`/teams/${team.id}/groups`, { slug: uniq('group'), name: 'x', teamId: 'x' })).status).to.eq(400);
  });

  it("lists the team's groups only", async () => {
    const owner = await platformUser();
    const team = await createTeam(owner);
    const other = await createTeam(owner);
    const mine = [await createGroup(owner, team.id), await createGroup(owner, team.id)];
    await createGroup(owner, other.id);

    const all = await as(owner).get(`/teams/${team.id}/groups`);
    expect(all.status).to.eq(200);
    expect(all.body.items.map((g: any) => g.id)).to.have.members(mine.map((g) => g.id));
    expect(all.body.total).to.eq(2);
    expect((await as(uniq('bob')).get(`/teams/${team.id}/groups`)).status).to.eq(403);
  });

  it('changes a group for the owner and refuses a plain member', async () => {
    const { owner, team } = await ownedTeam();
    const group = await createGroup(owner, team.id);
    const alice = uniq('alice');
    await grantAt(alice, 'team.member', teamRef(team.id));
    expect((await as(alice).patch(`/groups/${group.id}`, { name: 'x' })).status).to.eq(403);
    const res = await as(owner).patch(`/groups/${group.id}`, { name: 'Renamed' });
    expect(res.status).to.eq(200);
    expect(res.body).to.include({ id: group.id, name: 'Renamed' });
    expect((await as(owner).patch(`/groups/${group.id}`, {})).status).to.eq(400);
  });

  it('adds a group member, who reaches the team through the group, and removes them', async () => {
    const { owner, team } = await ownedTeam();
    const group = await createGroup(owner, team.id);
    const carol = uniq('carol');
    expect((await as(carol).get(`/teams/${team.id}`)).status).to.eq(403);

    expect((await as(owner).post(`/groups/${group.id}/members`, { subject: `user:${carol}` })).status).to.eq(200);
    expect((await as(carol).get(`/teams/${team.id}`)).status, 'membership flows up: group -> team').to.eq(200);
    const members = await as(carol).get(`/groups/${group.id}/members`);
    expect(members.status).to.eq(200);
    expect(members.body.items.map((m: any) => ({ subject: m.subject, role: m.role }))).to.deep.include({ subject: `user:${carol}`, role: 'group.member' });

    expect((await as(carol).post(`/groups/${group.id}/members`, { subject: `user:${uniq('dave')}` })).status).to.eq(403);
    expect((await as(owner).del(`/groups/${group.id}/members/${subjectPath(carol)}`)).status).to.eq(200);
    expect((await as(carol).get(`/teams/${team.id}`)).status).to.eq(403);
  });

  it('moves a group to another team', async () => {
    const owner = await platformUser();
    const team = await createTeam(owner);
    const other = await createTeam(owner);
    const group = await createGroup(owner, team.id);
    const res = await as(owner).post(`/groups/${group.id}/move`, { teamId: other.id, parentId: null });
    expect(res.status).to.eq(200);
    expect(res.body).to.include({ id: group.id, teamId: other.id, parentId: null });
    expect((await as(owner).get(`/teams/${team.id}/groups`)).body.items).to.deep.eq([]);
    expect((await as(owner).post(`/groups/${group.id}/move`, { teamId: team.id })).status, 'parentId is required').to.eq(400);
  });

  it('deletes a group; it is gone afterwards', async () => {
    const { owner, team } = await ownedTeam();
    const group = await createGroup(owner, team.id);
    const res = await as(owner).del(`/groups/${group.id}`);
    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ ok: true });
    expect([403, 404]).to.include((await as(owner).get(`/groups/${group.id}`)).status);
  });
});
