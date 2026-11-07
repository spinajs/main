import * as chai from 'chai';
import 'mocha';

import { ipv6PrefixOf } from '../../src/contracts/index.js';
import { clientAddressFindings } from '../../src/service/boot/index.js';
import { buildCore } from '../behaviour/harness.js';
import { TestLog, useTestLog } from '../audit/test-log.js';

const expect = chai.expect;

type Values = Record<string, unknown>;

function source(values: Values): { get<T>(path: string | string[]): T } {
  return {
    get<T>(path: string | string[]): T {
      const parts = Array.isArray(path) ? path : path.split('.');
      return parts.reduce<unknown>((n, k) => (n !== null && typeof n === 'object' ? (n as Values)[k] : undefined), values) as T;
    },
  };
}

const trust = (authnTrust: unknown, httpTrust: unknown) => clientAddressFindings(source({ authn: { http: { trustProxy: authnTrust } }, http: { trustProxy: httpTrust } }));
const prefixes = (authnPrefix: unknown, httpPrefix: unknown) => clientAddressFindings(source({ authn: { throttle: { ipv6Prefix: authnPrefix } }, http: { throttle: { ipv6Prefix: httpPrefix } } }));

describe('one client address (authn.http.trustProxy, authn.throttle.ipv6Prefix)', () => {
  describe('ipv6PrefixOf', () => {
    it('takes authn.throttle.ipv6Prefix, else http.throttle.ipv6Prefix, else 64', () => {
      expect(ipv6PrefixOf(56, 48)).to.eq(56);
      expect(ipv6PrefixOf(undefined, 48)).to.eq(48);
      expect(ipv6PrefixOf(null, 48)).to.eq(48);
      expect(ipv6PrefixOf(undefined, undefined)).to.eq(64);
      expect(ipv6PrefixOf(undefined)).to.eq(64);
      expect(ipv6PrefixOf('56', '48')).to.eq(64);
    });
  });

  describe('clientAddressFindings', () => {
    it('says nothing when at most one trust key is set', () => {
      expect(trust(undefined, undefined)).to.deep.eq([]);
      expect(trust(2, null)).to.deep.eq([]);
      expect(trust(null, ['10.0.0.0/8'])).to.deep.eq([]);
    });

    it('says nothing when both trust keys say the same, however spelled', () => {
      expect(trust(1, 1)).to.deep.eq([]);
      expect(trust(true, 1)).to.deep.eq([]);
      expect(trust(0, false)).to.deep.eq([]);
      expect(trust(['10.0.0.0/8', 'loopback'], '10.0.0.0/8, loopback')).to.deep.eq([]);
      expect(trust([' 10.0.0.0/8 '], ['10.0.0.0/8'])).to.deep.eq([]);
      expect(trust(['loopback', '10.0.0.0/8'], ['10.0.0.0/8', '::1/128', '127.0.0.0/8'])).to.deep.eq([]);
    });

    it('warns when both trust keys are set and differ, naming authn.http.trustProxy as the one that counts', () => {
      for (const [a, h] of [
        [2, 1],
        [0, 1],
        [['10.0.0.0/8'], 1],
        [['10.0.0.0/8'], ['192.168.0.0/16']],
      ] as const) {
        const findings = trust(a, h);
        expect(findings.map((f) => `${f.topic}:${f.level}`), JSON.stringify([a, h])).to.deep.eq(['proxy:warning']);
        expect(findings[0].message).to.contain('authn.http.trustProxy').and.contain('http.trustProxy').and.contain('wins');
      }
    });

    it('says nothing when the prefixes agree or only http.throttle.ipv6Prefix is set', () => {
      expect(prefixes(undefined, undefined)).to.deep.eq([]);
      expect(prefixes(undefined, 48)).to.deep.eq([]);
      expect(prefixes(48, 48)).to.deep.eq([]);
      expect(prefixes(64, undefined)).to.deep.eq([]);
    });

    it('warns when authn.throttle.ipv6Prefix differs from the prefix the http limiters count', () => {
      for (const [a, h] of [
        [56, 64],
        [56, undefined],
        [64, 48],
      ] as const) {
        const findings = prefixes(a, h);
        expect(findings.map((f) => `${f.topic}:${f.level}`), JSON.stringify([a, h])).to.deep.eq(['throttle:warning']);
        expect(findings[0].message).to.contain('authn.throttle.ipv6Prefix').and.contain('http.throttle.ipv6Prefix');
      }
    });
  });

  describe('at boot', function () {
    this.timeout(30000);
    useTestLog();

    it('DefaultAuthnService logs each conflict as a warning on authn-boot', async () => {
      const p = await buildCore({}, { strategies: [], raw: { http: { trustProxy: 1, throttle: { ipv6Prefix: 64 } }, authn: { http: { trustProxy: 2 }, throttle: { ipv6Prefix: 56 } } } });
      await p.dispose();
      const warnings = TestLog.of('authn-boot').filter((e) => e.level === 'warn' && typeof e.message === 'string');
      expect(warnings.filter((e) => e.message.includes('authn.http.trustProxy'))).to.have.length(1);
      expect(warnings.filter((e) => e.message.includes('authn.throttle.ipv6Prefix'))).to.have.length(1);
    });

    it('logs nothing about the client address when the settings agree', async () => {
      const p = await buildCore({}, { strategies: [], raw: { http: { trustProxy: 1 }, authn: { http: { trustProxy: 1 } } } });
      await p.dispose();
      const warnings = TestLog.of('authn-boot').filter((e) => e.level === 'warn' && typeof e.message === 'string');
      expect(warnings.filter((e) => e.message.includes('trustProxy') || e.message.includes('ipv6Prefix'))).to.deep.eq([]);
    });
  });
});
