import 'mocha';
import { expect } from 'chai';

import { requestOrigin, trustedPeer } from '../src/origin.js';

const facts = (over: Partial<Parameters<typeof requestOrigin>[0]> = {}) => ({ encrypted: false, peer: '10.0.0.5', host: 'app.example.test', forwardedProto: 'https', forwardedHost: 'public.example.test', ...over });

describe('authn-oidc request origin', () => {
  it('ignores forwarded headers without a trusted proxy', () => {
    for (const setting of [undefined, null, false, 0, []] as const) {
      expect(requestOrigin(facts(), trustedPeer(setting as never)), String(setting)).to.eq('http://app.example.test');
    }
    expect(requestOrigin(facts({ encrypted: true }), trustedPeer(null))).to.eq('https://app.example.test');
  });

  it('takes the first forwarded proto and host from a trusted peer', () => {
    for (const setting of [true, 1, 2, '10.0.0.0/8', ['10.0.0.5'], 'uniquelocal', 'loopback, 10.0.0.0/8'] as const) {
      expect(requestOrigin(facts({ forwardedProto: 'https, http', forwardedHost: 'public.example.test, inner' }), trustedPeer(setting as never)), String(setting)).to.eq('https://public.example.test');
    }
  });

  it('does not trust a peer outside the listed ranges, and reads IPv4-mapped peers', () => {
    expect(requestOrigin(facts({ peer: '203.0.113.9' }), trustedPeer('10.0.0.0/8'))).to.eq('http://app.example.test');
    expect(requestOrigin(facts({ peer: '::ffff:10.0.0.5' }), trustedPeer('10.0.0.0/8'))).to.eq('https://public.example.test');
    expect(requestOrigin(facts({ peer: '::1' }), trustedPeer('loopback'))).to.eq('https://public.example.test');
    expect(requestOrigin(facts({ peer: undefined }), trustedPeer('10.0.0.0/8'))).to.eq('http://app.example.test');
  });

  it('keeps only http or https as the scheme, and falls back to the Host header', () => {
    expect(requestOrigin(facts({ forwardedProto: 'javascript' }), trustedPeer(true))).to.eq('http://public.example.test');
    expect(requestOrigin(facts({ forwardedHost: undefined }), trustedPeer(true))).to.eq('https://app.example.test');
    expect(requestOrigin(facts({ forwardedProto: 'HTTPS' }), trustedPeer(true))).to.eq('https://public.example.test');
  });

  it('refuses a trust entry that is no address', () => {
    expect(() => trustedPeer('10.0.0.0/8, not-an-ip')).to.throw();
    expect(() => trustedPeer(['10.0.0.0/abc'])).to.throw();
  });
});
