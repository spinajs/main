import { expect } from 'chai';
import { DateTime } from 'luxon';
import { clearSessionCookie, hashSessionId, sessionCookie, sessionCookieMaxAge, sessionCookieName, sessionCookieOptions, UserSession } from '../src/index.js';

describe('sessionCookieMaxAge', () => {
  it('derives cookie maxAge (ms) from the session Expiration relative to now (B1)', () => {
    const session = new UserSession();
    session.Expiration = DateTime.now().plus({ minutes: 120 });

    const maxAge = sessionCookieMaxAge(session);

    // ~120 minutes in ms, allow a little slack for execution time
    expect(maxAge).to.be.a('number');
    expect(maxAge!).to.be.greaterThan(119 * 60 * 1000);
    expect(maxAge!).to.be.at.most(120 * 60 * 1000);
  });

  it('returns undefined when the session never expires (no Expiration)', () => {
    const session = new UserSession();
    session.Expiration = undefined;

    expect(sessionCookieMaxAge(session)).to.be.undefined;
  });

  it('clamps to 0 for an already-expired session (never negative)', () => {
    const session = new UserSession();
    session.Expiration = DateTime.now().minus({ minutes: 5 });

    expect(sessionCookieMaxAge(session)).to.equal(0);
  });
});

describe('session cookie attributes', () => {
  const live = () => {
    const s = new UserSession();
    s.Expiration = DateTime.now().plus({ minutes: 30 });
    return s;
  };

  it('is Secure, HttpOnly and SameSite=Strict with no configuration at all', () => {
    const options = sessionCookieOptions();

    expect(options.httpOnly).to.equal(true);
    expect(options.secure).to.equal(true);
    expect(options.sameSite).to.equal('strict');
  });

  it('cannot be downgraded to a javascript-readable cookie by configuration', () => {
    // the whole reason the flags are applied after the config spread: an app
    // config used to win over the hardening
    const options = sessionCookieOptions({ httpOnly: false } as any);

    expect(options.httpOnly).to.equal(true);
  });

  it('lets an application relax secure / sameSite deliberately', () => {
    const options = sessionCookieOptions({ secure: false, sameSite: 'lax' });

    expect(options.secure).to.equal(false);
    expect(options.sameSite).to.equal('lax');
  });

  it('passes unknown express options through', () => {
    const options = sessionCookieOptions({ path: '/app', priority: 'high' } as any);

    expect(options.path).to.equal('/app');
    expect(options.priority).to.equal('high');
  });

  it('defaults to the ssid name and honors a configured one', () => {
    expect(sessionCookieName()).to.equal('ssid');
    expect(sessionCookieName({ name: 'sid' })).to.equal('sid');
  });

  it('emits __Host- prefixed cookies with everything that prefix requires', () => {
    const cookie = sessionCookie(live(), { name: 'sid', hostPrefix: true, secure: false, domain: 'example.com' } as any);

    expect(cookie.Name).to.equal('__Host-sid');
    // browsers reject a __Host- cookie that is not secure, not rooted at / or
    // carries a Domain — so the prefix forces all three regardless of config
    expect(cookie.Options.secure).to.equal(true);
    expect(cookie.Options.path).to.equal('/');
    expect(cookie.Options).to.not.have.property('domain');
  });

  it('carries the session id, is signed, and expires with the session', () => {
    const session = live();
    const cookie = sessionCookie(session);

    expect(cookie.Value).to.equal(session.SessionId);
    expect(cookie.Options.signed).to.equal(true);
    expect(cookie.Options.maxAge).to.be.greaterThan(29 * 60 * 1000);
  });

  it('clears with an empty value and an immediate expiry, keeping the hardened flags', () => {
    const cookie = clearSessionCookie();

    expect(cookie.Value).to.equal('');
    expect(cookie.Options.maxAge).to.equal(0);
    expect(cookie.Options.httpOnly).to.equal(true);
    expect(cookie.Options.secure).to.equal(true);
  });
});

describe('shipped session cookie configuration', () => {
  /**
   * The config module reads NODE_ENV once, at import time, so each case needs a
   * fresh module instance — hence the cache-busting query on the specifier.
   */
  const loadConfig = async (nodeEnv: string | undefined, tag: string) => {
    const previous = process.env.NODE_ENV;

    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;

    try {
      const mod = await import(`../src/config/rbac.js?case=${tag}`);
      return mod.default.rbac.session.cookie;
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  };

  it('ships Secure cookies in production', async () => {
    const cookie = await loadConfig('production', 'prod');

    expect(cookie.secure, 'a deployment must never send the session cookie over plain http').to.equal(true);
  });

  it('relaxes Secure outside production so http://localhost can log in', async () => {
    const cookie = await loadConfig('development', 'dev');

    expect(cookie.secure).to.equal(false);
  });
});

describe('hashSessionId', () => {
  it('is stable for the same id and different for another', () => {
    expect(hashSessionId('abc')).to.equal(hashSessionId('abc'));
    expect(hashSessionId('abc')).to.not.equal(hashSessionId('abd'));
  });

  it('never contains the id itself — it is what goes into logs and API responses', () => {
    const id = 'da28df48-1f28-42f2-90fd-773502826497';
    const handle = hashSessionId(id);

    expect(handle).to.not.contain(id);
    expect(handle).to.match(/^[0-9a-f]{32}$/);
  });
});
