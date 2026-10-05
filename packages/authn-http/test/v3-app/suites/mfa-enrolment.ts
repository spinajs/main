import { expect } from 'chai';
import sinon from 'sinon';
import { Container, DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { IdentityStore } from '@spinajs/authn/contracts';
import type { IController, IRoute, Request } from '@spinajs/http';
import { FakeClock, parseOtpauth, totpFromProvisioning } from '@spinajs/authn-testing';
import type { ConfigOverrides, Harness, HttpRequest, HttpResponse } from '@spinajs/authn-testing';

import { TOTP_SERVICE, TotpEnrolmentOn } from '../../../src/mfa/index.js';
import { AUTHN_FAILURE_BODY, PASSWORD_HARD_CAP } from '../../../src/v3/index.js';
import { AUTHN_PROBE_PATH } from '../../v3/probe.js';
import { Client, clearLog, config, logLines, loggedIn, seedUser } from '../app.js';
import { ROUTES } from '../behaviour/harness.js';
import { failMfaStore, laneEvents, laneMfaConfig, laneTotpServiceClass, n8bHarness } from '../behaviour/n8b-harness.js';
import { mountedRoutes } from './route-table.js';

export const MFA_ROUTES_V3 = ['GET /user/mfa', 'POST /user/mfa', 'POST /user/mfa/confirm', 'POST /user/mfa/disable', 'POST /user/mfa/recovery-codes'];

/** One request of each route, with a code where the route takes one. */
const everyRoute = (code = '123456'): [string, string, unknown?][] => [
  ['GET', '/user/mfa'],
  ['POST', '/user/mfa', {}],
  ['POST', '/user/mfa/confirm', { code }],
  ['POST', '/user/mfa/disable', { code }],
  ['POST', '/user/mfa/recovery-codes', {}],
];

/** The five routes against the shared fakes, before anything has loaded authn-totp. */
export function mfaEnrolmentGateSuite(): void {
  it('without a TotpService every MFA enrolment route answers 404 not_found, also to a session (LEDGER two-factor-self-service 23-26, two-factor-wire-format 1-2)', async () => {
    expect(DI.RootContainer.hasRegistered(TOTP_SERVICE), 'nothing has loaded authn-totp yet').to.eq(false);
    const anonymous = new Client();
    const session = await loggedIn(await seedUser());
    for (const c of [anonymous, session]) {
      for (const [method, path, body] of everyRoute()) {
        const res = await c.send(method as 'GET' | 'POST', path, body);
        expect(res.status, `${method} ${path}`).to.eq(404);
        expect(res.body.error).to.eq('not_found');
      }
    }
  });

  it('the gate asks the container it resolves from: a class named TotpService and a step named totp do not open it', async () => {
    const child = DI.RootContainer.child();
    child.register({ TotpService: class {} }.TotpService).asSelf();
    // The app lists the kit's fake step under the name totp; with a key set only the step check is left to refuse.
    config().set('authn.mfa.encryptionKey', { secret: 'a'.repeat(64) });
    try {
      for (const container of [new Container(), child]) await expectGateClosed(container);
    } finally {
      delete config().get<Record<string, unknown>>('authn.mfa').encryptionKey;
    }
    expect(DI.RootContainer.hasRegistered(TOTP_SERVICE), 'the gate loaded no authn-totp').to.eq(false);
  });
}

/** What the gate of the MFA enrolment routes answers when it resolves from `container`. */
async function gateOn(container: IContainer): Promise<'open' | 'not_found'> {
  const route = {} as IRoute;
  const ctrl = {} as IController;
  const req = { storage: {} } as unknown as Request;
  const gate = new TotpEnrolmentOn();
  (gate as unknown as { Container: unknown }).Container = container;
  expect(gate.isEnabled(route, ctrl)).to.eq(true);
  try {
    await gate.execute(req, route, ctrl);
    return 'open';
  } catch (e) {
    expect((e as object).constructor.name).to.eq('ResourceNotFound');
    expect((e as { error?: unknown }).error).to.eq('not_found');
    return 'not_found';
  }
}

async function expectGateClosed(container: IContainer): Promise<void> {
  expect(await gateOn(container)).to.eq('not_found');
}

/** A browser on the lane harness: keeps the session cookie and sends the app's Origin. */
export class LaneClient {
  public cookie: string | undefined;
  public readonly answers: HttpResponse[] = [];

  constructor(
    private readonly h: Harness,
    private readonly headers: Record<string, string> = {},
  ) {}

  public async send(req: HttpRequest): Promise<HttpResponse> {
    const http = this.h.http!;
    const res = await http.send({ ...req, headers: { origin: http.origin, ...this.headers, ...req.headers }, ...(this.cookie ? { cookies: { [http.sessionCookie]: this.cookie } } : {}) });
    const set = res.setCookie.find((c) => c.startsWith(`${http.sessionCookie}=`));
    if (set) {
      const value = set.split(';')[0].slice(http.sessionCookie.length + 1);
      this.cookie = value === '' ? undefined : value;
    }
    this.answers.push(res);
    return res;
  }

  public status = () => this.send({ method: 'GET', path: '/user/mfa' });
  public begin = (body: Record<string, unknown> = {}) => this.send({ method: 'POST', path: '/user/mfa', body });
  public confirm = (code: unknown) => this.send({ method: 'POST', path: '/user/mfa/confirm', body: { code } });
  public disable = (code: unknown, body: Record<string, unknown> = {}) => this.send({ method: 'POST', path: '/user/mfa/disable', body: { code, ...body } });
  public recoveryCodes = (body: Record<string, unknown> = {}) => this.send({ method: 'POST', path: '/user/mfa/recovery-codes', body });
}

/** `fn` with Date `seconds` ahead (the server shares the process clock). */
export async function later<T>(seconds: number, fn: () => Promise<T>): Promise<T> {
  const clock = sinon.useFakeTimers({ now: Date.now() + seconds * 1000, toFake: ['Date'] });
  try {
    return await fn();
  } finally {
    clock.restore();
  }
}

export function expectFailureBody(res: HttpResponse, retryAfter?: string): void {
  expect(res.status, JSON.stringify(res.body)).to.eq(401);
  expect(res.body).to.deep.eq(AUTHN_FAILURE_BODY);
  expect(res.headers['cache-control']).to.eq('no-store');
  expect(res.headers['retry-after']).to.eq(retryAfter);
}

export function expectRefused(res: HttpResponse, status: number, error: string): void {
  expect(res.status, JSON.stringify(res.body)).to.eq(status);
  expect((res.body as { error?: unknown }).error).to.eq(error);
}

const enrolmentEvents = () => laneEvents.filter((e) => e.type === 'mfa.enrol' || e.type === 'mfa.disable');

const body = <T = Record<string, unknown>>(res: HttpResponse): T => res.body as T;

let users = 0;

/** The routes over the real TotpService and TotpMfaStep, authn-session and N1 (the behaviour harness's app). */
export function mfaEnrolmentRoutesSuite(): void {
  let h: Harness;

  const open = async (config: ConfigOverrides = {}) => {
    h = await n8bHarness({ rule: 'A10', facet: 'A10/http', caseName: 'lane', clock: new FakeClock(), config });
    clearLog();
  };

  afterEach(async () => {
    await h?.dispose?.();
  });

  const user = async () => {
    users++;
    const login = `mfa-lane-${users}@example.test`;
    const password = `Mfa-Lane-Pass-${users}`;
    return { ref: await h.seed!.user({ login, password }), login, password };
  };

  const login = async (u: { login: string; password: string }) => {
    const c = new LaneClient(h);
    const res = await c.send(ROUTES.login!(u.login, u.password));
    expect(res.status, JSON.stringify(res.body)).to.eq(200);
    return c;
  };

  /** Begins now and confirms `at` seconds later through the routes; `code(s)` is the code of `s` seconds after the start. */
  const enrolled = async (c: LaneClient, at = 0) => {
    const start = Date.now();
    const begun = await c.begin();
    expect(begun.status, JSON.stringify(begun.body)).to.eq(200);
    const provisioning = body<{ provisioning: string }>(begun).provisioning;
    const code = (seconds: number) => totpFromProvisioning(provisioning, new Date(start + seconds * 1000));
    const confirmed = await later(at, () => c.confirm(code(at)));
    expect(confirmed.status, JSON.stringify(confirmed.body)).to.eq(200);
    return { provisioning, code, recoveryCodes: body<{ recoveryCodes: string[] }>(confirmed).recoveryCodes };
  };

  describe('on a fresh session', () => {
    beforeEach(() => open());

    it('TOTP_SERVICE is the DI key of the TotpService the users-free subpath export registers', async () => {
      const TotpService = laneTotpServiceClass();
      expect(TotpService.name).to.eq(TOTP_SERVICE);
      expect(await DI.resolve(TOTP_SERVICE)).to.be.instanceOf(TotpService);
    });

    it('the gate opens on the TotpService of authn-totp only: a foreign class registered under its name closes it', async () => {
      expect(await gateOn(DI.RootContainer)).to.eq('open');
      const child = DI.RootContainer.child();
      child.register({ TotpService: class {} }.TotpService).asSelf();
      await expectGateClosed(child);
    });

    it('GET /user/mfa reports each configured step and whether the caller is enrolled, with no-store (LEDGER two-factor-self-service 1-3)', async () => {
      const c = await login(await user());
      const none = await c.status();
      expect(none.status).to.eq(200);
      expect(none.body).to.deep.eq({ steps: [{ name: 'totp', enrolled: false }] });
      expect(none.headers['cache-control']).to.eq('no-store');
      await c.begin();
      expect((await c.status()).body, 'a begun enrolment is not an enrolment').to.deep.eq({ steps: [{ name: 'totp', enrolled: false }] });
      await enrolled(c);
      expect((await c.status()).body).to.deep.eq({ steps: [{ name: 'totp', enrolled: true }] });
    });

    it('begin answers the provisioning URI once with no-store; a second begin replaces the secret, so only its code confirms (LEDGER two-factor-self-service 4, 8, 20)', async () => {
      const u = await user();
      const c = await login(u);
      const first = await c.begin();
      expect(first.status).to.eq(200);
      expect(first.headers['cache-control']).to.eq('no-store');
      const p1 = body<{ provisioning: string }>(first).provisioning;
      expect(p1).to.match(/^otpauth:\/\/totp\//);
      const p2 = body<{ provisioning: string }>(await c.begin()).provisioning;
      expect(parseOtpauth(p2).secret).to.not.eq(parseOtpauth(p1).secret);
      expectFailureBody(await c.confirm(totpFromProvisioning(p1, new Date())));
      const done = await c.confirm(totpFromProvisioning(p2, new Date()));
      expect(done.status).to.eq(200);
      expect(await h.mfa!.step.enrolled(u.ref)).to.eq(true);
    });

    it('confirm answers ten recovery codes once with no-store; no secret, URI or code reaches another answer, a log line or an audit event (SR-09)', async () => {
      const c = await login(await user());
      const { provisioning, recoveryCodes } = await enrolled(c);
      expect(recoveryCodes).to.have.length(10);
      const confirmAnswer = c.answers.find((r) => Array.isArray(body<{ recoveryCodes?: unknown }>(r).recoveryCodes))!;
      expect(confirmAnswer.headers['cache-control']).to.eq('no-store');
      await c.status();
      await c.confirm('000000');
      await c.begin();
      const carriers = c.answers.filter((r) => r === confirmAnswer || typeof body<{ provisioning?: unknown }>(r).provisioning === 'string');
      expect(carriers, 'the URI in the begin answer, the codes in the confirm answer').to.have.length(2);
      const others = c.answers.filter((r) => !carriers.includes(r));
      const seen = [...others.map((r) => `${JSON.stringify(r.body)} ${JSON.stringify(r.headers)} ${r.setCookie.join(' ')}`), ...logLines(), JSON.stringify(laneEvents), JSON.stringify(h.events!.all())].join('\n');
      expect(laneEvents.some((e) => e.type === 'mfa.enrol' && e.outcome === 'success'), 'TotpService audited the enrolment').to.eq(true);
      const secret = parseOtpauth(provisioning).secret;
      for (const [name, value] of Object.entries({ secret, provisioning, ...Object.fromEntries(recoveryCodes.map((code, i) => [`recovery ${i}`, code])) })) expect(seen, name).to.not.include(value);
    });

    it('enrolling stamps the trusted client ip and rotates no session id', async () => {
      const c = await login(await user());
      const cookie = c.cookie;
      const ip = body<{ clientIp: string }>(await c.send({ method: 'GET', path: `/${AUTHN_PROBE_PATH}` })).clientIp;
      await enrolled(c);
      expect(c.answers.slice(-2).flatMap((r) => r.setCookie), 'no Set-Cookie on begin or confirm').to.deep.eq([]);
      expect(c.cookie).to.eq(cookie);
      expect(laneEvents.find((e) => e.type === 'mfa.enrol')?.ip).to.eq(ip);
    });

    it('begin while enrolled answers 409 mfa_enrolled, confirm without a begun enrolment 409 mfa_not_begun (LEDGER two-factor-self-service 7, 11, 13)', async () => {
      const c = await login(await user());
      expectRefused(await c.confirm('123456'), 409, 'mfa_not_begun');
      const { code } = await enrolled(c);
      expectRefused(await c.begin(), 409, 'mfa_enrolled');
      expectRefused(await later(30, () => c.confirm(code(30))), 409, 'mfa_enrolled');
    });

    it('a wrong, missing or over-long code at confirm answers the login failure body and enrols nothing (LEDGER two-factor-self-service 10)', async () => {
      const u = await user();
      const c = await login(u);
      await c.begin();
      expectFailureBody(await c.confirm('000000'));
      expect(laneEvents.filter((e) => e.type === 'mfa.enrol').map((e) => e.reason), 'the wrong code was checked').to.deep.eq(['invalid_code']);
      for (const code of [undefined, '', 42, 'x'.repeat(PASSWORD_HARD_CAP + 1)]) expectFailureBody(await c.confirm(code));
      expect(laneEvents.filter((e) => e.type === 'mfa.enrol'), 'the malformed codes never reached TotpService').to.have.length(1);
      expect(await h.mfa!.step.enrolled(u.ref)).to.eq(false);
    });

    it('a throttled code check answers the login failure body with Retry-After, as MFA verify does', async () => {
      const c = await login(await user());
      await c.begin();
      let throttled: HttpResponse | undefined;
      for (let i = 0; i < 12 && !throttled; i++) {
        const res = await c.confirm('000000');
        if (res.headers['retry-after'] !== undefined) throttled = res;
        else expectFailureBody(res);
      }
      expect(throttled, 'the mfa throttle refused a code').to.not.eq(undefined);
      expect(Number(throttled!.headers['retry-after'])).to.be.greaterThan(0);
      expectFailureBody(throttled!, throttled!.headers['retry-after']);
    });

    it('a store failure is a 500, not a wrong code (LEDGER two-factor-self-service 12)', async () => {
      const c = await login(await user());
      const begun = body<{ provisioning: string }>(await c.begin()).provisioning;
      failMfaStore();
      const res = await c.confirm(totpFromProvisioning(begun, new Date()));
      expect(res.status).to.eq(500);
      expect(JSON.stringify(res.body)).to.not.include(parseOtpauth(begun).secret);
    });

    it('disable takes a TOTP code and needs a valid one: a wrong code changes nothing (LEDGER two-factor-self-service 14, 16)', async () => {
      const u = await user();
      const c = await login(u);
      const { code } = await enrolled(c);
      expectFailureBody(await later(30, () => c.disable('000000')));
      expect(await h.mfa!.step.enrolled(u.ref)).to.eq(true);
      const res = await later(60, () => c.disable(code(60)));
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.headers['cache-control']).to.eq('no-store');
      expect(res.setCookie, 'no session rotation (LEDGER two-factor-self-service 15)').to.deep.eq([]);
      expect(await h.mfa!.step.enrolled(u.ref)).to.eq(false);
      expect((await c.status()).body).to.deep.eq({ steps: [{ name: 'totp', enrolled: false }] });
    });

    it('disable takes a recovery code instead, once', async () => {
      const u = await user();
      const c = await login(u);
      const { recoveryCodes } = await enrolled(c);
      expect((await c.disable(recoveryCodes[0])).status).to.eq(200);
      expect(await h.mfa!.step.enrolled(u.ref)).to.eq(false);
      const again = await enrolled(c, 30);
      expectFailureBody(await c.disable(recoveryCodes[1]), undefined);
      expect((await c.disable(again.recoveryCodes[0])).status).to.eq(200);
    });

    it('disable and recovery-codes while not enrolled answer 409 mfa_not_enrolled (LEDGER two-factor-self-service 17, 21)', async () => {
      const c = await login(await user());
      expectRefused(await c.disable('123456'), 409, 'mfa_not_enrolled');
      expectRefused(await c.recoveryCodes(), 409, 'mfa_not_enrolled');
    });

    it('recovery-codes answers a new set once with no-store and voids the old one (LEDGER two-factor-self-service 18)', async () => {
      const u = await user();
      const c = await login(u);
      const { recoveryCodes: old } = await enrolled(c);
      const res = await c.recoveryCodes();
      expect(res.status).to.eq(200);
      expect(res.headers['cache-control']).to.eq('no-store');
      const fresh = body<{ recoveryCodes: string[] }>(res).recoveryCodes;
      expect(fresh).to.have.length(10);
      expect(fresh.some((code) => old.includes(code))).to.eq(false);
      expectFailureBody(await c.disable(old[0]));
      expect((await c.disable(fresh[0])).status).to.eq(200);
      expect(JSON.stringify(laneEvents)).to.not.include(fresh[1]);
    });

    it('the five routes are mounted once', async () => {
      const routes = await mountedRoutes();
      expect(routes).to.include.members(MFA_ROUTES_V3);
      for (const route of MFA_ROUTES_V3) expect(routes.filter((r) => r === route), route).to.have.length(1);
    });
  });

  describe('fresh authentication (A13)', () => {
    beforeEach(() => open());

    it('a stale session is refused 403 fresh_auth_required on begin, disable and recovery-codes; confirm needs none', async () => {
      const u = await user();
      const c = await login(u);
      const begun = body<{ provisioning: string }>(await c.begin()).provisioning;
      await later(301, async () => {
        expectRefused(await c.begin(), 403, 'fresh_auth_required');
        expect((await c.confirm(totpFromProvisioning(begun, new Date()))).status, 'confirm').to.eq(200);
        expectRefused(await c.recoveryCodes(), 403, 'fresh_auth_required');
        expectRefused(await c.disable('123456'), 403, 'fresh_auth_required');
      });
      expect(await h.mfa!.step.enrolled(u.ref)).to.eq(true);
    });

    it('a stale session passes with the right reauthPassword, for that request only, counted as a re-authentication (LEDGER two-factor-self-service 4)', async () => {
      const u = await user();
      const c = await login(u);
      await later(301, async () => {
        const res = await c.begin({ reauthPassword: u.password });
        expect(res.status, JSON.stringify(res.body)).to.eq(200);
        expect(h.events!.all().filter((e) => e.type === 'reauth').map((e) => e.outcome)).to.deep.eq(['success']);
        expectRefused(await c.begin(), 403, 'fresh_auth_required');
        const codes = await c.recoveryCodes({ reauthPassword: u.password });
        expectRefused(codes, 409, 'mfa_not_enrolled');
      });
    });

    it('a wrong reauthPassword answers the login failure body without Retry-After and changes nothing (LEDGER two-factor-self-service 6, 16, 19)', async () => {
      const u = await user();
      const c = await login(u);
      const { code, recoveryCodes } = await enrolled(c);
      await later(331, async () => {
        expectFailureBody(await c.disable(code(331), { reauthPassword: 'Not-The-Password-1' }));
        expectFailureBody(await c.recoveryCodes({ reauthPassword: 'Not-The-Password-1' }));
        expectFailureBody(await c.begin({ reauthPassword: 'Not-The-Password-1' }));
      });
      const events = h.events!.all();
      expect(events.filter((e) => e.type === 'reauth').map((e) => e.outcome), 'one re-authentication per request').to.deep.eq(['failure', 'failure', 'failure']);
      expect(events.filter((e) => e.type === 'throttle.block')).to.deep.eq([]);
      expect(await h.mfa!.step.enrolled(u.ref)).to.eq(true);
      expect((await c.disable(recoveryCodes[0])).status, 'the old recovery codes still hold').to.eq(200);
    });

    it('SR-20 a throttled re-authentication on an MFA route answers the login failure body without Retry-After, also to the right password', async () => {
      const u = await user();
      const c = await login(u);
      const { code, recoveryCodes } = await enrolled(c);
      const blocks = () => h.events!.all().filter((e) => e.type === 'throttle.block').length;
      await later(331, async () => {
        for (let i = 0; i < 10 && blocks() === 0; i++) expectFailureBody(await c.recoveryCodes({ reauthPassword: 'Not-The-Password-1' }));
        expect(blocks(), 'the reauth throttle blocked').to.eq(1);
        expectFailureBody(await c.recoveryCodes({ reauthPassword: u.password }));
        expectFailureBody(await c.begin({ reauthPassword: u.password }));
        expectFailureBody(await c.disable(code(331), { reauthPassword: u.password }));
      });
      expect(blocks(), 'each MFA route asked the throttled re-authentication').to.eq(4);
      expect(h.events!.all().filter((e) => e.type === 'reauth' && e.outcome === 'success'), 'the right password was never checked').to.deep.eq([]);
      expect(await h.mfa!.step.enrolled(u.ref)).to.eq(true);
      expect((await c.disable(recoveryCodes[0])).status, 'the old recovery codes still hold').to.eq(200);
    });

    it('a reauthPassword over the cap answers the login failure body and verifies nothing', async () => {
      const c = await login(await user());
      const res = await later(301, () => c.begin({ reauthPassword: 'x'.repeat(PASSWORD_HARD_CAP + 1) }));
      expectFailureBody(res);
      expect(h.events!.all().filter((e) => e.type === 'reauth').map((e) => e.reason)).to.deep.eq(['password_too_long']);
    });

    it('disable on a stale session passes with the right reauthPassword and a valid code', async () => {
      const u = await user();
      const c = await login(u);
      const { code } = await enrolled(c);
      const res = await later(331, () => c.disable(code(331), { reauthPassword: u.password }));
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(await h.mfa!.step.enrolled(u.ref)).to.eq(false);
      expect(JSON.stringify(logLines()), 'the password reaches no log line').to.not.include(u.password);
    });
  });

  describe('under authn.mfa.policy.force (A09)', () => {
    beforeEach(() => open({ authn: { mfa: { policy: { force: true } } } }));

    it('a pending session forced to enrol reaches begin and confirm and nothing else, then completes the login with the new step', async () => {
      const u = await user();
      const c = await login(u);
      expect(c.cookie, 'a pending session').to.be.a('string');
      expectRefused(await c.status(), 401, 'unauthenticated');
      expectRefused(await c.disable('123456'), 401, 'unauthenticated');
      expectRefused(await c.recoveryCodes(), 401, 'unauthenticated');
      expect((await c.send(ROUTES.sessionsList!())).status).to.eq(401);
      const { code, recoveryCodes } = await enrolled(c);
      expect(recoveryCodes).to.have.length(10);
      expect((await c.begin()).status, 'enrolled now: the pending session must complete the step').to.eq(401);
      const verified = await later(30, () => c.send(ROUTES.mfaVerify!(code(30))));
      expect(verified.status, JSON.stringify(verified.body)).to.eq(200);
      expect((await c.status()).body).to.deep.eq({ steps: [{ name: 'totp', enrolled: true }] });
    });
  });

  describe('under authn.mfa.policy.force, a pending session sending reauthPassword', () => {
    beforeEach(() => open({ authn: { mfa: { policy: { force: true } } } }));

    it('is not looked up, since TotpService never re-authenticates a pending session; over the cap it still answers the login failure body', async () => {
      const u = await user();
      const c = await login(u);
      const display = sinon.spy(await DI.resolve(IdentityStore), 'display');
      try {
        expect((await c.begin()).status).to.eq(200);
        const withoutPassword = display.callCount;
        display.resetHistory();
        const res = await c.begin({ reauthPassword: u.password });
        expect(res.status, JSON.stringify(res.body)).to.eq(200);
        expect(display.callCount, 'no identity lookup for the password').to.eq(withoutPassword);
        expectFailureBody(await c.begin({ reauthPassword: 'x'.repeat(PASSWORD_HARD_CAP + 1) }));
      } finally {
        display.restore();
      }
      expect(h.events!.all().filter((e) => e.type === 'reauth').map((e) => e.reason)).to.deep.eq(['password_too_long']);
    });
  });

  describe('while login asks for no TOTP step', () => {
    beforeEach(() => open());

    /** Every route answers 404 not_found to `c`, and nothing reached TotpService. */
    const expectOff = async (c: LaneClient) => {
      for (const [method, path, payload] of everyRoute()) expectRefused(await c.send({ method: method as 'GET' | 'POST', path, ...(payload ? { body: payload } : {}) }), 404, 'not_found');
      expect(enrolmentEvents()).to.deep.eq([]);
    };

    it('with authn.mfa.steps empty every route answers 404 not_found, although TotpService is registered', async () => {
      await laneMfaConfig({ steps: [] });
      expect(DI.RootContainer.hasRegistered(TOTP_SERVICE)).to.eq(true);
      const u = await user();
      await expectOff(await login(u));
      await expectOff(new LaneClient(h));
      expect(await h.mfa!.step.enrolled(u.ref)).to.eq(false);
    });

    it('a listed step named totp that is not the TotpMfaStep of authn-totp keeps every route at 404 not_found', async () => {
      await laneMfaConfig({ steps: [{ name: 'totp', service: 'V3AppMfaStep' }] });
      await expectOff(await login(await user()));
    });

    it('without authn.mfa.encryptionKey every route answers 404 not_found, not 500', async () => {
      const c = await login(await user());
      await laneMfaConfig({ encryptionKey: undefined });
      await expectOff(c);
      await expectOff(new LaneClient(h));
    });
  });

  describe('callers that may not enrol', () => {
    beforeEach(() => open());

    it('a pending session of an enrolled identity is refused 401 and changes nothing', async () => {
      const u = await user();
      await h.mfa!.enrol(u.ref);
      const c = await login(u);
      expect(c.cookie).to.be.a('string');
      for (const res of [await c.begin(), await c.confirm(await h.mfa!.code(u.ref)), await c.status()]) expectRefused(res, 401, 'unauthenticated');
      expect(laneEvents.filter((e) => e.type === 'mfa.enrol')).to.deep.eq([]);
    });

    it('a token principal is refused 403 session_required on every route', async () => {
      const u = await user();
      const created = await h.tokens!.create(u.ref, { name: 'lane', kind: 'pat', expiresAt: new Date(Date.now() + 86_400_000) }, { now: new Date(), purpose: 'request' });
      if (!created.ok) throw new Error(`token create: ${created.code}`);
      const c = new LaneClient(h, { authorization: `Bearer ${created.plaintext}` });
      for (const [method, path, payload] of everyRoute()) expectRefused(await c.send({ method: method as 'GET' | 'POST', path, ...(payload ? { body: payload } : {}) }), 403, 'session_required');
      expect(enrolmentEvents()).to.deep.eq([]);
    });

    it('an impersonated session is refused 403 impersonating on every route: enrolling a factor there is a takeover', async () => {
      await h.guard!.allowAll();
      const admin = await user();
      const target = await user();
      await h.mfa!.enrol(admin.ref);
      const c = await login(admin);
      await later(30, async () => expect((await c.send(ROUTES.mfaVerify!(await h.mfa!.code(admin.ref)))).status).to.eq(200));
      const started = await c.send(ROUTES.impersonateStart!(target.ref, admin.password));
      expect(started.status, JSON.stringify(started.body)).to.eq(200);
      for (const [method, path, payload] of everyRoute()) expectRefused(await c.send({ method: method as 'GET' | 'POST', path, ...(payload ? { body: payload } : {}) }), 403, 'impersonating');
      expect(enrolmentEvents()).to.deep.eq([]);
    });
  });
}
