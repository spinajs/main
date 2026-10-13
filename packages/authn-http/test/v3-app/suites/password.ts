import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { Container, DI } from '@spinajs/di';
import type { IController, IRoute, Request } from '@spinajs/http';
import { PasswordService, SessionIssuer } from '@spinajs/authn/contracts';
import type {
  AuthnContext,
  IdentityRef,
  PasswordChangeResult,
  PasswordPolicy,
  PasswordResetRequestResult,
  PasswordResetResult,
  PasswordSetResult,
  PasswordViolation,
  SessionHandle,
} from '@spinajs/authn/contracts';

import { PasswordServiceRegistered } from '../../../src/password/index.js';
import { AUTHN_FAILURE_BODY, PASSWORD_HARD_CAP } from '../../../src/v3/index.js';
import { AUTHN_PROBE_PATH } from '../../v3/probe.js';
import { Client, bind, clearLog, guard, logLines, loggedIn, loggedInAal2, seedUser, sessionSetCookie, step, switchHooksOn, tokens } from '../app.js';
import type { Res } from '../app.js';
import { mountedRoutes } from './route-table.js';

export const PASSWORD_ROUTES_V3 = ['GET /auth/password/policy', 'POST /auth/password/reset-request', 'POST /auth/password/reset', 'PATCH /user/password'];

type Call = { method: string; args: unknown[] };

/** Records every call; each flow answers what its `answer` hook says, or the happy path. */
class RouteFakePasswordService extends PasswordService {
  public calls: Call[] = [];
  public described: PasswordPolicy = { minLength: 8, maxLength: 128 };
  public answer: {
    change?: (session: SessionHandle) => Promise<PasswordChangeResult>;
    requestReset?: () => Promise<PasswordResetRequestResult>;
    redeemReset?: () => Promise<PasswordResetResult>;
  } = {};

  public reset(): void {
    this.calls = [];
    this.answer = {};
    this.described = { minLength: 8, maxLength: 128 };
  }

  public of(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  public async change(id: IdentityRef, oldPassword: string, newPassword: string, session: SessionHandle, ctx: AuthnContext): Promise<PasswordChangeResult> {
    this.calls.push({ method: 'change', args: [id, oldPassword, newPassword, session, ctx] });
    if (this.answer.change) return this.answer.change(session);
    return { status: 'changed', session: await (await DI.resolve(SessionIssuer)).rotate(session) };
  }

  public async requestReset(login: string, ctx: AuthnContext): Promise<PasswordResetRequestResult> {
    this.calls.push({ method: 'requestReset', args: [login, ctx] });
    return this.answer.requestReset ? this.answer.requestReset() : { status: 'accepted' };
  }

  public async redeemReset(login: string, secret: string, newPassword: string, ctx: AuthnContext): Promise<PasswordResetResult> {
    this.calls.push({ method: 'redeemReset', args: [login, secret, newPassword, ctx] });
    return this.answer.redeemReset ? this.answer.redeemReset() : { status: 'reset', purpose: 'reset' };
  }

  public async invite(): Promise<void> {
    throw new Error('not a route');
  }

  public policy(): PasswordPolicy {
    this.calls.push({ method: 'policy', args: [] });
    return this.described;
  }

  public async check(): Promise<readonly PasswordViolation[]> {
    return [];
  }

  public async set(): Promise<PasswordSetResult> {
    throw new Error('not a route');
  }

  public async expire(): Promise<void> {
    throw new Error('not a route');
  }
}

const fake = new RouteFakePasswordService();

const RESET_ACK = { Ok: true };

const clientIp = async (): Promise<string> => (await new Client().get(`/${AUTHN_PROBE_PATH}`)).body.clientIp;

function expectFailureBody(res: Res, retryAfter?: string): void {
  expect(res.status, JSON.stringify(res.body)).to.eq(401);
  expect(res.body).to.deep.eq(AUTHN_FAILURE_BODY);
  expect(res.headers['cache-control']).to.eq('no-store');
  expect(res.headers['retry-after']).to.eq(retryAfter);
}

/** The gate on containers of its own; test/v3/route-groups-boot.test.ts boots apps with and without authn-local. */
export function passwordGateSuite(): void {
  it('the gate asks the container it resolves from', async () => {
    const empty = new Container();
    const route = {} as IRoute;
    const ctrl = {} as IController;
    const req = { storage: {} } as unknown as Request;
    const gate = new PasswordServiceRegistered();
    (gate as unknown as { Container: unknown }).Container = empty;
    expect(gate.isEnabled(route, ctrl)).to.eq(true);
    await gate.execute(req, route, ctrl).then(
      () => expect.fail('the gate passed without a PasswordService'),
      (e: { constructor: { name: string } }) => expect(e.constructor.name).to.eq('ResourceNotFound'),
    );
    const child = empty.child();
    child.register({ StubPasswordService: () => ({}) }.StubPasswordService).as(PasswordService as never);
    (gate as unknown as { Container: unknown }).Container = child;
    await gate.execute(req, route, ctrl);
  });
}

/** The routes over a recording PasswordService (the real one runs in behaviour/n8b.test.ts). */
export function passwordRoutesSuite(): void {
  before(() => {
    bind(PasswordService, 'V3AppPasswordService', () => fake);
  });

  beforeEach(() => {
    fake.reset();
    clearLog();
  });

  describe('GET /auth/password/policy', () => {
    it('answers exactly what PasswordService.policy() describes, to anyone (LEDGER PasswordResetController 1)', async () => {
      fake.described = { minLength: 10, maxLength: 64, pattern: '^(?=.*\\d).+$', description: 'Ten characters and a digit' };
      const res = await new Client().get('/auth/password/policy');
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq(fake.described);
    });

    it('a policy without a rule answers only its bounds (LEDGER PasswordResetController 2)', async () => {
      const res = await new Client().get('/auth/password/policy');
      expect(res.body).to.deep.eq({ minLength: 8, maxLength: 128 });
    });
  });

  describe('POST /auth/password/reset-request', () => {
    it('hands the login and the trusted client ip to requestReset and answers the ack without caching (LEDGER PasswordResetController 3)', async () => {
      const res = await new Client().post('/auth/password/reset-request', { login: 'me@example.test' });
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq(RESET_ACK);
      expect(res.headers['cache-control']).to.eq('no-store');
      const [login, ctx] = fake.of('requestReset')[0].args as [string, AuthnContext];
      expect(login).to.eq('me@example.test');
      expect(ctx.ip).to.eq(await clientIp());
      expect(ctx.purpose).to.eq('login');
    });

    it('takes the 2.x field name Email too', async () => {
      await new Client().post('/auth/password/reset-request', { Email: 'me@example.test' });
      expect(fake.of('requestReset')[0].args[0]).to.eq('me@example.test');
    });

    it('answers the same status and body whatever the work does (LEDGER PasswordResetController 4, 5)', async () => {
      const known = await new Client().post('/auth/password/reset-request', { login: 'me@example.test' });
      fake.answer.requestReset = () => Promise.reject(new Error('mail queue down for ghost@example.test'));
      const failed = await new Client().post('/auth/password/reset-request', { login: 'ghost@example.test' });
      expect(failed.status).to.eq(known.status);
      expect(failed.body).to.deep.eq(known.body);
      expect(failed.headers['cache-control']).to.eq(known.headers['cache-control']);
      expect(logLines().join('\n'), 'the failure is logged without the login').to.not.include('ghost@example.test');
    });

    it('a throttled request answers 429 with Retry-After; the throttle keys never depend on whether the account exists', async () => {
      fake.answer.requestReset = async () => ({ status: 'throttled', retryAfterSeconds: 41.2 });
      const res = await new Client().post('/auth/password/reset-request', { login: 'me@example.test' });
      expect(res.status).to.eq(429);
      expect(res.body.error).to.eq('throttled');
      expect(res.headers['retry-after']).to.eq('42');
      expect(res.headers['cache-control']).to.eq('no-store');
    });

    it('a missing, empty or over-long login answers 400 invalid_login and never reaches the service', async () => {
      for (const body of [{}, { login: '' }, { login: 42 }, { login: 'x'.repeat(PASSWORD_HARD_CAP + 1) }]) {
        const res = await new Client().post('/auth/password/reset-request', body);
        expect(res.status, JSON.stringify(body)).to.eq(400);
        expect(res.body.error).to.eq('invalid_login');
      }
      expect(fake.of('requestReset')).to.deep.eq([]);
    });
  });

  describe('POST /auth/password/reset', () => {
    const body = (over: Record<string, unknown> = {}) => ({ login: 'me@example.test', secret: 'kit-secret-123', password: 'Brand-New-Pass-1', ...over });

    it('redeems the secret with the login, the new password and the trusted client ip (LEDGER PasswordResetController 6)', async () => {
      const res = await new Client().post('/auth/password/reset', body({ confirmPassword: 'Brand-New-Pass-1' }));
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq(RESET_ACK);
      expect(res.headers['cache-control']).to.eq('no-store');
      const [login, secret, password, ctx] = fake.of('redeemReset')[0].args as [string, string, string, AuthnContext];
      expect([login, secret, password]).to.deep.eq(['me@example.test', 'kit-secret-123', 'Brand-New-Pass-1']);
      expect(ctx.ip).to.eq(await clientIp());
    });

    it('takes the 2.x field names Email, Token, Password and ConfirmPassword too', async () => {
      const res = await new Client().post('/auth/password/reset', { Email: 'me@example.test', Token: 'tok-123', Password: 'Brand-New-Pass-1', ConfirmPassword: 'Brand-New-Pass-1' });
      expect(res.status).to.eq(200);
      expect(fake.of('redeemReset')[0].args.slice(0, 3)).to.deep.eq(['me@example.test', 'tok-123', 'Brand-New-Pass-1']);
    });

    it('rejects a mismatched confirmation before the secret is touched (LEDGER PasswordResetController 7)', async () => {
      const res = await new Client().post('/auth/password/reset', body({ confirmPassword: 'Other-Pass-1234' }));
      expect(res.status).to.eq(400);
      expect(res.body.error).to.eq('password_mismatch');
      expect(fake.of('redeemReset')).to.deep.eq([]);
    });

    it('an invalid, used or expired secret answers the login failure body (LEDGER PasswordResetController 8)', async () => {
      fake.answer.redeemReset = async () => ({ status: 'invalid' });
      expectFailureBody(await new Client().post('/auth/password/reset', body()));
    });

    it('a wrong secret and an unknown login answer alike (LEDGER PasswordResetController 9)', async () => {
      fake.answer.redeemReset = async () => ({ status: 'invalid' });
      const wrong = await new Client().post('/auth/password/reset', body({ secret: 'wrong' }));
      const unknown = await new Client().post('/auth/password/reset', body({ login: 'ghost@example.test' }));
      expect([unknown.status, unknown.body, unknown.headers['retry-after']]).to.deep.eq([wrong.status, wrong.body, wrong.headers['retry-after']]);
    });

    it('a throttled redemption answers the failure body with Retry-After: the reset throttle is keyed by the client ip only', async () => {
      fake.answer.redeemReset = async () => ({ status: 'throttled', retryAfterSeconds: 9 });
      expectFailureBody(await new Client().post('/auth/password/reset', body()), '9');
    });

    it('a policy violation answers 400 password_rejected with the violations', async () => {
      fake.answer.redeemReset = async () => ({ status: 'rejected', violations: ['too_short', 'rule'] });
      const res = await new Client().post('/auth/password/reset', body());
      expect(res.status).to.eq(400);
      expect(res.body).to.deep.include({ error: 'password_rejected', violations: ['too_short', 'rule'] });
      expect(res.headers['cache-control']).to.eq('no-store');
    });

    it('an unexpected failure is not masked as a bad secret (LEDGER PasswordResetController 10)', async () => {
      fake.answer.redeemReset = () => Promise.reject(new Error('database is down'));
      const res = await new Client().post('/auth/password/reset', body());
      expect(res.status).to.eq(500);
    });

    it('caps every field before the service: a long login or secret fails like a wrong one, a long password is too_long', async () => {
      const long = 'x'.repeat(PASSWORD_HARD_CAP + 1);
      expectFailureBody(await new Client().post('/auth/password/reset', body({ login: long })));
      expectFailureBody(await new Client().post('/auth/password/reset', body({ secret: long })));
      expectFailureBody(await new Client().post('/auth/password/reset', body({ secret: undefined })));
      const tooLong = await new Client().post('/auth/password/reset', body({ password: long }));
      expect(tooLong.status).to.eq(400);
      expect(tooLong.body).to.deep.include({ error: 'password_rejected', violations: ['too_long'] });
      const missing = await new Client().post('/auth/password/reset', body({ password: undefined }));
      expect(missing.status).to.eq(400);
      expect(missing.body.error).to.eq('invalid_password');
      expect(fake.of('redeemReset')).to.deep.eq([]);
    });
  });

  describe('PATCH /user/password', () => {
    const body = (over: Record<string, unknown> = {}) => ({ oldPassword: 'Old-Pass-1234', password: 'Brand-New-Pass-1', ...over });

    it('hands the identity, both passwords, the session and a reauth ctx to change, then sends the rotated session cookie (A30)', async () => {
      const u = await seedUser();
      const c = await loggedIn(u);
      const before = c.cookie!;
      const res = await c.patch('/user/password', body({ confirmPassword: 'Brand-New-Pass-1' }));
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.headers['cache-control']).to.eq('no-store');
      const [id, oldPassword, newPassword, session, ctx] = fake.of('change')[0].args as [IdentityRef, string, string, SessionHandle, AuthnContext];
      expect(id).to.deep.eq(u.ref);
      expect([oldPassword, newPassword]).to.deep.eq(['Old-Pass-1234', 'Brand-New-Pass-1']);
      expect(session.state).to.eq('active');
      expect(ctx).to.include({ purpose: 'reauth', ip: await clientIp() });
      expect(ctx.session?.id).to.eq(session.id);

      const cookie = sessionSetCookie(res);
      expect(cookie, 'the rotated session cookie').to.not.eq(undefined);
      expect(c.cookie).to.not.eq(before);
      expect(cookie!.attrs.has('httponly')).to.eq(true);
      expect((await c.get('/auth')).status, 'the rotated session works').to.eq(200);
      expect((await new Client(before).get('/auth')).status, 'the old id is gone').to.eq(401);
    });

    it('takes the 2.x field names OldPassword, Password and ConfirmPassword too', async () => {
      const c = await loggedIn(await seedUser());
      const res = await c.patch('/user/password', { OldPassword: 'Old-Pass-1234', Password: 'Brand-New-Pass-1', ConfirmPassword: 'Brand-New-Pass-1' });
      expect(res.status).to.eq(200);
      expect(fake.of('change')[0].args.slice(1, 3)).to.deep.eq(['Old-Pass-1234', 'Brand-New-Pass-1']);
    });

    it('a wrong old password and a throttled change answer the login failure body without Retry-After (N3)', async () => {
      const c = await loggedIn(await seedUser());
      const before = c.cookie;
      fake.answer.change = async () => ({ status: 'invalid' });
      const wrong = await c.patch('/user/password', body());
      expectFailureBody(wrong);
      expect(sessionSetCookie(wrong), 'no session cookie').to.eq(undefined);
      fake.answer.change = async () => ({ status: 'throttled', retryAfterSeconds: 30 });
      expectFailureBody(await c.patch('/user/password', body()));
      expect(c.cookie).to.eq(before);
    });

    it('a policy violation answers 400 password_rejected with the violations', async () => {
      const c = await loggedIn(await seedUser());
      fake.answer.change = async () => ({ status: 'rejected', violations: ['blocklisted'] });
      const res = await c.patch('/user/password', body());
      expect(res.status).to.eq(400);
      expect(res.body).to.deep.include({ error: 'password_rejected', violations: ['blocklisted'] });
      expect(res.headers['cache-control']).to.eq('no-store');
    });

    it('checks the fields before the service: a missing or over-long old password fails like a wrong one, a mismatch or a bad new password is 400', async () => {
      const c = await loggedIn(await seedUser());
      const long = 'x'.repeat(PASSWORD_HARD_CAP + 1);
      expectFailureBody(await c.patch('/user/password', body({ oldPassword: undefined })));
      expectFailureBody(await c.patch('/user/password', body({ oldPassword: long })));
      const mismatch = await c.patch('/user/password', body({ confirmPassword: 'Other-Pass-1234' }));
      expect([mismatch.status, mismatch.body.error]).to.deep.eq([400, 'password_mismatch']);
      const tooLong = await c.patch('/user/password', body({ password: long }));
      expect(tooLong.status).to.eq(400);
      expect(tooLong.body).to.deep.include({ error: 'password_rejected', violations: ['too_long'] });
      const missing = await c.patch('/user/password', body({ password: undefined }));
      expect([missing.status, missing.body.error]).to.deep.eq([400, 'invalid_password']);
      expect(fake.of('change')).to.deep.eq([]);
    });

    it('needs an authenticated caller: anonymous and pending sessions get 401', async () => {
      expect((await new Client().patch('/user/password', body())).status).to.eq(401);
      const u = await seedUser();
      step.enrol(u.ref);
      const pending = new Client();
      expect((await pending.post('/auth/login', { login: u.login, password: u.password })).body).to.have.property('MfaRequired');
      expect((await pending.patch('/user/password', body({ oldPassword: u.password }))).status).to.eq(401);
      expect(fake.of('change')).to.deep.eq([]);
    });

    it('a cookie PATCH from a foreign origin is refused before the route and changes nothing (A22)', async () => {
      const c = await loggedIn(await seedUser());
      const before = c.cookie;
      const res = await c.patch('/user/password', body(), { Origin: 'https://evil.example' });
      expect(res.status).to.eq(403);
      expect(res.body).to.have.nested.property('error.code', 'E_CSRF_ORIGIN');
      expect(sessionSetCookie(res), 'no session cookie').to.eq(undefined);
      expect(fake.of('change')).to.deep.eq([]);
      expect(c.cookie).to.eq(before);
      expect((await c.get('/auth')).status, 'the session stays').to.eq(200);
    });

    it('a token principal is refused with session_required', async () => {
      const u = await seedUser();
      const token = `spt_${randomUUID()}`;
      tokens.set(token, u.ref);
      const res = await new Client().patch('/user/password', body(), { Authorization: `Bearer ${token}` });
      expect(res.status).to.eq(403);
      expect(res.body.error).to.eq('session_required');
      expect(fake.of('change')).to.deep.eq([]);
    });

    describe('while impersonating', () => {
      before(switchHooksOn);
      beforeEach(() => guard.allowAll());

      it('an impersonated session is refused with impersonating: the impersonator never sets the target password', async () => {
        const admin = await seedUser();
        const target = await seedUser();
        const c = await loggedInAal2(admin);
        expect((await c.post('/auth/impersonate', { target: target.ref.id })).status).to.eq(200);
        const res = await c.patch('/user/password', body());
        expect(res.status).to.eq(403);
        expect(res.body.error).to.eq('impersonating');
        expect(fake.of('change')).to.deep.eq([]);
      });
    });
  });

  it('no password or secret reaches a log line or another answer', async () => {
    const marks = { old: `Old-${randomUUID()}`, next: `New-${randomUUID()}`, secret: `secret-${randomUUID()}`, login: `login-${randomUUID()}@example.test` };
    const c = await loggedIn(await seedUser());
    const answers = [
      await c.patch('/user/password', { oldPassword: marks.old, password: marks.next }),
      await new Client().post('/auth/password/reset-request', { login: marks.login }),
      await new Client().post('/auth/password/reset', { login: marks.login, secret: marks.secret, password: marks.next }),
    ];
    fake.answer.redeemReset = async () => ({ status: 'invalid' });
    fake.answer.change = async () => ({ status: 'rejected', violations: ['rule'] });
    answers.push(await new Client().post('/auth/password/reset', { login: marks.login, secret: marks.secret, password: marks.next }));
    answers.push(await c.patch('/user/password', { oldPassword: marks.old, password: marks.next, confirmPassword: `${marks.next}x` }));
    answers.push(await c.patch('/user/password', { oldPassword: marks.old, password: marks.next }));
    const seen = [...answers.map((r) => `${r.text} ${JSON.stringify(r.headers)} ${r.setCookie.join(' ')}`), ...logLines()].join('\n');
    for (const [name, value] of Object.entries(marks)) expect(seen, name).to.not.include(value);
  });

  it('the four password routes are mounted once', async () => {
    const routes = await mountedRoutes();
    expect(routes).to.include.members(PASSWORD_ROUTES_V3);
    for (const route of PASSWORD_ROUTES_V3) expect(routes.filter((r) => r === route), route).to.have.length(1);
  });
}
