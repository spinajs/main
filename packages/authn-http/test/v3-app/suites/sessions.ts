import { expect } from 'chai';
import { createHash, randomUUID } from 'node:crypto';

import { Client, events, loggedIn, loggedInAal2, resetRecorders, seedUser, sessionSetCookie, step, tokens } from '../app.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function sessionsSuite(): void {
  beforeEach(resetRecorders);

  it('GET /user/sessions lists the caller own sessions, newest first, the current one flagged, never a raw id or storage key', async () => {
    const u = await seedUser();
    const a = await loggedIn(u);
    const b = await loggedIn(u);
    await loggedIn(await seedUser());
    const res = await b.get('/user/sessions');
    expect(res.status).to.eq(200);
    expect(res.body).to.have.length(2);
    expect(res.body.filter((s: { Current: boolean }) => s.Current)).to.have.length(1);
    const created = res.body.map((s: { Created: string }) => Date.parse(s.Created));
    expect(created).to.deep.eq([...created].sort((x: number, y: number) => y - x));
    for (const row of res.body) {
      expect(Object.keys(row)).to.include.members(['Handle', 'Created', 'LastSeen', 'Current']);
      expect(row.Handle).to.match(/^[0-9a-f]{64}$/);
    }
    const text = JSON.stringify(res.body);
    for (const id of [a.sessionId!, b.sessionId!]) {
      expect(text).to.not.include(id);
      expect(text).to.not.include(sha256(id));
    }
    expect(res.headers['cache-control']).to.eq('no-store');
  });

  it('DELETE /user/sessions/:handle ends one own session; a foreign handle is 404', async () => {
    const u = await seedUser();
    const a = await loggedIn(u);
    const b = await loggedIn(u);
    const [, other] = (await b.get('/user/sessions')).body;
    expect((await b.del(`/user/sessions/${other.Handle}`)).status).to.eq(200);
    expect((await a.get('/auth')).status, 'that session ended').to.eq(401);
    expect((await b.get('/auth')).status).to.eq(200);

    const stranger = await loggedIn(await seedUser());
    const [foreign] = (await stranger.get('/user/sessions')).body;
    const res = await b.del(`/user/sessions/${foreign.Handle}`);
    expect(res.status).to.eq(404);
    expect(res.body.error).to.eq('session_not_found');
    expect((await stranger.get('/auth')).status, 'the stranger session lives').to.eq(200);
    expect((await b.del(`/user/sessions/${'0'.repeat(64)}`)).status).to.eq(404);
    const revoked = events.ofType('session.revoke');
    expect(revoked, 'only the revocation that happened is audited').to.have.length(1);
    expect(revoked[0]).to.include({ outcome: 'success', reason: 'owner', session: other.Handle });
    expect(revoked[0].identity).to.deep.eq(u.ref);
  });

  it('DELETE /user/sessions/:handle of the current session logs the caller out and clears the cookie', async () => {
    const c = await loggedIn(await seedUser());
    const [own] = (await c.get('/user/sessions')).body;
    const held = c.cookie!;
    const res = await c.del(`/user/sessions/${own.Handle}`);
    expect(res.status).to.eq(200);
    expect(sessionSetCookie(res)?.value).to.eq('');
    expect((await new Client(held).get('/auth')).status).to.eq(401);
  });

  it('DELETE /user/sessions ends every other session and keeps the current one', async () => {
    const u = await seedUser();
    const a = await loggedIn(u);
    const b = await loggedIn(u);
    const c = await loggedIn(u);
    const res = await c.del('/user/sessions');
    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ Revoked: 2 });
    const [e] = events.ofType('session.revoke');
    expect(e).to.include({ reason: 'owner_others' });
    expect(e.data).to.deep.eq({ count: 2 });
    expect((await a.get('/auth')).status).to.eq(401);
    expect((await b.get('/auth')).status).to.eq(401);
    expect((await c.get('/auth')).status).to.eq(200);
  });

  it('needs a session principal: none and pending 401, a per-request credential 403 session_required', async () => {
    expect((await new Client().get('/user/sessions')).status).to.eq(401);
    const p = await seedUser();
    step.enrol(p.ref);
    const pending = new Client();
    await pending.post('/auth/login', { login: p.login, password: p.password });
    for (const req of [() => pending.get('/user/sessions'), () => pending.del('/user/sessions')]) expect((await req()).status).to.eq(401);

    const u = await seedUser();
    const token = `spt_${randomUUID()}`;
    tokens.set(token, u.ref);
    const res = await new Client().get('/user/sessions', { Authorization: `Bearer ${token}` });
    expect(res.status).to.eq(403);
    expect(res.body.error).to.eq('session_required');
  });

  it('N8a decision: refused while impersonating, so the impersonator neither sees the target devices nor ends its sessions; the target sees the impersonation session', async () => {
    const admin = await seedUser();
    const target = await seedUser();
    const own = await loggedIn(target);
    const c = await loggedInAal2(admin);
    expect((await c.post('/auth/impersonate', { target: target.ref.id }, { 'User-Agent': 'v3-app-admin' })).status).to.eq(200);
    for (const res of [await c.get('/user/sessions'), await c.del('/user/sessions'), await c.del(`/user/sessions/${'0'.repeat(64)}`)]) {
      expect(res.status).to.eq(403);
      expect(res.body.error).to.eq('impersonating');
    }
    expect((await own.get('/auth')).status, 'the target stays logged in').to.eq(200);
    const rows = (await own.get('/user/sessions')).body;
    expect(rows).to.have.length(2);
    expect(rows.find((r: { Current: boolean }) => !r.Current)).to.include({ UserAgent: 'v3-app-admin' });
  });
}
