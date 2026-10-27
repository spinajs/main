import 'mocha';
import { expect } from 'chai';
import { InvalidOption } from '@spinajs/exceptions';
import { isTrustedPeer, parseTrustProxy } from '@spinajs/http';

import { OidcController } from '../src/controllers/OidcController.js';
import { checkedRequestOrigin, requestOrigin } from '../src/origin.js';
import { OidcProviders } from '../src/providers.js';
import { readOidcOptions } from './support/oidc-config.js';
import { recordingLog } from './support/recording-log.js';
import { fakeContainer, readingFrom } from '@spinajs/testing';

const trusted = (setting: unknown) => {
  const trust = parseTrustProxy(setting, 'http.trustProxy');
  return (peer: string | undefined) => isTrustedPeer(trust, peer);
};

const facts = (over: Partial<Parameters<typeof requestOrigin>[0]> = {}) => ({ encrypted: false, peer: '10.0.0.5', host: 'app.example.test', forwardedProto: 'https', forwardedHost: 'public.example.test', ...over });

describe('authn-oidc request origin', () => {
  it('ignores forwarded headers without a trusted proxy', () => {
    for (const setting of [undefined, null, false, 0, []] as const) {
      expect(requestOrigin(facts(), trusted(setting)), String(setting)).to.eq('http://app.example.test');
    }
    expect(requestOrigin(facts({ encrypted: true }), trusted(null))).to.eq('https://app.example.test');
  });

  it('takes the first forwarded proto and host from a trusted peer', () => {
    for (const setting of [true, 1, 2, '10.0.0.0/8', ['10.0.0.5'], 'uniquelocal', 'loopback, 10.0.0.0/8'] as const) {
      expect(requestOrigin(facts({ forwardedProto: 'https, http', forwardedHost: 'public.example.test, inner' }), trusted(setting)), String(setting)).to.eq('https://public.example.test');
    }
  });

  it('does not trust a peer outside the listed ranges, and reads IPv4-mapped peers', () => {
    expect(requestOrigin(facts({ peer: '203.0.113.9' }), trusted('10.0.0.0/8'))).to.eq('http://app.example.test');
    expect(requestOrigin(facts({ peer: '::ffff:10.0.0.5' }), trusted('10.0.0.0/8'))).to.eq('https://public.example.test');
    expect(requestOrigin(facts({ peer: '::1' }), trusted('loopback'))).to.eq('https://public.example.test');
    expect(requestOrigin(facts({ peer: undefined }), trusted('10.0.0.0/8'))).to.eq('http://app.example.test');
    expect(requestOrigin(facts({ peer: undefined }), trusted(1)), 'a hop count needs a peer that is an address').to.eq('http://app.example.test');
  });

  it('keeps only http or https as the scheme, and falls back to the Host header', () => {
    expect(requestOrigin(facts({ forwardedProto: 'javascript' }), trusted(true))).to.eq('http://public.example.test');
    expect(requestOrigin(facts({ forwardedHost: undefined }), trusted(true))).to.eq('https://app.example.test');
    expect(requestOrigin(facts({ forwardedProto: 'HTTPS' }), trusted(true))).to.eq('https://public.example.test');
  });

  describe('checkedRequestOrigin', () => {
    it('is the serialized origin of a well-formed Host or trusted X-Forwarded-Host', () => {
      expect(checkedRequestOrigin(facts({ host: 'App.Example.Test:443' }), trusted(null))).to.eq('http://app.example.test:443');
      expect(checkedRequestOrigin(facts({ encrypted: true, host: 'app.example.test:443' }), trusted(null))).to.eq('https://app.example.test');
      expect(checkedRequestOrigin(facts(), trusted(true))).to.eq('https://public.example.test');
      expect(checkedRequestOrigin(facts({ host: '[::1]:8080' }), trusted(null))).to.eq('http://[::1]:8080');
    });

    it('is undefined for a forged Host that is no authority: a path, credentials, a bad port, nothing', () => {
      for (const host of ['evil.example/x', 'evil.example?x', 'evil.example#x', 'user@evil.example', 'evil.example\\x', '*.example', 'evil.example:99999', '[::1', '', undefined]) {
        expect(checkedRequestOrigin(facts({ host }), trusted(null)), String(host)).to.eq(undefined);
      }
    });

    it('ignores X-Forwarded-Host from an untrusted peer, and refuses a junk one from a trusted peer', () => {
      expect(checkedRequestOrigin(facts({ forwardedHost: 'evil.example/x' }), trusted(null)), 'untrusted: Host counts').to.eq('http://app.example.test');
      expect(checkedRequestOrigin(facts({ peer: '203.0.113.9', forwardedHost: 'evil.example' }), trusted('10.0.0.0/8'))).to.eq('http://app.example.test');
      expect(checkedRequestOrigin(facts({ forwardedHost: 'evil.example/x, inner' }), trusted(true))).to.eq(undefined);
      expect(checkedRequestOrigin(facts({ forwardedHost: 'a@evil.example' }), trusted(true))).to.eq(undefined);
    });

    it('is undefined when a header it reads is longer than 2048 characters, even one it would not use', () => {
      expect(checkedRequestOrigin(facts({ host: `${'a'.repeat(2049)}.example` }), trusted(null))).to.eq(undefined);
      expect(checkedRequestOrigin(facts({ forwardedHost: 'a'.repeat(2049) }), trusted(null))).to.eq(undefined);
    });
  });

  it('refuses a trust entry that is no address', () => {
    expect(() => trusted('10.0.0.0/8, not-an-ip')).to.throw(InvalidOption);
    expect(() => trusted(['10.0.0.0/abc'])).to.throw(InvalidOption);
  });

  describe('OidcProviders boot warning', () => {
    class Probe extends OidcProviders {
      public warnings(): string[] {
        this.warnRequestOrigins();
        return this.lines;
      }
      public readonly lines: string[] = [];
    }
    const generic = (over: Record<string, unknown> = {}) => ({ issuer: 'https://idp.example.test/realms/corp', clientId: 'canvas', clientSecret: { secret: 'S'.repeat(32) }, ...over });
    const providersWith = (env: string | undefined, publicOrigin: string | null, providers: Record<string, unknown>) => {
      const p = readingFrom(new Probe(), fakeContainer({ 'authn.http.publicOrigin': publicOrigin }));
      Object.defineProperty(p, 'Log', { value: recordingLog(p.lines) });
      p.env = env;
      p.options = readOidcOptions({ providers }, env);
      return p;
    };

    it('warns in production for each provider whose redirect URI comes from the request Host', () => {
      const lines = providersWith(undefined, null, { corp: generic(), fixed: generic({ redirectUri: 'https://app.example.test/cb' }) }).warnings();
      expect(lines).to.have.length(1);
      expect(lines[0]).to.contain('corp').and.contain('authn.http.publicOrigin').and.contain('redirectUri');
    });

    it('says nothing with authn.http.publicOrigin, with every redirectUri set, or in development and test', () => {
      expect(providersWith(undefined, 'https://app.example.test', { corp: generic() }).warnings()).to.deep.eq([]);
      expect(providersWith('production', null, { corp: generic({ redirectUri: 'https://app.example.test/cb' }) }).warnings()).to.deep.eq([]);
      expect(providersWith('test', null, { corp: generic() }).warnings()).to.deep.eq([]);
    });
  });

  describe('OidcController', () => {
    class Probe extends OidcController {
      public trusts(peer: string): boolean {
        return this.peerTrust()(peer);
      }
    }
    const controller = (own: unknown, shared: unknown) => readingFrom(new Probe(), fakeContainer({ 'authn.http.trustProxy': own, 'http.trustProxy': shared }));

    it('reads authn.http.trustProxy, else http.trustProxy, as ClientIp and the CSRF guard do', () => {
      expect(controller(null, '10.0.0.0/8').trusts('10.0.0.5')).to.eq(true);
      expect(controller(undefined, ['10.0.0.0/8']).trusts('10.0.0.5')).to.eq(true);
      expect(controller(['192.0.2.1'], '10.0.0.0/8').trusts('10.0.0.5'), 'the own setting wins over the shared one').to.eq(false);
      expect(controller([], 1).trusts('10.0.0.5'), 'an empty own list trusts no proxy').to.eq(false);
      expect(controller(0, 1).trusts('10.0.0.5'), '0 hops trusts no proxy').to.eq(false);
      expect(controller(undefined, undefined).trusts('10.0.0.5')).to.eq(false);
      expect(controller(1, undefined).trusts('10.0.0.5')).to.eq(true);
    });

    it('refuses a trust entry that is no address, naming the key it came from', () => {
      expect(() => controller(['not-an-ip'], null).trusts('10.0.0.5')).to.throw(InvalidOption, 'authn.http.trustProxy');
      expect(() => controller(null, 'not-an-ip').trusts('10.0.0.5')).to.throw(InvalidOption, 'http.trustProxy');
    });

    describe('origin warnings', () => {
      class Warner extends OidcController {
        public readonly lines: string[] = [];
        public start(provider: string, host: string, forwardedHost?: string): string | undefined {
          const f = { host, forwardedHost, forwardedProto: forwardedHost === undefined ? undefined : 'https', connection: { encrypted: true, peer: '10.0.0.5', clientIp: undefined }, session: null };
          this.warnFlowCookieHost(provider, f);
          return this.originOf(f);
        }
      }
      const warner = (o: { env?: string; publicOrigin?: string | null; trust?: unknown; redirectUri?: string | null }) => {
        const c = readingFrom(new Warner(), fakeContainer({ 'authn.http.trustProxy': o.trust ?? null, 'http.trustProxy': null, 'authn.http.publicOrigin': o.publicOrigin ?? null }));
        const strategies = new Map([['corp', { provider: { options: { redirectUri: o.redirectUri ?? null } } }]]);
        Object.defineProperty(c, 'Providers', { value: { env: o.env, strategies: () => strategies } });
        Object.defineProperty(c, 'Log', { value: recordingLog(c.lines) });
        return c;
      };

      it('warns once when a flow starts on another host than authn.http.publicOrigin: the host-only flow cookie misses the callback', () => {
        const c = warner({ env: 'test', publicOrigin: 'https://app.example.test' });
        expect(c.start('corp', 'other.example.test')).to.eq('https://app.example.test');
        c.start('corp', 'third.example.test');
        expect(c.lines).to.have.length(1);
        expect(c.lines[0]).to.contain('corp').and.contain('https://other.example.test').and.contain('https://app.example.test').and.contain('flow cookie').and.contain('redirectUri');
      });

      it('says nothing for the same host (scheme and port aside), a trusted X-Forwarded-Host on it, a provider redirectUri, no publicOrigin or a Host that is no origin', () => {
        const same = warner({ publicOrigin: 'https://app.example.test', trust: 1 });
        same.start('corp', 'app.example.test');
        same.start('corp', 'app.example.test:8080');
        same.start('corp', 'backend:3000', 'app.example.test');
        expect(same.lines).to.deep.eq([]);
        const other = warner({ publicOrigin: 'https://app.example.test', redirectUri: 'https://login.example.test/cb' });
        other.start('corp', 'other.example.test');
        other.start('unknown', 'other.example.test');
        expect(other.lines, 'the callback is not on publicOrigin, or no such provider').to.deep.eq([]);
        const junk = warner({ publicOrigin: 'https://app.example.test' });
        junk.start('corp', 'evil.example/x');
        expect(junk.lines).to.deep.eq([]);
        const none = warner({ env: 'test' });
        none.start('corp', 'other.example.test');
        expect(none.lines).to.deep.eq([]);
      });

      it('warns once in production for an http authn.http.publicOrigin, as for an http request origin', () => {
        const c = warner({ publicOrigin: 'http://app.example.test' });
        c.start('corp', 'app.example.test');
        c.start('corp', 'app.example.test');
        expect(c.lines).to.have.length(1);
        expect(c.lines[0]).to.contain('authn.http.publicOrigin').and.contain('http origin');
        const relaxed = warner({ env: 'development', publicOrigin: 'http://app.example.test' });
        relaxed.start('corp', 'app.example.test');
        expect(relaxed.lines).to.deep.eq([]);
      });
    });
  });
});
