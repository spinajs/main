import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import { BaseController, Controllers, HttpServer, ServerMiddleware, parseTrustProxy } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { appEnvOf, sessionCookieName } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider } from '@spinajs/users';

import * as barrel from '../../src/index.js';
import * as api from '../../src/api.js';
import { CsrfOriginGuard, ownOrigin } from '../../src/middleware/csrf.js';
import { AUTHN_PROBE_PATH, authnProbeHits } from './probe.js';
import { TestConfiguration, req, restoreHttpErrorMap } from '../token-common.js';

const OWN = 'http://localhost:8889';
const PARTNER = 'https://partner.example.org';
const EVIL = 'https://evil.example.net';

class CsrfConfiguration extends TestConfiguration {}

// Same as releaseHttpServer() of packages/http/test/common.ts, which imports http's sources and so cannot be shared.
async function releaseHttpServer(): Promise<void> {
  await DI.get(HttpServer)?.stop();
  DI.uncache(HttpServer);
  DI.uncache(Controllers);
  for (const type of DI.getRegisteredTypes(BaseController) ?? []) DI.uncache(type as Class<BaseController>);
  DI.uncache(BaseController);
}

/**
 * Middleware instances outlive a suite, so the guard an earlier suite built reads that suite's configuration. Drops the
 * guard and the cached ServerMiddleware list (rebuilt from the other cached instances on the next resolve).
 */
function uncacheGuard(): void {
  DI.uncache(CsrfOriginGuard);
  DI.uncache(ServerMiddleware);
}

async function startServer(): Promise<void> {
  uncacheGuard();
  await DI.resolve(Controllers);
  await (await DI.resolve(HttpServer)).start();
}

/** Restarts the server so the guard reads the given settings when the middleware is built. */
async function restartWith(settings: Record<string, unknown>): Promise<void> {
  await releaseHttpServer();
  const config = DI.get(Configuration)!;
  for (const [path, value] of Object.entries(settings)) config.set(path, value);
  await startServer();
}

const DEFAULTS = { 'authn.http.csrf.enabled': true, 'authn.http.csrf.allowedOrigins': [PARTNER], 'authn.http.trustProxy': null, 'http.trustProxy': null };

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

let cookieName: string;

interface Sent {
  status: number;
  body: unknown;
  ran: boolean;
}

async function send(method: Method, headers: Record<string, string>, opts: { cookie?: string | false; path?: string } = {}): Promise<Sent> {
  const path = opts.path ?? AUTHN_PROBE_PATH;
  const r = req();
  let call = method === 'GET' ? r.get(path) : method === 'POST' ? r.post(path) : method === 'PUT' ? r.put(path) : method === 'PATCH' ? r.patch(path) : r.delete(path);
  call = call.set('Accept', 'application/json');
  const cookie = opts.cookie === undefined ? `${cookieName}=not-a-real-session` : opts.cookie;
  if (cookie !== false) call = call.set('Cookie', cookie);
  for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
  const before = authnProbeHits();
  const res = await call;
  return { status: res.status, body: res.body, ran: authnProbeHits() > before };
}

function expectPass(s: Sent): void {
  expect(s.status, JSON.stringify(s.body)).to.eq(200);
  expect(s.ran, 'the handler ran').to.eq(true);
}

function expectRefused(s: Sent): void {
  expect(s.status, JSON.stringify(s.body)).to.eq(403);
  expect(s.body).to.deep.eq({ error: { code: 'E_CSRF_ORIGIN', message: 'Cross-origin request refused' } });
  expect(s.ran, 'the refused request never reached the handler').to.eq(false);
}

function unitGuard(values: Record<string, unknown>): CsrfOriginGuard {
  const mw = new CsrfOriginGuard();
  Object.defineProperty(mw, 'Configuration', { value: { get: (path: string, def?: unknown) => (path in values ? values[path] : def) } });
  return mw;
}

function fakeReq(method: string, headers: Record<string, string>, socket: { remoteAddress?: string; encrypted?: boolean } = { remoteAddress: '127.0.0.1' }) {
  return { method, headers, socket, storage: {} } as any;
}

function fakeRes() {
  const res = { statusCode: 200, body: undefined as unknown, status: (c: number) => ((res.statusCode = c), res), json: (b: unknown) => ((res.body = b), res) };
  return res;
}

describe('CsrfOriginGuard (A22, SR-12)', function () {
  this.timeout(60000);

  before(async () => {
    DI.setESMModuleSupport();
    restoreHttpErrorMap();

    DI.unregister(CsrfConfiguration);
    DI.register(CsrfConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) await b.bootstrap();

    const config = await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Orm);
    for (const [path, value] of Object.entries(DEFAULTS)) config.set(path, value);
    await startServer();

    cookieName = sessionCookieName(config.get<ISessionCookieConfig>('authn.session.cookie', {}), appEnvOf(config));
  });

  after(async () => {
    await releaseHttpServer();
    DI.unregister(CsrfConfiguration);
    DI.uncache(CsrfConfiguration);
    DI.uncache(Configuration);
    DI.uncache(Orm);
    uncacheGuard();
  });

  it('the barrel exports the lane CsrfOriginGuard, registered as a ServerMiddleware at Order 4, not the api.ts stub', () => {
    expect(barrel.CsrfOriginGuard).to.eq(CsrfOriginGuard).and.not.eq(api.CsrfOriginGuard);
    expect(new CsrfOriginGuard().Order).to.eq(4);
    expect(DI.getRegisteredTypes(ServerMiddleware)).to.include(CsrfOriginGuard);
  });

  describe('over the real server', () => {
    beforeEach(async () => restartWith(DEFAULTS));

    it('A22 own origin passes', async () => expectPass(await send('POST', { Origin: OWN })));
    it('SR-12 a cross-origin POST with the session cookie never reaches the handler', async () => expectRefused(await send('POST', { Origin: EVIL })));
    it('A22 a listed origin passes', async () => expectPass(await send('POST', { Origin: PARTNER })));
    it('A22 same-origin fetch metadata passes without Origin', async () => expectPass(await send('POST', { 'Sec-Fetch-Site': 'same-origin' })));

    it('A22 without Origin, same-site, cross-site, none and absent fetch metadata are refused', async () => {
      for (const site of ['same-site', 'cross-site', 'none']) expectRefused(await send('POST', { 'Sec-Fetch-Site': site }));
      expectRefused(await send('POST', {}));
    });

    it('A22 Origin null is refused', async () => expectRefused(await send('POST', { Origin: 'null' })));
    it('A22 another port is another origin', async () => expectRefused(await send('POST', { Origin: 'http://localhost:8890' })));
    it('A22 a longer host is another origin', async () => expectRefused(await send('POST', { Origin: 'http://localhost.evil.example.net:8889' })));
    it('A22 a longer listed origin is another origin', async () => expectRefused(await send('POST', { Origin: `${PARTNER}.evil.example.net` })));
    it('A22 another scheme is another origin', async () => expectRefused(await send('POST', { Origin: 'https://localhost:8889' })));

    it('A22 an origin that only differs in case or adds a path is not the serialized origin', async () => {
      expectRefused(await send('POST', { Origin: 'HTTPS://partner.example.org' }));
      expectRefused(await send('POST', { Origin: `${PARTNER}/` }));
    });

    it('A22 Origin wins over fetch metadata', async () => expectRefused(await send('POST', { Origin: EVIL, 'Sec-Fetch-Site': 'same-origin' })));

    it('A22 every unsafe method is checked: PUT, PATCH, DELETE', async () => {
      for (const method of ['PUT', 'PATCH', 'DELETE'] as const) expectRefused(await send(method, { Origin: EVIL }));
      for (const method of ['PUT', 'PATCH', 'DELETE'] as const) expectPass(await send(method, { Origin: OWN }));
    });

    it('A22 safe methods are not checked', async () => expectPass(await send('GET', { Origin: EVIL })));

    it('A22 requests without the session cookie are exempt', async () => {
      expectPass(await send('POST', { Origin: EVIL }, { cookie: false }));
      expectPass(await send('POST', { Origin: EVIL }, { cookie: 'unrelated=1' }));
    });

    it('A22 the session cookie is found among other cookies, under either prefix form', async () => {
      const base = cookieName.replace(/^__Host-/, '');
      expectRefused(await send('POST', { Origin: EVIL }, { cookie: `a=1; ${cookieName}=x; b=2` }));
      expectRefused(await send('POST', { Origin: EVIL }, { cookie: `${base}=x` }));
      expectRefused(await send('POST', { Origin: EVIL }, { cookie: `__Host-${base}=x` }));
      expectRefused(await send('POST', { Origin: EVIL }, { cookie: `${cookieName}=` }));
    });

    it('A22 the guard is off when disabled', async () => {
      await restartWith({ ...DEFAULTS, 'authn.http.csrf.enabled': false });
      expectPass(await send('POST', { Origin: EVIL }));
    });

    it('A22 the guard is on when authn.http.csrf is not configured', async () => {
      await restartWith({ ...DEFAULTS, 'authn.http.csrf.enabled': undefined, 'authn.http.csrf.allowedOrigins': undefined });
      expectRefused(await send('POST', { Origin: EVIL }));
      expectRefused(await send('POST', { Origin: PARTNER }));
      expectPass(await send('POST', { Origin: OWN }));
    });

    it('A22 a cross-origin cookie request to the OIDC link routes is refused (N10)', async () => {
      expectRefused(await send('POST', { Origin: EVIL }, { path: 'auth/oidc/test-provider/link' }));
      expectRefused(await send('DELETE', { Origin: EVIL }, { path: 'auth/oidc/test-provider/link' }));
      expectPass(await send('POST', { Origin: OWN }, { path: 'auth/oidc/test-provider/link' }));
    });

    it('A22 X-Forwarded-Proto and -Host set the own origin only behind a trusted proxy', async () => {
      const forwarded = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'app.example.test' };
      expectRefused(await send('POST', { ...forwarded, Origin: 'https://app.example.test' }));
      expectPass(await send('POST', { ...forwarded, Origin: OWN }));

      await restartWith({ ...DEFAULTS, 'authn.http.trustProxy': ['loopback'] });
      expectPass(await send('POST', { ...forwarded, Origin: 'https://app.example.test' }));
      expectRefused(await send('POST', { ...forwarded, Origin: OWN }));

      await restartWith({ ...DEFAULTS, 'http.trustProxy': ['loopback'] });
      expectPass(await send('POST', { ...forwarded, Origin: 'https://app.example.test' }));

      await restartWith({ ...DEFAULTS, 'authn.http.trustProxy': 0, 'http.trustProxy': ['loopback'] });
      expectRefused(await send('POST', { ...forwarded, Origin: 'https://app.example.test' }));
    });
  });

  describe('ownOrigin', () => {
    const none = parseTrustProxy(null, 'k');
    const proxied = parseTrustProxy(['10.0.0.0/8'], 'k');
    const forwarded = { host: 'internal:3000', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'App.Example.Test' };

    it('takes the scheme from the connection and the host from Host without a trusted proxy', () => {
      expect(ownOrigin(fakeReq('POST', forwarded, { remoteAddress: '10.0.0.5' }), none)).to.eq('http://internal:3000');
      expect(ownOrigin(fakeReq('POST', forwarded, { remoteAddress: '203.0.113.9' }), proxied)).to.eq('http://internal:3000');
      expect(ownOrigin(fakeReq('POST', { host: 'app.example.test' }, { remoteAddress: '203.0.113.9', encrypted: true }), none)).to.eq('https://app.example.test');
    });

    it('takes X-Forwarded-Proto and -Host from a trusted proxy', () => {
      expect(ownOrigin(fakeReq('POST', forwarded, { remoteAddress: '10.0.0.5' }), proxied)).to.eq('https://app.example.test');
      expect(ownOrigin(fakeReq('POST', forwarded, { remoteAddress: '::ffff:10.0.0.5' }), proxied)).to.eq('https://app.example.test');
    });

    it('normalises the default port', () => {
      expect(ownOrigin(fakeReq('POST', { host: 'app.example.test:80' }), none)).to.eq('http://app.example.test');
    });

    it('has no own origin without a usable Host', () => {
      for (const host of [undefined, '', 'app.example.test/x', 'evil.example@app.example.test', 'a b']) {
        const headers: Record<string, string> = host === undefined ? {} : { host };
        expect(ownOrigin(fakeReq('POST', headers), none), String(host)).to.eq(undefined);
      }
    });
  });

  describe('built from configuration', () => {
    const run = (guard: CsrfOriginGuard, method: string, headers: Record<string, string>) => {
      const handler = guard.before()!;
      const res = fakeRes();
      const next = sinon.spy();
      handler(fakeReq(method, { cookie: 'ssid=x; __Host-ssid=x', ...headers }), res as any, next);
      return { passed: next.calledOnce, status: res.statusCode };
    };

    it('treats every method but GET, HEAD and OPTIONS as unsafe', () => {
      const guard = unitGuard({});
      for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(run(guard, method, { origin: EVIL }).passed, method).to.eq(true);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND', 'get']) expect(run(guard, method, { origin: EVIL }), method).to.deep.eq({ passed: false, status: 403 });
    });

    it('without a usable Host only listed origins pass', () => {
      const guard = unitGuard({ 'authn.http.csrf.allowedOrigins': [PARTNER] });
      expect(run(guard, 'POST', { origin: PARTNER }).passed).to.eq(true);
      expect(run(guard, 'POST', { origin: 'http://' }).passed).to.eq(false);
      expect(run(guard, 'POST', { origin: 'http://localhost', host: 'localhost' }).passed).to.eq(true);
    });

    it('listed origins are normalised when the guard is built', () => {
      const guard = unitGuard({ 'authn.http.csrf.allowedOrigins': ['HTTPS://Partner.Example.Org:443/'] });
      expect(run(guard, 'POST', { origin: PARTNER }).passed).to.eq(true);
    });

    it('a bad allowedOrigins entry fails when the middleware is built, naming the key', () => {
      const bad = ['*', 'null', '', 'partner.example.org', 'https://partner.example.org/app', 'https://*.example.org', 'https://user@partner.example.org', 42];
      for (const entry of bad) {
        expect(() => unitGuard({ 'authn.http.csrf.allowedOrigins': [entry] }).before(), String(entry)).to.throw(InvalidOption, 'authn.http.csrf.allowedOrigins');
      }
      expect(() => unitGuard({ 'authn.http.csrf.allowedOrigins': PARTNER }).before()).to.throw(InvalidOption, 'authn.http.csrf.allowedOrigins');
      expect(unitGuard({ 'authn.http.csrf.allowedOrigins': null }).before()).to.be.a('function');
    });

    it('a bad trust setting fails when the middleware is built, naming the key', () => {
      expect(() => unitGuard({ 'authn.http.trustProxy': 'nope' }).before()).to.throw(InvalidOption, 'authn.http.trustProxy');
    });

    it('is off only for enabled: false', () => {
      expect(unitGuard({ 'authn.http.csrf.enabled': false }).before()).to.eq(null);
      expect(unitGuard({ 'authn.http.csrf.enabled': true }).before()).to.be.a('function');
      expect(unitGuard({ 'authn.http.csrf.enabled': null }).before()).to.be.a('function');
      expect(unitGuard({}).after()).to.eq(null);
    });

    it('a non-boolean enabled or a non-object authn.http.csrf fails when the middleware is built, naming the key', () => {
      for (const enabled of ['false', 'true', 0, 1, {}]) {
        expect(() => unitGuard({ 'authn.http.csrf.enabled': enabled }).before(), JSON.stringify(enabled)).to.throw(InvalidOption, 'authn.http.csrf.enabled');
      }
      for (const csrf of [false, true, 'off', []]) {
        expect(() => unitGuard({ 'authn.http.csrf': csrf }).before(), JSON.stringify(csrf)).to.throw(InvalidOption, 'authn.http.csrf');
      }
    });

    it('checks the configured cookie name, bare and with __Host-', () => {
      const sid = unitGuard({ 'authn.session.cookie': { name: 'sid' } });
      for (const cookie of ['sid=x', '__Host-sid=x']) expect(run(sid, 'POST', { origin: EVIL, cookie }).passed, cookie).to.eq(false);
      expect(run(sid, 'POST', { origin: EVIL, cookie: 'ssid=x; __Host-ssid=x' }).passed).to.eq(true);

      const prefixed = unitGuard({ 'authn.session.cookie': { name: '__Host-sid' } });
      for (const cookie of ['__Host-sid=x', '__Host-__Host-sid=x']) expect(run(prefixed, 'POST', { origin: EVIL, cookie }).passed, cookie).to.eq(false);
    });
  });
});
