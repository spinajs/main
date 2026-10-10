import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { PasswordService } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { FakeClock, planCases, runAuthnBehaviour, totpFromProvisioning } from '@spinajs/authn-testing';
import type { Facet, Harness, HttpRequest, HttpResponse } from '@spinajs/authn-testing';

import { clearLog, logLines } from '../app.js';
import { LaneClient, expectFailureBody, mfaEnrolmentRoutesSuite } from '../suites/mfa-enrolment.js';
import { keyRoutesSuite } from '../suites/keys.js';
import { tokenRoutesSuite } from '../suites/tokens.js';
import { tokenEndToEndSuite } from '../suites/token-e2e.js';
import { credentialAdminRoutesSuite } from '../suites/credential-admin.js';
import { ROUTES, supports, tokenDb } from './harness.js';
import { ADMIN_ROUTES, KEY_ROUTES, MFA_ROUTES, N8B_PORTS, N8B_SUPPORTED_CONFIG, PASSWORD_ROUTES, TOKEN_ROUTES, bootN8bApp, laneEvents, laneMfaConfig, n8bHarness, shutdownN8bApp } from './n8b-harness.js';

/** Plan §N8b task 7. */
const PLAN_LIST = ['A10', 'A11', 'A13', 'A14', 'A17', 'A25', 'A30', 'A32'] as const;

/** The plan list and A09, whose http facet N8a left to this lane (two of its cases need N8b's routes). */
const RULES = ['A09', ...PLAN_LIST] as const;

/** The kit README's facets of N8b ("Lane → facets"). */
const N8B_FACETS: readonly Facet[] = ['A10/core', 'A10/http', 'A11/local', 'A11/http', 'A13/local', 'A13/http', 'A14/http', 'A17/core', 'A17/http', 'A25/http', 'A30/local', 'A30/http', 'A32/http'];

/** Every facet of N8b, and A09/http. */
const CLAIM: readonly Facet[] = ['A09/http', ...N8B_FACETS];

/**
 * The facets left pending here, the needs the lane does not supply and the lane that owns each. Every other facet of
 * RULES runs on the real strategy packages, claimed or not.
 */
const EXPECTED_PENDING: Readonly<Record<string, { owner: string; needs: readonly string[] }>> = {
  'A10/totp': { owner: 'N5', needs: ['mfaStorage'] },
  'A17/jws': { owner: 'N7', needs: ['jws'] },
};

/** SR cases of RULES that stay pending: A10/totp's (N5). */
const PENDING_SR = ['A10 SR-09 TOTP secret encrypted at rest'];

// mfa.recovery: the runner checks the mfa step for recovery methods, which authn-totp's TotpMfaStep has.
const have = (need: string): boolean => (need.startsWith('http.routes.') ? need.slice('http.routes.'.length) in { ...ROUTES, ...PASSWORD_ROUTES, ...MFA_ROUTES, ...TOKEN_ROUTES, ...KEY_ROUTES, ...ADMIN_ROUTES } : need === 'fakeDate' || need === 'mfa.recovery' || (N8B_PORTS as readonly string[]).includes(need));

const ALICE = { login: 'lane-alice@example.test', password: 'Lane-Alice-Pass-1' };

/** One request through the harness's port, carrying `cookie` and the app's Origin. */
async function send(h: Harness, req: HttpRequest, cookie?: string): Promise<HttpResponse> {
  const http = h.http!;
  return http.send({ ...req, headers: { origin: http.origin, ...req.headers }, ...(cookie ? { cookies: { [http.sessionCookie]: cookie } } : {}) });
}

const everything = (answers: readonly HttpResponse[]): string => [...answers.map((r) => `${JSON.stringify(r.body)} ${JSON.stringify(r.headers)} ${r.setCookie.join(' ')}`), ...logLines()].join('\n');

describe('N8b behaviour rules over HTTP on the real strategy packages (test/v3-app)', function () {
  before(async function () {
    this.timeout(120000);
    await bootN8bApp();
  });

  after(async function () {
    this.timeout(60000);
    await shutdownN8bApp();
  });

  it('runs the plan list in this one call; only facets of other lanes stay pending', () => {
    const planned = planCases([...RULES]);
    expect([...new Set(planned.map((p) => p.kase.facet))]).to.include.members([...N8B_FACETS]);
    const missing = new Map<string, Set<string>>();
    for (const p of planned) for (const n of p.kase.needs.filter((x) => !have(x))) missing.set(p.kase.facet, (missing.get(p.kase.facet) ?? new Set()).add(n));
    const pending = Object.fromEntries([...missing].map(([facet, needs]) => [facet, [...needs].sort()]));
    expect(pending, JSON.stringify(EXPECTED_PENDING)).to.deep.eq(Object.fromEntries(Object.entries(EXPECTED_PENDING).map(([facet, e]) => [facet, [...e.needs].sort()])));
    const unsupported = planned.filter((p) => typeof p.kase.config === 'object' && !supports(p.kase.config, N8B_SUPPORTED_CONFIG)).map((p) => p.kase.name);
    expect(unsupported, 'cases the harness config cannot apply go pending').to.deep.eq([]);
    const sr = planned.filter((p) => / SR-\d+ /.test(p.kase.name));
    expect(sr.filter((p) => p.kase.needs.some((n) => !have(n))).map((p) => p.kase.name)).to.deep.eq(PENDING_SR);
  });

  it('A25/http is claimed as soon as an A25 route builder exists', () => {
    const builders = [...new Set(planCases(['A25'], { facets: ['A25/http'] }).flatMap((p) => p.kase.needs.filter((n) => n.startsWith('http.routes.') && !(n.slice('http.routes.'.length) in ROUTES))))];
    expect(builders, 'the credential admin route builders').to.have.length(4);
    if (builders.some(have)) expect(CLAIM, 'an A25 route builder exists: claim A25/http').to.include('A25/http');
  });

  it('every planned case of the claimed facets has its needs', () => {
    const planned = planCases([...RULES], { facets: [...CLAIM] });
    expect(planned.map((p) => p.kase.facet)).to.include.members([...CLAIM]);
    const missing = planned.flatMap((p) => p.kase.needs.filter((n) => !have(n)).map((n) => `${p.kase.name}: ${n}`));
    expect(missing).to.deep.eq([]);
  });

  // Every facet: the other lanes' run here unclaimed, on the real strategy packages.
  runAuthnBehaviour([...RULES], n8bHarness, { title: 'authn-http: N8b plan list and A09', claim: [...CLAIM], timeoutMs: 60000 });

  describe('MFA enrolment routes on authn-totp (task 2)', function () {
    this.timeout(60000);
    mfaEnrolmentRoutesSuite();
  });

  describe('token routes on authn-token (task 3)', function () {
    this.timeout(60000);
    tokenRoutesSuite();
  });

  describe('tokens through the whole stack (T3 task 2)', function () {
    this.timeout(60000);
    tokenEndToEndSuite();
  });

  describe('key routes on authn-keys (task 4)', function () {
    this.timeout(60000);
    keyRoutesSuite();
  });

  describe('credential admin routes (task 5)', function () {
    this.timeout(60000);
    credentialAdminRoutesSuite();
  });

  describe('a 2.x user whose TOTP the upgrade migration carried (Z8, design §22.4, §22.18)', function () {
    this.timeout(60000);
    let h: Harness;

    // 2fa:token as 2.x stored it: the base32 TOTP secret.
    const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const CAROL = { login: 'lane-carol@example.test', password: 'Lane-Carol-Pass-1' };
    const DAVE = { login: 'lane-dave@example.test', password: 'Lane-Dave-Pass-1' };

    beforeEach(async () => {
      h = await n8bHarness({ rule: 'A32', facet: 'A32/http', caseName: 'lane', clock: new FakeClock(), config: {} });
      clearLog();
    });

    afterEach(async () => {
      await h.dispose?.();
    });

    /** Carol, with a password and the 2.x metadata of an enabled TOTP, after the A32 upgrade migration ran. */
    async function carriedCarol(): Promise<IdentityRef> {
      const ref = await h.seed!.user(CAROL);
      const db = tokenDb();
      const [row] = (await db.select().from('users').where('Uuid', ref.id)) as { Id: number }[];
      await db.insert().into('users_metadata').values({ Key: '2fa:token', Type: 'string', Value: SECRET, user_id: row.Id });
      await db.insert().into('users_metadata').values({ Key: '2fa:enabled', Type: 'boolean', Value: 'true', user_id: row.Id });
      await h.migration!.run();
      expect(await h.mfa!.step.enrolled(ref), 'the migration carried a confirmed totp row').to.eq(true);
      return ref;
    }

    const sessionCookieSet = (res: HttpResponse): boolean => res.setCookie.some((c) => c.startsWith(`${h.http!.sessionCookie}=`) && !c.startsWith(`${h.http!.sessionCookie}=;`));

    it('with no step listed the password alone does not let the carried user in, answering as for a wrong password', async () => {
      await carriedCarol();
      await h.seed!.user(DAVE);
      await laneMfaConfig({ steps: [] });
      const wrong = await send(h, ROUTES.login!(CAROL.login, 'Not-Carols-Pass-1'));
      const refused = await send(h, ROUTES.login!(CAROL.login, CAROL.password));
      expectFailureBody(refused);
      expect([refused.status, refused.body]).to.deep.eq([wrong.status, wrong.body]);
      expect(sessionCookieSet(refused), 'no session, pending or active').to.eq(false);
      expect(
        h
          .events!.all()
          .filter((e) => e.type === 'login' && e.outcome === 'failure')
          .map((e) => [e.reason, e.data]),
      ).to.deep.include(['mfa_step_not_listed', { steps: ['totp'] }]);
      const dave = await send(h, ROUTES.login!(DAVE.login, DAVE.password));
      expect(dave.status, 'a user without a second factor still logs in').to.eq(200);
      expect(sessionCookieSet(dave)).to.eq(true);
    });

    it('with totp listed the carried user passes the second factor with a code of the 2.x secret', async () => {
      await carriedCarol();
      const c = new LaneClient(h);
      const login = await c.send(ROUTES.login!(CAROL.login, CAROL.password));
      expect([login.status, login.body]).to.deep.eq([200, { MfaRequired: ['totp'] }]);
      const verified = await c.send(ROUTES.mfaVerify!(totpFromProvisioning(`otpauth://totp/carol?secret=${SECRET}`, new Date())));
      expect(verified.status, JSON.stringify(verified.body)).to.eq(200);
      expect((await c.send(ROUTES.whoami!())).status).to.eq(200);
    });
  });

  describe('lane cases on authn-local and authn-orm', function () {
    this.timeout(60000);
    let h: Harness;

    beforeEach(async () => {
      h = await n8bHarness({ rule: 'A11', facet: 'A11/http', caseName: 'lane', clock: new FakeClock(), config: {} });
      clearLog();
    });

    afterEach(async () => {
      await h.dispose?.();
    });

    it('the routes run on LocalPasswordService', async () => {
      expect((await DI.resolve(PasswordService)).constructor.name).to.eq('LocalPasswordService');
      const res = await send(h, { method: 'GET', path: '/auth/password/policy' });
      expect(res.status).to.eq(200);
      expect(res.body).to.include({ minLength: 8, maxLength: 128 });
    });

    it('the reset secret travels in the mail only (SR-09): no answer, header or log line holds it or a password', async () => {
      const id = await h.seed!.user(ALICE);
      const asked = await send(h, PASSWORD_ROUTES.passwordResetRequest!(ALICE.login));
      expect(asked.status).to.eq(200);
      const secret = await h.outbox!.secretFor(id, 'reset');
      expect(secret, 'the mail holds the secret').to.be.a('string');
      const next = 'Lane-New-Pass-2';
      const reset = await send(h, PASSWORD_ROUTES.passwordReset!(ALICE.login, secret!, next));
      expect(reset.status, JSON.stringify(reset.body)).to.eq(200);
      const login = await send(h, ROUTES.login!(ALICE.login, next));
      expect(login.status).to.eq(200);
      expect(laneEvents.some((e) => e.type === 'password.reset'), 'the lane recorded the password events').to.eq(true);
      const seen = [everything([asked, reset, login]), JSON.stringify(laneEvents)].join('\n');
      for (const [name, value] of Object.entries({ secret: secret!, old: ALICE.password, next })) expect(seen, name).to.not.include(value);
    });

    it('a throttled reset request answers 429 with Retry-After, alike for a known and an unknown login', async () => {
      await h.seed!.user(ALICE);
      const answers: HttpResponse[] = [];
      for (const login of [ALICE.login, ALICE.login, 'lane-nobody@example.test', 'lane-nobody@example.test']) answers.push(await send(h, PASSWORD_ROUTES.passwordResetRequest!(login)));
      expect(answers.map((r) => r.status)).to.deep.eq([200, 429, 200, 429]);
      expect(answers[3].body).to.deep.eq(answers[1].body);
      expect(answers[3].headers['retry-after']).to.eq(answers[1].headers['retry-after']);
      expect(Number(answers[1].headers['retry-after'])).to.be.greaterThan(0);
    });

    it('PATCH /user/password through the real service: a wrong old password changes nothing and answers the login failure body', async () => {
      await h.seed!.user(ALICE);
      const login = await send(h, ROUTES.login!(ALICE.login, ALICE.password));
      const cookie = login.setCookie.find((c) => c.startsWith(`${h.http!.sessionCookie}=`))!.split(';')[0].split('=').slice(1).join('=');
      const wrong = await send(h, PASSWORD_ROUTES.passwordChange!('Not-The-Pass-1', 'Lane-New-Pass-2'), cookie);
      expect(wrong.status).to.eq(401);
      expect(wrong.headers['retry-after']).to.eq(undefined);
      expect((await send(h, ROUTES.whoami!(), cookie)).status, 'the session stays').to.eq(200);
      expect((await send(h, ROUTES.login!(ALICE.login, ALICE.password))).status, 'the password stays').to.eq(200);
    });

    it('the password change events carry no password: neither the old, the new nor a wrong one', async () => {
      await h.seed!.user(ALICE);
      const login = await send(h, ROUTES.login!(ALICE.login, ALICE.password));
      const cookie = login.setCookie.find((c) => c.startsWith(`${h.http!.sessionCookie}=`))!.split(';')[0].split('=').slice(1).join('=');
      const next = 'Lane-New-Pass-3';
      const wrong = await send(h, PASSWORD_ROUTES.passwordChange!('Not-The-Pass-1', next), cookie);
      const changed = await send(h, PASSWORD_ROUTES.passwordChange!(ALICE.password, next), cookie);
      expect([wrong.status, changed.status]).to.deep.eq([401, 200]);
      expect(laneEvents.filter((e) => e.type === 'password.change').map((e) => e.outcome)).to.deep.eq(['failure', 'success']);
      const seen = [everything([wrong, changed]), JSON.stringify(laneEvents)].join('\n');
      for (const [name, value] of Object.entries({ old: ALICE.password, next, wrong: 'Not-The-Pass-1' })) expect(seen, name).to.not.include(value);
    });
  });
});
