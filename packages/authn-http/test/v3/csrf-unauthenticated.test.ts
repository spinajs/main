import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { CONFIGURATION_CONTAINER_KEY } from '@spinajs/configuration';

import { CsrfOriginGuard } from '../../src/middleware/csrf.js';
import authnHttpConfig from '../../src/config/authn-http.js';
import { fakeContainer } from '@spinajs/testing';

const OWN = 'http://app.example.test';
const PARTNER = 'https://partner.example.org';
const EVIL = 'https://evil.example.net';
const FORMERLY_LISTED = ['/auth/login', '/auth/password/reset-request', '/auth/password/reset', '/auth/keys/login', '/auth/mfa/verify', '/auth/mfa/recovery', '/auth/code/request', '/auth/code/login'];
const FORMERLY_MISSED = ['/auth/register', '/auth/verify', '/auth/passkeys/login', '/auth/passkeys/challenge', '/auth/keys/challenge', '/auth/tokens/revoke'];
const REFUSED = { error: { code: 'E_CSRF_ORIGIN', message: 'Cross-origin request refused' } };

const BASE = {
  'authn.http.csrf.enabled': true,
  'authn.http.csrf.allowedOrigins': [PARTNER],
  'authn.session.cookie': { name: 'ssid' },
  'authn.http.trustProxy': null,
  'http.trustProxy': null,
  'http.controllers.route.prefix': '',
};

function guardWith(values: Record<string, unknown> = {}): CsrfOriginGuard {
  const mw = new CsrfOriginGuard();
  Object.defineProperty(mw, CONFIGURATION_CONTAINER_KEY, { value: fakeContainer({ ...BASE, ...values }) });
  Object.defineProperty(mw, 'Log', { value: { warn: () => undefined, debug: () => undefined }, configurable: true });
  return mw;
}

interface Outcome {
  readonly passed: boolean;
  readonly status: number;
  readonly body: unknown;
}

function run(guard: CsrfOriginGuard, path: string, headers: Record<string, string> = {}, method = 'POST'): Outcome {
  const res = { statusCode: 200, body: undefined as unknown, status: (c: number) => ((res.statusCode = c), res), json: (b: unknown) => ((res.body = b), res) };
  const next = sinon.spy();
  const req = { method, path, url: path, headers: { host: 'app.example.test', ...headers }, socket: { remoteAddress: '127.0.0.1' }, storage: {} } as any;
  guard.before()!(req, res as any, next);
  return { passed: next.calledOnce, status: res.statusCode, body: res.body };
}

const refused = (o: Outcome): void => {
  expect(o.passed, 'the request was let through').to.eq(false);
  expect(o.status).to.eq(403);
  expect(o.body).to.deep.eq(REFUSED);
};

const passes = (o: Outcome): void => {
  expect(o.passed, JSON.stringify(o.body)).to.eq(true);
};

describe('CsrfOriginGuard without the session cookie (A22, L1, X1 default-deny)', () => {
  it('ships no route list: every unsafe request a browser sends is checked', () => {
    expect((authnHttpConfig.authn.http as Record<string, unknown>).csrf).to.eq(undefined);
  });

  describe('any route', () => {
    for (const path of [...FORMERLY_LISTED, ...FORMERLY_MISSED, '/user/mfa', '/xauth/login', '/api/auth/login']) {
      it(`${path}: a foreign Origin is refused`, () => refused(run(guardWith(), path, { origin: EVIL })));
    }

    it('the own origin passes', () => passes(run(guardWith(), '/auth/login', { origin: OWN })));
    it('an origin from the deprecated authn.http.csrf.allowedOrigins passes', () => passes(run(guardWith(), '/auth/login', { origin: PARTNER })));
    it('an origin from http.csrf.allowedOrigins passes', () => passes(run(guardWith({ 'authn.http.csrf.allowedOrigins': [], 'http.csrf.allowedOrigins': [PARTNER] }), '/auth/register', { origin: PARTNER })));
    it('Origin null is refused', () => refused(run(guardWith(), '/auth/login', { origin: 'null' })));
    it('another port is another origin', () => refused(run(guardWith(), '/auth/login', { origin: 'http://app.example.test:8080' })));

    it('without Origin, cross-site, same-site and none fetch metadata are refused', () => {
      for (const site of ['cross-site', 'same-site', 'none']) refused(run(guardWith(), '/auth/register', { 'sec-fetch-site': site }));
    });

    it('without Origin, same-origin fetch metadata passes', () => passes(run(guardWith(), '/auth/register', { 'sec-fetch-site': 'same-origin' })));
    it('a non-browser client sending neither header passes', () => passes(run(guardWith(), '/auth/register')));
    it('Origin wins over fetch metadata', () => refused(run(guardWith(), '/auth/login', { origin: EVIL, 'sec-fetch-site': 'same-origin' })));
    it('a safe method is not checked', () => passes(run(guardWith(), '/auth/login', { origin: EVIL }, 'GET')));
  });

  describe('the session cookie', () => {
    it('keeps the cookie rule: no Origin and no fetch metadata is refused', () => {
      refused(run(guardWith(), '/auth/login', { cookie: 'ssid=x' }));
      refused(run(guardWith(), '/user/mfa', { cookie: '__Host-ssid=x' }));
      passes(run(guardWith(), '/auth/login', { cookie: 'ssid=x', origin: OWN }));
    });

    it('an unrelated cookie does not count as a session', () => {
      passes(run(guardWith(), '/auth/login', { cookie: 'theme=dark' }));
      refused(run(guardWith(), '/auth/login', { cookie: 'theme=dark', origin: EVIL }));
    });

    it('http.csrf.ambientCookies add to the session cookie', () => {
      const guard = guardWith({ 'http.csrf.ambientCookies': ['app_sid'] });
      refused(run(guard, '/x', { cookie: 'app_sid=1' }));
      refused(run(guard, '/x', { cookie: 'ssid=1' }));
    });
  });

  describe('deprecated authn.http.csrf.unauthenticatedRoutes', () => {
    it('is ignored: an empty or custom list leaves every route checked, with a deprecation warning', () => {
      const warn = sinon.spy();
      const guard = guardWith({ 'authn.http.csrf.unauthenticatedRoutes': [] });
      Object.defineProperty(guard, 'Log', { value: { warn, debug: () => undefined } });
      refused(run(guard, '/auth/login', { origin: EVIL }));
      expect(String((warn.firstCall.args[0] as { keys: string }).keys)).to.contain('authn.http.csrf.unauthenticatedRoutes');
      refused(run(guardWith({ 'authn.http.csrf.unauthenticatedRoutes': ['/custom/signin'] }), '/auth/login', { origin: EVIL }));
    });
  });
});
