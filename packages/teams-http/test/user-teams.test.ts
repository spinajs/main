import 'mocha';
import { expect } from 'chai';

import { as, createGroup, grantAt, ownedTeam, send, teamRef, uniq } from './support/client.js';

describe('GET /user/teams', function () {
  this.timeout(30_000);

  it('is empty for a user in no team', async () => {
    const res = await as(uniq('nobody')).get('/user/teams');
    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ teams: [], groups: [] });
  });

  it("lists the caller's teams and groups with roles", async () => {
    const a = await ownedTeam();
    const b = await ownedTeam();
    const group = await createGroup(b.owner, b.team.id);
    const carol = uniq('carol');
    await grantAt(carol, 'team.admin', teamRef(a.team.id));
    expect((await as(b.owner).post(`/groups/${group.id}/members`, { subject: `user:${carol}` })).status).to.eq(200);

    const res = await as(carol).get('/user/teams');
    expect(res.status).to.eq(200);
    const team = res.body.teams.find((t: any) => t.id === a.team.id);
    expect(team).to.include({ id: a.team.id, slug: a.team.slug, name: a.team.name });
    expect(team.roles).to.include('team.admin');
    const member = res.body.groups.find((g: any) => g.id === group.id);
    expect(member).to.include({ id: group.id, teamId: b.team.id });
    expect(member.roles).to.include('group.member');
  });

  it('answers 401 without a principal', async () => {
    expect((await send('GET', '/user/teams')).status).to.eq(401);
  });
});
