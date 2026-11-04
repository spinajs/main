import 'mocha';
import { expect } from 'chai';
import assert from 'node:assert/strict';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import type { TestApp } from '@spinajs/testing';
import { IdempotencyClaimConflict, IdempotencyKeyModel, OrmIdempotencyStore } from '../../src/index.js';
import { describeIdempotencyStoreConformance } from '../../src/testing/index.js';
import { REAL_DB_TARGETS, bootRealDb } from './real-db.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`OrmIdempotencyStore integration (${target.name})`, function () {
    this.timeout(60_000);

    let app: TestApp;

    before(async () => {
      app = await bootRealDb(target);
    });

    after(() => app?.dispose());

    const emptyStore = async (): Promise<OrmIdempotencyStore> => {
      await IdempotencyKeyModel.destroy().where('Key', '!=', '');
      return app.resolve(OrmIdempotencyStore);
    };

    describeIdempotencyStoreConformance(`OrmIdempotencyStore (${target.name})`, emptyStore);

    describe('inside a transaction', () => {
      let store: OrmIdempotencyStore;
      let driver: OrmDriver;

      beforeEach(async () => {
        store = await emptyStore();
        driver = (await app.resolve(Orm)).Connections.get('it')!;
      });

      it('answers running for a key another caller claimed after the transaction took its snapshot', async () => {
        let start!: () => void;
        // chained outside the transaction, so this claim runs on a connection of its own
        const elsewhere = new Promise<void>((resolve) => (start = resolve)).then(() => store.claim('t', { leaseMs: 60_000, now: T0 }));

        const mine = await driver.transaction(async () => {
          await IdempotencyKeyModel.where('Key', 'snapshot');
          start();
          expect((await elsewhere).state).to.equal('claimed');
          return store.claim('t', { leaseMs: 60_000, now: T0 + 1 });
        });

        expect(mine).to.deep.equal({ state: 'running', leaseUntil: T0 + 60_000 });
      });

      it('claims a taken key without failing a statement, so the transaction goes on', async () => {
        await store.claim('k', { leaseMs: 60_000, now: T0 });

        const seen = await driver.transaction(async () => {
          const claim = await store.claim('k', { leaseMs: 60_000, now: T0 + 1 });
          // Postgres refuses every statement of a transaction after one failed
          const rows = await IdempotencyKeyModel.where('Key', 'k');
          return { state: claim.state, rows: rows.length };
        });

        expect(seen).to.deep.equal({ state: 'running', rows: 1 });
      });

      it('answers concurrent claims, each in its own transaction, with claimed, running or IdempotencyClaimConflict', async () => {
        await store.claim('e', { leaseMs: 1, now: T0 });

        const outcomes = await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            driver.transaction(() => store.claim('e', { leaseMs: 60_000, now: T0 + 100 + i })).then(
              (claim) => claim.state as string,
              (error: unknown) => (error instanceof IdempotencyClaimConflict ? 'conflict' : String(error)),
            ),
          ),
        );

        expect(outcomes.filter((outcome) => outcome === 'claimed')).to.have.length.at.most(1);
        expect(outcomes.filter((outcome) => !['claimed', 'running', 'conflict'].includes(outcome))).to.deep.equal([]);
      });

      (target.name === 'postgres' ? it : it.skip)('refuses a REPEATABLE READ claim after a concurrent commit with IdempotencyClaimConflict', async () => {
        let start!: () => void;
        const elsewhere = new Promise<void>((resolve) => (start = resolve)).then(() => store.claim('t', { leaseMs: 60_000, now: T0 }));

        const claim = async () => {
          await IdempotencyKeyModel.where('Key', 'snapshot');
          start();
          await elsewhere;
          return store.claim('t', { leaseMs: 60_000, now: T0 + 1 });
        };

        await assert.rejects(driver.transaction(claim, { isolation: 'REPEATABLE READ' }), IdempotencyClaimConflict);
      });

      it('replays a completed reply and its fingerprint', async () => {
        const reply = { kind: 'test', body: { n: 1 } };
        const claim = await store.claim('k', { leaseMs: 60_000, now: T0, fingerprint: 'f' });
        await store.complete('k', claim.state === 'claimed' ? claim.token : '', reply, 60_000, T0);

        const replayed = await driver.transaction(() => store.claim('k', { leaseMs: 60_000, now: T0 + 1 }));

        expect(replayed).to.deep.equal({ state: 'done', reply, fingerprint: 'f' });
      });
    });

    // MySQL counts changed rows unless the client sets CLIENT_FOUND_ROWS: an unchanged lease would read as lost
    it('renews twice in the same millisecond', async () => {
      const store = await emptyStore();
      const claim = await store.claim('k', { leaseMs: 1_000, now: T0 });
      const token = claim.state === 'claimed' ? claim.token : '';

      expect(await store.renew('k', token, 1_000, T0 + 10)).to.equal(true);
      expect(await store.renew('k', token, 1_000, T0 + 10)).to.equal(true);
    });
  });
}
