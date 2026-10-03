import * as chai from 'chai';
import 'mocha';
import { Authorizer, AuthzConfigError, DefaultConditionCompiler, FALSE, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { DecisionRequest, EvaluationContext, Policy, Vote } from '@spinajs/authz';
import { StaticModel, agentPrincipal, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';

import { AbacModel, ConfigPolicyStore, DbPolicyStore, MemoryPolicyStore, storesFromConfig } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const F1 = { type: 'file', id: 'f1' };
const alice = userPrincipal('alice');

const registry = (): PermissionRegistryImpl => {
  const r = new PermissionRegistryImpl();
  r.register(
    [
      { name: 'file:read', types: ['file'], fields: true },
      { name: 'file:delete', types: ['file'] },
    ],
    'test',
  );
  r.freeze();
  return r;
};

const policy = (id: string, extra: Partial<Policy> = {}): Policy => ({ id, effect: 'permit', permissions: ['file:read'], source: 'test', ...extra });
const ctx = (reg = registry()): EvaluationContext => fakeEvaluationContext({ now: NOW, permissions: reg, conditions: new DefaultConditionCompiler() });
const req = (over: Partial<DecisionRequest> = {}): DecisionRequest => ({ principal: alice, permission: 'file:read', resource: { type: 'file' }, env: { now: NOW }, ...over });

async function model(stores: AbacModel extends never ? never : ConstructorParameters<typeof AbacModel>[0], reg = registry()): Promise<AbacModel> {
  const m = new AbacModel(stores);
  await m.init(fakeModelInitContext({ permissions: reg }));
  return m;
}

/** A memory store whose loads can be held back. */
class GatedStore extends MemoryPolicyStore {
  gate: Promise<void> | undefined;
  loads = 0;
  async load(): Promise<readonly Policy[]> {
    this.loads++;
    if (this.gate) await this.gate;
    return super.load();
  }
}

describe('authz-abac: field sets, reloads and decided conditions (review 4-8)', () => {
  describe('field sets', () => {
    it('keep negations and globs, merged as the engine merges them (C1)', async () => {
      const m = await model({ stores: [new MemoryPolicyStore([policy('most', { fields: { read: ['*', '!salary'] } })])] });
      expect(((await m.evaluate(req(), ctx())) as Vote).fields).to.deep.equal({ read: ['*', '!salary'], write: [] });
      const reg = registry();
      const a = new Authorizer({ domain: 'root', models: [m], registry: reg, conditions: new DefaultConditionCompiler(), clock: () => NOW });
      const d = await a.check({ principal: alice, permission: 'file:read', resource: F1 });
      expect(d.fields.read).to.include('!salary');
    });

    it('come from the permits that hold everywhere; with none, the intersection of all (C2)', async () => {
      const names = policy('everyone-names', { fields: { read: ['name'] } });
      const self = policy('self-all', { when: { attr: 'resource.id', eq: { ref: 'principal.id' } } });
      const m = await model({ stores: [new MemoryPolicyStore([names, self])] });
      expect(((await m.evaluate(req(), ctx())) as Vote).fields).to.deep.include({ read: ['name'] });
      const onlyConditional = await model({ stores: [new MemoryPolicyStore([policy('a', { when: { attr: 'resource.x', eq: 1 }, fields: { read: ['a', 'b'] } }), policy('b', { when: { attr: 'resource.y', eq: 1 }, fields: { read: ['b', 'c'] } })])] });
      expect(((await onlyConditional.evaluate(req(), ctx())) as Vote).fields).to.deep.include({ read: ['b'] });
      // and through the engine, with the row of another user
      const reg = registry();
      const a = new Authorizer({ domain: 'root', models: [m], registry: reg, conditions: new DefaultConditionCompiler(), clock: () => NOW });
      const d = await a.check({ principal: alice, permission: 'file:read', resource: F1, subject: { id: 'bob', name: 'Bob', salary: 1 } });
      expect(d.allowed).to.equal(true);
      expect(d.fields.read).to.deep.equal(['name']);
    });
  });

  describe('reloads', () => {
    it('a request during a reload waits for it (I1); the catch-all tag reloads too (I2)', async () => {
      const store = new GatedStore([policy('read')]);
      const m = await model({ stores: [store] });
      let open!: () => void;
      store.gate = new Promise((r) => (open = r));
      store.put(policy('frozen', { effect: 'deny' }));
      m.invalidate(['*']);
      const pending = m.evaluate(req(), ctx());
      expect(pending).to.be.instanceOf(Promise);
      open();
      store.gate = undefined;
      expect((await pending).denyWhen).to.equal(TRUE);
    });

    it('moves version() at once and routes every pair until the reload lands, so a new deny on an unrouted pair applies (I3)', async () => {
      const reg = registry();
      const store = new MemoryPolicyStore([policy('read')]);
      const m = await model({ stores: [store] }, reg);
      const a = new Authorizer({ domain: 'root', models: [m], registry: reg, conditions: new DefaultConditionCompiler(), clock: () => NOW });
      const del = (): Promise<boolean> => a.check({ principal: alice, permission: 'file:delete', resource: F1 }).then((d) => d.allowed);
      expect(await del()).to.equal(false);
      const before = m.version();
      store.put(policy('deleters', { permissions: ['file:delete'] }));
      a.invalidate(['policy:deleters']);
      expect(m.version()).to.not.equal(before);
      expect(await del()).to.equal(true);
      store.put(policy('no-delete', { effect: 'deny', permissions: ['file:delete'] }));
      a.invalidate(['policy:no-delete']);
      expect(await del()).to.equal(false);
    });

    it('a reload that brings the same data gives the routes back to the sync model (r2 I-a)', async () => {
      const reg = registry();
      const store = new GatedStore([policy('read')]);
      const m = await model({ stores: [store] }, reg);
      const rbac = new StaticModel({ name: 'rbac', votes: () => ({ permitWhen: TRUE }) });
      const a = new Authorizer({ domain: 'root', models: [rbac, m], registry: reg, conditions: new DefaultConditionCompiler(), clock: () => NOW });
      const sync = () => a.filterNow(alice, 'file:delete', 'file');
      expect(sync()).to.deep.equal(TRUE);
      let open!: () => void;
      store.gate = new Promise((r) => (open = r));
      a.invalidate(['*']);
      expect(m.version()).to.match(/~$/);
      const during = a.check({ principal: alice, permission: 'file:delete', resource: F1 });
      expect(sync()).to.equal(undefined);
      open();
      store.gate = undefined;
      expect((await during).allowed).to.equal(true);
      await new Promise((r) => setTimeout(r, 0));
      expect(m.version()).to.not.match(/~$/);
      expect(sync()).to.deep.equal(TRUE);
    });

    it('after a failed reload only the pairs the model governs are indeterminate, and it retries (r2 I-b)', async () => {
      const reg = registry();
      const store = new MemoryPolicyStore([policy('read')]);
      const m = await model({ stores: [store] }, reg);
      const rbac = new StaticModel({ name: 'rbac', votes: () => ({ permitWhen: TRUE }) });
      const a = new Authorizer({ domain: 'root', models: [rbac, m], registry: reg, conditions: new DefaultConditionCompiler(), clock: () => NOW });
      const load = store.load.bind(store);
      let down = true;
      store.load = async () => {
        if (down) throw new Error('db down');
        return load();
      };
      a.invalidate(['policy']);
      const read = await a.check({ principal: alice, permission: 'file:read', resource: F1 });
      expect(read.reason?.code).to.equal('model_error');
      const del = await a.check({ principal: alice, permission: 'file:delete', resource: F1 });
      expect(del.allowed).to.equal(true);
      down = false;
      expect((await a.check({ principal: alice, permission: 'file:read', resource: F1 })).allowed).to.equal(true);
    });

    it('an invalidation during a load starts the next one when it lands (r2 M-b)', async () => {
      const store = new GatedStore([policy('read')]);
      const m = await model({ stores: [store] });
      let open!: () => void;
      store.gate = new Promise((r) => (open = r));
      m.invalidate(['policy']);
      m.invalidate(['policy']);
      const loads = store.loads;
      open();
      store.gate = undefined;
      await new Promise((r) => setTimeout(r, 10));
      expect(store.loads).to.equal(loads + 1);
      expect(m.version()).to.not.match(/~$/);
    });

    it('a load that fails after a newer change came in leaves the next load to run for it (r3 I-c, N8)', async () => {
      const store = new GatedStore([policy('read')]);
      const m = await model({ stores: [store] });
      const load = MemoryPolicyStore.prototype.load.bind(store);
      let fail = true;
      let open!: () => void;
      store.gate = new Promise((r) => (open = r));
      store.load = async () => {
        store.loads++;
        await store.gate;
        if (fail) {
          fail = false;
          throw new Error('db down');
        }
        return load();
      };
      const before = store.loads;
      m.invalidate(['policy']);
      store.put(policy('no-read', { effect: 'deny' }));
      m.invalidate(['policy:no-read']);
      open();
      await new Promise((r) => setTimeout(r, 10));
      expect(store.loads - before).to.equal(2);
      expect(((await m.evaluate(req(), ctx())) as Vote).denyWhen).to.equal(TRUE);
    });

    it('retries a failed load on its own, with backoff, so a change applies with no request of the model (r3 I-c, N7)', async () => {
      const store = new MemoryPolicyStore([policy('read')]);
      const m = await model({ stores: [store], retryMs: 5 });
      const load = store.load.bind(store);
      let down = true;
      let loads = 0;
      store.load = async () => {
        loads++;
        if (down) throw new Error('db down');
        return load();
      };
      store.put(policy('no-read', { effect: 'deny' }));
      m.invalidate(['policy']);
      await new Promise((r) => setTimeout(r, 30));
      expect(loads).to.be.greaterThan(1);
      expect(m.version()).to.not.match(/~$/);
      const stale = m.version();
      down = false;
      await new Promise((r) => setTimeout(r, 200));
      // The timer, not a request, brought the new data in.
      expect(m.version()).to.not.equal(stale);
      expect(((await m.evaluate(req(), ctx())) as Vote).denyWhen).to.equal(TRUE);
      const settled = loads;
      await new Promise((r) => setTimeout(r, 50));
      expect(loads).to.equal(settled);
      await m.dispose();
    });

    it('keeps routing to the last good index while it retries a failed load (r4 I-d)', async () => {
      const reg = registry();
      const store = new MemoryPolicyStore([policy('read')]);
      const m = await model({ stores: [store], retryMs: 2 }, reg);
      const rbac = new StaticModel({ name: 'rbac', votes: () => ({ permitWhen: TRUE }) });
      const a = new Authorizer({ domain: 'root', models: [rbac, m], registry: reg, conditions: new DefaultConditionCompiler(), clock: () => NOW });
      store.load = async () => {
        await new Promise((r) => setTimeout(r, 1));
        throw new Error('db down');
      };
      a.invalidate(['policy']);
      const versions = new Set<string>();
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 1));
        if (i > 3) {
          versions.add(m.version());
          expect((await a.check({ principal: alice, permission: 'file:delete', resource: F1 })).allowed).to.equal(true);
          expect(a.filterNow(alice, 'file:delete', 'file')).to.deep.equal(TRUE);
        }
      }
      expect([...versions].some((v) => v.endsWith('~'))).to.equal(false);
      await m.dispose();
    });

    it('refuses a retryMs that is not a positive number', () => {
      expect(() => new AbacModel({ retryMs: 0 })).to.throw(AuthzConfigError, /retryMs must be a positive number/);
    });

    it('a model over config stores only ignores invalidations and stays sync (M1)', async () => {
      const m = await model({ stores: [new ConfigPolicyStore([policy('read')])] });
      m.invalidate(['*', 'policy']);
      expect(m.capabilities.sync).to.equal('always');
      expect(m.evaluate(req(), ctx())).to.not.be.instanceOf(Promise);
    });
  });

  describe('conditions decided without the row (I4)', () => {
    it('a FALSE one drops the policy, a TRUE one applies it, both with their own reason', async () => {
      const guest = userPrincipal('m', { attributes: { role: 'member' } });
      const m = await model({
        stores: [
          new MemoryPolicyStore([
            policy('guest-paths', {
              effect: 'deny',
              when: {
                all: [
                  { attr: 'principal.attributes.role', eq: 'guest' },
                  { fn: 'glob', args: { value: { ref: 'resource.path' }, pattern: 'x/*' } },
                ],
              },
            }),
            policy('members', {
              when: {
                any: [
                  { attr: 'principal.attributes.role', eq: 'member' },
                  { fn: 'glob', args: { value: { ref: 'resource.path' }, pattern: 'x/*' } },
                ],
              },
            }),
          ]),
        ],
      });
      const v = (await m.evaluate(req({ principal: guest }), ctx())) as Vote;
      expect(v.denyWhen).to.equal(FALSE);
      expect(v.permitWhen).to.equal(TRUE);
    });
  });

  describe('actor types (I5)', () => {
    it('an agent acting on its own meets an actorTypes policy', async () => {
      const agent = agentPrincipal('ag1', alice, { delegation: 'intersect' });
      const m = await model({ stores: [new MemoryPolicyStore([policy('agents-off', { effect: 'deny', permissions: ['*'], actorTypes: ['agent'] })])] });
      expect(((await m.evaluate(req({ principal: agent }), ctx())) as Vote).denyWhen).to.equal(TRUE);
      expect(((await m.evaluate(req(), ctx())) as Vote).denyWhen).to.equal(FALSE);
    });
  });

  describe('stores from config (I6)', () => {
    it('builds the stores authz.<name>.stores names, and refuses unknown names', async () => {
      const config = fakeModelInitContext({ config: { stores: ['ConfigPolicyStore', 'DbPolicyStore'], policies: [policy('read')] } });
      expect(storesFromConfig('abac', config).map((s) => s.constructor.name)).to.deep.equal(['ConfigPolicyStore', 'DbPolicyStore']);
      expect(storesFromConfig('abac', fakeModelInitContext({})).map((s) => s.constructor.name)).to.deep.equal(['ConfigPolicyStore']);
      const m = new AbacModel();
      await m.init(fakeModelInitContext({ permissions: registry(), config: { stores: ['ConfigPolicyStore'], policies: [policy('read')] } }));
      expect(((await m.evaluate(req(), ctx())) as Vote).permitWhen).to.equal(TRUE);
      let error: unknown;
      await new AbacModel().init(fakeModelInitContext({ permissions: registry(), config: { stores: ['Nope'] } })).catch((e) => (error = e));
      expect(error).to.be.instanceOf(AuthzConfigError);
      expect((error as Error).message).to.match(/authz\.abac\.stores names "Nope"/);
    });

    it('DbPolicyStore.put refuses a malformed policy or one that does not fit the columns (M6, M3)', async () => {
      const store = new DbPolicyStore(() => {
        throw new Error('never reached');
      });
      const tx = { driver: {} };
      let error: unknown;
      await store.put({ id: 'p', effect: 'permit', permissions: [] }, undefined, tx).catch((e) => (error = e));
      expect((error as Error).message).to.match(/permissions must be a non-empty list/);
      error = undefined;
      await store.put({ id: 'x'.repeat(65), effect: 'permit', permissions: ['file:read'] }, undefined, tx).catch((e) => (error = e));
      expect((error as Error).message).to.match(/id is longer than 64 characters/);
    });
  });
});
