import * as chai from 'chai';
import 'mocha';
import { Authorizer, DefaultConditionCompiler, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { Decision, Vote } from '@spinajs/authz';
import { fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';

import { AUTHZ_POLICY_TABLE, AbacModel, DbPolicyStore, MemoryPolicyStore, PolicyStore } from '../../src/index.js';
import { DB_KINDS, bootDb } from '../support/db.js';
import type { TestDb } from '../support/db.js';

const expect = chai.expect;
const NOW = new Date('2026-10-01T12:00:00.000Z');
const alice = userPrincipal('alice');
const DEADLINE = 8000;
const TICKS = 20;
const ENGINE_TICKS = 5;

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

for (const kind of DB_KINDS) {
  describe(`AbacModel over DbPolicyStore beside a nested transaction (${kind})`, function () {
    this.timeout(600_000);
    let db: TestDb;

    before(async function () {
      db = await bootDb(this, kind, 'v4_orm_tq_01i_abac_reload_not_started_inside');
    });
    after(async () => {
      await db?.dispose();
    });

    const beside = <T>(ticks: number, outer: () => Promise<T>, inner: () => Promise<T>): Promise<T[]> =>
      db.driver.transaction(() =>
        Promise.all([
          outer(),
          (async () => {
            for (let i = 0; i < ticks; i++) await Promise.resolve();
            return db.driver.transaction(inner);
          })(),
        ]),
      );

    const registry = (): PermissionRegistryImpl => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'file:read', types: ['file'] }], 'test');
      reg.freeze();
      return reg;
    };

    const OPEN = { id: 'open', effect: 'permit' as const, permissions: ['file:read'] };

    const setup = async (store: DbPolicyStore, policies: readonly (typeof OPEN)[] = []) => {
      await db.driver.del().from(AUTHZ_POLICY_TABLE);
      for (const p of policies) await db.driver.transaction(() => store.put(p, alice, { driver: db.driver }, NOW));
      const reg = registry();
      const model = new AbacModel({ stores: [store], retryMs: 600_000 });
      await model.init(fakeModelInitContext({ permissions: reg, container: db.container }));
      const ctx = fakeEvaluationContext({ now: NOW, permissions: reg, conditions: new DefaultConditionCompiler() });
      const req = { principal: alice, permission: 'file:read', resource: { type: 'file' }, env: { now: NOW } };
      await model.evaluate(req, ctx);
      return { model, reg, ctx, evaluate: async () => model.evaluate(req, ctx) };
    };

    const answer = (v: Vote): string => (v.denyWhen === TRUE ? 'deny' : v.permitWhen === TRUE ? 'allow' : 'abstain');

    /** The next background load lands last, as when it must first take a pool connection while a transaction holds one. */
    const holdNextLoad = (store: DbPolicyStore): (() => void) => {
      const real = store.load.bind(store);
      let hold = false;
      store.load = async () => {
        if (hold) {
          hold = false;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        return real();
      };
      return () => {
        hold = true;
      };
    };

    class Rollback extends Error {}

    /** A third-party store over the same table that does not say whether its reads run inside a transaction. */
    class OpaqueStore extends PolicyStore {
      readonly name = 'opaque';
      constructor(private readonly inner: DbPolicyStore) {
        super();
      }
      load() {
        return this.inner.load();
      }
      version() {
        return this.inner.version();
      }
    }

    const pending = (model: AbacModel): boolean => model.version().endsWith('~');

    if (kind === 'postgres') {
      it('an invalidate inside a REPEATABLE READ transaction loads nothing on its snapshot: a policy deleted and committed meanwhile stops granting outside (tq-01i)', async () => {
        const store = new DbPolicyStore();
        const { model, evaluate } = await setup(store, [OPEN]);
        let go!: () => void;
        const gate = new Promise<void>((resolve) => (go = resolve));
        const b = db.driver.transaction(
          async () => {
            await store.load();
            await gate;
            model.invalidate(['policy']);
            await new Promise((resolve) => setTimeout(resolve, 300));
          },
          { isolation: 'REPEATABLE READ' },
        );
        await db.driver.transaction(() => store.delete('open', { driver: db.driver }));
        go();
        await within(DEADLINE, 'the REPEATABLE READ transaction', b);
        const behind = pending(model);
        expect(answer(await within(DEADLINE, 'outside', evaluate())), 'outside, after the transaction').to.equal('abstain');
        expect(behind, 'still behind until the first check outside').to.equal(true);
        expect(pending(model), 'current after the first check outside').to.equal(false);
      });
    }

    it('an invalidate inside a transaction that rolls back loads nothing it wrote: its permit grants nothing outside (tq-01i)', async () => {
      const store = new DbPolicyStore();
      const { model, evaluate } = await setup(store);
      const done = db.driver.transaction(async () => {
        await store.put(OPEN, alice, { driver: db.driver }, NOW);
        model.invalidate(['policy']);
        await new Promise((resolve) => setTimeout(resolve, 300));
        throw new Rollback();
      });
      await within(
        DEADLINE,
        'the rolled-back transaction',
        done.catch((e: unknown) => {
          if (!(e instanceof Rollback)) throw e;
        }),
      );
      const behind = pending(model);
      expect(answer(await within(DEADLINE, 'outside', evaluate())), 'outside, after the rollback').to.equal('abstain');
      expect(behind, 'still behind until the first check outside').to.equal(true);
      expect(pending(model), 'current after the first check outside').to.equal(false);
    });

    it('a store that does not say whether it is in a transaction still reloads in the background after an invalidate inside one (tq-01i)', async () => {
      const inner = new DbPolicyStore();
      await db.driver.del().from(AUTHZ_POLICY_TABLE);
      const reg = registry();
      const model = new AbacModel({ stores: [new OpaqueStore(inner)], retryMs: 600_000 });
      await model.init(fakeModelInitContext({ permissions: reg, container: db.container }));
      const ctx = fakeEvaluationContext({ now: NOW, permissions: reg, conditions: new DefaultConditionCompiler() });
      const evaluate = async () => answer(await model.evaluate({ principal: alice, permission: 'file:read', resource: { type: 'file' }, env: { now: NOW } }, ctx));
      await db.driver.transaction(() => inner.put(OPEN, alice, { driver: db.driver }, NOW));
      await db.driver.transaction(async () => {
        model.invalidate(['policy']);
      });
      expect(await evaluate()).to.equal('allow');
      expect(await evaluate()).to.equal('allow');
      const started = Date.now();
      while (pending(model) && Date.now() - started < DEADLINE) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pending(model), 'caught up without a check that keeps its read').to.equal(false);
    });

    it('with a second store that is never in a transaction, an invalidate inside one still starts no reload there (tq-01i)', async () => {
      await db.driver.del().from(AUTHZ_POLICY_TABLE);
      const store = new DbPolicyStore();
      const reg = registry();
      const model = new AbacModel({ stores: [store, new MemoryPolicyStore([])], retryMs: 600_000 });
      await model.init(fakeModelInitContext({ permissions: reg, container: db.container }));
      const ctx = fakeEvaluationContext({ now: NOW, permissions: reg, conditions: new DefaultConditionCompiler() });
      const evaluate = async () => answer(await model.evaluate({ principal: alice, permission: 'file:read', resource: { type: 'file' }, env: { now: NOW } }, ctx));
      await evaluate();
      const done = db.driver.transaction(async () => {
        await store.put(OPEN, alice, { driver: db.driver }, NOW);
        model.invalidate(['policy']);
        await new Promise((resolve) => setTimeout(resolve, 300));
        throw new Rollback();
      });
      await within(
        DEADLINE,
        'the rolled-back transaction',
        done.catch((e: unknown) => {
          if (!(e instanceof Rollback)) throw e;
        }),
      );
      expect(await within(DEADLINE, 'outside', evaluate()), 'outside, after the rollback').to.equal('abstain');
    });

    if (kind === 'postgres') {
      it('a check inside a REPEATABLE READ transaction keeps nothing it read: a policy deleted and committed meanwhile stops granting outside', async () => {
        const store = new DbPolicyStore();
        const { model, evaluate } = await setup(store, [OPEN]);
        const holdNext = holdNextLoad(store);
        let go!: () => void;
        const gate = new Promise<void>((resolve) => (go = resolve));
        let inside = '';
        const b = db.driver.transaction(
          async () => {
            await store.load();
            await gate;
            inside = answer(await evaluate());
          },
          { isolation: 'REPEATABLE READ' },
        );
        await db.driver.transaction(() => store.delete('open', { driver: db.driver }));
        holdNext();
        model.invalidate(['policy']);
        go();
        await within(DEADLINE, 'the REPEATABLE READ transaction', b);
        expect(inside, 'inside, on its own snapshot').to.equal('allow');
        expect(answer(await within(DEADLINE, 'outside', evaluate())), 'outside, right after').to.equal('abstain');
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(answer(await evaluate()), 'outside, later').to.equal('abstain');
      });
    }

    it('a permit written in a transaction that rolls back grants nothing outside', async () => {
      const store = new DbPolicyStore();
      const { model, evaluate } = await setup(store);
      const holdNext = holdNextLoad(store);
      holdNext();
      model.invalidate(['policy']);
      let inside = '';
      const done = db.driver.transaction(async () => {
        await store.put(OPEN, alice, { driver: db.driver }, NOW);
        inside = answer(await evaluate());
        throw new Rollback();
      });
      await within(
        DEADLINE,
        'the rolled-back transaction',
        done.catch((e: unknown) => {
          if (!(e instanceof Rollback)) throw e;
        }),
      );
      expect(inside, 'inside, its own uncommitted row').to.equal('allow');
      expect(answer(await within(DEADLINE, 'outside', evaluate())), 'outside, after the rollback').to.equal('abstain');
    });

    it('preload, listPlan and summarize in a nested transaction after an invalidate in the outer level settle', async () => {
      const { model, reg, ctx, evaluate } = await setup(new DbPolicyStore());
      const permission = reg.get('file:read');
      if (!permission) throw new Error('file:read is not registered');
      const calls: Record<string, () => Promise<unknown>> = {
        preload: () => model.preload(),
        listPlan: () => model.listPlan({ principal: alice, permission, type: 'file' }, ctx),
        summarize: () => model.summarize(alice, { type: '$global' }, ctx),
      };
      for (const [name, call] of Object.entries(calls)) {
        const outer = async (): Promise<unknown> => {
          model.invalidate(['policy']);
          return evaluate();
        };
        const out = await within(5000, `${name}, 0 microtasks later`, beside<unknown>(0, outer, call));
        expect(out).to.have.length(2);
      }
    });

    it('a reload an invalidate started inside the transaction is not awaited by a check in a nested transaction', async () => {
      const { model, evaluate } = await setup(new DbPolicyStore());
      for (let k = 0; k <= TICKS; k++) {
        const out = await within(
          DEADLINE,
          `invalidate, ${k} microtasks later`,
          beside(
            k,
            async () => {
              model.invalidate(['policy']);
              return evaluate();
            },
            evaluate,
          ),
        );
        expect(out).to.have.length(2);
      }
    });

    it('the first checks after a failed reload, one inside a nested transaction, settle', async () => {
      const store = new DbPolicyStore();
      const { model, evaluate } = await setup(store);
      const real = store.load.bind(store);
      for (let k = 0; k <= TICKS; k++) {
        store.load = () => Promise.reject(new Error('store down'));
        model.invalidate(['policy']);
        await Promise.resolve().then(evaluate).catch(() => undefined);
        store.load = real;
        const out = await within(DEADLINE, `after a failed reload, ${k} microtasks later`, beside(k, evaluate, evaluate));
        expect(out).to.have.length(2);
      }
    });

    it('through Authorizer.check, both checks of one request are allowed without waiting for the model deadline', async () => {
      await db.driver.del().from(AUTHZ_POLICY_TABLE);
      const store = new DbPolicyStore();
      await db.driver.transaction(() => store.put({ id: 'open', effect: 'permit', permissions: ['file:read'] }, alice, { driver: db.driver }, NOW));
      const reg = registry();
      const model = new AbacModel({ stores: [store], retryMs: 600_000 });
      await model.init(fakeModelInitContext({ permissions: reg, container: db.container }));
      const a = new Authorizer({ domain: 'root', models: [model], registry: reg, combine: { default: { algorithm: 'deny-overrides' } }, conditions: new DefaultConditionCompiler(), clock: () => NOW });
      const req = { principal: alice, permission: 'file:read', resource: { type: 'file' } };
      const real = store.load.bind(store);
      for (let k = 0; k <= ENGINE_TICKS; k++) {
        store.load = () => Promise.reject(new Error('store down'));
        model.invalidate(['policy']);
        expect((await a.check(req, { cache: new Map() })).reason?.code).to.equal('model_error');
        store.load = real;
        const scope = { cache: new Map<string, unknown>() };
        const started = Date.now();
        const ds = await within(DEADLINE, `engine, ${k} microtasks later`, beside<Decision>(k, () => a.check(req, scope), () => a.check(req, scope)));
        const ms = Date.now() - started;
        expect(ds.map((d) => d.allowed), `${k} microtasks later: ${ds.map((d) => d.reason?.code).join(', ')}`).to.deep.equal([true, true]);
        expect(ms, `${k} microtasks later, ms`).to.be.below(1500);
      }
    });
  });
}
