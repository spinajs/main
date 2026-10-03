import { expect } from 'chai';
import { randomBytes, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { IdentityRef } from '@spinajs/authn/contracts';
import type { ISession, SessionProvider } from '../../src/contracts.js';

/**
 * Expiration strategy config passed to the provider factory. Mirrors the shape
 * of `authn.session.expiration`.
 */
export interface IConformanceExpiration {
  service: 'AbsoluteExpiration' | 'SlidingExpiration' | 'SlidingCappedExpiration';
  ttl: number;
  maxLifetime?: number;
}

/**
 * Factory that produces a ready-to-use provider bound to the given expiration
 * strategy config. Called once per behavior so tests stay isolated.
 */
export type SessionProviderFactory = (expiration: IConformanceExpiration) => Promise<SessionProvider>;

/** A session as 2.x wrote it: keyed by its raw uuid, no Subject or State, identity in Data. */
export interface ILegacyRow {
  rawId: string;
  /** Data 'User'; omitted = a 2.x row without an owner. */
  user?: string;
  /** Data 'Authorized'. */
  authorized: boolean;
  /** Data 'Impersonator'. */
  impersonator?: string;
  creation: DateTime;
  expiration?: DateTime;
}

export interface ISessionProviderConformanceOptions {
  /** Writes a 2.x-shaped row the way 2.x did for this store. Required for persistent stores (A07, A08, SR-06). */
  seedLegacy?: (provider: SessionProvider, row: ILegacyRow) => Promise<void>;
}

const SLIDING: IConformanceExpiration = { service: 'SlidingExpiration', ttl: 60 };
const ABSOLUTE: IConformanceExpiration = { service: 'AbsoluteExpiration', ttl: 60 };
const CAPPED: IConformanceExpiration = { service: 'SlidingCappedExpiration', ttl: 60, maxLifetime: 120 };

export const userRef = (id: string): IdentityRef => ({ type: 'user', id });

/** A storage key shaped like the issuer's: sha256 hex. */
const storageKey = () => randomBytes(32).toString('hex');

export function makeSession(over: Partial<ISession> = {}): ISession {
  return {
    SessionId: storageKey(),
    Subject: userRef('u-1'),
    State: 'active',
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

const ids = (list: ISession[]) => list.map((s) => s.SessionId).sort();

/**
 * Provider-agnostic conformance suite asserting the full `SessionProvider`
 * contract. Run against any store by supplying a factory.
 *
 * @param makeProvider - builds a provider bound to a given expiration strategy
 */
export function runSessionProviderConformance(makeProvider: SessionProviderFactory, opts: ISessionProviderConformanceOptions = {}): void {
  describe('SessionProvider conformance', function () {
    this.timeout(15000);

    describe('save / restore round-trip', () => {
      it('round-trips SessionId, Subject, Impersonator, State and Data value types (string, number, boolean, DateTime)', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const when = DateTime.fromISO('2026-03-04T05:06:07.000Z');
        const session = makeSession({ Subject: userRef('u-42'), Impersonator: userRef('u-7') });
        session.Data.set('count', 7);
        session.Data.set('flag', true);
        session.Data.set('label', 'x');
        session.Data.set('when', when);

        await provider.save(session);
        const restored = await provider.restore(session.SessionId);

        expect(restored, 'session should restore').to.not.be.null;
        expect(restored!.SessionId).to.equal(session.SessionId);
        expect({ ...restored!.Subject }).to.deep.equal(userRef('u-42'));
        expect({ ...restored!.Impersonator }).to.deep.equal(userRef('u-7'));
        expect(restored!.State).to.equal('active');
        expect(restored!.Data.get('count')).to.equal(7);
        expect(restored!.Data.get('flag')).to.equal(true);
        expect(restored!.Data.get('label')).to.equal('x');
        expect(DateTime.isDateTime(restored!.Data.get('when')), '`when` should round-trip as a DateTime').to.be.true;
        expect((restored!.Data.get('when') as DateTime).toMillis()).to.equal(when.toMillis());
      });

      it('round-trips a pending session with no impersonator', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const session = makeSession({ State: 'pending', Expiration: DateTime.now().plus({ minutes: 5 }) });
        await provider.save(session);
        const restored = await provider.restore(session.SessionId);

        expect(restored!.State).to.equal('pending');
        expect(restored!.Impersonator).to.equal(undefined);
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

      it('save refuses a pending session without its own expiration (A09)', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        let failed = false;
        try {
          await provider.save(makeSession({ State: 'pending' }));
        } catch {
          failed = true;
        }
        expect(failed, 'a pending session must not get the active TTL').to.be.true;
      });
    });

    describe('delete / deleteBySubject / listBySubject / truncate', () => {
      it('delete removes a single session', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const session = makeSession();
        await provider.save(session);
        await provider.delete(session.SessionId);

        expect(await provider.restore(session.SessionId)).to.be.null;
      });

      it('deleteBySubject removes all sessions for a subject and returns the count', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const a1 = makeSession({ Subject: userRef('u-1') });
        const a2 = makeSession({ Subject: userRef('u-1') });
        const b1 = makeSession({ Subject: userRef('u-2') });
        const svc = makeSession({ Subject: { type: 'service', id: 'u-1' } });
        await provider.save(a1);
        await provider.save(a2);
        await provider.save(b1);
        await provider.save(svc);

        expect(await provider.deleteBySubject(userRef('u-1'))).to.equal(2);

        expect(await provider.restore(a1.SessionId)).to.be.null;
        expect(await provider.restore(a2.SessionId)).to.be.null;
        expect(await provider.restore(b1.SessionId), 'other subjects untouched').to.not.be.null;
        expect(await provider.restore(svc.SessionId), 'the subject type is part of the match').to.not.be.null;
      });

      it('deleteBySubject keeps the session named by except', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const keep = makeSession();
        const drop = makeSession();
        await provider.save(keep);
        await provider.save(drop);

        expect(await provider.deleteBySubject(userRef('u-1'), { except: keep.SessionId })).to.equal(1);
        expect(await provider.restore(keep.SessionId)).to.not.be.null;
        expect(await provider.restore(drop.SessionId)).to.be.null;
      });

      it('SR-06 deleteBySubject with includeImpersonations ends sessions the subject impersonates from', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const own = makeSession({ Subject: userRef('admin') });
        const impersonation = makeSession({ Subject: userRef('victim'), Impersonator: userRef('admin') });
        const victimOwn = makeSession({ Subject: userRef('victim') });
        await provider.save(own);
        await provider.save(impersonation);
        await provider.save(victimOwn);

        expect(await provider.deleteBySubject(userRef('admin')), 'a plain delete keeps the impersonation').to.equal(1);
        expect(await provider.restore(impersonation.SessionId)).to.not.be.null;

        expect(await provider.deleteBySubject(userRef('admin'), { includeImpersonations: true })).to.equal(1);
        expect(await provider.restore(impersonation.SessionId), 'revoking the impersonator ends the impersonation').to.be.null;
        expect(await provider.restore(victimOwn.SessionId), "the target's own session stays").to.not.be.null;
      });

      it("listBySubject returns only that subject's live sessions and excludes expired ones", async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const live1 = makeSession({ Subject: userRef('u-5') });
        const live2 = makeSession({ Subject: userRef('u-5') });
        const expired = makeSession({ Subject: userRef('u-5'), Expiration: DateTime.now().minus({ minutes: 1 }) });
        const other = makeSession({ Subject: userRef('u-6') });
        await provider.save(live1);
        await provider.save(live2);
        await provider.save(expired);
        await provider.save(other);

        expect(ids(await provider.listBySubject(userRef('u-5')))).to.deep.equal([live1.SessionId, live2.SessionId].sort());
      });

      it('listBySubject includes sessions the subject impersonates from only on request', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const own = makeSession({ Subject: userRef('admin') });
        const impersonation = makeSession({ Subject: userRef('victim'), Impersonator: userRef('admin') });
        await provider.save(own);
        await provider.save(impersonation);

        expect(ids(await provider.listBySubject(userRef('admin')))).to.deep.equal([own.SessionId]);
        expect(ids(await provider.listBySubject(userRef('admin'), { includeImpersonations: true }))).to.deep.equal([own.SessionId, impersonation.SessionId].sort());
        expect(ids(await provider.listBySubject(userRef('victim'))), 'the target sees the impersonation as its own').to.deep.equal([impersonation.SessionId]);
      });

      it('deleteBySubject with except and includeImpersonations ends the rest, impersonations included (A30)', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const current = makeSession({ Subject: userRef('admin') });
        const other = makeSession({ Subject: userRef('admin') });
        const impersonation = makeSession({ Subject: userRef('victim'), Impersonator: userRef('admin') });
        await provider.save(current);
        await provider.save(other);
        await provider.save(impersonation);

        expect(await provider.deleteBySubject(userRef('admin'), { except: current.SessionId, includeImpersonations: true })).to.equal(2);
        expect(await provider.restore(current.SessionId)).to.not.be.null;
        expect(await provider.restore(other.SessionId)).to.be.null;
        expect(await provider.restore(impersonation.SessionId)).to.be.null;
      });

      it('listBySubject with includeImpersonations leaves out an expired impersonation', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const live = makeSession({ Subject: userRef('victim'), Impersonator: userRef('admin') });
        const expired = makeSession({ Subject: userRef('victim'), Impersonator: userRef('admin'), Expiration: DateTime.now().minus({ minutes: 1 }) });
        await provider.save(live);
        await provider.save(expired);

        expect(ids(await provider.listBySubject(userRef('admin'), { includeImpersonations: true }))).to.deep.equal([live.SessionId]);
      });

      it('truncate clears all sessions', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        await provider.save(makeSession({ Subject: userRef('u-1') }));
        await provider.save(makeSession({ Subject: userRef('u-2') }));

        await provider.truncate();

        expect(await provider.listBySubject(userRef('u-1'))).to.be.empty;
        expect(await provider.listBySubject(userRef('u-2'))).to.be.empty;
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

      it('SR-07 touch never extends a pending session', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const fixed = DateTime.now().plus({ minutes: 5 });
        const session = makeSession({ State: 'pending', Expiration: fixed });
        await provider.save(session);

        expect(await provider.touch(session)).to.be.false;
        const restored = await provider.restore(session.SessionId);
        expect(restored!.Expiration!.toMillis()).to.equal(fixed.toMillis());
      });

      it('SR-07 touch writes the Data of a pending session and keeps its expiration (the issuer sets pending rows through touch)', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const fixed = DateTime.now().plus({ minutes: 5 });
        const session = makeSession({ State: 'pending', Expiration: fixed });
        await provider.save(session);
        const restored = await provider.restore(session.SessionId);
        restored!.Data.set('Ip', '203.0.113.7');

        expect(await provider.touch(restored!)).to.be.false;
        const after = (await provider.restore(session.SessionId))!;
        expect(after.Data.get('Ip')).to.equal('203.0.113.7');
        expect(after.Expiration!.toMillis()).to.equal(fixed.toMillis());
        expect(after.State).to.equal('pending');
      });

      it('SR-session absolute timeout: capped: the initial expiration of an old session stops at Creation + maxLifetime', async () => {
        const provider = await makeProvider(CAPPED);
        await provider.truncate();

        const creation = DateTime.now().minus({ minutes: 119 });
        const session = makeSession({ Creation: creation });
        await provider.save(session);

        closeTo((await provider.restore(session.SessionId))!.Expiration, creation.plus({ minutes: 120 }));
      });

      it('SR-session revocation: touch never revives a deleted session', async () => {
        const provider = await makeProvider(SLIDING);
        await provider.truncate();

        const session = makeSession({ Expiration: DateTime.now().plus({ minutes: 5 }) });
        await provider.save(session);
        const restored = await provider.restore(session.SessionId);
        await provider.delete(session.SessionId);

        expect(await provider.touch(restored!)).to.be.false;
        expect(await provider.restore(session.SessionId), 'a logout or ban between read and touch stays in force').to.be.null;
      });

      it('touch writes the Data of the row, also when the expiration does not change (the issuer updates rows only through touch)', async () => {
        const provider = await makeProvider(ABSOLUTE);
        await provider.truncate();

        const session = makeSession();
        await provider.save(session);
        const restored = await provider.restore(session.SessionId);
        restored!.Data.set('ActiveRole', 'editor');

        expect(await provider.touch(restored!)).to.be.false;
        expect((await provider.restore(session.SessionId))!.Data.get('ActiveRole')).to.equal('editor');
      });
    });

    if (opts.seedLegacy) {
      const seedLegacy = opts.seedLegacy;
      const legacy = (over: Partial<ILegacyRow> = {}): ILegacyRow => {
        const creation = DateTime.now().minus({ minutes: 1 });
        return { rawId: randomUUID(), user: 'u-legacy', authorized: true, creation, expiration: creation.plus({ minutes: 30 }), ...over };
      };

      describe('2.x rows (written before the upgrade, not migrated yet)', () => {
        it('restore gives the 3.0 view: Subject from User, Impersonator, State active when Authorized', async () => {
          const provider = await makeProvider(SLIDING);
          await provider.truncate();
          const row = legacy({ user: 'u-1', impersonator: 'u-9' });
          await seedLegacy(provider, row);

          const s = await provider.restore(row.rawId);
          expect(s).to.not.be.null;
          expect(s!.SessionId).to.equal(row.rawId);
          expect({ ...s!.Subject }).to.deep.equal(userRef('u-1'));
          expect({ ...s!.Impersonator }).to.deep.equal(userRef('u-9'));
          expect(s!.State).to.equal('active');
          expect(s!.Creation.toMillis()).to.equal(row.creation.toMillis());
        });

        it('SR-07 a 2.x row that never passed 2FA comes back pending', async () => {
          const provider = await makeProvider(SLIDING);
          await provider.truncate();
          const row = legacy({ authorized: false });
          await seedLegacy(provider, row);
          expect((await provider.restore(row.rawId))!.State).to.equal('pending');
        });

        it('a 2.x row without User is absent', async () => {
          const provider = await makeProvider(SLIDING);
          await provider.truncate();
          const row = legacy({ user: undefined });
          await seedLegacy(provider, row);
          expect(await provider.restore(row.rawId)).to.be.null;
        });

        it('an expired 2.x row is absent', async () => {
          const provider = await makeProvider(SLIDING);
          await provider.truncate();
          const row = legacy({ expiration: DateTime.now().minus({ seconds: 1 }) });
          await seedLegacy(provider, row);
          expect(await provider.restore(row.rawId)).to.be.null;
        });

        it('A08 deleteBySubject reaches the 2.x rows of the subject', async () => {
          const provider = await makeProvider(SLIDING);
          await provider.truncate();
          const own = legacy({ user: 'admin' });
          const other = legacy({ user: 'someone' });
          await seedLegacy(provider, own);
          await seedLegacy(provider, other);

          expect(await provider.deleteBySubject(userRef('admin'))).to.equal(1);
          expect(await provider.restore(own.rawId)).to.be.null;
          expect(await provider.restore(other.rawId)).to.not.be.null;
        });

        it('SR-06 deleteBySubject with includeImpersonations reaches 2.x impersonations', async () => {
          const provider = await makeProvider(SLIDING);
          await provider.truncate();
          const imp = legacy({ user: 'victim', impersonator: 'admin' });
          await seedLegacy(provider, imp);

          expect(await provider.deleteBySubject(userRef('admin')), 'a plain delete keeps it').to.equal(0);
          expect(await provider.deleteBySubject(userRef('admin'), { includeImpersonations: true })).to.equal(1);
          expect(await provider.restore(imp.rawId)).to.be.null;
        });

        it('listBySubject returns live 2.x rows, owned and (on request) impersonated from', async () => {
          const provider = await makeProvider(SLIDING);
          await provider.truncate();
          const own = legacy({ user: 'admin' });
          const imp = legacy({ user: 'victim', impersonator: 'admin' });
          const expired = legacy({ user: 'admin', expiration: DateTime.now().minus({ seconds: 1 }) });
          await seedLegacy(provider, own);
          await seedLegacy(provider, imp);
          await seedLegacy(provider, expired);

          expect(ids(await provider.listBySubject(userRef('admin')))).to.deep.equal([own.rawId]);
          expect(ids(await provider.listBySubject(userRef('admin'), { includeImpersonations: true }))).to.deep.equal([own.rawId, imp.rawId].sort());
          const victim = await provider.listBySubject(userRef('victim'));
          expect(ids(victim)).to.deep.equal([imp.rawId]);
          expect({ ...victim[0].Subject }).to.deep.equal(userRef('victim'));
        });
      });
    }
  });
}
