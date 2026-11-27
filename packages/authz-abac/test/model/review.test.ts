import * as chai from 'chai';
import 'mocha';
import { Authorizer, AuthzConfigError, DefaultConditionCompiler, FALSE, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { DecisionRequest, EvaluationContext, Vote } from '@spinajs/authz';
import type { Policy } from '../../src/contracts.js';
import { StaticModel, agentPrincipal, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';

import { AbacModel, ConfigPolicyStore, DbPolicyStore, MemoryPolicyStore, PolicyStore, storesFromConfig } from '../../src/index.js';

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

/** A memory store that holds its next `hold` loads, each with the policies of its start, until released; `inside` plays a read inside a transaction. */
class HeldStore extends MemoryPolicyStore {
  hold = 0;
  loads = 0;
  inside = true;
  readonly held: (() => void)[] = [];

  override inTransaction(): boolean {
    return this.inside;
  }

  async load(): Promise<readonly Policy[]> {
    this.loads++;
    const policies = await super.load();
    if (this.hold > 0) {
      this.hold--;
      await new Promise<void>((resolve) => this.held.push(resolve));
    }
    return policies;
  }

  releaseAll(): void {
    for (const release of this.held) release();
  }
}

/** A third-party store that does not say whether its reads run inside a transaction; its next load can be held. */
class UnknownStore extends PolicyStore {
  readonly name = 'unknown';
  loads = 0;
  hold = false;
  release: () => void = () => undefined;

  constructor(private readonly policies: readonly Policy[]) {
    super();
  }

  async load(): Promise<readonly Policy[]> {
    this.loads++;
    if (this.hold) {
      this.hold = false;
      await new Promise<void>((resolve) => (this.release = resolve));
    }
    return this.policies;
  }

  async version(): Promise<string> {
    return '1';
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

  describe('checks share the reload outside a transaction and read for themselves inside one (tq-01h)', () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
    const denies = async (m: AbacModel): Promise<boolean> => (await m.evaluate(req(), ctx())).denyWhen === TRUE;
    const overlapping = (m: AbacModel, n: number) => {
      const state = { settled: 0 };
      const checks = Array.from({ length: n }, async () => {
        const denied = await denies(m);
        state.settled++;
        return denied;
      });
      return { state, all: () => Promise.all(checks) };
    };

    it('outside a transaction, overlapping checks wait for the one background reload: one read per invalidation', async () => {
      const store = new HeldStore([policy('read')]);
      store.inside = false;
      const m = await model({ stores: [store] });
      let loads = store.loads;
      for (let i = 0; i < 5; i++) await m.evaluate(req(), ctx());
      expect(store.loads - loads, 'reads per check when nothing is behind').to.equal(0);
      store.hold = 1;
      store.put(policy('no-read', { effect: 'deny' }));
      loads = store.loads;
      m.invalidate(['policy']);
      const ten = overlapping(m, 10);
      await settle();
      expect(ten.state.settled, 'checks settled before the reload landed').to.equal(0);
      store.releaseAll();
      expect(await ten.all()).to.deep.equal(Array.from({ length: 10 }, () => true));
      expect(store.loads - loads, 'reads for one invalidation and 10 overlapping checks').to.equal(1);
    });

    it('inside a transaction, each check reads the policies itself and the model keeps nothing it read', async () => {
      const store = new HeldStore([policy('read')]);
      const m = await model({ stores: [store] });
      store.hold = 1;
      store.put(policy('no-read', { effect: 'deny' }));
      m.invalidate(['policy']);
      let loads = store.loads;
      const ten = overlapping(m, 10);
      await settle();
      expect(ten.state.settled, 'checks that waited for the held background reload').to.equal(10);
      expect(await ten.all()).to.deep.equal(Array.from({ length: 10 }, () => true));
      expect(store.loads - loads, 'reads of 10 overlapping checks inside a transaction').to.equal(10);
      loads = store.loads;
      expect(await denies(m)).to.equal(true);
      expect(store.loads - loads, 'a later check inside reads again: nothing was kept').to.equal(1);
      expect(m.version()).to.match(/~$/);
      store.releaseAll();
      await settle();
      loads = store.loads;
      expect(await denies(m)).to.equal(true);
      expect(store.loads - loads, 'reads once the background reload landed').to.equal(0);
      expect(m.version()).to.not.match(/~$/);
    });

    it('a check inside a transaction evaluates on the read it started, and the next one reads again after an invalidation', async () => {
      const store = new HeldStore([policy('read')]);
      const m = await model({ stores: [store] });
      store.hold = 2;
      m.invalidate(['policy']);
      const first = denies(m);
      await settle();
      store.put(policy('no-read', { effect: 'deny' }));
      m.invalidate(['policy:no-read']);
      store.held[1]();
      expect(await first, 'a check evaluates on the read it started').to.equal(false);
      expect(await denies(m), 'the next check after the invalidation').to.equal(true);
      store.releaseAll();
    });

    it('the background reload, not a check inside a transaction, makes the model current', async () => {
      const store = new HeldStore([policy('read')]);
      const m = await model({ stores: [store] });
      store.hold = 1;
      m.invalidate(['policy']);
      store.put(policy('no-read', { effect: 'deny' }));
      m.invalidate(['policy:no-read']);
      expect(await denies(m)).to.equal(true);
      expect(m.version()).to.match(/~$/);
      store.releaseAll();
      await settle();
      store.inside = false;
      expect(await denies(m)).to.equal(true);
      expect(m.version()).to.not.match(/~$/);
    });

    it('a store that does not say whether it is in a transaction counts as inside: each check reads itself, nothing is kept', async () => {
      const store = new UnknownStore([policy('no-read', { effect: 'deny' })]);
      const m = await model({ stores: [store] });
      store.hold = true;
      m.invalidate(['policy']);
      let loads = store.loads;
      const three = overlapping(m, 3);
      await settle();
      expect(three.state.settled, 'checks that waited for the held background reload').to.equal(3);
      expect(await three.all()).to.deep.equal([true, true, true]);
      expect(store.loads - loads, 'reads of three overlapping checks').to.equal(3);
      loads = store.loads;
      expect(await denies(m)).to.equal(true);
      expect(store.loads - loads, 'a later check reads again: nothing was kept').to.equal(1);
      store.release();
      await settle();
      loads = store.loads;
      expect(await denies(m)).to.equal(true);
      expect(store.loads - loads, 'reads once the background reload landed').to.equal(0);
    });

    for (const inside of [false, true]) {
      it(`a failed read fails the check, never an empty policy set, and the next check reads again (${inside ? 'inside' : 'outside'} a transaction)`, async () => {
        const store = new HeldStore([policy('no-read', { effect: 'deny' })]);
        store.inside = inside;
        const m = await model({ stores: [store] });
        const load = MemoryPolicyStore.prototype.load.bind(store);
        let down = true;
        store.load = async () => {
          if (down) throw new Error('db down');
          return load();
        };
        m.invalidate(['policy']);
        const failure = await Promise.resolve(m.evaluate(req(), ctx())).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(failure).to.be.instanceOf(Error);
        down = false;
        expect(await denies(m)).to.equal(true);
      });

      it(`through the engine, a read that hangs denies with model_error at modelTimeoutMs (${inside ? 'inside' : 'outside'} a transaction)`, async () => {
        const reg = registry();
        const store = new HeldStore([policy('read')]);
        store.inside = inside;
        const m = await model({ stores: [store] }, reg);
        const a = new Authorizer({ domain: 'root', models: [m], registry: reg, conditions: new DefaultConditionCompiler(), clock: () => NOW, config: { modelTimeoutMs: 30 } });
        store.hold = 2;
        a.invalidate(['policy']);
        const d = await a.check({ principal: alice, permission: 'file:read', resource: F1 });
        expect([d.allowed, d.reason?.code]).to.deep.equal([false, 'model_error']);
        store.releaseAll();
      });
    }
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

  describe('final review', () => {
    it('validate() refuses what would break a reload: an unknown function or permission, an id another store holds (I-1)', async () => {
      const m = await model({ stores: [new ConfigPolicyStore([policy('cfg')]), new MemoryPolicyStore([policy('mem')])] });
      expect(() => m.validate({ id: 'new', effect: 'permit', permissions: ['file:read'] })).not.to.throw();
      expect(() => m.validate({ id: 'mem', effect: 'deny', permissions: ['file:read'] }, 'memory')).not.to.throw();
      expect(() => m.validate({ id: 'cfg', effect: 'permit', permissions: ['file:read'] })).to.throw(AuthzConfigError, /already used by a policy from store "config"/);
      expect(() => m.validate({ id: 'x', effect: 'permit', permissions: ['ghost:read'] })).to.throw(AuthzConfigError, /ghost:read/);
      expect(() => m.validate({ id: 'x', effect: 'permit', permissions: ['file:read'], when: { fn: 'nope' } })).to.throw(AuthzConfigError, /unknown condition function "nope"/);
    });

    it('a disposed model neither reloads nor retries (m3)', async () => {
      const store = new MemoryPolicyStore([policy('read')]);
      const m = await model({ stores: [store], retryMs: 2 });
      let loads = 0;
      store.load = async () => {
        loads++;
        throw new Error('db down');
      };
      await m.dispose();
      m.invalidate(['policy']);
      await new Promise((r) => setTimeout(r, 20));
      expect(loads).to.equal(0);
    });

    it('summarize unites the field sets of every permit, conditional ones too (m5, E1 review I1)', async () => {
      const m = await model({ stores: [new MemoryPolicyStore([policy('a', { fields: { read: ['name'] } }), policy('b', { fields: { read: ['email'] } }), policy('c', { when: { attr: 'resource.x', eq: 1 }, fields: { read: ['phone'] } })])] });
      const s = await m.summarize(alice, { type: '$global' }, ctx());
      expect(s.permissions).to.deep.equal([{ name: 'file:read', conditional: false, fields: { read: ['email', 'name', 'phone'], write: [] } }]);
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
      await new AbacModel().init(fakeModelInitContext({ permissions: registry(), config: { stores: ['Nope'] } })).catch((e: unknown) => {
        error = e;
      });
      expect(error).to.be.instanceOf(AuthzConfigError);
      expect((error as Error).message).to.match(/authz\.abac\.stores names "Nope"/);
    });

    it('refuses authz.<name>.connection at init, naming db.Aliases.authz', async () => {
      for (const name of ['abac', 'tenant-abac']) {
        let error: unknown;
        await new AbacModel({ name, stores: [] }).init(fakeModelInitContext({ permissions: registry(), config: { connection: 'reporting' } })).catch((e: unknown) => {
          error = e;
        });
        expect(error, name).to.be.instanceOf(AuthzConfigError);
        expect((error as Error).message).to.equal(`authz.${name}.connection: removed; the authz tables use the ORM connection alias "authz", so set db.Aliases.authz to the connection name instead (default: "default")`);
      }
    });

    it('DbPolicyStore.put refuses a malformed policy or one that does not fit the columns (M6, M3)', async () => {
      const store = new DbPolicyStore();
      const tx = { driver: {} };
      let error: unknown;
      await store.put({ id: 'p', effect: 'permit', permissions: [] }, undefined, tx).catch((e: unknown) => {
        error = e;
      });
      expect((error as Error).message).to.match(/permissions must be a non-empty list/);
      error = undefined;
      await store.put({ id: 'x'.repeat(65), effect: 'permit', permissions: ['file:read'] }, undefined, tx).catch((e: unknown) => {
        error = e;
      });
      expect((error as Error).message).to.match(/id is longer than 64 characters/);
    });
  });
});
