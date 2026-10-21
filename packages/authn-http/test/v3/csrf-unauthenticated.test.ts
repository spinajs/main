import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { CONFIGURATION_CONTAINER_KEY } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';

import { CsrfOriginGuard } from '../../src/middleware/csrf.js';
import authnHttpConfig from '../../src/config/authn-http.js';
import { fakeContainer } from '../support/config-boot.js';

const OWN = 'http://app.example.test';
const PARTNER = 'https://partner.example.org';
const EVIL = 'https://evil.example.net';
const LISTED = ['/auth/login', '/auth/password/reset-request', '/auth/password/reset', '/auth/keys/login', '/auth/mfa/verify', '/auth/mfa/recovery', '/auth/code/request', '/auth/code/login'];
const REFUSED = { error: { code: 'E_CSRF_ORIGIN', message: 'Cross-origin request refused' } };

const BASE = {
  'authn.http.csrf.enabled': true,
  'authn.http.csrf.allowedOrigins': [PARTNER],
  'authn.http.csrf.unauthenticatedRoutes': LISTED,
  'authn.session.cookie': { name: 'ssid' },
  'authn.http.trustProxy': null,
  'http.trustProxy': null,
  'http.controllers.route.prefix': '',
};

function guardWith(values: Record<string, unknown> = {}): CsrfOriginGuard {
  const mw = new CsrfOriginGuard();
  Object.defineProperty(mw, CONFIGURATION_CONTAINER_KEY, { value: fakeContainer({ ...BASE, ...values }) });
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
  const req = { method, path, headers: { host: 'app.example.test', ...headers }, socket: { remoteAddress: '127.0.0.1' }, storage: {} } as any;
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

describe('CsrfOriginGuard on unauthenticated auth POSTs (A22, L1)', () => {
  describe('shipped configuration', () => {
    it('lists the credential-taking routes', () => {
      expect(authnHttpConfig.authn.http.csrf.unauthenticatedRoutes).to.deep.eq(LISTED);
    });
  });

  describe('a listed route without the session cookie', () => {
    for (const path of LISTED) {
      it(`${path}: a foreign Origin is refused`, () => refused(run(guardWith(), path, { origin: EVIL })));
    }

    it('the own origin passes', () => passes(run(guardWith(), '/auth/login', { origin: OWN })));
    it('an origin from allowedOrigins passes', () => passes(run(guardWith(), '/auth/login', { origin: PARTNER })));
    it('Origin null is refused', () => refused(run(guardWith(), '/auth/login', { origin: 'null' })));
    it('another port is another origin', () => refused(run(guardWith(), '/auth/login', { origin: 'http://app.example.test:8080' })));

    it('without Origin, cross-site and same-site fetch metadata are refused', () => {
      refused(run(guardWith(), '/auth/login', { 'sec-fetch-site': 'cross-site' }));
      refused(run(guardWith(), '/auth/login', { 'sec-fetch-site': 'same-site' }));
    });

    it('without Origin, same-origin fetch metadata passes', () => passes(run(guardWith(), '/auth/login', { 'sec-fetch-site': 'same-origin' })));
    it('a non-browser client sending neither header passes', () => passes(run(guardWith(), '/auth/login')));
    it('Origin wins over fetch metadata', () => refused(run(guardWith(), '/auth/login', { origin: EVIL, 'sec-fetch-site': 'same-origin' })));
    it('a safe method is not checked', () => passes(run(guardWith(), '/auth/login', { origin: EVIL }, 'GET')));
    it('a path with a trailing slash is the same route', () => refused(run(guardWith(), '/auth/login/', { origin: EVIL })));
    it('the path is matched case-insensitively, as the router does', () => refused(run(guardWith(), '/Auth/LOGIN', { origin: EVIL })));
  });

  describe('a route that is not listed', () => {
    it('a foreign Origin passes without the session cookie (as before)', () => {
      passes(run(guardWith(), '/user/mfa', { origin: EVIL }));
      passes(run(guardWith(), '/auth/login/extra', { origin: EVIL }));
      passes(run(guardWith(), '/xauth/login', { origin: EVIL }));
    });
  });

  describe('the session cookie', () => {
    it('keeps the cookie rule on a listed route: no Origin and no fetch metadata is refused', () => {
      refused(run(guardWith(), '/auth/login', { cookie: 'ssid=x' }));
      refused(run(guardWith(), '/auth/login', { cookie: 'ssid=x', origin: EVIL }));
      passes(run(guardWith(), '/auth/login', { cookie: 'ssid=x', origin: OWN }));
    });

    it('keeps the cookie rule on any other route', () => {
      refused(run(guardWith(), '/user/mfa', { cookie: 'ssid=x', origin: EVIL }));
      refused(run(guardWith(), '/user/mfa', { cookie: '__Host-ssid=x' }));
    });

    it('an unrelated cookie does not count as a session', () => {
      passes(run(guardWith(), '/auth/login', { cookie: 'theme=dark' }));
      refused(run(guardWith(), '/auth/login', { cookie: 'theme=dark', origin: EVIL }));
    });
  });

  describe('http.controllers.route.prefix', () => {
    it('matches the list against the path after the prefix', () => {
      const guard = guardWith({ 'http.controllers.route.prefix': 'api' });
      refused(run(guard, '/api/auth/login', { origin: EVIL }));
      passes(run(guard, '/api/auth/login', { origin: OWN }));
    });

    it('a listed path without the prefix is another route', () => {
      passes(run(guardWith({ 'http.controllers.route.prefix': 'api' }), '/auth/login', { origin: EVIL }));
    });

    it('accepts the prefix with surrounding slashes', () => {
      for (const prefix of ['/api', 'api/', '/api/']) refused(run(guardWith({ 'http.controllers.route.prefix': prefix }), '/api/auth/login', { origin: EVIL }));
    });

    it('a nested prefix', () => {
      refused(run(guardWith({ 'http.controllers.route.prefix': 'v1/public' }), '/v1/public/auth/mfa/verify', { origin: EVIL }));
    });
  });

  describe('authn.http.csrf.unauthenticatedRoutes', () => {
    it('replaces the default list', () => {
      const guard = guardWith({ 'authn.http.csrf.unauthenticatedRoutes': ['/custom/signin'] });
      refused(run(guard, '/custom/signin', { origin: EVIL }));
      passes(run(guard, '/auth/login', { origin: EVIL }));
    });

    it('an empty list leaves every cookieless request unchecked', () => {
      passes(run(guardWith({ 'authn.http.csrf.unauthenticatedRoutes': [] }), '/auth/login', { origin: EVIL }));
    });

    it('an entry that is not an absolute path fails when the middleware is built, naming the key', () => {
      expect(() => guardWith({ 'authn.http.csrf.unauthenticatedRoutes': ['auth/login'] }).before()).to.throw(InvalidOption, 'authn.http.csrf.unauthenticatedRoutes');
    });

  });
});
