import 'mocha';
import { expect } from 'chai';

import { AUTHN_FAILURE_BODY } from '../../src/v3/index.js';
import { Client, bootApp, config, resetRecorders, seedUser, startServer, step, stopApp } from './app.js';
import type { KitUser, Res } from './app.js';

const KEY = 'authn.http.rateLimit.mfaVerify';
// A window no other suite uses: the counters of the process-wide MemoryThrottleStore are keyed by limit and window.
const WINDOW = 57;

const rateLimitHeaders = (res: Res): string[] => Object.keys(res.headers).filter((h) => h.toLowerCase().startsWith('x-ratelimit'));

async function pending(u: KitUser): Promise<Client> {
  step.enrol(u.ref);
  const c = new Client();
  const res = await c.post('/auth/login', { login: u.login, password: u.password });
  expect(res.body).to.deep.eq({ MfaRequired: ['totp'], MfaEnrol: [] });
  return c;
}

// The app config raises every session limit; this suite lowers mfaVerify before the routes mount.
describe('3.0 shipped rate limits of the routes with a session over HTTP (RL-4)', function () {
  this.timeout(60000);

  let saved: unknown;

  before(async () => {
    await bootApp();
    saved = config().get(KEY);
    config().set(KEY, { limit: 2, windowSeconds: WINDOW });
    await startServer();
  });

  after(async () => {
    config().set(KEY, saved);
    await stopApp();
  });

  beforeEach(resetRecorders);

  it('mfa/verify over the limit of one pending session answers the uniform failure, while another pending session from the same address still verifies', async () => {
    const a = await seedUser();
    const first = await pending(a);
    for (let i = 0; i < 2; i++) expect((await first.post('/auth/mfa/verify', { code: 'wrong-code' })).status, `wrong code ${i + 1}`).to.eq(401);

    const limited = await first.post('/auth/mfa/verify', { code: step.nextCode(a.ref) });
    expect(limited.status).to.eq(401);
    expect(limited.body).to.deep.eq(AUTHN_FAILURE_BODY);
    expect(Number(limited.headers['retry-after'])).to.be.within(1, WINDOW);
    expect(rateLimitHeaders(limited)).to.deep.eq([]);

    // Counted per pending session, not per address: every client here is the loopback.
    const b = await seedUser();
    const second = await pending(b);
    const verified = await second.post('/auth/mfa/verify', { code: step.nextCode(b.ref) });
    expect(verified.status, JSON.stringify(verified.body)).to.eq(200);
  });
});
