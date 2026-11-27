import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { expect } from 'chai';
import { DateTime, Settings } from 'luxon';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { AUTHN_SESSION_CONFIGURATION_SCHEMA } from '../src/schema.js';
import { AbsoluteExpiration, MemorySessionStore, SessionExpirationProvider, SlidingExpiration, SlidingCappedExpiration, UserSession } from '../src/index.js';
import type { ISession } from '../src/index.js';
import shipped from '../src/config/session.js';
import { UNREADABLE_INSTANTS, uncacheOwned, withSessionConfig } from './support.js';

async function withConfig(expiration: unknown) {
  await withSessionConfig({ authn: { session: { expiration } } });
}

// Assert two DateTimes are within `toleranceMs` of each other.
function closeTo(actual: DateTime | undefined, expected: DateTime, toleranceMs = 2000) {
  expect(actual, 'expiration should be defined').to.not.be.undefined;
  const diff = Math.abs(actual!.toMillis() - expected.toMillis());
  expect(diff, `expected ${actual!.toISO()} to be within ${toleranceMs}ms of ${expected.toISO()}`).to.be.lessThan(toleranceMs);
}

describe('Session expiration strategies', () => {
  afterEach(() => {
    uncacheOwned();
  });

  describe('AbsoluteExpiration', () => {
    it('initial = Creation + ttl (minutes)', async () => {
      await withConfig({ service: 'AbsoluteExpiration', ttl: 120 });
      const strategy = await DI.resolve(AbsoluteExpiration);

      const session = new UserSession();
      session.Creation = DateTime.fromISO('2026-01-01T00:00:00.000Z');

      const result = strategy.initial(session);
      closeTo(result, session.Creation.plus({ minutes: 120 }), 5);
    });

    it('renew returns the current Expiration unchanged (no slide)', async () => {
      await withConfig({ service: 'AbsoluteExpiration', ttl: 120 });
      const strategy = await DI.resolve(AbsoluteExpiration);

      const session = new UserSession();
      session.Expiration = DateTime.fromISO('2026-01-01T02:00:00.000Z');

      const result = strategy.renew(session);
      expect(result!.toMillis()).to.equal(session.Expiration.toMillis());
    });
  });

  describe('SlidingExpiration', () => {
    it('initial = now + ttl (minutes)', async () => {
      await withConfig({ service: 'SlidingExpiration', ttl: 30 });
      const strategy = await DI.resolve(SlidingExpiration);

      const session = new UserSession();
      const result = strategy.initial(session);
      closeTo(result, DateTime.now().plus({ minutes: 30 }));
    });

    it('renew = now + ttl (slides forward from now, ignoring Creation)', async () => {
      await withConfig({ service: 'SlidingExpiration', ttl: 30 });
      const strategy = await DI.resolve(SlidingExpiration);

      const session = new UserSession();
      session.Creation = DateTime.now().minus({ hours: 10 });
      const result = strategy.renew(session);
      closeTo(result, DateTime.now().plus({ minutes: 30 }));
    });
  });

  describe('SlidingCappedExpiration', () => {
    it('initial = now + ttl', async () => {
      await withConfig({ service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 1440 });
      const strategy = await DI.resolve(SlidingCappedExpiration);

      const session = new UserSession();
      const result = strategy.initial(session);
      closeTo(result, DateTime.now().plus({ minutes: 30 }));
    });

    it('SR-session absolute timeout: initial never passes Creation + maxLifetime (elevate keeps an old Creation)', async () => {
      await withConfig({ service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 480 });
      const strategy = await DI.resolve(SlidingCappedExpiration);

      const session = new UserSession();
      session.Creation = DateTime.now().minus({ minutes: 470 });
      closeTo(strategy.initial(session), session.Creation.plus({ minutes: 480 }));
    });

    it('renew slides to now + ttl when under the cap', async () => {
      await withConfig({ service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 1440 });
      const strategy = await DI.resolve(SlidingCappedExpiration);

      const session = new UserSession();
      session.Creation = DateTime.now(); // cap = now + 1440min, well beyond now + 30
      const result = strategy.renew(session);
      closeTo(result, DateTime.now().plus({ minutes: 30 }));
    });

    it('renew clamps to Creation + maxLifetime when the slide would exceed the cap', async () => {
      await withConfig({ service: 'SlidingCappedExpiration', ttl: 120, maxLifetime: 60 });
      const strategy = await DI.resolve(SlidingCappedExpiration);

      const session = new UserSession();
      // Created 59 minutes ago; cap = Creation + 60min = now + 1min.
      // Slide = now + 120min would exceed the cap, so renew must clamp to the cap.
      session.Creation = DateTime.now().minus({ minutes: 59 });
      const cap = session.Creation.plus({ minutes: 60 });

      const result = strategy.renew(session);
      closeTo(result, cap);
    });
  });
});

/** A store whose expiration helpers a test can call with a strategy of its choice. */
class HelperStore extends MemorySessionStore {
  constructor(strategy: SessionExpirationProvider) {
    super();
    this.Expiration = strategy;
  }
  public initial(s: ISession): DateTime | undefined {
    this.applyInitialExpiration(s);
    return s.Expiration;
  }
  public renewed(s: ISession): DateTime | undefined {
    this.applyRenewedExpiration(s);
    return s.Expiration;
  }
}

const STRATEGIES: [string, () => Promise<SessionExpirationProvider>][] = [
  ['AbsoluteExpiration', async () => (await withConfig({ service: 'AbsoluteExpiration', ttl: 120 }), DI.resolve(AbsoluteExpiration))],
  ['SlidingExpiration', async () => (await withConfig({ service: 'SlidingExpiration', ttl: 30 }), DI.resolve(SlidingExpiration))],
  ['SlidingCappedExpiration', async () => (await withConfig({ service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 480 }), DI.resolve(SlidingCappedExpiration))],
];

describe('Session expiration through the store helpers', () => {
  afterEach(() => {
    Settings.now = () => Date.now();
    uncacheOwned();
  });

  for (const [name, resolve] of STRATEGIES) {
    it(`${name}: a session whose Creation is not a valid instant gets the epoch, a valid instant that has passed`, async () => {
      const store = new HelperStore(await resolve());
      for (const [label, at] of UNREADABLE_INSTANTS) {
        const s = new UserSession({ Creation: at });
        expect(store.initial(s)?.isValid, `${label}: initial is valid`).to.equal(true);
        expect(s.Expiration?.toMillis(), `${label}: initial`).to.equal(0);
        s.Expiration = DateTime.now().plus({ minutes: 10 });
        expect(store.renewed(s)?.isValid, `${label}: renewed is valid`).to.equal(true);
        expect(s.Expiration?.toMillis(), `${label}: renewed`).to.equal(0);
        expect(store.isExpired(s), label).to.equal(true);
      }
    });

    it(`${name}: the expiry of a valid session is exactly the strategy's`, async () => {
      const strategy = await resolve();
      const store = new HelperStore(strategy);
      const now = DateTime.fromISO('2026-06-01T12:00:00.000Z').toMillis();
      Settings.now = () => now;
      for (const minutesAgo of [0, 1, 29, 31, 470, 479, 481, 600, 60 * 24 * 365]) {
        const creation = DateTime.fromMillis(now).minus({ minutes: minutesAgo });
        const stored = DateTime.fromMillis(now).plus({ minutes: 5 });
        const s = new UserSession({ Creation: creation, Expiration: stored });
        const fresh = new UserSession({ Creation: creation });
        expect(store.initial(fresh)?.toMillis(), `initial, created ${minutesAgo} min ago`).to.equal(strategy.initial(new UserSession({ Creation: creation }))?.toMillis());
        expect(store.renewed(s)?.toMillis(), `renewed, created ${minutesAgo} min ago`).to.equal(strategy.renew(new UserSession({ Creation: creation, Expiration: stored }))?.toMillis());
      }
    });
  }
});

describe('Session expiration strategy defaults', () => {
  afterEach(() => {
    uncacheOwned();
  });

  it('the schema defaults ttl and maxLifetime to 30 and 480 minutes, and the shipped config does not repeat them', async () => {
    type Expiration = { properties: { expiration: { properties: Record<string, { default?: unknown }> } } };
    const expiration = (AUTHN_SESSION_CONFIGURATION_SCHEMA as unknown as Expiration).properties.expiration.properties;
    // maxLifetime is in the authn schema: the impersonation service reads it too.
    const core = (AUTHN_CONFIGURATION_SCHEMA as unknown as { properties: { session: Expiration } }).properties.session.properties.expiration.properties;
    expect({ ttl: expiration.ttl.default, maxLifetime: core.maxLifetime.default }).to.deep.equal({ ttl: 30, maxLifetime: 480 });
    expect(shipped.authn.session.expiration).to.deep.equal({ service: 'SlidingCappedExpiration' });

    await withSessionConfig({});
    expect(DI.get(Configuration)!.get('authn.session.expiration')).to.deep.include({ ttl: 30, maxLifetime: 480 });
  });

  it('without a ttl and maxLifetime the schema filled, a session expires at once instead of living on', async () => {
    // The test configuration merges its overrides after the schema check, as a runtime set would.
    await withConfig({ service: 'SlidingCappedExpiration', ttl: undefined, maxLifetime: undefined });
    const capped = await DI.resolve(SlidingCappedExpiration);
    const absolute = await DI.resolve(AbsoluteExpiration);

    const session = new UserSession();
    expect(capped.initial(session)!.toMillis()).to.be.at.most(DateTime.now().toMillis());
    expect(absolute.initial(session)!.toMillis()).to.equal(session.Creation.toMillis());
  });
});
