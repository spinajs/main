import 'mocha';
import { expect } from 'chai';
import { InvalidOption } from '@spinajs/exceptions';
import { Log } from '@spinajs/log';
import { HTTP_CONFIGURATION_SCHEMA } from '@spinajs/http';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { PUBLIC_DEFAULT_COOKIE_SECRET } from '@spinajs/authn-session';

import { ClientIp, CsrfOriginGuard, AuthnMiddleware, ApiKeyHeaderExtractor, AuthorizationBearerExtractor, proxyTrustOf } from '../../src/index.js';
import { boot, disposeBooted, readingFrom, violationsOf } from '../support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, HTTP_CONFIGURATION_SCHEMA];
const STRONG = 'unit-' + 'Zx8q'.repeat(10);
const bad = (values: Record<string, unknown>) => violationsOf(SCHEMAS, values);

const reqFrom = (peer: string, headers: Record<string, string> = {}, method = 'GET') => ({ method, headers, socket: { remoteAddress: peer }, storage: {} as Record<string, unknown> }) as never;

function run(handler: (req: never, res: never, next: () => void) => void, req: never): { passed: boolean; status?: number } {
  let passed = false;
  const res = {
    statusCode: 0,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  };
  handler(req, res as never, () => {
    passed = true;
  });
  return { passed, status: res.statusCode || undefined };
}

describe('authn http middlewares through @Config and the schemas', () => {
  afterEach(disposeBooted);

  describe('schema', () => {
    // The update interval moved with the last-use stamp to authn-token's TokenStrategy.
    it('gives the api-key and bearer extractors the token header and prefix they read', async () => {
      const { child } = await boot(SCHEMAS, {});
      const apiKey = readingFrom(new ApiKeyHeaderExtractor(), child) as unknown as Record<string, unknown>;
      const bearer = readingFrom(new AuthorizationBearerExtractor(), child) as unknown as Record<string, unknown>;
      expect([apiKey.HeaderName, apiKey.Prefix, bearer.Prefix]).to.deep.equal(['x-api-key', 'spt_', 'spt_']);
    });

    it('fills the csrf and session cookie defaults', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.http.csrf')).to.deep.eq({ enabled: true, allowedOrigins: [] });
      expect(configuration.get('authn.session.cookie')).to.deep.include({ name: 'ssid', hostPrefix: 'auto', secure: 'auto', sameSite: 'strict' });
    });

    it('names the bad csrf, trust and secret key', async () => {
      expect(await bad({ authn: { http: { csrf: { enabled: null } } } })).to.include('authn.http.csrf.enabled');
      expect(await bad({ authn: { http: { csrf: { enabled: 'false' } } } })).to.include('authn.http.csrf.enabled');
      expect(await bad({ authn: { http: { csrf: { allowedOrigins: ['https://ok.example.org', 'partner.example.org'] } } } })).to.include('authn.http.csrf.allowedOrigins.1');
      expect(await bad({ authn: { http: { csrf: { allowedOrigins: 'https://ok.example.org' } } } })).to.include('authn.http.csrf.allowedOrigins');
      expect(await bad({ authn: { http: { trustProxy: -1 } } })).to.include('authn.http.trustProxy');
      expect(await bad({ http: { cookie: { secret: '' } } })).to.include('http.cookie.secret');
    });

    it('accepts csrf off', async () => {
      expect(await bad({ authn: { http: { csrf: { enabled: false } } } })).to.deep.eq([]);
    });
  });

  describe('proxyTrustOf', () => {
    it('takes authn.http.trustProxy, else http.trustProxy when the former is null or absent', () => {
      expect(proxyTrustOf(2, 5)).to.deep.eq({ hops: 2 });
      expect(proxyTrustOf(null, 3)).to.deep.eq({ hops: 3 });
      expect(proxyTrustOf(undefined, undefined)).to.deep.eq({ hops: 0 });
      expect(proxyTrustOf(0, 3)).to.deep.eq({ hops: 0 });
    });

    it('names the key whose setting does not compile', () => {
      expect(() => proxyTrustOf(['10.0.0.0/33'], null)).to.throw(InvalidOption, 'authn.http.trustProxy');
      expect(() => proxyTrustOf(null, ['nope'])).to.throw(InvalidOption, 'http.trustProxy');
    });
  });

  describe('ClientIp', () => {
    it("takes the client behind the trusted proxies of its container's configuration", async () => {
      const { child } = await boot(SCHEMAS, { authn: { http: { trustProxy: ['10.0.0.0/8'] } } });
      const handler = readingFrom(new ClientIp(), child).before()!;
      const req = reqFrom('10.0.0.5', { 'x-forwarded-for': '203.0.113.7' });
      handler(req, {} as never, () => undefined);
      expect((req as { storage: { ClientIp?: string } }).storage.ClientIp).to.eq('203.0.113.7');
    });

    it('falls back to http.trustProxy and reads the socket address with neither', async () => {
      const shared = readingFrom(new ClientIp(), (await boot(SCHEMAS, { http: { trustProxy: 1 } })).child).before()!;
      const a = reqFrom('10.0.0.5', { 'x-forwarded-for': '203.0.113.7' });
      shared(a, {} as never, () => undefined);
      expect((a as { storage: { ClientIp?: string } }).storage.ClientIp).to.eq('203.0.113.7');
      const none = readingFrom(new ClientIp(), (await boot(SCHEMAS, {})).child).before()!;
      const b = reqFrom('10.0.0.5', { 'x-forwarded-for': '203.0.113.7' });
      none(b, {} as never, () => undefined);
      expect((b as { storage: { ClientIp?: string } }).storage.ClientIp).to.eq('10.0.0.5');
    });

    it('still refuses a CIDR the schema cannot judge when the middleware is built', async () => {
      const { child } = await boot(SCHEMAS, { authn: { http: { trustProxy: ['10.0.0.0/33'] } } });
      expect(() => readingFrom(new ClientIp(), child).before()).to.throw(InvalidOption, 'authn.http.trustProxy');
    });
  });

  describe('CsrfOriginGuard', () => {
    const cookieHeaders = (origin: string) => ({ cookie: 'ssid=x', origin, host: 'app.example.org' });
    const guardOf = (child: Parameters<typeof readingFrom>[1]) => {
      const guard = readingFrom(new CsrfOriginGuard(), child);
      Object.defineProperty(guard, 'Log', { value: { warn: () => undefined } });
      return guard;
    };

    it('refuses a cross-origin unsafe request carrying the session cookie, passes a listed and the own origin', async () => {
      const { child } = await boot(SCHEMAS, { authn: { http: { csrf: { allowedOrigins: ['HTTPS://Partner.Example.Org:443/'] } } } });
      const handler = guardOf(child).before()!;
      expect(run(handler, reqFrom('10.0.0.5', cookieHeaders('https://evil.example.org'), 'POST')), 'foreign').to.deep.eq({ passed: false, status: 403 });
      expect(run(handler, reqFrom('10.0.0.5', cookieHeaders('https://partner.example.org'), 'POST')).passed, 'listed, normalised').to.eq(true);
      expect(run(handler, reqFrom('10.0.0.5', cookieHeaders('http://app.example.org'), 'POST')).passed, 'own').to.eq(true);
    });

    it('is off only for enabled: false, and takes the session cookie name from authn.session.cookie', async () => {
      expect(guardOf((await boot(SCHEMAS, { authn: { http: { csrf: { enabled: false } } } })).child).before()).to.eq(null);
      const { child } = await boot(SCHEMAS, { authn: { session: { cookie: { name: 'sid2' } } } });
      const handler = guardOf(child).before()!;
      expect(run(handler, reqFrom('10.0.0.5', { cookie: 'ssid=x', origin: 'https://evil.example.org', host: 'app.example.org' }, 'POST')).passed, 'another cookie').to.eq(true);
      expect(run(handler, reqFrom('10.0.0.5', { cookie: 'sid2=x', origin: 'https://evil.example.org', host: 'app.example.org' }, 'POST')).passed).to.eq(false);
    });

    it('still refuses an allowed origin the pattern cannot judge, naming the key', async () => {
      const { child } = await boot(SCHEMAS, { authn: { http: { csrf: { allowedOrigins: ['https://partner.example.org:99999'] } } } });
      expect(() => guardOf(child).before()).to.throw(InvalidOption, 'authn.http.csrf.allowedOrigins');
    });
  });

  describe('AuthnMiddleware boot', () => {
    const middleware = async (values: Record<string, unknown>, env: string) => {
      const { child, configuration } = await boot(SCHEMAS, values, env);
      const mw = readingFrom(new AuthnMiddleware(), child) as unknown as Record<string, unknown>;
      const warnings: string[] = [];
      Object.defineProperty(mw, 'Configuration', { value: configuration });
      Object.defineProperty(mw, 'Log', { value: { warn: (m: string) => warnings.push(m) } as unknown as Log });
      Object.defineProperty(mw, 'Container', { value: { resolve: async (t: unknown) => ((t as { Type?: unknown }).Type ? [] : { restore: async () => null }) } });
      return { mw: mw as unknown as AuthnMiddleware, warnings };
    };

    it('refuses the public default secret outside development and test, and a missing secret anywhere', async () => {
      await middleware({ http: { cookie: { secret: STRONG } } }, 'production').then(({ mw }) => mw.resolve());
      let error: unknown;
      try {
        await (await middleware({ http: { cookie: { secret: PUBLIC_DEFAULT_COOKIE_SECRET } } }, 'production')).mw.resolve();
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.contain('public default');
      error = undefined;
      try {
        await (await middleware({}, 'test')).mw.resolve();
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.contain('http.cookie.secret is not set');
    });

    it('warns about the public secret in test and about a missing publicOrigin', async () => {
      const { mw, warnings } = await middleware({ http: { cookie: { secret: PUBLIC_DEFAULT_COOKIE_SECRET } } }, 'test');
      await mw.resolve();
      expect(warnings.join('\n')).to.contain('public default').and.to.contain('authn.http.publicOrigin is not set');
      const set = await middleware({ http: { cookie: { secret: STRONG } }, authn: { http: { publicOrigin: 'https://app.example.org' } } }, 'test');
      await set.mw.resolve();
      expect(set.warnings).to.deep.eq([]);
    });

    it('takes the cookie name from authn.session.cookie and the env flags from the app env', async () => {
      const prod = await middleware({ http: { cookie: { secret: STRONG } } }, 'production');
      await prod.mw.resolve();
      expect((prod.mw as unknown as { CookieName: string }).CookieName).to.eq('__Host-ssid');
      const dev = await middleware({ http: { cookie: { secret: STRONG } }, authn: { session: { cookie: { name: 'sid2' } } } }, 'test');
      await dev.mw.resolve();
      expect((dev.mw as unknown as { CookieName: string }).CookieName).to.eq('sid2');
    });
  });
});
