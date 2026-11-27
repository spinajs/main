import * as chai from 'chai';
import 'mocha';

import type { EvaluationContext, ResourceRef } from '@spinajs/authz';
import { fakeEvaluationContext, fakeModelInitContext } from '@spinajs/authz-testing';

import { AUTHZ_REBAC_TUPLE_TABLE, DbTupleStore, RebacModel } from '../../src/index.js';
import type { Tuple } from '../../src/index.js';
import { bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { NAMESPACES, PERMISSIONS, PERMISSION_INPUTS, d1, tuple, user } from '../support/world.js';

const expect = chai.expect;

const CONCURRENT = 10;

/** Rejects with `what` when `work` has not settled after `ms`, so a hang fails its own test instead of reaching mocha's timeout. */
async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: still running after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Counts the tuple reads that reach the table; `failures` fail before reaching it; `hold` keeps an answer back after the table answered. */
class CountedTuples extends DbTupleStore {
  loads = 0;
  answered = 0;
  failures = 0;
  hold?: Promise<void>;

  override async read(object: ResourceRef, relation: string): Promise<readonly Tuple[]> {
    this.loads++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error('tuple store unavailable');
    }
    const tuples = await super.read(object, relation);
    this.answered++;
    await this.hold;
    return tuples;
  }
}

const OWNER = tuple(d1, 'owner', user('alice'));

for (const pg of [false, true]) {
  describe(`authz-rebac: the request memo of DbTupleStore reads beside a nested transaction (${pg ? 'postgres' : 'sqlite'})`, function () {
    this.timeout(600_000);
    let db: TestDb;

    before(async function () {
      db = await bootDb('v4_orm_tq_01e_queue_safe_caches', pg ? this : undefined);
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      await rawQuery(db.driver, `DELETE FROM ${AUTHZ_REBAC_TUPLE_TABLE}`);
      await new DbTupleStore().write([OWNER], [], user('admin'));
    });

    async function rebac() {
      const store = new CountedTuples();
      const model = new RebacModel({ store, namespaces: NAMESPACES, permissions: PERMISSIONS });
      await model.init(fakeModelInitContext({ permissions: PERMISSION_INPUTS, model: model.name, container: db.container }));
      return { model, store };
    }

    const check = (model: RebacModel, ctx: EvaluationContext) => model.check(d1, 'read', user('alice'), ctx);

    it('a check settles beside a nested transaction that makes the same check in the same request, cold and warm, however late it starts', async () => {
      for (const warm of [false, true]) {
        for (let ticks = 0; ticks <= 60; ticks++) {
          const { model } = await rebac();
          if (warm) await check(model, fakeEvaluationContext());
          const ctx = fakeEvaluationContext();
          const nested = async () => {
            for (let i = 0; i < ticks; i++) await Promise.resolve();
            return db.driver.transaction(() => check(model, ctx));
          };
          const answers = await within(10_000, `a tuple check beside a nested one, ${warm ? 'warm' : 'cold'}, ${ticks} microtasks later`, db.driver.transaction(() => Promise.all([check(model, ctx), nested()])));
          expect(answers).to.deep.equal(['member', 'member']);
          await model.dispose();
        }
      }
    });

    it('store loads: concurrent checks of a request read each, a settled answer serves the rest of the request', async () => {
      const { model, store } = await rebac();
      const ctx = fakeEvaluationContext();
      await check(model, fakeEvaluationContext());
      const one = store.loads;
      store.loads = 0;
      await Promise.all(Array.from({ length: CONCURRENT }, () => check(model, ctx)));
      const concurrent = store.loads;
      await Promise.all(Array.from({ length: CONCURRENT }, () => check(model, ctx)));
      expect({ concurrent, settled: store.loads - concurrent }).to.deep.equal({ concurrent: CONCURRENT * one, settled: 0 });
      await model.dispose();
    });

    it('a failed read is not kept: the next check of the request reads again', async () => {
      const { model, store } = await rebac();
      const ctx = fakeEvaluationContext();
      store.failures = 1;
      const failed = await check(model, ctx).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(failed?.message).to.equal('tuple store unavailable');
      expect(await check(model, ctx)).to.equal('member');
      await model.dispose();
    });

    it('a tuple read before an invalidate, settled or in flight, does not answer a check of the request after it', async () => {
      for (const inFlight of [false, true]) {
        await rawQuery(db.driver, `DELETE FROM ${AUTHZ_REBAC_TUPLE_TABLE}`);
        await new DbTupleStore().write([OWNER], [], user('admin'));
        const { model, store } = await rebac();
        const ctx = fakeEvaluationContext();
        let release = (): void => undefined;
        if (inFlight) {
          store.hold = new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        const first = check(model, ctx);
        while (inFlight && store.answered === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        if (!inFlight) expect(await first).to.equal('member');
        await new DbTupleStore().write([], [OWNER], user('admin'));
        model.invalidate(['rebac']);
        release();
        store.hold = undefined;
        await first;
        expect(await check(model, ctx), inFlight ? 'in flight' : 'settled').to.equal('not');
        await model.dispose();
      }
    });
  });
}
