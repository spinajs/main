import { expect } from 'chai';

// Moved by C1 task 9: users ships no authn.session config (LEDGER session-cookie rows 12-13; authn-session tests the 3.0 setting).
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
      const mod = await import(`../src/config/users.js?case=${tag}`);
      return mod.default.authn.session.cookie;
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
