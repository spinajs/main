import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { InvalidOption } from '@spinajs/exceptions';

import { RealIp, parseTrustProxy, trustedClientAddress, isTrustedPeer, requestOrigin } from '../src/middlewares/RealIp.js';
import { MemoryThrottleStore, ThrottleMiddleware } from '../src/middlewares/Throttle.js';

const SOCKET = '203.0.113.9';
const SPOOF = '198.51.100.66';

function realIp(trustProxy: unknown) {
  const mw = new RealIp();
  Object.defineProperty(mw, 'Configuration', { value: { get: (path: string, def?: unknown) => (path === 'http.trustProxy' ? trustProxy : def) } });
  return mw;
}

function fakeReq(xff?: string | string[], socket: string | undefined = SOCKET, extra: Record<string, unknown> = {}) {
  return { headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: socket }, storage: {} as Record<string, unknown>, ...extra } as any;
}

describe('trusted client address (RealIp)', () => {
  describe('parseTrustProxy', () => {
    const at = (v: unknown) => trustedClientAddress(SOCKET, '192.0.2.1, 192.0.2.2', parseTrustProxy(v, 'http.trustProxy'));

    it('null, undefined, false and 0 trust no proxy', () => {
      for (const v of [null, undefined, false, 0]) expect(at(v), String(v)).to.eq(SOCKET);
    });

    it('true is one hop, never trust-all', () => {
      expect(at(true)).to.eq('192.0.2.2');
    });

    it('a number is a hop count', () => {
      expect(at(1)).to.eq('192.0.2.2');
      expect(at(2)).to.eq('192.0.2.1');
    });

    it('a string is a comma-separated list; arrays take addresses, CIDRs and the express names', () => {
      expect(at(`${SOCKET}, 192.0.2.2`)).to.eq('192.0.2.1');
      expect(at(['203.0.113.0/24'])).to.eq('192.0.2.2');
      expect(trustedClientAddress('127.0.0.1', '10.1.2.3, 192.168.0.4', parseTrustProxy(['loopback', 'uniquelocal'], 'k'))).to.eq('10.1.2.3');
      expect(trustedClientAddress('169.254.1.1', SPOOF, parseTrustProxy('linklocal', 'k'))).to.eq(SPOOF);
    });

    it('throws InvalidOption naming the key for a bad value or entry', () => {
      for (const v of [-1, 1.5, Number.NaN, 'not-an-ip', ['10.0.0.0/33'], ['::1/129'], ['10.0.0.0/x'], ['1.2.3.4', 'x'], {}, () => 1]) {
        expect(() => parseTrustProxy(v, 'authn.http.trustProxy'), JSON.stringify(v) ?? String(v))
          .to.throw(InvalidOption)
          .with.property('message')
          .that.contains('authn.http.trustProxy');
      }
    });
  });

  describe('trustedClientAddress', () => {
    const hops = (n: number) => parseTrustProxy(n, 'k');

    it('without trust is the socket address, whatever X-Forwarded-For says', () => {
      expect(trustedClientAddress(SOCKET, SPOOF, hops(0))).to.eq(SOCKET);
    });

    it('a hop count takes the entry that many steps from the socket: spoofed entries left of it are ignored', () => {
      expect(trustedClientAddress(SOCKET, `${SPOOF}, 192.0.2.1`, hops(1))).to.eq('192.0.2.1');
      expect(trustedClientAddress(SOCKET, `198.51.100.1, ${SPOOF}`, hops(1))).to.eq(SPOOF);
    });

    it('a hop count larger than the chain gives the farthest address', () => {
      expect(trustedClientAddress(SOCKET, '192.0.2.1, 192.0.2.2', hops(5))).to.eq('192.0.2.1');
      expect(trustedClientAddress(SOCKET, undefined, hops(3))).to.eq(SOCKET);
    });

    it('a CIDR list walks from the socket while the address is trusted', () => {
      const trust = parseTrustProxy(['203.0.113.0/24', '10.0.0.0/8'], 'k');
      expect(trustedClientAddress(SOCKET, `${SPOOF}, 192.0.2.1, 10.0.0.5`, trust)).to.eq('192.0.2.1');
      expect(trustedClientAddress('192.0.2.200', `${SPOOF}`, trust), 'an untrusted socket is the client').to.eq('192.0.2.200');
      expect(trustedClientAddress(SOCKET, '10.0.0.1, 10.0.0.2', trust), 'all trusted: the farthest').to.eq('10.0.0.1');
    });

    it('an entry that is not an IP stops the walk; a non-IP is never returned', () => {
      expect(trustedClientAddress(SOCKET, `${SPOOF}, evil.example`, hops(2))).to.eq(SOCKET);
      expect(trustedClientAddress(SOCKET, `${SPOOF}, 192.0.2.1:8080, 192.0.2.2`, hops(3))).to.eq('192.0.2.2');
      expect(trustedClientAddress(SOCKET, `${SPOOF}, , 192.0.2.2`, hops(3))).to.eq('192.0.2.2');
      expect(trustedClientAddress(SOCKET, '<script>', parseTrustProxy([SOCKET], 'k'))).to.eq(SOCKET);
      expect(trustedClientAddress('not-an-ip', SPOOF, hops(1))).to.eq(undefined);
      expect(trustedClientAddress(undefined, SPOOF, hops(1))).to.eq(undefined);
    });

    it('an empty header leaves the socket address', () => {
      expect(trustedClientAddress(SOCKET, '', hops(1))).to.eq(SOCKET);
      expect(trustedClientAddress(SOCKET, '  ', parseTrustProxy([SOCKET], 'k'))).to.eq(SOCKET);
    });

    it('handles IPv6', () => {
      const trust = parseTrustProxy(['2001:db8::/32'], 'k');
      expect(trustedClientAddress('2001:db8::1', '2001:db8:ffff::1, 2001:db8::2', trust)).to.eq('2001:db8:ffff::1');
      expect(trustedClientAddress('2001:db8::1', '2001:4860::8888, 2001:db8::2', trust)).to.eq('2001:4860::8888');
      expect(trustedClientAddress('::1', '2001:4860::8888', hops(1))).to.eq('2001:4860::8888');
    });

    it('normalises IPv4-mapped IPv6 for matching and output', () => {
      expect(trustedClientAddress(`::ffff:${SOCKET}`, SPOOF, hops(0))).to.eq(SOCKET);
      expect(trustedClientAddress(`::ffff:${SOCKET}`, `::ffff:${SPOOF}`, parseTrustProxy(['203.0.113.0/24'], 'k'))).to.eq(SPOOF);
      expect(trustedClientAddress(SOCKET, SPOOF, parseTrustProxy([`::ffff:${SOCKET}`], 'k'))).to.eq(SPOOF);
    });

    it('joins several X-Forwarded-For headers with a comma', () => {
      expect(trustedClientAddress(SOCKET, [`${SPOOF}, 192.0.2.1`, '192.0.2.2'], hops(2))).to.eq('192.0.2.1');
    });
  });

  describe('isTrustedPeer and requestOrigin', () => {
    const origin = (trust: unknown, headers: Record<string, string>, socket = SOCKET, encrypted = false) =>
      requestOrigin({ headers: { host: 'app.example.test', ...headers }, socket: { remoteAddress: socket, encrypted } } as any, parseTrustProxy(trust, 'k'));

    it('a hop count trusts the peer, a list trusts a listed peer, none trusts nobody', () => {
      expect(isTrustedPeer(parseTrustProxy(0, 'k'), SOCKET)).to.eq(false);
      expect(isTrustedPeer(parseTrustProxy(1, 'k'), SOCKET)).to.eq(true);
      expect(isTrustedPeer(parseTrustProxy(['203.0.113.0/24'], 'k'), `::ffff:${SOCKET}`)).to.eq(true);
      expect(isTrustedPeer(parseTrustProxy(['10.0.0.0/8'], 'k'), SOCKET)).to.eq(false);
      expect(isTrustedPeer(parseTrustProxy(1, 'k'), undefined)).to.eq(false);
    });

    it('takes X-Forwarded-Proto and -Host (first value) only from a trusted peer', () => {
      const fwd = { 'x-forwarded-proto': 'HTTPS, http', 'x-forwarded-host': 'Public.Example.Test, inner' };
      expect(origin(1, fwd)).to.eq('https://public.example.test');
      expect(origin(null, fwd)).to.eq('http://app.example.test');
      expect(origin(['10.0.0.0/8'], fwd)).to.eq('http://app.example.test');
      expect(origin(null, {}, SOCKET, true)).to.eq('https://app.example.test');
      expect(origin(1, { 'x-forwarded-proto': 'gopher' })).to.eq('http://app.example.test');
    });
  });

  describe('RealIp middleware', () => {
    it('SR-03 RealIp ignores a client-set X-Forwarded-For', () => {
      const req = fakeReq(SPOOF);
      const next = sinon.spy();
      realIp(undefined).before()(req, {} as any, next);
      expect(req.storage.realIp).to.eq(SOCKET);
      expect(next.calledOnce).to.eq(true);
    });

    it('honours http.trustProxy', () => {
      const req = fakeReq(`${SPOOF}, 192.0.2.1`);
      realIp(1).before()(req, {} as any, () => undefined);
      expect(req.storage.realIp).to.eq('192.0.2.1');
    });

    it('a bad http.trustProxy fails when the middleware is built', () => {
      expect(() => realIp('nope').before()).to.throw(InvalidOption, 'http.trustProxy');
    });
  });

  describe('ThrottleMiddleware key', () => {
    function throttle(limit: number) {
      const mw = new ThrottleMiddleware();
      const cfg = { enabled: true, rules: [{ path: '/auth', methods: ['POST'], limit, windowSeconds: 60 }] };
      Object.defineProperty(mw, 'Configuration', { value: { get: (path: string, def?: unknown) => (path === 'http.throttle' ? cfg : def) } });
      Object.defineProperty(mw, 'Store', { value: new MemoryThrottleStore() });
      Object.defineProperty(mw, 'Log', { value: { warn: sinon.stub() } });
      return mw.before()!;
    }

    function hit(handler: (req: any, res: any, next: any) => void, req: any): Promise<number> {
      return new Promise((resolve) => {
        const res = {
          set: () => res,
          status: (code: number) => ({ json: () => resolve(code) }),
        };
        handler(req, res, () => resolve(200));
      });
    }

    it('SR-03 the throttle ignores a spoofed X-Forwarded-For', async () => {
      const ip = realIp(null).before();
      const limited = throttle(3);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const req = fakeReq(`198.51.100.${i + 1}`, SOCKET, { path: '/auth/login', method: 'POST', ip: `198.51.100.${i + 1}` });
        ip(req, {} as any, () => undefined);
        statuses.push(await hit(limited, req));
      }
      expect(statuses).to.deep.eq([200, 200, 200, 429, 429]);
    });

    it('without realIp keys on the socket address, never on req.ip', async () => {
      const limited = throttle(1);
      const a = { path: '/auth', method: 'POST', ip: '198.51.100.1', socket: { remoteAddress: SOCKET }, storage: {} };
      const b = { path: '/auth', method: 'POST', ip: '198.51.100.2', socket: { remoteAddress: SOCKET }, storage: {} };
      expect(await hit(limited, a)).to.eq(200);
      expect(await hit(limited, b)).to.eq(429);
    });

    it('matches a rule path on a segment boundary', async () => {
      const limited = throttle(1);
      const at = (path: string) => ({ path, method: 'POST', socket: { remoteAddress: SOCKET }, storage: { realIp: SOCKET } });
      expect(await hit(limited, at('/authority'))).to.eq(200);
      expect(await hit(limited, at('/authority'))).to.eq(200);
      expect(await hit(limited, at('/auth/login'))).to.eq(200);
      expect(await hit(limited, at('/auth'))).to.eq(429);
    });
  });
});
