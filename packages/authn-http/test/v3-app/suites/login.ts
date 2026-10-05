import { expect } from 'chai';
import { randomUUID } from 'node:crypto';

import { AUTHN_FAILURE_BODY } from '../../../src/v3/index.js';
import { AUTHN_PROBE_PATH } from '../../v3/probe.js';
import { Client, V3AppResponseExtension, clearLog, config, cookieName, logLines, loggedIn, passwordStrategy, resetRecorders, seedUser, sessionSetCookie, step, throttle, tokens } from '../app.js';
import type { Res } from '../app.js';

const probe = async (c: Client) => (await c.get(`/${AUTHN_PROBE_PATH}`)).body;

function expectA02(res: Res, label: string): void {
  expect(res.status, label).to.eq(401);
  expect(res.body, label).to.deep.eq(AUTHN_FAILURE_BODY);
  expect(res.headers['retry-after'], label).to.eq(undefined);
}

export function loginSuite(): void {
  beforeEach(resetRecorders);

  describe('POST /auth/login', () => {
    it('logs in: the session cookie, the principal summary and the login extensions; the client ip and user agent are stored', async () => {
      const u = await seedUser();
      const c = new Client();
      const res = await c.post('/auth/login', { login: u.login, password: u.password }, { 'User-Agent': 'v3-app-browser' });
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.body.Identity).to.deep.eq({ type: 'user', id: u.ref.id });
      expect(res.body.Authn).to.include({ method: 'password', strategy: 'local', assurance: 'aal1' });
      expect(res.body.Access).to.deep.eq({ kind: 'login', id: u.ref.id, roles: null });
      expect(V3AppResponseExtension.calls.map((x) => x.kind)).to.deep.eq(['login']);
      expect(res.headers['cache-control']).to.eq('no-store');
      expect(JSON.stringify(res.body)).to.not.include(c.sessionId!);

      const p = await probe(c);
      expect(p.principal.id).to.eq(u.ref.id);
      const sessions = (await c.get('/user/sessions')).body;
      expect(sessions).to.have.length(1);
      expect(sessions[0]).to.include({ Ip: p.clientIp, UserAgent: 'v3-app-browser', Current: true });
    });

    it('passes ctx.ip from ClientIp and purpose login to the authentication', async () => {
      const u = await seedUser();
      const c = await loggedIn(u);
      const ip = (await probe(c)).clientIp;
      const login = throttle.attempts.filter((a) => a.flow === 'login');
      expect(login).to.have.length(1);
      expect(login[0].ctx).to.include({ ip, purpose: 'login' });
    });

    it('accepts the 2.x field names Email and Password', async () => {
      const u = await seedUser();
      const res = await new Client().post('/auth/login', { Email: u.login, Password: u.password });
      expect(res.status).to.eq(200);
    });

    it('SR-16 the session cookie without any app env: __Host-ssid, Secure, HttpOnly, SameSite=Strict, Path=/, no Domain, no lifetime (D7)', async () => {
      expect(config().get('process.env.APP_ENV'), 'the configuration fell back on its own').to.eq('development');
      const u = await seedUser();
      const res = await new Client().post('/auth/login', { login: u.login, password: u.password });
      expect(cookieName()).to.eq('__Host-ssid');
      const ck = sessionSetCookie(res)!;
      expect(ck, res.setCookie.join(' | ')).to.not.eq(undefined);
      expect([...ck.attrs.keys()]).to.include.members(['secure', 'httponly', 'path', 'samesite']);
      expect(ck.attrs.get('path')).to.eq('/');
      expect(ck.attrs.get('samesite')?.toLowerCase()).to.eq('strict');
      expect([...ck.attrs.keys()]).to.not.include.members(['domain', 'max-age', 'expires']);
    });

    it('the session cookie under APP_ENV test: ssid without Secure, still HttpOnly and SameSite=Strict', async () => {
      const u = await seedUser();
      config().set('process.env.APP_ENV', 'test');
      try {
        const res = await new Client().post('/auth/login', { login: u.login, password: u.password });
        expect(res.status).to.eq(200);
        expect(cookieName()).to.eq('ssid');
        const ck = sessionSetCookie(res)!;
        expect(ck, res.setCookie.join(' | ')).to.not.eq(undefined);
        expect([...ck.attrs.keys()]).to.include.members(['httponly', 'samesite']);
        expect([...ck.attrs.keys()]).to.not.include('secure');
      } finally {
        config().set('process.env.APP_ENV', 'development');
      }
    });

    it('revokes the session the caller already holds', async () => {
      const u = await seedUser();
      const c = await loggedIn(u);
      const first = c.cookie;
      expect((await c.post('/auth/login', { login: u.login, password: u.password })).status).to.eq(200);
      expect(c.cookie).to.not.eq(first);
      expect((await new Client(first!).get('/auth')).status).to.eq(401);
    });

    describe('A02 one failure answer', () => {
      const ROWS: { label: string; status?: NonNullable<Parameters<typeof seedUser>[0]>['status']; body: (u: { login: string; password: string }) => unknown }[] = [
        { label: 'unknown account', body: () => ({ login: `nobody-${randomUUID()}@example.test`, password: 'Wrong-Pass-9876' }) },
        { label: 'wrong password', body: (u) => ({ login: u.login, password: 'Wrong-Pass-9876' }) },
        { label: 'banned', status: { banned: true }, body: (u) => ({ login: u.login, password: u.password }) },
        { label: 'inactive', status: { active: false }, body: (u) => ({ login: u.login, password: u.password }) },
        { label: 'deleted', status: { deleted: true }, body: (u) => ({ login: u.login, password: u.password }) },
        { label: 'no password', body: (u) => ({ login: u.login }) },
        { label: 'no body', body: () => undefined },
        { label: 'a login that is not a string', body: (u) => ({ login: [u.login], password: u.password }) },
        { label: 'a login over 1024 characters', body: (u) => ({ login: 'x'.repeat(1025), password: u.password }) },
        { label: 'a password over 1024 characters', body: (u) => ({ login: u.login, password: 'p'.repeat(1025) }) },
      ];

      for (const row of ROWS) {
        it(`answers 401 with the one failure body: ${row.label}`, async () => {
          const u = await seedUser(row.status ? { status: row.status } : {});
          const c = new Client();
          const res = await c.post('/auth/login', row.body(u));
          expectA02(res, row.label);
          expect(sessionSetCookie(res), 'no session cookie').to.eq(undefined);
          expect(res.body).to.deep.eq({ error: { code: 'E_AUTH_FAILED', message: 'login or password incorrect' }, message: 'login or password incorrect' });
        });
      }

      it('over-long values and malformed bodies reach no strategy', async () => {
        const u = await seedUser();
        await new Client().post('/auth/login', { login: 'x'.repeat(1025), password: u.password });
        await new Client().post('/auth/login', { login: u.login, password: 'p'.repeat(1025) });
        await new Client().post('/auth/login', { login: 42, password: u.password });
        expect(passwordStrategy.verifyCalls).to.have.length(0);
        expect(throttle.attempts).to.have.length(0);
      });

      it('a throttled login answers the same body with Retry-After from retryAfterSeconds (A06)', async () => {
        const u = await seedUser();
        throttle.refuse(7);
        const res = await new Client().post('/auth/login', { login: u.login, password: u.password });
        expect(res.status).to.eq(401);
        expect(res.body).to.deep.eq(AUTHN_FAILURE_BODY);
        expect(res.headers['retry-after']).to.eq('7');
        expect(passwordStrategy.verifyCalls, 'a throttled attempt verifies nothing').to.have.length(0);
      });

      it('a failed login of a caller holding a session ends that session and clears its cookie', async () => {
        const u = await seedUser();
        const c = await loggedIn(u);
        const held = c.cookie;
        const res = await c.post('/auth/login', { login: u.login, password: 'Wrong-Pass-9876' });
        expectA02(res, 'held session');
        expect(sessionSetCookie(res)?.value, 'the cookie is cleared').to.eq('');
        expect((await new Client(held!).get('/auth')).status).to.eq(401);
      });
    });

    it('SR-19 the login never logs the submitted login string', async () => {
      const u = await seedUser();
      const unknown = `sr19-${randomUUID()}@example.test`;
      clearLog();
      await new Client().post('/auth/login', { login: unknown, password: 'Wrong-Pass-9876' });
      await new Client().post('/auth/login', { login: u.login, password: 'Wrong-Pass-9876' });
      await new Client().post('/auth/login', { login: u.login, password: u.password });
      await new Client().post('/auth/login', { login: `${unknown}${'y'.repeat(1100)}`, password: 'x' });
      const lines = logLines();
      expect(lines.length, 'the log target records').to.be.greaterThan(0);
      for (const needle of [unknown, u.login, 'Wrong-Pass-9876', u.password]) {
        expect(lines.filter((l) => l.includes(needle)), needle).to.deep.eq([]);
      }
    });
  });

  describe('GET /auth (whoami)', () => {
    it('401 without a session or principal', async () => {
      const res = await new Client().get('/auth');
      expect(res.status).to.eq(401);
      expect(res.body.error).to.eq('unauthenticated');
    });

    it('an active session: the principal summary and the whoami extensions', async () => {
      const u = await seedUser();
      const c = await loggedIn(u);
      resetRecorders();
      const res = await c.get('/auth');
      expect(res.status).to.eq(200);
      expect(res.body.Identity).to.deep.eq({ type: 'user', id: u.ref.id });
      expect(res.body.Authn).to.include({ assurance: 'aal1' });
      expect(res.body.Authn).to.not.have.property('sessionHandle');
      expect(res.body.Access).to.include({ kind: 'whoami' });
      expect(V3AppResponseExtension.calls.map((x) => x.kind)).to.deep.eq(['whoami']);
    });

    it('SR-07 pending whoami shows only MfaRequired', async () => {
      const u = await seedUser();
      step.enrol(u.ref);
      const c = new Client();
      const login = await c.post('/auth/login', { login: u.login, password: u.password });
      expect(login.status).to.eq(200);
      expect(login.body).to.deep.eq({ MfaRequired: ['totp'] });
      resetRecorders();
      const res = await c.get('/auth');
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq({ MfaRequired: ['totp'] });
      expect(V3AppResponseExtension.calls, 'no extension sees a pending session').to.deep.eq([]);
    });
  });

  describe('POST /auth/logout', () => {
    it('A08 revokes the session, clears the cookie and the site data', async () => {
      const u = await seedUser();
      const c = await loggedIn(u);
      const held = c.cookie!;
      const res = await c.post('/auth/logout');
      expect(res.status).to.eq(200);
      const ck = sessionSetCookie(res)!;
      expect(ck.value).to.eq('');
      expect(ck.attrs.has('expires') || ck.attrs.get('max-age') === '0', res.setCookie.join(' | ')).to.eq(true);
      expect(res.headers['clear-site-data']).to.include('"cookies"');
      expect(res.headers['cache-control']).to.eq('no-store');
      expect((await new Client(held).get('/auth')).status).to.eq(401);
    });

    it('a pending session may log out too', async () => {
      const u = await seedUser();
      step.enrol(u.ref);
      const c = new Client();
      await c.post('/auth/login', { login: u.login, password: u.password });
      const held = c.cookie!;
      expect((await c.post('/auth/logout')).status).to.eq(200);
      expect((await new Client(held).post('/auth/mfa/verify', { code: step.nextCode(u.ref) })).status).to.eq(401);
    });

    it('401 without a session', async () => {
      expect((await new Client().post('/auth/logout')).status).to.eq(401);
    });

    it('a per-request credential has no session to end: 401', async () => {
      const u = await seedUser();
      const token = `spt_${randomUUID()}`;
      tokens.set(token, u.ref);
      expect((await new Client().post('/auth/logout', undefined, { Authorization: `Bearer ${token}` })).status).to.eq(401);
    });
  });
}
