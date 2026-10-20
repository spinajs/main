import 'mocha';
import { expect } from 'chai';

import { HTTP_PUBLIC_COOKIE_SECRET, clearCookie, hostPrefixedCookie, isPublicCookieSecret } from '../src/index.js';
// The built config: ts-node's type check rejects the default helmet import that the build accepts.
import httpConfig from '../lib/mjs/config/http.js';

describe('public cookie secret', () => {
  it('is the secret the default config ships', () => {
    expect(httpConfig.http.cookie.secret).to.eq(HTTP_PUBLIC_COOKIE_SECRET);
  });

  it('isPublicCookieSecret matches only that value', () => {
    expect(isPublicCookieSecret(HTTP_PUBLIC_COOKIE_SECRET)).to.eq(true);
    for (const secret of [undefined, null, '', 'my own secret', ` ${HTTP_PUBLIC_COOKIE_SECRET}`]) {
      expect(isPublicCookieSecret(secret)).to.eq(false);
    }
  });
});

describe('hostPrefixedCookie', () => {
  it('outside development and test: __Host- prefix, Secure, Path=/ and no Domain', () => {
    for (const env of [undefined, null, '', 'production', 'prod', 'staging']) {
      const c = hostPrefixedCookie('flow', 'v', { httpOnly: true, sameSite: 'lax', maxAge: 1000, domain: 'example.com', path: '/x', secure: false }, env);
      expect(c.Name, String(env)).to.eq('__Host-flow');
      expect(c.Value).to.eq('v');
      expect(c.Options).to.deep.eq({ httpOnly: true, sameSite: 'lax', maxAge: 1000, secure: true, path: '/', domain: undefined });
    }
  });

  it('in development and test: no prefix and no Secure', () => {
    for (const env of ['development', 'dev', 'test']) {
      const c = hostPrefixedCookie('flow', 'v', { httpOnly: true }, env);
      expect(c.Name, env).to.eq('flow');
      expect(c.Options).to.deep.eq({ httpOnly: true, secure: false, path: '/', domain: undefined });
    }
  });

  it('keeps an own domain key set to undefined, so it overrides http.cookie.options.domain', () => {
    expect(Object.prototype.hasOwnProperty.call(hostPrefixedCookie('a', 'b').Options, 'domain')).to.eq(true);
  });
});

describe('clearCookie', () => {
  it('expires the cookie under the same name and options, unsigned and empty', () => {
    const issued = hostPrefixedCookie('ssid', 'raw', { httpOnly: true, sameSite: 'strict', maxAge: 60_000, signed: true }, 'production');
    expect(clearCookie(issued)).to.deep.eq({
      Name: '__Host-ssid',
      Value: '',
      Options: { httpOnly: true, sameSite: 'strict', maxAge: 0, signed: false, secure: true, path: '/', domain: undefined },
    });
    expect(issued.Value).to.eq('raw');
  });
});
