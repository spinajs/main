import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { PasswordService } from '@spinajs/authn/contracts';
import { FakeClock, planCases, runAuthnBehaviour } from '@spinajs/authn-testing';
import type { Facet, Harness, HttpRequest, HttpResponse } from '@spinajs/authn-testing';

import { clearLog, logLines } from '../app.js';
import { ROUTES } from './harness.js';
import { N8B_PORTS, PASSWORD_ROUTES, bootN8bApp, n8bHarness, shutdownN8bApp } from './n8b-harness.js';

/** The http facets N8b owns so far; each task adds its own. */
const CLAIM: readonly Facet[] = ['A11/http', 'A30/http', 'A32/http'];

const RULES = ['A11', 'A30', 'A32'] as const;

const have = (need: string): boolean => (need.startsWith('http.routes.') ? need.slice('http.routes.'.length) in { ...ROUTES, ...PASSWORD_ROUTES } : need === 'fakeDate' || (N8B_PORTS as readonly string[]).includes(need));

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

  it('every planned case of the claimed facets has its needs', () => {
    const planned = planCases([...RULES], { facets: [...CLAIM] });
    expect(planned.map((p) => p.kase.facet)).to.include.members([...CLAIM]);
    const missing = planned.flatMap((p) => p.kase.needs.filter((n) => !have(n)).map((n) => `${p.kase.name}: ${n}`));
    expect(missing).to.deep.eq([]);
  });

  runAuthnBehaviour([...RULES], n8bHarness, { title: 'authn-http: N8b plan list (task 1)', claim: [...CLAIM], facets: [...CLAIM], timeoutMs: 60000 });

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
      const seen = everything([asked, reset, login]);
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
  });
});
