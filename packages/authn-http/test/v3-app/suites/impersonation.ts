import { expect } from 'chai';
import sinon from 'sinon';
import { randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';

import { AUTHN_FAILURE_BODY } from '../../../src/v3/index.js';
import { AUTHN_PROBE_PATH } from '../../v3/probe.js';
import { Client, V3AppResponseExtension, config, guard, identities, loggedIn, loggedInAal2, resetRecorders, seedUser, sessionSetCookie, step, throttle, tokens } from '../app.js';

const probe = async (c: Client) => (await c.get(`/${AUTHN_PROBE_PATH}`)).body;

async function later<T>(seconds: number, fn: () => Promise<T>): Promise<T> {
  const clock = sinon.useFakeTimers({ now: Date.now() + seconds * 1000, toFake: ['Date'] });
  try {
    return await fn();
  } finally {
    clock.restore();
  }
}

const reauthAttempts = () => throttle.attempts.filter((a) => a.flow === 'reauth');

export function impersonationSuite(): void {
  beforeEach(async () => {
    resetRecorders();
    await guard.allowAll();
  });

  it('A20 start: a new session for the target with authn.impersonator, the old one ends, the impersonation extensions answer', async () => {
    const admin = await seedUser();
    const target = await seedUser();
    const c = await loggedInAal2(admin);
    const before = c.cookie!;
    resetRecorders();
    const res = await c.post('/auth/impersonate', { target: target.ref.id }, { 'User-Agent': 'v3-app-admin' });
    expect(res.status, JSON.stringify(res.body)).to.eq(200);
    expect(c.cookie).to.not.eq(before);
    expect(res.body.Identity).to.deep.eq({ type: 'user', id: target.ref.id });
    expect(res.body.Authn.impersonator).to.deep.eq({ type: 'user', id: admin.ref.id });
    expect(res.body.Access).to.include({ kind: 'impersonation', id: target.ref.id });
    expect(V3AppResponseExtension.calls.map((x) => x.kind)).to.deep.eq(['impersonation']);
    expect((await new Client(before).get('/auth')).status, 'the admin session ended').to.eq(401);

    const p = (await probe(c)).principal;
    expect(p.id).to.eq(target.ref.id);
    expect(p.authn.impersonator).to.deep.eq({ type: 'user', id: admin.ref.id });
    const own = (await c.get('/user/sessions')).body.find((s: { Current: boolean }) => s.Current);
    expect(own).to.include({ UserAgent: 'v3-app-admin' });
    expect(own.Ip).to.be.a('string');
  });

  it('GET /auth/impersonate: the state from authn.impersonator', async () => {
    const admin = await seedUser();
    const target = await seedUser();
    const c = await loggedInAal2(admin);
    expect((await c.get('/auth/impersonate')).body).to.deep.eq({ Active: false });
    await c.post('/auth/impersonate', { target: target.ref.id });
    const res = await c.get('/auth/impersonate');
    expect(res.status).to.eq(200);
    expect(res.body).to.include({ Active: true });
    expect(res.body.Impersonator).to.deep.eq({ type: 'user', id: admin.ref.id });
    expect(res.body.Target).to.deep.eq({ type: 'user', id: target.ref.id });
    expect(Date.parse(res.body.StartedAt)).to.be.closeTo(Date.now(), 60_000);
  });

  it('DELETE /auth/impersonate: a new session for the impersonator, the impersonation one ends', async () => {
    const admin = await seedUser();
    const target = await seedUser();
    const c = await loggedInAal2(admin);
    await c.post('/auth/impersonate', { target: target.ref.id });
    const impersonating = c.cookie!;
    const res = await c.del('/auth/impersonate');
    expect(res.status, JSON.stringify(res.body)).to.eq(200);
    expect(c.cookie).to.not.eq(impersonating);
    expect(res.body.Identity).to.deep.eq({ type: 'user', id: admin.ref.id });
    expect(res.body.Authn).to.not.have.property('impersonator');
    const p = (await probe(c)).principal;
    expect(p.id).to.eq(admin.ref.id);
    expect(p.authn.impersonator).to.eq(undefined);
    expect((await new Client(impersonating).get('/auth')).status).to.eq(401);
  });

  it('DELETE without an impersonation is 400 not_impersonating and leaves the session alone', async () => {
    const c = await loggedIn(await seedUser());
    const before = c.cookie;
    const res = await c.del('/auth/impersonate');
    expect(res.status).to.eq(400);
    expect(res.body.error).to.eq('not_impersonating');
    expect(sessionSetCookie(res)).to.eq(undefined);
    expect(c.cookie).to.eq(before);
    expect((await c.get('/auth')).status).to.eq(200);
  });

  it('SR-06 a banned impersonator: the next request, a stop included, finds the impersonation ended', async () => {
    const admin = await seedUser();
    const target = await seedUser();
    const c = await loggedInAal2(admin);
    await c.post('/auth/impersonate', { target: target.ref.id });
    const impersonating = c.cookie!;
    identities.setStatus(admin.ref, { banned: true });
    try {
      const res = await c.del('/auth/impersonate');
      expect(res.status).to.eq(401);
      expect((await new Client(impersonating).get('/auth')).status).to.eq(401);
      identities.setStatus(admin.ref, { banned: false });
      expect((await new Client(impersonating).get(`/${AUTHN_PROBE_PATH}`)).body.principal, 'the session is gone, not only refused').to.eq(null);
    } finally {
      identities.setStatus(admin.ref, { banned: false });
    }
  });

  it('the guard decides: a refusal is 403 impersonation_refused and the admin session survives', async () => {
    const admin = await seedUser();
    const target = await seedUser();
    const c = await loggedInAal2(admin);
    const before = c.cookie;
    for (const code of ['forbidden', 'protected_role', 'escalation'] as const) {
      await guard.deny(code);
      const res = await c.post('/auth/impersonate', { target: target.ref.id });
      expect(res.status, code).to.eq(403);
      expect(res.body.error, code).to.eq('impersonation_refused');
    }
    expect(c.cookie).to.eq(before);
    expect((await c.get('/auth')).status).to.eq(200);
  });

  it('impersonating yourself, an unknown or a banned target is refused 403; a target that is not an id is 400', async () => {
    const admin = await seedUser();
    const banned = await seedUser({ status: { banned: true } });
    const c = await loggedInAal2(admin);
    expect((await c.post('/auth/impersonate', { target: admin.ref.id })).status).to.eq(403);
    expect((await c.post('/auth/impersonate', { target: randomUUID() })).status).to.eq(403);
    expect((await c.post('/auth/impersonate', { target: banned.ref.id })).status).to.eq(403);
    for (const target of [undefined, '', 42, ['x'], { type: 'user' }, 't'.repeat(257)]) {
      expect((await c.post('/auth/impersonate', { target })).status, JSON.stringify(target)).to.eq(400);
    }
  });

  it('takes the target as { type, id } and the 2.x TargetUuid', async () => {
    const admin = await seedUser();
    const c = await loggedInAal2(admin);
    const t1 = await seedUser();
    expect((await c.post('/auth/impersonate', { target: { type: 'user', id: t1.ref.id } })).status).to.eq(200);
    const admin2 = await seedUser();
    const d = await loggedInAal2(admin2);
    const t2 = await seedUser();
    expect((await d.post('/auth/impersonate', { TargetUuid: t2.ref.id })).status).to.eq(200);
  });

  it('requireMfa: an aal1 session is refused although no step is required of it', async () => {
    const admin = await seedUser();
    const target = await seedUser();
    const c = await loggedIn(admin);
    const res = await c.post('/auth/impersonate', { target: target.ref.id });
    expect(res.status).to.eq(403);
    expect(res.body.error).to.eq('impersonation_refused');
  });

  describe('fresh auth (A13, SR-20)', () => {
    it('a stale session without a password is refused 403 fresh_auth_required and verifies nothing', async () => {
      const admin = await seedUser();
      const target = await seedUser();
      const c = await loggedInAal2(admin);
      resetRecorders();
      const res = await later(301, () => c.post('/auth/impersonate', { target: target.ref.id }));
      expect(res.status).to.eq(403);
      expect(res.body.error).to.eq('fresh_auth_required');
      expect(reauthAttempts()).to.have.length(0);
    });

    it('a stale session starts with the right password', async () => {
      const admin = await seedUser();
      const target = await seedUser();
      const c = await loggedInAal2(admin);
      const res = await later(301, () => c.post('/auth/impersonate', { target: target.ref.id, password: admin.password }));
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(reauthAttempts(), 'the route, then the service under requirePassword').to.have.length(2);
      expect(reauthAttempts().every((a) => a.ctx.purpose === 'reauth')).to.eq(true);
    });

    it('a wrong password answers the login failure body with no Retry-After, counted once in the reauth flow', async () => {
      const admin = await seedUser();
      const target = await seedUser();
      const c = await loggedInAal2(admin);
      resetRecorders();
      const res = await later(301, () => c.post('/auth/impersonate', { target: target.ref.id, password: 'Wrong-Pass-9876' }));
      expect(res.status).to.eq(401);
      expect(res.body).to.deep.eq(AUTHN_FAILURE_BODY);
      expect(res.headers['retry-after']).to.eq(undefined);
      expect(reauthAttempts()).to.have.length(1);
      expect(guard.calls.filter((x) => x.target.id === target.ref.id)).to.have.length(0);
    });

    describe('with authn.impersonation.requirePassword false', () => {
      // AuthnImpersonationService reads its settings when it resolves.
      const setRequirePassword = async (on: boolean) => {
        config().set('authn.impersonation.requirePassword', on);
        const { AuthnImpersonationService } = await import('@spinajs/authn');
        DI.uncache(AuthnImpersonationService);
      };
      before(() => setRequirePassword(false));
      after(() => setRequirePassword(true));

      it('the route still needs fresh auth (design §22.11: FreshAuth on start); only the service skips its own check', async () => {
        const admin = await seedUser();
        const target = await seedUser();
        const c = await loggedInAal2(admin);
        const stale = await later(301, () => c.post('/auth/impersonate', { target: target.ref.id }));
        expect(stale.status).to.eq(403);
        expect(stale.body.error).to.eq('fresh_auth_required');
        resetRecorders();
        const res = await later(301, () => c.post('/auth/impersonate', { target: target.ref.id, password: admin.password }));
        expect(res.status, JSON.stringify(res.body)).to.eq(200);
        expect(reauthAttempts(), 'verified once, by the route').to.have.length(1);
      });
    });

    it("another account's password never counts", async () => {
      const admin = await seedUser();
      const target = await seedUser();
      const c = await loggedInAal2(admin);
      const res = await later(301, () => c.post('/auth/impersonate', { target: target.ref.id, password: target.password }));
      expect(res.status).to.eq(401);
    });
  });

  it('SR-07 pending session cannot impersonate', async () => {
    const admin = await seedUser();
    const target = await seedUser();
    step.enrol(admin.ref);
    const c = new Client();
    await c.post('/auth/login', { login: admin.login, password: admin.password });
    const calls = guard.calls.length;
    const res = await c.post('/auth/impersonate', { target: target.ref.id, password: admin.password });
    expect(res.status).to.eq(401);
    expect(guard.calls.length).to.eq(calls);
    expect((await probe(c)).principal).to.eq(null);
  });

  it('a per-request credential cannot impersonate: 403 session_required', async () => {
    const admin = await seedUser();
    const target = await seedUser();
    const token = `spt_${randomUUID()}`;
    tokens.set(token, admin.ref);
    const res = await new Client().post('/auth/impersonate', { target: target.ref.id }, { Authorization: `Bearer ${token}` });
    expect(res.status).to.eq(403);
    expect(res.body.error).to.eq('session_required');
  });

  it('A20 logout during impersonation ends it', async () => {
    const admin = await seedUser();
    const target = await seedUser();
    const c = await loggedInAal2(admin);
    await c.post('/auth/impersonate', { target: target.ref.id });
    const impersonating = c.cookie!;
    expect((await c.post('/auth/logout')).status).to.eq(200);
    expect((await probe(new Client(impersonating))).principal).to.eq(null);
  });

  it('a nested start while impersonating is refused', async () => {
    const admin = await seedUser();
    const t1 = await seedUser();
    const t2 = await seedUser();
    const c = await loggedInAal2(admin);
    await c.post('/auth/impersonate', { target: t1.ref.id });
    const res = await c.post('/auth/impersonate', { target: t2.ref.id });
    expect(res.status).to.eq(403);
    expect((await probe(c)).principal.id).to.eq(t1.ref.id);
  });
}
