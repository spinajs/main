import 'mocha';
import { expect } from 'chai';

import { as, createTeam, grantAt, ownedTeam, platformUser, send, teamRef, uniq } from './support/client.js';

describe('teams routes', function () {
  this.timeout(30_000);

  describe('POST /teams', () => {
    it('creates a root team; the creator owns it', async () => {
      const owner = await platformUser();
      const slug = uniq('team');
      const res = await as(owner).post('/teams', { slug, name: 'Red', description: 'the red team' });
      expect(res.status).to.eq(200);
      expect(res.body).to.include({ slug, name: 'Red', description: 'the red team', parentId: null, archivedAt: null, deletedAt: null });
      expect(res.body.id).to.be.a('string').that.is.not.empty;
      expect(res.body.createdAt).to.be.a('string');
      expect((await as(owner).patch(`/teams/${res.body.id}`, { name: 'Crimson' })).status).to.eq(200);
    });

    it('answers 401 without a principal and 403 without team:create anywhere', async () => {
      expect((await send('POST', '/teams', { body: { slug: uniq('team'), name: 'x' } })).status).to.eq(401);
      expect((await as(uniq('nobody')).post('/teams', { slug: uniq('team'), name: 'x' })).status).to.eq(403);
    });

    it('refuses a root team to the owner of another team (team:create at $global)', async () => {
      const other = uniq('owner');
      const { team } = await ownedTeam();
      await grantAt(other, 'team.owner', teamRef(team.id));
      expect((await as(other).post('/teams', { slug: uniq('team'), name: 'x' })).status).to.eq(403);
    });

    it('creates a sub-team for the parent owner and refuses a member of the parent', async () => {
      const { owner, team } = await ownedTeam();
      const child = await as(owner).post('/teams', { slug: uniq('team'), name: 'Child', parentId: team.id });
      expect(child.status).to.eq(200);
      expect(child.body.parentId).to.eq(team.id);

      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(team.id));
      expect((await as(alice).post('/teams', { slug: uniq('team'), name: 'x', parentId: team.id })).status).to.eq(403);
    });

    it('checks team:create at the body parentId: an owner of only the parent creates a sub-team, not under an archived parent', async () => {
      const { owner, team } = await ownedTeam();
      const other = uniq('owner');
      await grantAt(other, 'team.owner', teamRef(team.id));
      const child = await as(other).post('/teams', { slug: uniq('team'), name: 'Child', parentId: team.id });
      expect(child.status, JSON.stringify(child.body)).to.eq(200);
      expect(child.body.parentId).to.eq(team.id);

      expect((await as(owner).post(`/teams/${team.id}/archive`)).status).to.eq(200);
      expect((await as(other).post('/teams', { slug: uniq('team'), name: 'x', parentId: team.id })).status, 'teams.archived.write denies team:create').to.eq(403);
    });

    it('validates the body against the CreateTeamBody schema', async () => {
      const owner = await platformUser();
      for (const body of [{ name: 'no slug' }, { slug: 'Bad Slug', name: 'x' }, { slug: uniq('team'), name: '' }, { slug: uniq('team'), name: 'x', color: 'red' }]) {
        expect((await as(owner).post('/teams', body)).status, JSON.stringify(body)).to.eq(400);
      }
    });

    it('answers 409 conflict for a taken slug', async () => {
      const owner = await platformUser();
      const slug = uniq('team');
      expect((await as(owner).post('/teams', { slug, name: 'a' })).status).to.eq(200);
      const again = await as(owner).post('/teams', { slug, name: 'b' });
      expect(again.status).to.eq(409);
      expect(again.body.error.code).to.eq('conflict');
    });
  });

  describe('GET /teams', () => {
    it('lists only the teams the caller can read, with a total', async () => {
      const a = await ownedTeam();
      await ownedTeam();
      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(a.team.id));
      const res = await as(alice).get('/teams');
      expect(res.status).to.eq(200);
      expect(res.body.items.map((t: any) => t.id)).to.deep.eq([a.team.id]);
      expect(res.body.total).to.eq(1);
    });

    it('filters by parentId, or to the root teams, and pages', async () => {
      const owner = await platformUser();
      const parent = await createTeam(owner);
      const child = await createTeam(owner, { parentId: parent.id });

      expect((await as(owner).get(`/teams?parentId=${parent.id}`)).body.items.map((t: any) => t.id)).to.deep.eq([child.id]);
      const roots = (await as(owner).get('/teams?root=true')).body.items.map((t: any) => t.id);
      expect(roots).to.include(parent.id);
      expect(roots).to.not.include(child.id);
      expect((await as(owner).get(`/teams?root=true&parentId=${parent.id}`)).status).to.eq(400);

      const first = await as(owner).get('/teams?size=1');
      const second = await as(owner).get('/teams?size=1&page=1');
      expect(first.body.items).to.have.length(1);
      expect(first.body.total).to.eq(2);
      expect([first.body.items[0].id, second.body.items[0].id]).to.have.members([parent.id, child.id]);
      expect((await as(owner).get('/teams?size=0')).status).to.eq(400);
      expect((await as(owner).get('/teams?page=-1')).status).to.eq(400);
    });

    it('answers 403 to a caller who can read no team', async () => {
      expect((await as(uniq('nobody')).get('/teams')).status).to.eq(403);
    });
  });

  describe('GET, PATCH, DELETE /teams/:team', () => {
    it('reads a team for a member and refuses an outsider', async () => {
      const { team } = await ownedTeam();
      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(team.id));
      const res = await as(alice).get(`/teams/${team.id}`);
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq(team);
      expect((await as(uniq('bob')).get(`/teams/${team.id}`)).status).to.eq(403);
    });

    it('changes a team for the owner, refuses a member, and refuses an empty patch', async () => {
      const { owner, team } = await ownedTeam();
      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(team.id));
      expect((await as(alice).patch(`/teams/${team.id}`, { name: 'x' })).status).to.eq(403);
      const res = await as(owner).patch(`/teams/${team.id}`, { name: 'Renamed', description: null });
      expect(res.status).to.eq(200);
      expect(res.body).to.include({ id: team.id, name: 'Renamed', description: null, slug: team.slug });
      expect((await as(owner).patch(`/teams/${team.id}`, {})).status).to.eq(400);
    });

    it('deletes a team for the owner; it is gone afterwards', async () => {
      const { owner, team } = await ownedTeam();
      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(team.id));
      expect((await as(alice).del(`/teams/${team.id}`)).status).to.eq(403);
      const res = await as(owner).del(`/teams/${team.id}`);
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq({ ok: true });
      const gone = await as(owner).get(`/teams/${team.id}`);
      expect(gone.status).to.eq(404);
      expect(gone.body.error.code).to.eq('not_found');
    });

    it('restores a deleted team for the owner and refuses a member', async () => {
      const { owner, team } = await ownedTeam();
      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(team.id));
      expect((await as(owner).del(`/teams/${team.id}`)).status).to.eq(200);
      expect((await as(alice).post(`/teams/${team.id}/restore`)).status).to.eq(403);
      const back = await as(owner).post(`/teams/${team.id}/restore`);
      expect(back.status).to.eq(200);
      expect(back.body).to.include({ id: team.id, deletedAt: null });
      expect((await as(alice).get(`/teams/${team.id}`)).status).to.eq(200);
    });
  });

  describe('POST /teams/:team/archive|unarchive|move|transfer', () => {
    it('archives and unarchives for the owner and refuses a member', async () => {
      const { owner, team } = await ownedTeam();
      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(team.id));
      expect((await as(alice).post(`/teams/${team.id}/archive`)).status).to.eq(403);
      const archived = await as(owner).post(`/teams/${team.id}/archive`);
      expect(archived.status).to.eq(200);
      expect(archived.body.archivedAt).to.be.a('string');
      expect((await as(alice).get(`/teams/${team.id}`)).status, 'team:read stays allowed on an archived team').to.eq(200);
      expect((await as(owner).patch(`/teams/${team.id}`, { name: 'x' })).status, 'teams.archived.write denies team:update').to.eq(403);
      const back = await as(owner).post(`/teams/${team.id}/unarchive`);
      expect(back.status).to.eq(200);
      expect(back.body.archivedAt).to.eq(null);
    });

    it('moves a team under another and back to the root', async () => {
      const owner = await platformUser();
      const parent = await createTeam(owner);
      const team = await createTeam(owner);
      const moved = await as(owner).post(`/teams/${team.id}/move`, { parentId: parent.id });
      expect(moved.status).to.eq(200);
      expect(moved.body.parentId).to.eq(parent.id);
      expect((await as(owner).get(`/teams?parentId=${parent.id}`)).body.items.map((t: any) => t.id)).to.deep.eq([team.id]);
      expect((await as(owner).post(`/teams/${team.id}/move`, { parentId: null })).body.parentId).to.eq(null);
      expect((await as(owner).post(`/teams/${team.id}/move`, {})).status).to.eq(400);
    });

    it('transfers ownership to a user; by default the old owner stays team.admin', async () => {
      const { owner, team } = await ownedTeam();
      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(team.id));
      expect((await as(owner).post(`/teams/${team.id}/transfer`, { to: `group:${uniq('g')}` })).status).to.eq(400);
      const res = await as(owner).post(`/teams/${team.id}/transfer`, { to: `user:${alice}` });
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq({ ok: true });
      expect((await as(alice).patch(`/teams/${team.id}`, { name: 'Mine' })).status).to.eq(200);

      expect((await as(owner).patch(`/teams/${team.id}`, { name: 'Still admin' })).status, 'team.admin keeps team:update').to.eq(200);
      expect((await as(owner).post(`/teams/${team.id}/transfer`, { to: `user:${owner}` })).status, 'no team:ownership.transfer').to.eq(403);
      expect((await as(owner).del(`/teams/${team.id}`)).status, 'no team:delete').to.eq(403);
    });

    it('transfers ownership with keepAs null; the old owner loses the team', async () => {
      const { owner, team } = await ownedTeam();
      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(team.id));
      expect((await as(owner).post(`/teams/${team.id}/transfer`, { to: `user:${alice}`, keepAs: null })).status).to.eq(200);
      expect((await as(alice).patch(`/teams/${team.id}`, { name: 'Mine' })).status).to.eq(200);
      expect((await as(owner).get(`/teams/${team.id}`)).status).to.eq(403);
      expect((await as(owner).patch(`/teams/${team.id}`, { name: 'Not mine' })).status).to.eq(403);
    });
  });
});
