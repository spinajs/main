import { expect } from 'chai';

import { AUTHN_FAILURE_BODY, PASSWORD_HARD_CAP } from '../../../src/v3/index.js';
import { Client, events, loggedIn, loggedInAal2, passwordStrategy, resetRecorders, roles, seedUser, sessionSetCookie, step, throttle } from '../app.js';
import type { Res } from '../app.js';

/** The uniform login failure (A02): 401, the one body, no-store, no Retry-After. */
export function expectUniformFailure(res: Res, label: string): void {
  expect(res.status, `${label}: ${res.text}`).to.eq(401);
  expect(res.body, label).to.deep.eq(AUTHN_FAILURE_BODY);
  expect(res.headers['cache-control'], label).to.contain('no-store');
  expect(res.headers['retry-after'], label).to.eq(undefined);
}

/** A 400 `{ error: code }` with no-store. */
export function expectCode(res: Res, code: string, label: string, noStore = true): void {
  expect(res.status, `${label}: ${res.text}`).to.eq(400);
  expect((res.body as { error?: unknown }).error, label).to.eq(code);
  if (noStore) expect(res.headers['cache-control'], label).to.contain('no-store');
}

const OVER = 'x'.repeat(PASSWORD_HARD_CAP + 1);

/** The account routes' answers to bodies their DTOs refuse (V2): the contract of each route, never the generic 400. */
export function accountInputSuite(): void {
  beforeEach(resetRecorders);

  describe('POST /auth/login', () => {
    const BODIES: [string, unknown][] = [
      ['an empty body', {}],
      ['no password', { login: 'a' }],
      ['a password over the cap', { login: 'a', password: OVER }],
      ['a login that is a list', { login: ['a'], password: 'p' }],
      ['a login that is a number, not coerced', { login: 123, password: 'p' }],
      ['a form body without a password', 'login=a'],
      ['an unknown field', { login: 'a', password: 'p', extra: 1 }],
    ];
    for (const [label, body] of BODIES) {
      it(`answers the uniform failure for ${label}, and counts and verifies nothing`, async () => {
        expectUniformFailure(await new Client().post('/auth/login', body), label);
        expect(throttle.attempts).to.have.length(0);
        expect(passwordStrategy.verifyCalls).to.have.length(0);
      });
    }

    it('refuses an unknown field next to the right credentials rather than ignoring it (D5)', async () => {
      const u = await seedUser();
      const res = await new Client().post('/auth/login', { login: u.login, password: u.password, remember: true });
      expectUniformFailure(res, 'unknown field');
      expect(sessionSetCookie(res)).to.eq(undefined);
    });

    it('ends the session the caller held, as any failed login does', async () => {
      const u = await seedUser();
      const c = await loggedIn(u);
      const held = c.cookie;
      const res = await c.post('/auth/login', { login: u.login });
      expectUniformFailure(res, 'held session');
      expect(sessionSetCookie(res)?.value).to.eq('');
      expect((await new Client(held!).get('/auth')).status).to.eq(401);
      expect(events.ofType('session.revoke').map((e) => e.reason)).to.deep.eq(['login']);
    });
  });

  describe('POST /auth/reauth', () => {
    for (const [label, body] of [
      ['an empty body', {}],
      ['an empty password', { password: '' }],
      ['a password that is a number', { password: 42 }],
      ['an unknown field', { password: 'p', extra: 1 }],
    ] as [string, unknown][]) {
      it(`answers the uniform failure for ${label} and re-authenticates nothing`, async () => {
        const c = await loggedIn(await seedUser());
        throttle.attempts.length = 0;
        expectUniformFailure(await c.post('/auth/reauth', body), label);
        expect(throttle.attempts.filter((a) => a.flow === 'reauth')).to.have.length(0);
      });
    }

    it('answers 401 unauthenticated without a session and 403 mfa_pending for a pending one, whatever the body', async () => {
      const anonymous = await new Client().post('/auth/reauth', {});
      expect(anonymous.status).to.eq(401);
      expect((anonymous.body as { error?: unknown }).error).to.eq('unauthenticated');
      const u = await seedUser();
      step.enrol(u.ref);
      const pending = new Client();
      await pending.post('/auth/login', { login: u.login, password: u.password });
      const res = await pending.post('/auth/reauth', {});
      expect(res.status).to.eq(403);
      expect((res.body as { error?: unknown }).error).to.eq('mfa_pending');
    });
  });

  describe('DELETE /user/sessions/:handle', () => {
    it('a handle over 128 characters answers the 404 of an unknown one and ends nothing', async () => {
      const c = await loggedIn(await seedUser());
      const res = await c.del(`/user/sessions/${'h'.repeat(129)}`);
      expect(res.status).to.eq(404);
      expect((res.body as { error?: unknown }).error).to.eq('session_not_found');
      expect((await c.get('/auth')).status).to.eq(200);
    });
  });

  describe('POST /auth/active-role', () => {
    it('a missing or over-long role answers 400 invalid_role, an unknown field 400 invalid_field, a password that is no string the login failure', async () => {
      const u = await seedUser();
      await roles.grant(u.ref, [{ role: 'editor', requirePassword: false }]);
      const c = await loggedIn(u);
      for (const body of [{}, { role: '' }, { role: 'r'.repeat(257) }, { role: 7 }]) expectCode(await c.post('/auth/active-role', body), 'invalid_role', JSON.stringify(body).slice(0, 30), false);
      expectCode(await c.post('/auth/active-role', { role: 'editor', remember: true }), 'invalid_field', 'unknown field');
      expectUniformFailure(await c.post('/auth/active-role', { role: 'editor', password: 42 }), 'password 42');
      expect((await c.get('/auth/active-role')).body).to.deep.include({ ActiveRole: null });
    });
  });

  describe('POST /auth/impersonate', () => {
    it('a malformed target answers 400 invalid_target, an unknown field 400 invalid_field, a password that is no string the login failure', async () => {
      const c = await loggedInAal2(await seedUser());
      for (const body of [{}, { target: '' }, { target: { type: 'user' } }, { target: { type: 'user', id: 'x', extra: 1 } }, { target: 't'.repeat(257) }, { target: { type: 't'.repeat(65), id: 'x' } }]) {
        expectCode(await c.post('/auth/impersonate', body), 'invalid_target', JSON.stringify(body).slice(0, 40), false);
      }
      expectCode(await c.post('/auth/impersonate', { target: 'someone', reason: 'x' }), 'invalid_field', 'unknown field');
      expectUniformFailure(await c.post('/auth/impersonate', { target: 'someone', password: ['p'] }), 'password list');
    });
  });

  describe('the MFA completion and step-up routes', () => {
    const pendingClient = async () => {
      const u = await seedUser();
      step.enrol(u.ref);
      const c = new Client();
      await c.post('/auth/login', { login: u.login, password: u.password });
      return c;
    };

    it('a pending session: a body the schema refuses answers the uniform failure and the session stays pending', async () => {
      const c = await pendingClient();
      for (const body of [{}, { code: 123456 }, { code: OVER }, { code: '1', extra: 1 }, { code: '1', step: 's'.repeat(65) }]) {
        expectUniformFailure(await c.post('/auth/mfa/verify', body), JSON.stringify(body).slice(0, 30));
      }
      for (const body of [{}, { code: 123456 }, { code: OVER }, { code: '1', step: 'totp' }]) {
        expectUniformFailure(await c.post('/auth/mfa/recovery', body), `recovery ${JSON.stringify(body).slice(0, 30)}`);
      }
      expect((await c.get('/auth')).body).to.have.property('MfaRequired');
      expect(throttle.attempts.filter((a) => a.flow === 'mfa')).to.have.length(0);
    });

    it('the session checks still answer first: an active session 403 mfa_not_pending, a pending one 403 mfa_pending on step-up', async () => {
      const active = await loggedIn(await seedUser());
      const verify = await active.post('/auth/mfa/verify', {});
      expect([verify.status, (verify.body as { error?: unknown }).error]).to.deep.eq([403, 'mfa_not_pending']);
      const pending = await pendingClient();
      const stepUp = await pending.post('/auth/mfa/step-up', {});
      expect([stepUp.status, (stepUp.body as { error?: unknown }).error]).to.deep.eq([403, 'mfa_pending']);
    });

    it('step-up of an active session answers the uniform failure to a body the schema refuses', async () => {
      const c = await loggedIn(await seedUser());
      for (const body of [{}, { code: 42 }, { code: '1', step: '' }, { code: '1', extra: 1 }]) expectUniformFailure(await c.post('/auth/mfa/step-up', body), JSON.stringify(body));
    });

    it('a challenge answers its one 202 to a body the schema refuses, and sends nothing', async () => {
      const c = await pendingClient();
      const sent = step.challenges.length;
      for (const body of [{ step: 42 }, { step: 'totp', extra: 1 }]) {
        const res = await c.post('/auth/mfa/challenge', body);
        expect([res.status, res.body], JSON.stringify(body)).to.deep.eq([202, { Ok: true }]);
      }
      expect(step.challenges).to.have.length(sent);
    });
  });
}
