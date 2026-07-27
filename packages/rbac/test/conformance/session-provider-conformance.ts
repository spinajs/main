import { expect } from 'chai';
import { DateTime } from 'luxon';
import { v4 as uuidv4 } from 'uuid';
import type { ISession, SessionProvider } from '@spinajs/rbac';

/**
 * Expiration strategy config passed to the provider factory. Mirrors the shape
 * of `rbac.session.expiration`.
 */
export interface IConformanceExpiration {
  service: 'AbsoluteExpiration' | 'SlidingExpiration' | 'SlidingCappedExpiration';
  ttl: number;
  maxLifetime?: number;
}

/**
 * Factory that produces a ready-to-use provider bound to the given expiration
 * strategy config. Implementations wire their store + configuration and return
 * a resolved `SessionProvider`. Called once per behavior so tests stay isolated.
 */
export type SessionProviderFactory = (expiration: IConformanceExpiration) => Promise<SessionProvider>;

const SLIDING: IConformanceExpiration = { service: 'SlidingExpiration', ttl: 60 };
const ABSOLUTE: IConformanceExpiration = { service: 'AbsoluteExpiration', ttl: 60 };
const CAPPED: IConformanceExpiration = { service: 'SlidingCappedExpiration', ttl: 60, maxLifetime: 120 };

function makeSession(over: Partial<ISession> = {}): ISession {
  return {
    SessionId: uuidv4(),
    UserId: 1,
    Creation: DateTime.now(),
    Expiration: undefined,
    Data: new Map<string, unknown>(),
    ...over,
  };
}

function closeTo(actual: DateTime | undefined, expected: DateTime, toleranceMs = 3000) {
  expect(actual, 'expiration should be defined').to.not.be.undefined;
  const diff = Math.abs(actual!.toMillis() - expected.toMillis());
  expect(diff, `expected ${actual!.toISO()} within ${toleranceMs}ms of ${expected.toISO()}`).to.be.lessThan(toleranceMs);
}

/**
 * Provider-agnostic conformance suite asserting the full `SessionProvider`
 * contract. Run against any store by supplying a factory.
 *
 * @param makeProvider - builds a provider bound to a given expiration strategy
 */
export function runSessionProviderConformance(makeProvider: SessionProviderFactory): void {
  describe('SessionProvider conformance', function () {
    this.timeout(15000);

    describe('save / restore round-trip', () => {
      it('round-trips SessionId, UserId and Data value types (string, number, boolean, DateTime)', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const when = DateTime.fromISO('2026-03-04T05:06:07.000Z');
        const session = makeSession({ UserId: 42 });
        session.Data.set('User', 'a-uuid');
        session.Data.set('count', 7);
        session.Data.set('Authorized', true);
        session.Data.set('when', when);

        await provider.save(session);
        const restored = await provider.restore(session.SessionId);

        expect(restored, 'session should restore').to.not.be.null;
        expect(restored!.SessionId).to.equal(session.SessionId);
        expect(restored!.UserId).to.equal(42);
        expect(restored!.Data.get('User')).to.equal('a-uuid');
        expect(restored!.Data.get('count')).to.equal(7);
        expect(restored!.Data.get('Authorized')).to.equal(true);
        expect(DateTime.isDateTime(restored!.Data.get('when')), '`when` should round-trip as a DateTime').to.be.true;
        expect((restored!.Data.get('when') as DateTime).toMillis()).to.equal(when.toMillis());
      });

      it('restore returns null for a missing session', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const restored = await provider.restore('does-not-exist');
        expect(restored).to.be.null;
      });

      it('restore returns null for an expired session', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const session = makeSession({ Expiration: DateTime.now().minus({ hours: 1 }) });
        await provider.save(session);

        const restored = await provider.restore(session.SessionId);
        expect(restored).to.be.null;
      });

      it('save persists Expiration verbatim — does not recompute an already-set expiry (B3)', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        // A fixed, far-future expiry. Under sliding, a buggy store would reset
        // it to now + ttl on save. It must be preserved exactly.
        const fixed = DateTime.fromISO('2030-01-01T00:00:00.000Z');
        const session = makeSession({ Expiration: fixed });

        await provider.save(session);
        const restored = await provider.restore(session.SessionId);

        expect(restored).to.not.be.null;
        expect(restored!.Expiration!.toMillis()).to.equal(fixed.toMillis());
      });
    });

    describe('delete / deleteByUser / listByUser / truncate', () => {
      it('delete removes a single session', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const session = makeSession();
        await provider.save(session);
        await provider.delete(session.SessionId);

        expect(await provider.restore(session.SessionId)).to.be.null;
      });

      it('deleteByUser removes all sessions for a user, keyed on numeric UserId', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const a1 = makeSession({ UserId: 1 });
        const a2 = makeSession({ UserId: 1 });
        const b1 = makeSession({ UserId: 2 });
        await provider.save(a1);
        await provider.save(a2);
        await provider.save(b1);

        await provider.deleteByUser(1);

        expect(await provider.restore(a1.SessionId)).to.be.null;
        expect(await provider.restore(a2.SessionId)).to.be.null;
        expect(await provider.restore(b1.SessionId), 'other users untouched').to.not.be.null;
      });

      it('listByUser returns only that user\'s live sessions and excludes expired ones', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const live1 = makeSession({ UserId: 5 });
        const live2 = makeSession({ UserId: 5 });
        const expired = makeSession({ UserId: 5, Expiration: DateTime.now().minus({ minutes: 1 }) });
        const other = makeSession({ UserId: 6 });
        await provider.save(live1);
        await provider.save(live2);
        await provider.save(expired);
        await provider.save(other);

        const list = await provider.listByUser(5);
        const ids = list.map((s) => s.SessionId).sort();

        expect(ids).to.deep.equal([live1.SessionId, live2.SessionId].sort());
      });

      it('truncate clears all sessions', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        await provider.save(makeSession({ UserId: 1 }));
        await provider.save(makeSession({ UserId: 2 }));

        await provider.truncate();

        expect(await provider.listByUser(1)).to.be.empty;
        expect(await provider.listByUser(2)).to.be.empty;
      });
    });

    describe('touch — expiration renewal per strategy', () => {
      it('sliding: extends expiration and returns true', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const old = DateTime.now();
        const session = makeSession({ Expiration: old });
        await provider.save(session);

        const changed = await provider.touch(session);

        expect(changed, 'sliding touch should report a change').to.be.true;
        const restored = await provider.restore(session.SessionId);
        closeTo(restored!.Expiration, DateTime.now().plus({ minutes: 60 }));
        expect(restored!.Expiration!.toMillis()).to.be.greaterThan(old.toMillis());
      });

      it('absolute: no-ops, does not write, returns false', async () => {
        const provider = await makeProvider(ABSOLUTE);
        await provider.truncate();

        const fixed = DateTime.now().plus({ minutes: 60 });
        const session = makeSession({ Expiration: fixed });
        await provider.save(session);

        const changed = await provider.touch(session);

        expect(changed, 'absolute touch should report no change').to.be.false;
        const restored = await provider.restore(session.SessionId);
        expect(restored!.Expiration!.toMillis()).to.equal(fixed.toMillis());
      });

      it('capped: clamps the renewed expiration to Creation + maxLifetime', async () => {
        const provider = await makeProvider(CAPPED);
        await provider.truncate();

        // Created 119 min ago; cap = Creation + 120min = now + 1min.
        // Slide = now + 60min would exceed the cap and must be clamped.
        const creation = DateTime.now().minus({ minutes: 119 });
        const session = makeSession({ Creation: creation, Expiration: DateTime.now() });
        await provider.save(session);

        const changed = await provider.touch(session);

        expect(changed).to.be.true;
        const restored = await provider.restore(session.SessionId);
        closeTo(restored!.Expiration, creation.plus({ minutes: 120 }));
      });
    });
  });
}
