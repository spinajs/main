import 'mocha';
import { expect } from 'chai';
import assert from 'node:assert/strict';
import { FakeClock } from '@spinajs/durable/testing';
import { InvalidArgument } from '@spinajs/exceptions';
import type { TestApp } from '@spinajs/testing';
import { IdempotencyInFlight, IdempotencyKeyReuse, IdempotencyLeaseLost, IdempotencyOutcomeUnknown, IdempotencyService, idempotencyKey } from '../src/index.js';
import type { IdempotencyRunOptions } from '../src/index.js';
import { bootIdempotencyApp } from './support/app.js';
import { withClock } from './support/clock.js';

const SCOPE = { namespace: 'test', principal: 'user:1' };
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

const numberReply = (extra: Partial<IdempotencyRunOptions<number>> = {}): IdempotencyRunOptions<number> => ({
  ttl: '1h',
  toReply: (n) => ({ kind: 'n', body: n }),
  fromReply: (reply) => reply.body as number,
  ...extra,
});

const nextTurn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

const simulatedCrash = (): Error => Object.assign(new Error('simulated crash'), { crash: true });

for (const store of ['MemoryIdempotencyStore', 'OrmIdempotencyStore']) {
  describe(`IdempotencyService on ${store}`, function () {
    this.timeout(30_000);

    let app: TestApp;
    let clock: FakeClock;
    let service: IdempotencyService;
    let calls: number;
    const counted = async (): Promise<number> => ++calls;

    beforeEach(async () => {
      clock = new FakeClock(T0);
      calls = 0;
      app = await bootIdempotencyApp({ idempotency: { store, lease: '30s', sweepBatch: 2 }, register: withClock(clock) });
      service = await app.resolve(IdempotencyService);
    });

    afterEach(() => app.dispose());

    it('runs once and replays the stored reply', async () => {
      expect(await service.run(SCOPE, 'k', counted, numberReply())).to.deep.equal({ replayed: false, value: 1 });
      expect(await service.run(SCOPE, 'k', counted, numberReply())).to.deep.equal({ replayed: true, value: 1 });
      expect(calls).to.equal(1);
    });

    it('keeps principals and namespaces apart', async () => {
      await service.run(SCOPE, 'k', counted, numberReply());
      await service.run({ ...SCOPE, principal: 'user:2' }, 'k', counted, numberReply());
      await service.run({ namespace: 'other', principal: 'user:1' }, 'k', counted, numberReply());
      expect(calls).to.equal(3);
    });

    it('answers a concurrent call with IdempotencyInFlight and the rest of the lease', async () => {
      let finish: (() => void) | undefined;
      const first = service.run(SCOPE, 'k', () => new Promise<number>((resolve) => (finish = () => resolve(7))), numberReply());
      // the claim is real I/O on sqlite: wait until the function runs
      while (!finish) await nextTurn();

      await assert.rejects(service.run(SCOPE, 'k', counted, numberReply()), (err: unknown) => err instanceof IdempotencyInFlight && err.retryAfterMs === 30_000);
      finish();
      expect(await first).to.deep.equal({ replayed: false, value: 7 });
      expect(calls).to.equal(0);
    });

    it('refuses a repeat with another fingerprint and does not run it', async () => {
      await service.run(SCOPE, 'k', counted, numberReply({ fingerprint: 'a'.repeat(64) }));
      await assert.rejects(service.run(SCOPE, 'k', counted, numberReply({ fingerprint: 'b'.repeat(64) })), IdempotencyKeyReuse);
      expect(calls).to.equal(1);
    });

    it('refuses a concurrent call with another fingerprint as key reuse, not as in flight', async () => {
      let finish: (() => void) | undefined;
      const first = service.run(SCOPE, 'k', () => new Promise<number>((resolve) => (finish = () => resolve(1))), numberReply({ fingerprint: 'a'.repeat(64) }));
      while (!finish) await nextTurn();

      await assert.rejects(service.run(SCOPE, 'k', counted, numberReply({ fingerprint: 'b'.repeat(64) })), IdempotencyKeyReuse);
      finish();
      await first;
      expect(calls).to.equal(0);
    });

    it('releases the key when toReply stores nothing, so a repeat runs again', async () => {
      const nothing = numberReply({ toReply: () => undefined });
      expect(await service.run(SCOPE, 'k', counted, nothing)).to.deep.equal({ replayed: false, value: 1 });
      expect(await service.run(SCOPE, 'k', counted, nothing)).to.deep.equal({ replayed: false, value: 2 });
    });

    it('releases the key when the function throws, and rethrows', async () => {
      const boom = new Error('boom');
      await assert.rejects(
        service.run(SCOPE, 'k', () => Promise.reject(boom), numberReply()),
        (err: unknown) => err === boom,
      );
      expect(await service.run(SCOPE, 'k', counted, numberReply())).to.deep.equal({ replayed: false, value: 1 });
    });

    it('releases the key when toReply throws, and rethrows', async () => {
      const boom = new Error('cannot serialize');
      const throwing = numberReply({
        toReply: () => {
          throw boom;
        },
      });
      await assert.rejects(service.run(SCOPE, 'k', counted, throwing), (err: unknown) => err === boom);
      expect(await service.run(SCOPE, 'k', counted, numberReply())).to.deep.equal({ replayed: false, value: 2 });
    });

    it('keeps the claim of a call whose outcome is unknown (IdempotencyOutcomeUnknown) until its lease ends', async () => {
      const unknown = new IdempotencyOutcomeUnknown('the client went away');
      await assert.rejects(
        service.run(SCOPE, 'k', () => Promise.reject(unknown), numberReply()),
        (err: unknown) => err === unknown,
      );
      await assert.rejects(service.run(SCOPE, 'k', counted, numberReply()), IdempotencyInFlight);

      await clock.advance(30_001);
      expect(await service.run(SCOPE, 'k', counted, numberReply())).to.deep.equal({ replayed: false, value: 1 });
    });

    it('keeps the claim of a crashed call (crash: true) until its lease ends', async () => {
      const crash = simulatedCrash();
      await assert.rejects(
        service.run(SCOPE, 'k', () => Promise.reject(crash), numberReply()),
        (err: unknown) => err === crash,
      );
      await assert.rejects(service.run(SCOPE, 'k', counted, numberReply()), IdempotencyInFlight);

      await clock.advance(30_001);
      expect(await service.run(SCOPE, 'k', counted, numberReply())).to.deep.equal({ replayed: false, value: 1 });
    });

    it('rethrows a crash of the store while storing the reply or releasing the key, and keeps the claim', async () => {
      const crash = simulatedCrash();
      const crashing = () => Promise.reject(crash);
      Object.assign(service.Store, { complete: crashing, release: crashing });

      await assert.rejects(service.run(SCOPE, 'a', counted, numberReply()), (err: unknown) => err === crash);
      await assert.rejects(
        service.run(SCOPE, 'b', () => Promise.reject(new Error('boom')), numberReply()),
        (err: unknown) => err === crash,
      );
      for (const key of ['a', 'b']) {
        await assert.rejects(service.run(SCOPE, key, counted, numberReply()), IdempotencyInFlight);
      }
      expect(clock.pendingTimers).to.equal(0);
    });

    it('keeps the claim and rethrows when toReply throws a crash', async () => {
      const crash = simulatedCrash();
      const crashing = numberReply({
        toReply: () => {
          throw crash;
        },
      });
      await assert.rejects(service.run(SCOPE, 'k', counted, crashing), (err: unknown) => err === crash);
      await assert.rejects(service.run(SCOPE, 'k', counted, numberReply()), IdempotencyInFlight);
      expect(clock.pendingTimers).to.equal(0);
    });

    it('rethrows a crash of the renewal although the function then reports an unknown outcome', async () => {
      const crash = simulatedCrash();
      Object.assign(service.Store, { renew: () => Promise.reject(crash) });
      let reason: unknown;
      const unknownAfterRenewal = async (signal: AbortSignal): Promise<number> => {
        await clock.advance(15_000);
        reason = signal.reason;
        throw new IdempotencyOutcomeUnknown('the client went away');
      };

      await assert.rejects(service.run(SCOPE, 'k', unknownAfterRenewal, numberReply()), (err: unknown) => err === crash);
      expect(reason).to.equal(crash);
      expect(clock.pendingTimers).to.equal(0);
    });

    it('releases the key of a function that stops on a lost lease, so a repeat runs again', async () => {
      Object.assign(service.Store, { renew: () => Promise.resolve(false) });
      const stopsOnLoss = async (signal: AbortSignal): Promise<number> => {
        await clock.advance(15_000);
        throw signal.reason;
      };

      await assert.rejects(service.run(SCOPE, 'k', stopsOnLoss, numberReply()), IdempotencyLeaseLost);
      expect(await service.run(SCOPE, 'k', counted, numberReply())).to.deep.equal({ replayed: false, value: 1 });
    });

    it('derives the scoped key from the namespace, principal and key', () => {
      expect(service.scopedKey(SCOPE, 'k')).to.equal(idempotencyKey(SCOPE, 'k'));
    });

    it('sweeps replies past their TTL in batches of idempotency.sweepBatch', async () => {
      for (const key of ['a', 'b', 'c']) {
        await service.run(SCOPE, key, counted, numberReply({ ttl: '1s' }));
      }
      await clock.advance(1_000);

      expect(await service.sweep()).to.equal(2);
      expect(await service.sweep()).to.equal(1);
      expect(await service.sweep()).to.equal(0);
    });

    it('refuses a ttl that is not a positive duration', () => {
      for (const ttl of ['0s', 'soon', -1]) {
        expect(() => service.ttlOf(ttl), String(ttl)).to.throw(InvalidArgument);
      }
      expect(service.ttlOf('24h')).to.equal(86_400_000);
    });
  });
}
