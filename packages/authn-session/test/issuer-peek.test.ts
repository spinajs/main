import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef } from '@spinajs/authn/contracts';
import { FakeClock } from '@spinajs/authn-testing';
import { DefaultSessionIssuer, MemorySessionStore, peekingSessions } from '../src/index.js';
import { uncacheOwned, withSessionConfig } from './support.js';

const MIN = 60_000;

const alice: IdentityRef = { type: 'user', id: 'alice' };

const facts = (over: Partial<AuthnFacts> = {}): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(), ...over });

const SESSION_CONFIG = { authn: { session: { service: 'MemorySessionStore', expiration: { service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 480 }, pendingTtlSeconds: 300 } } };

async function setup() {
  await withSessionConfig(SESSION_CONFIG, [DefaultSessionIssuer, SessionIssuer]);
  const issuer = await DI.resolve(DefaultSessionIssuer);
  const store = await DI.resolve(MemorySessionStore);
  await store.truncate();
  return { issuer, store };
}

describe('DefaultSessionIssuer.peek: validation without activity', () => {
  let clock: FakeClock | null = null;

  afterEach(() => {
    clock?.uninstall();
    clock = null;
    sinon.restore();
    uncacheOwned([DefaultSessionIssuer, SessionIssuer]);
  });

  const fake = () => {
    clock = new FakeClock();
    clock.install();
    return clock;
  };

  it('gives the session restore gives', async () => {
    const { issuer } = await setup();
    const h = await issuer.issue(alice, facts());

    expect(await issuer.peek(h.id)).to.deep.equal(await issuer.restore(h.id));
  });

  it('never slides the idle deadline', async () => {
    const c = fake();
    const { issuer } = await setup();
    const h = await issuer.issue(alice, facts());

    c.tick(29 * MIN);
    expect(await issuer.peek(h.id), 'alive after 29 minutes').to.not.be.null;
    c.tick(2 * MIN);
    expect(await issuer.peek(h.id), 'the peek at 29 minutes did not slide it').to.be.null;
    expect(await issuer.restore(h.id)).to.be.null;
  });

  it('writes nothing: no touch, lastSeenAt unchanged', async () => {
    const c = fake();
    const t0 = c.now().getTime();
    const { issuer, store } = await setup();
    const h = await issuer.issue(alice, facts());
    const touch = sinon.spy(store, 'touch');

    c.tick(2 * MIN);
    await issuer.peek(h.id);

    expect(touch.called).to.eq(false);
    expect((await issuer.list(alice))[0].lastSeenAt.getTime()).to.equal(t0);
  });

  it('gives null for an unknown, a revoked or an expired session', async () => {
    const c = fake();
    const { issuer } = await setup();
    const revoked = await issuer.issue(alice, facts());
    await issuer.revoke(revoked);
    const expired = await issuer.issue(alice, facts());

    expect(await issuer.peek('kQ7c1d0yYcH1m3S2bA9x_w')).to.be.null;
    expect(await issuer.peek(revoked.id)).to.be.null;
    c.tick(31 * MIN);
    expect(await issuer.peek(expired.id)).to.be.null;
  });

  it('peekingSessions: a restore inside the scope does not slide, one running beside it still does', async () => {
    const c = fake();
    const { issuer } = await setup();
    const peeked = await issuer.issue(alice, facts());
    const used = await issuer.issue(alice, facts());

    c.tick(29 * MIN);
    const [inside, beside] = await Promise.all([peekingSessions(() => issuer.restore(peeked.id)), issuer.restore(used.id)]);
    expect(inside).to.not.be.null;
    expect(beside).to.not.be.null;

    c.tick(2 * MIN);
    expect(await issuer.restore(peeked.id)).to.be.null;
    expect(await issuer.restore(used.id)).to.not.be.null;
  });
});
