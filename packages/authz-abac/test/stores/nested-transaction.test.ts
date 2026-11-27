import * as chai from 'chai';
import 'mocha';
import { Authorizer, DefaultConditionCompiler, PermissionRegistryImpl } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';
import { fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';

import { AUTHZ_POLICY_TABLE, AbacModel, DbPolicyStore } from '../../src/index.js';
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
      db = await bootDb(this, kind, 'v4_orm_tq_01h_abac_reload_not_shared');
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

    const setup = async (store: DbPolicyStore) => {
      await db.driver.del().from(AUTHZ_POLICY_TABLE);
      const reg = registry();
      const model = new AbacModel({ stores: [store], retryMs: 600_000 });
      await model.init(fakeModelInitContext({ permissions: reg, container: db.container }));
      const ctx = fakeEvaluationContext({ now: NOW, permissions: reg, conditions: new DefaultConditionCompiler() });
      const req = { principal: alice, permission: 'file:read', resource: { type: 'file' }, env: { now: NOW } };
      await model.evaluate(req, ctx);
      return { model, evaluate: async () => model.evaluate(req, ctx) };
    };

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
