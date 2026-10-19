import 'mocha';
import { expect } from 'chai';
import { parseTrustProxy } from '@spinajs/http';
import type { ProxyTrust, Request } from '@spinajs/http';

import { OidcController } from '../src/controllers/OidcController.js';
import { fakeContainer, readingFrom } from './support/config-boot.js';

describe('authn-oidc request origin', () => {
  class Probe extends OidcController {
    protected override get env(): string {
      return 'test';
    }

    public origin(req: Request): string {
      return this.originOf(req);
    }
  }

  const request = (proxyTrust: ProxyTrust | undefined, peer = '10.0.0.5') =>
    ({
      headers: { host: 'App.Example.Test', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'public.example.test' },
      socket: { remoteAddress: peer },
      storage: proxyTrust === undefined ? {} : { proxyTrust },
    }) as unknown as Request;

  const origin = (proxyTrust: ProxyTrust | undefined, peer?: string) => readingFrom(new Probe(), fakeContainer({})).origin(request(proxyTrust, peer));

  it('ignores forwarded headers without the trust RealIp stored for the request', () => {
    expect(origin(undefined)).to.eq('http://app.example.test');
    expect(origin(parseTrustProxy(null, 'http.trustProxy'))).to.eq('http://app.example.test');
  });

  it('takes X-Forwarded-Proto and -Host from a peer the stored trust names', () => {
    expect(origin(parseTrustProxy('10.0.0.0/8', 'http.trustProxy'))).to.eq('https://public.example.test');
    expect(origin(parseTrustProxy('10.0.0.0/8', 'http.trustProxy'), '203.0.113.9')).to.eq('http://app.example.test');
  });
});
