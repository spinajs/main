import { expect } from 'chai';

import { AUTHN_FAILURE_BODY, PASSWORD_HARD_CAP } from '../../../src/v3/index.js';
import { Client, events, loggedIn, passwordStrategy, resetRecorders, seedUser, sessionSetCookie, step, throttle } from '../app.js';
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
}
