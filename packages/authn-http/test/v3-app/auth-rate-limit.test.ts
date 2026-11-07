import 'mocha';
import { expect } from 'chai';

import { AUTHN_FAILURE_BODY } from '../../src/v3/index.js';
import { Client, bootApp, config, passwordStrategy, rebuildServer, resetRecorders, seedUser, startServer, stopApp } from './app.js';
import type { Res } from './app.js';
import { FREE, backoffOn } from './suites/ip-gate.js';

const KEY = 'authn.http.rateLimit.login';
// A window no other suite uses: the counters of the process-wide MemoryThrottleStore are keyed by limit and window.
const WINDOW = 59;

const rateLimitHeaders = (res: Res): string[] => Object.keys(res.headers).filter((h) => h.toLowerCase().startsWith('x-ratelimit'));

// Sorts before behaviour/, like the other auth-*.test.ts files; the app config raises every limit, these tests lower one.
describe('3.0 shipped rate limits over HTTP (RL-3)', function () {
  this.timeout(60000);

  let saved: unknown;

  before(async () => {
    await bootApp();
    saved = config().get(KEY);
    config().set(KEY, { limit: FREE + 1, windowSeconds: WINDOW });
    await startServer();
  });

  after(async () => {
    config().set(KEY, saved);
    await stopApp();
  });

  beforeEach(resetRecorders);

  it("a login over the configured limit gets the IP throttle's answer: 401, the one failure body, Retry-After, no X-RateLimit-*, nothing verified", async () => {
    const u = await seedUser();
    const restore = backoffOn();
    const seen: Res[] = [];
    let held: Res;
    try {
      for (let i = 0; i < FREE; i++) seen.push(await new Client().post('/auth/login', { login: u.login }));
      held = await new Client().post('/auth/login', { login: u.login, password: u.password });
      expect([held.status, held.headers['retry-after']], 'the IP throttle holds the ip').to.deep.eq([401, '60']);
    } finally {
      restore();
    }
    passwordStrategy.verifyCalls.length = 0;

    // The IP throttle lets everything through again: only the rate limit can refuse the right password now.
    const limited = await new Client().post('/auth/login', { login: u.login, password: u.password });
    expect(limited.status, JSON.stringify(limited.body)).to.eq(held.status);
    expect(limited.body).to.deep.eq(held.body).and.to.deep.eq(AUTHN_FAILURE_BODY);
    expect(limited.headers['cache-control']).to.eq(held.headers['cache-control']).and.to.eq('no-store');
    expect(Number(limited.headers['retry-after'])).to.be.within(1, WINDOW);
    expect(passwordStrategy.verifyCalls, 'refused before the strategy').to.have.length(0);
    for (const res of [...seen, held, limited]) expect(rateLimitHeaders(res)).to.deep.eq([]);
  });

  it('false takes the limit off the route', async () => {
    config().set(KEY, false);
    await rebuildServer();
    const u = await seedUser();
    for (let i = 0; i < 3 * (FREE + 1); i++) {
      const res = await new Client().post('/auth/login', { login: u.login, password: u.password });
      expect(res.status, `login ${i + 1}`).to.eq(200);
      expect(rateLimitHeaders(res)).to.deep.eq([]);
    }
  });

  it('unset, the shipped 30 a minute applies', async () => {
    config().set(KEY, undefined);
    await rebuildServer();
    for (let i = 0; i < 30; i++) {
      const res = await new Client().post('/auth/login', { login: 'nobody@example.test', password: 'wrong-password' });
      expect([res.status, res.headers['retry-after']], `failed login ${i + 1}`).to.deep.eq([401, undefined]);
    }
    const limited = await new Client().post('/auth/login', { login: 'nobody@example.test', password: 'wrong-password' });
    expect(limited.status).to.eq(401);
    expect(limited.body).to.deep.eq(AUTHN_FAILURE_BODY);
    expect(Number(limited.headers['retry-after'])).to.be.within(1, 60);
    expect(rateLimitHeaders(limited)).to.deep.eq([]);
  });
});
