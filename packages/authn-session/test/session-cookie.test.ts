import { expect } from 'chai';
import { DateTime } from 'luxon';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { appEnvOf, assertSessionCookieSecret, clearSessionCookie, ISessionCookieConfig, PUBLIC_DEFAULT_COOKIE_SECRET, sessionCookie, sessionCookieMaxAge, sessionCookieName, sessionCookieOptions, UserSession } from '../src/index.js';
import shipped from '../src/config/session.js';
import { uncacheOwned, withSessionConfig } from './support.js';

const RAW_ID = 'kQ7c1d0yYcH1m3S2bA9x_w';
const in30 = () => DateTime.now().plus({ minutes: 30 });

/** Runs `fn` with NODE_ENV set to `value` (deleted when undefined), restoring it afterwards. */
function withNodeEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

/** App envs and whether the cookie must be Secure and `__Host-` prefixed there. */
const ENVS: [string | undefined, boolean][] = [
  ['production', true],
  ['prod', true],
  ['staging', true],
  ['development', false],
  ['dev', false],
  ['test', false],
  ['Development', true],
  ['qa-eu-1', true],
  ['', true],
  [undefined, true],
];

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
  it('is Secure, HttpOnly and SameSite=Strict with no configuration at all in production', () => {
    const options = sessionCookieOptions({}, undefined, 'production');

    expect(options.httpOnly).to.equal(true);
    expect(options.secure).to.equal(true);
    expect(options.sameSite).to.equal('strict');
  });

  it('cannot be downgraded to a javascript-readable cookie by configuration', () => {
    const options = sessionCookieOptions({ httpOnly: false } as any);

    expect(options.httpOnly).to.equal(true);
  });

  it('lets an application relax secure / sameSite deliberately', () => {
    for (const secure of [false, 'false'] as const) {
      const options = sessionCookieOptions({ secure, hostPrefix: false, sameSite: 'lax' }, undefined, 'production');

      expect(options.secure, String(secure)).to.equal(false);
      expect(options.sameSite).to.equal('lax');
    }
  });

  it('keeps Secure when only secure is relaxed, because the auto __Host- prefix requires it', () => {
    expect(sessionCookieOptions({ secure: false }, undefined, 'production').secure).to.equal(true);
    expect(sessionCookieName({ secure: false }, 'production')).to.equal('__Host-ssid');
  });

  it('lets an application force secure on in a relaxed env', () => {
    for (const secure of [true, 'true'] as const) {
      expect(sessionCookieOptions({ secure }, undefined, 'development').secure, String(secure)).to.equal(true);
    }
  });

  it('never hands the auto setting to express', () => {
    const options = sessionCookieOptions({ secure: 'auto', hostPrefix: 'auto' }, undefined, 'development');

    expect(options.secure).to.equal(false);
    expect(options).to.not.have.property('hostPrefix');
  });

  it('passes unknown express options through', () => {
    const options = sessionCookieOptions({ path: '/app', priority: 'high' } as any, undefined, 'development');

    expect(options.path).to.equal('/app');
    expect(options.priority).to.equal('high');
  });

  it('defaults to the ssid name and honors a configured one', () => {
    expect(sessionCookieName({ hostPrefix: false })).to.equal('ssid');
    expect(sessionCookieName({ hostPrefix: 'false' }, 'production')).to.equal('ssid');
    expect(sessionCookieName({}, 'development')).to.equal('ssid');
    expect(sessionCookieName({ name: 'sid', hostPrefix: false })).to.equal('sid');
    expect(sessionCookieName({ name: 'sid' }, 'production')).to.equal('__Host-sid');
  });

  it('emits __Host- prefixed cookies with everything that prefix requires', () => {
    for (const [hostPrefix, env] of [
      [true, 'development'],
      ['true', 'test'],
      ['auto', 'production'],
      [undefined, 'staging'],
    ] as [ISessionCookieConfig['hostPrefix'], string][]) {
      const cookie = sessionCookie(RAW_ID, { name: 'sid', hostPrefix, secure: false, domain: 'example.com' } as any, in30(), env);
      const label = `${String(hostPrefix)} in ${env}`;

      expect(cookie.Name, label).to.equal('__Host-sid');
      // browsers reject a __Host- cookie that is not secure, not rooted at / or
      // carries a Domain — so the prefix forces all three regardless of config
      expect(cookie.Options.secure, label).to.equal(true);
      expect(cookie.Options.path, label).to.equal('/');
      expect(cookie.Options, label).to.not.have.property('domain');
    }
  });

  it('carries the session id, is signed, and expires with the session', () => {
    const cookie = sessionCookie(RAW_ID, {}, in30());

    expect(cookie.Value).to.equal(RAW_ID);
    expect(cookie.Options.signed).to.equal(true);
    expect(cookie.Options.maxAge).to.be.greaterThan(29 * 60 * 1000);
  });

  it('clears with an empty value and an immediate expiry, keeping the hardened flags', () => {
    const cookie = clearSessionCookie({}, 'production');

    expect(cookie.Value).to.equal('');
    expect(cookie.Options.maxAge).to.equal(0);
    expect(cookie.Options.httpOnly).to.equal(true);
    expect(cookie.Options.secure).to.equal(true);
  });
});

describe('session cookie by app env', () => {
  for (const [env, strict] of ENVS) {
    it(`${JSON.stringify(env)}: ${strict ? '__Host-ssid, Secure' : 'ssid, not Secure'}, HttpOnly, SameSite=Strict`, () => {
      const name = strict ? '__Host-ssid' : 'ssid';
      const issued = sessionCookie(RAW_ID, {}, in30(), env);
      const cleared = clearSessionCookie({}, env);

      for (const cookie of [issued, cleared]) {
        expect(cookie.Name).to.equal(name);
        expect(cookie.Options.secure).to.equal(strict);
        expect(cookie.Options.httpOnly).to.equal(true);
        expect(cookie.Options.sameSite).to.equal('strict');
      }
      expect(sessionCookieName({}, env)).to.equal(name);
      expect(sessionCookieOptions({}, undefined, env).secure).to.equal(strict);
      if (strict) {
        expect(issued.Options.path).to.equal('/');
      }
    });
  }

  it('never reads NODE_ENV', () => {
    withNodeEnv('production', () => {
      expect(sessionCookie(RAW_ID, {}, in30(), 'development').Options.secure).to.equal(false);
      expect(sessionCookieName({}, 'development')).to.equal('ssid');
    });
    withNodeEnv('development', () => {
      expect(sessionCookie(RAW_ID, {}, in30(), 'staging').Options.secure).to.equal(true);
      expect(sessionCookieName({}, 'staging')).to.equal('__Host-ssid');
    });
  });

  it('SR-16 a deployment without NODE_ENV=production still sends a Secure __Host- cookie', () => {
    const cookie = withNodeEnv(undefined, () => sessionCookie(RAW_ID, shipped.authn.session.cookie as ISessionCookieConfig, in30(), 'staging'));

    expect(cookie.Name).to.equal('__Host-ssid');
    expect(cookie.Options.secure).to.equal(true);
    expect(cookie.Options.httpOnly).to.equal(true);
    expect(cookie.Options.sameSite).to.equal('strict');
  });
});

describe('shipped session cookie configuration', () => {
  const cookieConfig = () => shipped.authn.session.cookie as ISessionCookieConfig;

  it('ships the cookie block with the auto settings', () => {
    expect(cookieConfig()).to.deep.equal({ name: 'ssid', hostPrefix: 'auto', secure: 'auto', sameSite: 'strict' });
  });

  for (const [env, strict] of ENVS) {
    it(`${JSON.stringify(env)}: ${strict ? 'ships a Secure __Host- cookie' : 'relaxes Secure so http://localhost can log in'}`, () => {
      const cookie = sessionCookie(RAW_ID, cookieConfig(), in30(), env);

      expect(cookie.Name).to.equal(strict ? '__Host-ssid' : 'ssid');
      expect(cookie.Options.secure, 'a deployment must never send the session cookie over plain http').to.equal(strict);
      expect(cookie.Options.httpOnly).to.equal(true);
      expect(cookie.Options.sameSite).to.equal('strict');
    });
  }
});

describe('appEnvOf', () => {
  afterEach(() => uncacheOwned());

  it('SR-16 the env the deployment resolved, not NODE_ENV, reaches the cookie builder', async () => {
    await withNodeEnv(undefined, () => withSessionConfig({ process: { env: { APP_ENV: 'staging' } } }));
    const env = appEnvOf(DI.get(Configuration)!);
    const cookie = withNodeEnv(undefined, () => sessionCookie(RAW_ID, shipped.authn.session.cookie as ISessionCookieConfig, DateTime.now().plus({ minutes: 30 }), env));

    expect(cookie.Name).to.equal('__Host-ssid');
    expect(cookie.Options.secure).to.equal(true);
  });

  it('an unparsable flag value counts as on, in any env', () => {
    const config = { secure: 'yes', hostPrefix: 'TRUE' } as unknown as ISessionCookieConfig;
    expect(sessionCookieName(config, 'development')).to.equal('__Host-ssid');
    expect(sessionCookieOptions(config, undefined, 'development').secure).to.equal(true);
  });

  it('reads the app env the configuration resolved', async () => {
    await withSessionConfig({ process: { env: { APP_ENV: 'staging' } } });

    expect(appEnvOf(DI.get(Configuration)!)).to.equal('staging');
  });

  it('returns undefined when the configuration has no app env', () => {
    const config = { get: (): undefined => undefined } as unknown as Configuration;

    expect(appEnvOf(config)).to.equal(undefined);
  });
});

describe('assertSessionCookieSecret', () => {
  it('exports the public default secret shipped with @spinajs/http', () => {
    expect(PUBLIC_DEFAULT_COOKIE_SECRET).to.equal('1234adreewD');
  });

  for (const env of ['production', 'staging', 'development', 'test', 'qa-eu-1', undefined]) {
    it(`${JSON.stringify(env)}: refuses a missing or empty secret`, () => {
      expect(() => assertSessionCookieSecret(undefined, env)).to.throw();
      expect(() => assertSessionCookieSecret('', env)).to.throw();
    });

    it(`${JSON.stringify(env)}: accepts an own secret`, () => {
      expect(() => assertSessionCookieSecret('a-long-private-secret', env)).to.not.throw();
    });
  }

  for (const env of ['development', 'dev', 'test']) {
    it(`${env}: tolerates the public default`, () => {
      expect(() => assertSessionCookieSecret(PUBLIC_DEFAULT_COOKIE_SECRET, env)).to.not.throw();
    });
  }

  it('SR-16 the public cookie secret refuses to boot outside development and test', () => {
    withNodeEnv(undefined, () => {
      for (const env of ['production', 'prod', 'staging', 'qa-eu-1', '', undefined]) {
        expect(() => assertSessionCookieSecret(PUBLIC_DEFAULT_COOKIE_SECRET, env), JSON.stringify(env)).to.throw(/public default/);
      }
    });
  });
});
