import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';

import { AuthorizationModel, AuthzAdminFailure, AuthzConfigError, AuthzWriteHandler, MemoryAuthzAdminBackend, SYSTEM } from '@spinajs/authz';
import type { AuthzCommand, AuthzTx } from '@spinajs/authz';

import { AbacModel, AbacPolicyHandler, ConfigPolicyStore, MemoryPolicyStore, PolicyStore } from '../../src/index.js';
import { F1, G, HOUR, P1, P2, START, TestGuard, abacDomain, del, failure, installHost, instance, ok, policy, put, rejection, resetHost, snapshot, stored, uninstallHost } from './support.js';
import type { AbacDomain } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const dave = userPrincipal('dave');

describe('ABAC policy commands through AuthzAdmin', function () {
  this.timeout(20000);
  let d: AbacDomain;

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
  });

  describe('policy.put', () => {
    beforeEach(async () => {
      d = await abacDomain();
    });

    it('stores the policy in the writable store, tags it and emits PolicyChanged', async () => {
      const [r] = ok(await d.admin.execute(alice, [put(policy('p1', { scope: P1, reason: 'test' }))]));
      expect(r).to.deep.equal({ ok: true, kind: 'policy.put', id: 'p1', affected: 1 });
      expect(await snapshot(d.store)).to.deep.equal({ p1: stored('p1', { scope: P1, reason: 'test' }) });
      expect([...d.bus.published[0].tags].sort()).to.deep.equal(['policy', 'policy:p1']);
      expect(d.sink.events.map((e) => [e.type, e.data, e.actor])).to.deep.equal([['PolicyChanged', { id: 'p1', scope: P1, op: 'put' }, { type: 'user', id: 'alice' }]]);
      expect(d.audit.entries.filter((e) => e.kind === 'admin').map((e) => [e.permission, e.resource])).to.deep.equal([['authz:policies.manage', P1]]);
    });

    it('a policy without scope is checked at GLOBAL and its event has no scope', async () => {
      ok(await d.admin.execute(alice, [put(policy('p1'))]));
      expect(d.audit.entries.filter((e) => e.kind === 'admin').map((e) => e.resource)).to.deep.equal([G]);
      expect(d.sink.events[0].data).to.deep.equal({ id: 'p1', op: 'put' });
      expect(failure(await d.admin.execute(bob, [put(policy('p2'))]))).to.deep.equal({ at: 0, code: 'forbidden' });
    });

    it('changes the next decision: the model reloads on policy:<id>', async () => {
      expect(await d.service.can(dave, 'file:read', F1)).to.equal(false);
      await d.admin.putPolicy(alice, policy('open'));
      expect(await d.service.can(dave, 'file:read', F1)).to.equal(true);
      await d.admin.putPolicy(alice, policy('shut', { effect: 'deny' }));
      expect(await d.service.can(dave, 'file:read', F1)).to.equal(false);
      await d.admin.deletePolicy(alice, 'shut');
      expect(await d.service.can(dave, 'file:read', F1)).to.equal(true);
    });

    it('replaces a policy with the same id', async () => {
      ok(await d.admin.execute(alice, [put(policy('p1', { scope: P1 }))]));
      const [r] = ok(await d.admin.execute(alice, [put(policy('p1', { scope: P1, effect: 'deny', permissions: ['file:edit'] }))]));
      expect(r.affected).to.equal(1);
      expect(await snapshot(d.store)).to.deep.equal({ p1: stored('p1', { scope: P1, effect: 'deny', permissions: ['file:edit'] }) });
    });

    it('a replace that moves the scope needs the permission at the old scope too', async () => {
      ok(await d.admin.execute(alice, [put(policy('p1', { scope: P2 }))]));
      // bob manages policies at p1 only: he may not pull a p2 policy over to p1.
      expect(failure(await d.admin.execute(bob, [put(policy('p1', { scope: P1 }))]))).to.deep.equal({ at: 0, code: 'forbidden' });
      expect((await snapshot(d.store)).p1.scope).to.deep.equal(P2);
      // Nor push one of his own out of reach, which the core's check at the new scope already refuses.
      ok(await d.admin.execute(alice, [put(policy('mine', { scope: P1 }))]));
      expect(failure(await d.admin.execute(bob, [put(policy('mine', { scope: P2 }))]))).to.deep.equal({ at: 0, code: 'forbidden' });
      // alice holds both.
      ok(await d.admin.execute(alice, [put(policy('p1', { scope: P1 }))]));
      expect((await snapshot(d.store)).p1.scope).to.deep.equal(P1);
      // A replace in place needs nothing more.
      ok(await d.admin.execute(bob, [put(policy('p1', { scope: P1, effect: 'deny' }))]));
    });

    it('a conditional allow at the new scope is forbidden', async () => {
      expect(failure(await d.admin.execute(carol, [put(policy('p1', { scope: P1 }))]))).to.deep.equal({ at: 0, code: 'forbidden' });
    });

    it('refuses malformed policies with invalid_command and the field', async () => {
      const refused = async (c: AuthzCommand) => failure(await d.admin.execute(SYSTEM, [c]));
      expect(await refused({ kind: 'policy.put', policy: null as never })).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy' });
      expect(await refused(put(policy('')))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.id' });
      expect(await refused(put(policy(7 as never)))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.id' });
      expect(await refused(put(policy('x'.repeat(65))))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.id' });
      expect(await refused(put(policy('p1', { effect: 'allow' as never })))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.effect' });
      expect(await refused(put(policy('p1', { permissions: [] })))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.permissions' });
      expect(await refused(put(policy('p1', { permissions: 'file:read' as never })))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.permissions' });
      expect(await refused(put(policy('p1', { priority: 1.5 })))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.priority' });
      expect(await refused(put(policy('p1', { scope: { type: 'project', id: '' } })))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.scope' });
      expect(await refused(put(policy('p1', { fields: { hide: ['email'] } })))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.fields' });
      expect(await refused(put({ ...policy('p1'), colour: 'red' } as never))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.colour' });
      expect(await refused(put({ ...policy('p1'), source: 'db' } as never))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.source' });
      expect(await snapshot(d.store)).to.deep.equal({});
    });

    it('refuses an expiry that is not a future Date', async () => {
      const refused = async (expiresAt: unknown) => failure(await d.admin.execute(SYSTEM, [put(policy('p1', { expiresAt: expiresAt as Date }))]));
      expect(await refused(START)).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.expiresAt' });
      expect(await refused(new Date(START.getTime() - HOUR))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.expiresAt' });
      expect(await refused(new Date(NaN))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.expiresAt' });
      expect(await refused(new Date(START.getTime() + HOUR).toISOString())).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.expiresAt' });
      ok(await d.admin.execute(SYSTEM, [put(policy('p1', { expiresAt: new Date(START.getTime() + HOUR) }))]));
      ok(await d.admin.execute(SYSTEM, [put(policy('p2', { expiresAt: null }))]));
      expect((await snapshot(d.store)).p1.expiresAt?.getTime()).to.equal(START.getTime() + HOUR);
    });

    it('refuses an unregistered permission (unknown_permission) and accepts globs the model can match', async () => {
      expect(failure(await d.admin.execute(SYSTEM, [put(policy('p1', { permissions: ['file:read', 'ghost:read'] }))]))).to.deep.equal({ at: 0, code: 'unknown_permission', field: 'policy.permissions' });
      expect(failure(await d.admin.execute(SYSTEM, [put(policy('p1', { permissions: ['not a permission'] }))]))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.permissions' });
      ok(await d.admin.execute(SYSTEM, [put(policy('p1', { permissions: ['file:*'] }))]));
    });

    it('refuses a condition that does not parse or calls an unknown function (rule_not_compilable)', async () => {
      expect(failure(await d.admin.execute(SYSTEM, [put(policy('p1', { when: { attr: 'resource.status', bogus: 'x' } as never }))]))).to.deep.equal({ at: 0, code: 'rule_not_compilable', field: 'policy.when' });
      expect(failure(await d.admin.execute(SYSTEM, [put(policy('p1', { when: { fn: 'no.such.fn' } }))]))).to.deep.equal({ at: 0, code: 'rule_not_compilable', field: 'policy.when' });
      ok(await d.admin.execute(SYSTEM, [put(policy('p1', { when: { attr: 'principal.id', eq: 'alice' } }))]));
      expect(await d.service.can(alice, 'file:read', F1)).to.equal(true);
      expect(await d.service.can(dave, 'file:read', F1)).to.equal(false);
    });

    it('stores what the command says, not a reference to it', async () => {
      const p = { ...policy('p1'), permissions: ['file:read'] };
      ok(await d.admin.execute(SYSTEM, [put(p)]));
      p.permissions.push('file:edit');
      expect((await snapshot(d.store)).p1.permissions).to.deep.equal(['file:read']);
    });
  });

  describe('policy ids held by another store', () => {
    it('refuses an id a config policy of the model already uses', async () => {
      d = await abacDomain('test', { configPolicies: [{ ...stored('cfg'), source: 'config' }] });
      expect(failure(await d.admin.execute(SYSTEM, [put(policy('cfg'))]))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.id' });
      expect(failure(await d.admin.execute(SYSTEM, [del('cfg')]))).to.deep.equal({ at: 0, code: 'not_found', field: 'id' });
    });
  });

  describe('policy.delete', () => {
    beforeEach(async () => {
      d = await abacDomain('test', { policies: [stored('p1', { scope: P1 }), stored('p2', { scope: P2 }), stored('g')] });
    });

    it('removes the policy, tags it and emits PolicyChanged', async () => {
      const [r] = ok(await d.admin.execute(bob, [del('p1')]));
      expect(r).to.deep.equal({ ok: true, kind: 'policy.delete', id: 'p1', affected: 1 });
      expect(Object.keys(await snapshot(d.store))).to.deep.equal(['p2', 'g']);
      expect([...d.bus.published[0].tags].sort()).to.deep.equal(['policy', 'policy:p1']);
      expect(d.sink.events.map((e) => [e.type, e.data])).to.deep.equal([['PolicyChanged', { id: 'p1', scope: P1, op: 'delete' }]]);
    });

    it('is checked at the stored row scope', async () => {
      expect(failure(await d.admin.execute(bob, [del('p2')]))).to.deep.equal({ at: 0, code: 'forbidden' });
      expect(failure(await d.admin.execute(bob, [del('g')]))).to.deep.equal({ at: 0, code: 'forbidden' });
      ok(await d.admin.execute(alice, [del('g')]));
      expect(d.audit.entries.filter((e) => e.kind === 'admin').map((e) => e.resource)).to.deep.equal([G]);
    });

    it('refuses an unknown or malformed id', async () => {
      expect(failure(await d.admin.execute(SYSTEM, [del('nope')]))).to.deep.equal({ at: 0, code: 'not_found', field: 'id' });
      expect(failure(await d.admin.execute(SYSTEM, [del('' as never)]))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'id' });
      expect(((await rejection(d.admin.deletePolicy(alice, 'nope'))) as AuthzAdminFailure).code).to.equal('not_found');
    });

    it('a delete of what an earlier command of the batch removed affects nothing, with no tag or event', async () => {
      const results = ok(await d.admin.execute(SYSTEM, [del('p1'), del('p1')]));
      expect(results.map((r) => r.affected)).to.deep.equal([1, 0]);
      expect(d.sink.events.length).to.equal(1);
      expect([...d.bus.published[0].tags].sort()).to.deep.equal(['policy', 'policy:p1']);
    });
  });

  describe('transactions', () => {
    beforeEach(async () => {
      d = await abacDomain('test', { policies: [stored('old', { scope: P1 }), stored('gone', { scope: P1 })] });
    });

    it('a batch that fails in apply leaves the store as it was and publishes nothing', async () => {
      const before = await snapshot(d.store);
      TestGuard.refuse = (c) => c.kind === 'policy.put' && c.policy.id === 'stop';
      const results = await d.admin.execute(alice, [put(policy('new', { scope: P1 })), put(policy('old', { scope: P1, effect: 'deny' })), del('gone'), put(policy('stop'))]);
      expect(failure(results)).to.deep.equal({ at: 3, code: 'escalation' });
      expect(await snapshot(d.store)).to.deep.equal(before);
      expect(d.bus.published).to.deep.equal([]);
      expect(d.sink.events).to.deep.equal([]);
    });

    it('scope.forget rolls back with the batch', async () => {
      const before = await snapshot(d.store);
      TestGuard.refuse = (c) => c.kind === 'policy.delete';
      expect(failure(await d.admin.execute(alice, [{ kind: 'scope.forget', scope: P1 }, del('old')])).at).to.equal(1);
      expect(await snapshot(d.store)).to.deep.equal(before);
    });

    it('a dry run validates and rolls back', async () => {
      const before = await snapshot(d.store);
      const [r] = ok(await d.admin.execute(alice, [put(policy('new'))], { dryRun: true }));
      expect(r.affected).to.equal(1);
      expect(await snapshot(d.store)).to.deep.equal(before);
      expect(d.bus.published).to.deep.equal([]);
    });

    it('the memory store refuses a transaction that is not a memory one', async () => {
      const before = await snapshot(d.store);
      const h = new AbacPolicyHandler();
      expect(await rejection(h.apply(put(policy('new')), d.context(), { driver: {} }))).to.be.instanceOf(AuthzConfigError);
      expect(await rejection(h.apply(del('old'), d.context(), { driver: {} }))).to.be.instanceOf(AuthzConfigError);
      expect(await snapshot(d.store)).to.deep.equal(before);
    });

    // Phase A runs outside the transaction, so another batch can move the policy before apply runs.
    describe('a policy moved by another batch between validate and apply', () => {
      const h = new AbacPolicyHandler();
      const inTx = <T>(fn: (tx: AuthzTx) => Promise<T>): Promise<T> => new MemoryAuthzAdminBackend().transaction('test', fn);

      it('a delete is checked again at the scope the row has now', async () => {
        const ctx = d.context(bob);
        await h.validate(del('old'), ctx);
        expect((await h.permission(del('old'), ctx)).resource).to.deep.equal(P1);
        d.store.put(stored('old', { scope: P2 }));
        const e = (await rejection(inTx((tx) => h.apply(del('old'), ctx, tx)))) as AuthzAdminFailure;
        expect(e).to.be.instanceOf(AuthzAdminFailure);
        expect(e.code).to.equal('forbidden');
        expect((await snapshot(d.store)).old).to.deep.equal(stored('old', { scope: P2 }));
      });

      it('a put is checked again at the scope the row has now', async () => {
        const ctx = d.context(bob);
        const c = put(policy('old', { scope: P1, effect: 'deny' }));
        await h.validate(c, ctx);
        d.store.put(stored('old', { scope: P2 }));
        expect(((await rejection(inTx((tx) => h.apply(c, ctx, tx)))) as AuthzAdminFailure).code).to.equal('forbidden');
        expect((await snapshot(d.store)).old).to.deep.equal(stored('old', { scope: P2 }));
        // alice manages both scopes.
        await inTx((tx) => h.apply(c, d.context(alice), tx));
        expect((await snapshot(d.store)).old).to.deep.equal(stored('old', { scope: P1, effect: 'deny' }));
      });
    });
  });

  describe('stored form', () => {
    beforeEach(async () => {
      d = await abacDomain();
    });

    it('stores and emits the scope as scopeOf gives it: none for GLOBAL, no null id', async () => {
      ok(await d.admin.execute(SYSTEM, [put(policy('g', { scope: G })), put(policy('t', { scope: { type: 'project', id: null as never } }))]));
      const rows = await snapshot(d.store);
      expect(rows.g).to.deep.equal(stored('g'));
      expect(rows.t).to.deep.equal(stored('t', { scope: { type: 'project' } }));
      expect(d.sink.events.map((e) => e.data)).to.deep.equal([
        { id: 'g', op: 'put' },
        { id: 't', scope: { type: 'project' }, op: 'put' },
      ]);
    });

    it('stored rows are frozen and list() hands out copies', async () => {
      ok(await d.admin.execute(SYSTEM, [put(policy('p1', { scope: P1 }))]));
      const [row] = await d.store.load();
      expect(Object.isFrozen(row) && Object.isFrozen(row.permissions) && Object.isFrozen(row.scope)).to.equal(true);
      const [item] = (await d.admin.list(alice, { kind: 'policies' })).items as { permissions: string[] }[];
      item.permissions.push('ghost:read');
      expect((await d.store.load())[0].permissions).to.deep.equal(['file:read']);
    });
  });

  describe('store and model lookup', () => {
    it('is registered as the AuthzWriteHandler of policy.put and policy.delete', async () => {
      d = await abacDomain();
      const handlers = (await d.container.resolve(Array.chainOf(AuthzWriteHandler))) as AuthzWriteHandler[];
      expect(handlers.filter((h) => h instanceof AbacPolicyHandler).map((h) => [...h.kinds])).to.deep.equal([['policy.put', 'policy.delete']]);
    });

    it('ignores a config store registered beside the writable one', async () => {
      d = await abacDomain('test', { register: (c) => c.register(instance(new ConfigPolicyStore([]))).as(PolicyStore) });
      ok(await d.admin.execute(SYSTEM, [put(policy('p1'))]));
    });

    it('rejects without a writable PolicyStore, or with two', async () => {
      d = await abacDomain('test', { without: ['store'] });
      expect(await rejection(d.admin.execute(SYSTEM, [put(policy('p1'))]))).to.be.instanceOf(AuthzConfigError);
      await resetHost();
      d = await abacDomain('test', { register: (c) => c.register(instance(new MemoryPolicyStore())).as(PolicyStore) });
      const e = await rejection(d.admin.execute(SYSTEM, [put(policy('p1'))]));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect(e.message).to.match(/more than one writable PolicyStore/);
    });

    it('rejects a put without an AbacModel in the domain; a delete needs none', async () => {
      d = await abacDomain('test', { without: ['model'], policies: [stored('p1')] });
      const e = await rejection(d.admin.execute(SYSTEM, [put(policy('p2'))]));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect(e.message).to.match(/no AbacModel/);
      ok(await d.admin.execute(SYSTEM, [del('p1')]));
    });

    it('validates against every AbacModel of the domain', async () => {
      const other = new AbacModel({ name: 'abac2', stores: [new ConfigPolicyStore([{ ...stored('cfg2'), source: 'config' }])] });
      d = await abacDomain('test', { register: (c) => c.register(instance(other)).as(AuthorizationModel) });
      expect(failure(await d.admin.execute(SYSTEM, [put(policy('cfg2'))]))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'policy.id' });
      ok(await d.admin.execute(SYSTEM, [put(policy('p1'))]));
    });
  });
});
