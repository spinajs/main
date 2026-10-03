import { DI } from '@spinajs/di';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import { AbsoluteExpiration, SlidingExpiration, SlidingCappedExpiration, UserSession } from '../src/index.js';
import { uncacheOwned, withSessionConfig } from './support.js';

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

describe('Session expiration strategy defaults', () => {
  afterEach(() => {
    uncacheOwned();
  });

  it('without ttl and maxLifetime, the built-in defaults equal the shipped config: 30 and 480 minutes', async () => {
    await withConfig({ service: 'SlidingCappedExpiration', ttl: undefined, maxLifetime: undefined });
    const capped = await DI.resolve(SlidingCappedExpiration);
    const absolute = await DI.resolve(AbsoluteExpiration);

    const session = new UserSession();
    closeTo(capped.initial(session), DateTime.now().plus({ minutes: 30 }));
    session.Creation = DateTime.now().minus({ minutes: 470 });
    closeTo(capped.renew(session), session.Creation.plus({ minutes: 480 }));
    closeTo(absolute.initial(session), session.Creation.plus({ minutes: 30 }));
  });
});
