import { AuthzConfigError, FALSE, GLOBAL, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, ResourceRef, Vote } from '@spinajs/authz';
import { ManualClock, fakeEvaluationContext, fakeModelInitContext, servicePrincipal, userPrincipal, withCompanions } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, RbacModel, subjectKey } from '../../src/index.js';
import type { RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const FILES: ResourceRef = { type: 'file' };
const f1: ResourceRef = { type: 'file', id: 'f1' };
const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const bot = userPrincipal('bot');

const role = (name: string, grants: readonly string[]): RoleDef => ({ name, extends: [], assignable: true, source: 'test', grants: grants.map((permission) => ({ permission })) });
const assignment = (id: string, who: { type: string; id: string }, roleName: string): Assignment => ({ id, subject: { type: who.type, id: who.id }, role: roleName, scope: GLOBAL, source: 'test' });

class CountingStore extends MemoryAssignmentStore {
  readonly reads: string[][] = [];
  failures = 0;

  override async forSubjects(subjects: readonly AssignmentSubject[], at: Date): Promise<readonly Assignment[]> {
    this.reads.push(subjects.map(subjectKey));
    if (this.failures > 0) {
      this.failures--;
      throw new Error('assignment store unavailable');
    }
    return super.forSubjects(subjects, at);
  }
}

const isThenable = (v: unknown): boolean => typeof (v as { then?: unknown } | null)?.then === 'function';

async function setup(opts: { assignments?: readonly Assignment[]; config?: Record<string, unknown> } = {}) {
  const registry = new PermissionRegistryImpl();
  registry.register([{ name: 'file:read' }], 'test');
  registry.freeze();
  const store = new CountingStore(opts.assignments ?? [assignment('a1', alice, 'viewer')]);
  const clock = new ManualClock(NOW);
  const model = new RbacModel({ roles: new MemoryRoleStore([role('viewer', ['file:read'])]), assignments: store, clock, log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', config: opts.config ?? {}, permissions: registry }));
  return { model, store, clock };
}

const ctx = (now: Date = NOW) => fakeEvaluationContext({ now });
const list = (principal = alice) => ({ principal, permission: 'file:read', resource: FILES });

/** The vote when evaluate answers without IO; fails the test otherwise. */
const syncVote = (v: Vote | Promise<Vote>): Vote => {
  expect(isThenable(v), 'evaluate answered with a promise').to.equal(false);
  return v as Vote;
};

describe('authz-rbac model: preload and the assignment cache', () => {
  it('a type-level request answers synchronously after preload, in the preloaded context and in a fresh one (B22)', async () => {
    const { model, store } = await setup();
    const c = ctx();
    await model.preload(alice, c);
    expect(store.reads).to.deep.equal([['user:alice']]);
    expect(syncVote(model.evaluate(list(), c)).permitWhen).to.deep.equal(TRUE);
    expect(syncVote(model.evaluate(list(), ctx())).permitWhen).to.deep.equal(TRUE);
    expect(store.reads).to.have.length(1);
  });

  it('a principal without assignments preloads to a synchronous no_access, never a guess', async () => {
    const { model } = await setup();
    await model.preload(bob, ctx());
    const vote = syncVote(model.evaluate(list(bob), ctx()));
    expect(vote.permitWhen).to.deep.equal(FALSE);
    expect(vote.reason?.code).to.equal('no_access');
  });

  it('without preload a type-level request answers with a promise; a concrete request always does', async () => {
    const { model } = await setup();
    const before = model.evaluate(list(), ctx());
    expect(isThenable(before)).to.equal(true);
    expect((await before).permitWhen).to.deep.equal(TRUE);
    await model.preload(alice, ctx());
    expect(isThenable(model.evaluate({ principal: alice, permission: 'file:read', resource: f1 }, ctx()))).to.equal(true);
  });

  it('the synchronous vote after preload equals the awaited vote of a fresh model', async () => {
    const assignments = [assignment('a1', alice, 'viewer')];
    const { model } = await setup({ assignments });
    await model.preload(alice, ctx());
    const { model: fresh } = await setup({ assignments });
    for (const who of [alice, bob]) {
      await model.preload(who, ctx());
      expect(syncVote(model.evaluate(list(who), ctx()))).to.deep.equal(await fresh.evaluate(list(who), ctx()));
    }
  });

  it('preload reads the principal and its companions in one store read; a later request of the companion reads nothing', async () => {
    const { model, store } = await setup({ assignments: [assignment('b1', bot, 'viewer')] });
    await model.preload(withCompanions(alice, [bot]), ctx());
    expect(store.reads).to.deep.equal([['user:alice', 'user:bot']]);
    expect(syncVote(model.evaluate(list(withCompanions(alice, [bot])), ctx())).permitWhen).to.deep.equal(TRUE);
    expect(syncVote(model.evaluate(list(bot), ctx())).permitWhen).to.deep.equal(TRUE);
    expect(syncVote(model.evaluate(list(alice), ctx())).permitWhen).to.deep.equal(FALSE);
    expect(store.reads).to.have.length(1);
  });

  it('the TTL is authz.rbac.cache.assignmentsTtlSeconds on the model clock', async () => {
    const { model, store, clock } = await setup({ config: { cache: { assignmentsTtlSeconds: 10 } } });
    await model.preload(alice, ctx());
    clock.advance(9_999);
    syncVote(model.evaluate(list(), ctx()));
    clock.advance(1);
    const later = model.evaluate(list(), ctx());
    expect(isThenable(later)).to.equal(true);
    await later;
    expect(store.reads).to.have.length(2);
  });

  it('the cached rows answer until invalidate(subject:<key>), and the next request sees the change', async () => {
    const { model, store } = await setup({ assignments: [] });
    await model.preload(alice, ctx());
    store.add(assignment('a1', alice, 'viewer'));
    expect(syncVote(model.evaluate(list(), ctx())).permitWhen).to.deep.equal(FALSE);
    model.invalidate(['subject:user:alice']);
    expect(isThenable(model.evaluate(list(), ctx()))).to.equal(true);
    expect((await model.evaluate(list(), ctx())).permitWhen).to.deep.equal(TRUE);
  });

  it('an invalidate during a request drops what that request preloaded', async () => {
    const { model, store } = await setup();
    const c = ctx();
    await model.preload(alice, c);
    store.remove('a1');
    model.invalidate(['model:rbac']);
    expect((await model.evaluate(list(), c)).permitWhen).to.deep.equal(FALSE);
  });

  it('a failed preload rejects and caches nothing; the next request reads the store again', async () => {
    const { model, store } = await setup();
    store.failures = 1;
    const c = ctx();
    const err = await model.preload(alice, c).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).to.equal('assignment store unavailable');
    const next = model.evaluate(list(), c);
    expect(isThenable(next)).to.equal(true);
    expect((await next).permitWhen).to.deep.equal(TRUE);
    expect(store.reads).to.have.length(2);
  });

  it('a check whose load fails rejects rather than voting no', async () => {
    const { model, store } = await setup();
    store.failures = 1;
    const err = await Promise.resolve(model.evaluate(list(), ctx())).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).to.equal('assignment store unavailable');
  });

  it('config roles come from config on every request, not from the cache', async () => {
    const { model } = await setup({ assignments: [], config: { serviceRoles: { 'service:telemetry': ['viewer'] } } });
    const principal = servicePrincipal('telemetry');
    await model.preload(principal, ctx());
    expect(syncVote(model.evaluate(list(principal), ctx())).permitWhen).to.deep.equal(TRUE);
  });

  it('refuses an assignmentsTtlSeconds that is not a finite number at init (an unvalidated configuration)', async () => {
    for (const cache of [{ assignmentsTtlSeconds: 'soon' }, { assignmentsTtlSeconds: Infinity }, { assignmentsTtlSeconds: {} }]) {
      const err = await setup({ config: { cache } }).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err, JSON.stringify(cache)).to.be.instanceOf(AuthzConfigError);
      expect(err?.message).to.contain('authz.rbac.cache.assignmentsTtlSeconds');
    }
  });

  it('preload before init throws AuthzConfigError; invalidate before init does nothing', async () => {
    const m = new RbacModel({ roles: new MemoryRoleStore([]), assignments: new MemoryAssignmentStore() });
    const err = await m.preload(alice, ctx()).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect(() => m.invalidate(['model:rbac'])).to.not.throw();
  });
});
