import { expect } from 'chai';
import sinon from 'sinon';
import { createHash } from 'node:crypto';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef, SessionHandle } from '@spinajs/authn/contracts';
import { FakeClock } from '@spinajs/authn-testing';
import { AUTHN_SESSION_CONFIGURATION_SCHEMA, DefaultSessionIssuer, MemorySessionStore } from '../src/index.js';
import type { ISession } from '../src/index.js';
import shipped from '../src/config/session.js';
import { uncacheOwned, withSessionConfig } from './support.js';

const SECOND = 1000;
const MIN = 60 * SECOND;

const alice: IdentityRef = { type: 'user', id: 'alice' };
const facts = (): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() });
const keyOf = (h: SessionHandle) => createHash('sha256').update(h.id).digest('hex');

const configFor = (expiration: string) => ({
  authn: { session: { service: 'MemorySessionStore', expiration: { service: expiration, ttl: 30, maxLifetime: 480 }, pendingTtlSeconds: 300, touchThresholdSeconds: 60 } },
});

async function setup(expiration: string) {
  await withSessionConfig(configFor(expiration), [DefaultSessionIssuer, SessionIssuer]);
  const issuer = await DI.resolve(DefaultSessionIssuer);
  const store = await DI.resolve(MemorySessionStore);
  await store.truncate();
  return { issuer, store, rows: (store as unknown as { Sessions: Map<string, ISession> }).Sessions };
}

describe('DefaultSessionIssuer.restore writes only when lastSeenAt or the expiry moves (PERF-1)', () => {
  let clock: FakeClock;

  beforeEach(() => {
    clock = new FakeClock();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
    sinon.restore();
    uncacheOwned([DefaultSessionIssuer, SessionIssuer]);
  });

  /** Restores `h` at each offset from `t0`, in order. */
  async function restoreAt(issuer: DefaultSessionIssuer, h: SessionHandle, t0: number, offsets: number[]): Promise<void> {
    for (const offset of offsets) {
      clock.set(new Date(t0 + offset));
      expect(await issuer.restore(h.id), `alive at t0+${offset / SECOND} s`).to.not.be.null;
    }
  }

  it('touchThresholdSeconds is 60 seconds by default, from the schema', async () => {
    const props = (AUTHN_SESSION_CONFIGURATION_SCHEMA as unknown as { properties: Record<string, { default?: unknown }> }).properties;
    expect(props.touchThresholdSeconds.default).to.equal(60);
    expect(shipped.authn.session).to.not.have.property('touchThresholdSeconds');
    await withSessionConfig({});
    expect(DI.get(Configuration)!.get('authn.session.touchThresholdSeconds')).to.equal(60);
  });

  it('SlidingCappedExpiration: no write within the threshold, one once both lastSeenAt and the expiry moved', async () => {
    const { issuer, store, rows } = await setup('SlidingCappedExpiration');
    const t0 = clock.now().getTime();
    const h = await issuer.issue(alice, facts());
    const touch = sinon.spy(store, 'touch');

    await restoreAt(issuer, h, t0, [1 * SECOND, 10 * SECOND, 59 * SECOND]);
    expect(touch.callCount, 'no write before the threshold').to.equal(0);
    expect(rows.get(keyOf(h))!.Expiration!.toMillis(), 'the expiry has not moved').to.equal(t0 + 30 * MIN);

    await restoreAt(issuer, h, t0, [61 * SECOND]);
    expect(touch.callCount).to.equal(1);
    expect(rows.get(keyOf(h))!.Expiration!.toMillis()).to.equal(t0 + 61 * SECOND + 30 * MIN);
    expect((await issuer.list(alice))[0].lastSeenAt.getTime()).to.equal(t0 + 61 * SECOND);
  });

  it('AbsoluteExpiration: the expiry never moves, so one write per lastSeenAt window and none in between', async () => {
    const { issuer, store, rows } = await setup('AbsoluteExpiration');
    const t0 = clock.now().getTime();
    const h = await issuer.issue(alice, facts());
    const expiry = rows.get(keyOf(h))!.Expiration!.toMillis();
    const touch = sinon.spy(store, 'touch');

    await restoreAt(issuer, h, t0, [1 * SECOND, 30 * SECOND, 59 * SECOND]);
    expect(touch.callCount, 'first window').to.equal(0);
    await restoreAt(issuer, h, t0, [61 * SECOND]);
    expect(touch.callCount, 'lastSeenAt moved').to.equal(1);
    await restoreAt(issuer, h, t0, [62 * SECOND, 100 * SECOND, 120 * SECOND]);
    expect(touch.callCount, 'second window').to.equal(1);
    await restoreAt(issuer, h, t0, [121 * SECOND]);
    expect(touch.callCount, 'lastSeenAt moved again').to.equal(2);
    expect(rows.get(keyOf(h))!.Expiration!.toMillis(), 'the absolute expiry never moves').to.equal(expiry);
    expect((await issuer.list(alice))[0].lastSeenAt.getTime()).to.equal(t0 + 121 * SECOND);
  });

  it('a pending session is never touched', async () => {
    const { issuer, store } = await setup('SlidingCappedExpiration');
    const t0 = clock.now().getTime();
    const pd = await issuer.issue(alice, facts(), { pending: { steps: ['totp'] } });
    const touch = sinon.spy(store, 'touch');

    await restoreAt(issuer, pd, t0, [1 * SECOND, 61 * SECOND, 121 * SECOND, 250 * SECOND]);
    expect(touch.callCount).to.equal(0);
  });

  it('a session that was not written expires at its stored deadline and its row is deleted', async () => {
    const { issuer, rows } = await setup('SlidingCappedExpiration');
    const t0 = clock.now().getTime();
    const h = await issuer.issue(alice, facts());

    await restoreAt(issuer, h, t0, [1 * SECOND, 59 * SECOND]);
    clock.set(new Date(t0 + 30 * MIN + SECOND));
    expect(await issuer.restore(h.id)).to.be.null;
    expect(rows.has(keyOf(h))).to.equal(false);
  });

  it('an expired row the store hands back is still deleted by restore', async () => {
    const { issuer, store, rows } = await setup('SlidingCappedExpiration');
    const h = await issuer.issue(alice, facts());
    const row = rows.get(keyOf(h))!;
    clock.tick(31 * MIN);
    // A store that missed the expiry: the issuer judges the row itself.
    sinon.stub(store, 'restore').resolves(row);
    const del = sinon.spy(store, 'delete');

    expect(await issuer.restore(h.id)).to.be.null;
    expect(del.calledWith(keyOf(h))).to.equal(true);
    expect(rows.has(keyOf(h))).to.equal(false);
  });
});
