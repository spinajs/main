import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { InvalidOption } from '@spinajs/exceptions';

import { SameOriginGuard, checkSameOrigin, parseAllowedOrigins } from '../src/middlewares/SameOrigin.js';
import type { MissingOriginRule, OriginRefusal } from '../src/middlewares/SameOrigin.js';
import { parseTrustProxy } from '../src/middlewares/RealIp.js';
import type { Request } from '../src/interfaces.js';

const OWN = 'https://app.example.test';
const PARTNER = 'https://partner.example.test';

describe('same-origin check', () => {
  describe('checkSameOrigin', () => {
    const allowedOrigins = parseAllowedOrigins([PARTNER], 'k');
    const check = (headers: Record<string, string>, missingOrigin?: MissingOriginRule, own: string | undefined = OWN) => checkSameOrigin(headers, own, { allowedOrigins, missingOrigin });

    it('allows the own origin and an allowed origin, compared as serialized origins', () => {
      expect(check({ origin: OWN })).to.deep.eq({ allowed: true });
      expect(check({ origin: PARTNER })).to.deep.eq({ allowed: true });
      expect(check({ origin: 'https://APP.example.test:443' }), 'case and default port').to.deep.eq({ allowed: true });
      expect(check({ origin: 'http://app.example.test:80' }, undefined, 'http://App.Example.Test:80')).to.deep.eq({ allowed: true });
    });

    it('refuses another origin, another scheme or another port of the own host', () => {
      for (const origin of ['https://evil.example.test', 'http://app.example.test', 'https://app.example.test:8443', 'https://sub.app.example.test']) {
        expect(check({ origin }), origin).to.deep.eq({ allowed: false, reason: 'foreign-origin' });
      }
    });

    it('refuses an Origin that is not an origin, whatever the fetch metadata says', () => {
      for (const origin of ['null', '*', '', 'https://app.example.test/path', 'https://user@app.example.test', 'app.example.test']) {
        expect(check({ origin, 'sec-fetch-site': 'same-origin' }), origin).to.deep.eq({ allowed: false, reason: 'malformed-origin' });
      }
    });

    it('refuses every Origin when the own origin is unknown, unless it is allowed', () => {
      expect(checkSameOrigin({ origin: OWN }, undefined, { allowedOrigins })).to.deep.eq({ allowed: false, reason: 'foreign-origin' });
      expect(checkSameOrigin({ origin: OWN }, 'https://', { allowedOrigins }), 'requestOrigin without a Host').to.deep.eq({ allowed: false, reason: 'foreign-origin' });
      expect(checkSameOrigin({ origin: PARTNER }, undefined, { allowedOrigins })).to.deep.eq({ allowed: true });
    });

    it('ignores Sec-Fetch-Site when an Origin is present', () => {
      expect(check({ origin: OWN, 'sec-fetch-site': 'cross-site' })).to.deep.eq({ allowed: true });
      expect(check({ origin: 'https://evil.example.test', 'sec-fetch-site': 'same-origin' })).to.deep.eq({ allowed: false, reason: 'foreign-origin' });
    });

    it('same-origin-fetch (default): without an Origin only Sec-Fetch-Site: same-origin passes', () => {
      expect(check({ 'sec-fetch-site': 'same-origin' })).to.deep.eq({ allowed: true });
      expect(check({})).to.deep.eq({ allowed: false, reason: 'missing-origin' });
      expect(check({ 'sec-fetch-site': 'none' })).to.deep.eq({ allowed: false, reason: 'missing-origin' });
      expect(check({ 'sec-fetch-site': 'cross-site' })).to.deep.eq({ allowed: false, reason: 'cross-site-fetch' });
      expect(check({ 'sec-fetch-site': 'same-site' })).to.deep.eq({ allowed: false, reason: 'cross-site-fetch' });
    });

    it('unless-cross-site: without an Origin only cross-site and same-site fetches are refused', () => {
      expect(check({}, 'unless-cross-site')).to.deep.eq({ allowed: true });
      expect(check({ 'sec-fetch-site': 'none' }, 'unless-cross-site')).to.deep.eq({ allowed: true });
      expect(check({ 'sec-fetch-site': 'same-origin' }, 'unless-cross-site')).to.deep.eq({ allowed: true });
      expect(check({ 'sec-fetch-site': 'cross-site' }, 'unless-cross-site')).to.deep.eq({ allowed: false, reason: 'cross-site-fetch' });
      expect(check({ 'sec-fetch-site': 'same-site' }, 'unless-cross-site')).to.deep.eq({ allowed: false, reason: 'cross-site-fetch' });
    });

    it('allows nothing extra without allowed origins', () => {
      expect(checkSameOrigin({ origin: PARTNER }, OWN)).to.deep.eq({ allowed: false, reason: 'foreign-origin' });
    });
  });

  describe('parseAllowedOrigins', () => {
    it('normalises entries; absent or null is empty', () => {
      expect([...parseAllowedOrigins(['HTTPS://Partner.Example.Test:443/', 'http://x.test:8080'], 'k')]).to.deep.eq([PARTNER, 'http://x.test:8080']);
      expect(parseAllowedOrigins(null, 'k').size).to.eq(0);
      expect(parseAllowedOrigins(undefined, 'k').size).to.eq(0);
    });

    it('throws InvalidOption naming the key for an entry that is not an origin', () => {
      for (const entry of ['*', 'null', 'partner.example.test', 'https://partner.example.test/app', 'https://*.example.test', 'https://x.test:70000']) {
        expect(() => parseAllowedOrigins([entry], 'my.allowedOrigins'), entry).to.throw(InvalidOption, 'my.allowedOrigins');
      }
    });
  });

  describe('SameOriginGuard', () => {
    class Guard extends SameOriginGuard {
      public refusals: OriginRefusal[] = [];
      constructor(
        private readonly allowed: readonly string[] = [],
        rule?: MissingOriginRule,
      ) {
        super();
        if (rule) this.MissingOrigin = rule;
      }
      protected allowedOrigins() {
        return parseAllowedOrigins(this.allowed, 'test.allowedOrigins');
      }
    }

    function fakeReq(method: string, headers: Record<string, string>, storage: Record<string, unknown> = {}, remoteAddress = '10.0.0.2') {
      return { method, headers: { host: 'app.example.test', ...headers }, socket: { remoteAddress, encrypted: true }, storage } as unknown as Request;
    }

    function run(guard: SameOriginGuard, req: Request): { next: sinon.SinonSpy; status?: number; body?: unknown } {
      const out: { next: sinon.SinonSpy; status?: number; body?: unknown } = { next: sinon.spy() };
      const res = {
        status(code: number) {
          out.status = code;
          return { json: (b: unknown) => (out.body = b) };
        },
      };
      guard.before()!(req, res as any, out.next);
      return out;
    }

    it('runs after RealIp', () => {
      expect(new Guard().Order).to.be.greaterThan(1);
    });

    it('lets safe methods through unchecked', () => {
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        expect(run(new Guard(), fakeReq(method, { origin: 'https://evil.example.test' })).next.calledOnce, method).to.eq(true);
      }
    });

    it('passes a same-origin unsafe request and answers 403 to a cross-origin one', () => {
      expect(run(new Guard(), fakeReq('POST', { origin: OWN })).next.calledOnce).to.eq(true);
      const refused = run(new Guard(), fakeReq('DELETE', { origin: 'https://evil.example.test' }));
      expect(refused.next.called).to.eq(false);
      expect(refused.status).to.eq(403);
      expect(refused.body).to.deep.eq({ error: { code: 'E_ORIGIN_REFUSED', message: 'Cross-origin request refused' } });
    });

    it('takes the own origin from X-Forwarded-* only through the trust RealIp stored', () => {
      const fwd = { origin: 'https://shop.example.test', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'shop.example.test' };
      expect(run(new Guard(), fakeReq('POST', fwd, { proxyTrust: parseTrustProxy(['10.0.0.0/8'], 'k') })).next.calledOnce).to.eq(true);
      expect(run(new Guard(), fakeReq('POST', fwd)).status, 'no stored trust: no proxy').to.eq(403);
      expect(run(new Guard(), fakeReq('POST', fwd, { proxyTrust: parseTrustProxy(['10.0.0.0/8'], 'k') }, '192.0.2.9')).status, 'untrusted peer').to.eq(403);
    });

    it('honours allowed origins and the missing-origin rule', () => {
      expect(run(new Guard([PARTNER]), fakeReq('POST', { origin: PARTNER })).next.calledOnce).to.eq(true);
      expect(run(new Guard(), fakeReq('POST', {})).status).to.eq(403);
      expect(run(new Guard([], 'unless-cross-site'), fakeReq('POST', {})).next.calledOnce).to.eq(true);
    });

    it('a bad allowed origin fails when the middleware is built', () => {
      expect(() => new Guard(['nope']).before()).to.throw(InvalidOption, 'test.allowedOrigins');
    });

    it('a subclass narrows the requests it checks and answers refusals its own way', () => {
      class CookieGuard extends Guard {
        protected appliesTo(req: Request) {
          return super.appliesTo(req) && (req.headers.cookie ?? '').includes('sid=');
        }
        protected refuse(reason: OriginRefusal, _req: Request, _res: unknown, next: (err?: unknown) => void) {
          this.refusals.push(reason);
          next(new Error(reason));
        }
      }
      const guard = new CookieGuard();
      expect(run(guard, fakeReq('POST', { origin: 'https://evil.example.test' })).next.calledOnceWithExactly(), 'no cookie: not checked').to.eq(true);
      const out = run(guard, fakeReq('POST', { origin: 'null', cookie: 'sid=1' }));
      expect(out.next.firstCall.args[0]).to.be.instanceOf(Error);
      expect(guard.refusals).to.deep.eq(['malformed-origin']);
    });
  });
});
