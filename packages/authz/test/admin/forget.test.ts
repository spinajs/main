import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';

import { AuthzConfigError, AuthzContributor, GLOBAL, MemoryScopeAttributeStore, ScopeAttributeStore, ScopeForgetHandler, ScopeForgetter, WritableScopeAttributeStore, memoryTx } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, AuthzEvent, AuthzTx, ResourceRef } from '@spinajs/authz';
import { adminConfig, adminDomain, installHost, instance, rejection, resetHost, uninstallHost } from './support.js';
import type { AdminDomain } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const p1: ResourceRef = { type: 'project', id: 'p1' };
const p2: ResourceRef = { type: 'project', id: 'p2' };
const forget = (scope: ResourceRef): AuthzCommand => ({ kind: 'scope.forget', scope });

/** Holds rows per scope key; forget removes the rows AT the scope, undoable. */
class RowForgetter extends ScopeForgetter {
  readonly rows = new Map<string, string[]>([
    ['project:p1', ['r1', 'r2']],
    ['project:p2', ['r3']],
  ]);
  readonly seen: { scope: ResourceRef; ctx: AdminContext }[] = [];

  async forget(scope: ResourceRef, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    this.seen.push({ scope, ctx });
    const key = `${scope.type}:${scope.id}`;
    const gone = this.rows.get(key) ?? [];
    this.rows.delete(key);
    memoryTx(tx).onRollback(() => this.rows.set(key, gone));
    return { affected: gone.length, tags: gone.map((r) => `rule:${r}`), events: gone.map((id) => ({ type: 'RuleChanged', data: { id, op: 'delete' } }) as unknown as AuthzEvent) };
  }
}

class BrokenForgetter extends ScopeForgetter {
  static answer: unknown = { affected: -1 };
  async forget(): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    return BrokenForgetter.answer as never;
  }
}

class OtherForgetter extends ScopeForgetter {
  async forget(scope: ResourceRef): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    return { affected: 2, tags: [`link:${scope.id}`], events: [{ type: 'LinkRevoked', data: { id: 'l1' } } as unknown as AuthzEvent] };
  }
}

const SCHEMA = { scopeType: 'project', schema: { type: 'object' }, defaults: {} };

async function domain(opts: { forgetter?: RowForgetter; store?: MemoryScopeAttributeStore; extra?: (c: AdminDomain['container']) => void } = {}): Promise<AdminDomain> {
  return adminDomain('test', {
    register(c) {
      if (opts.forgetter) c.register(instance(opts.forgetter)).as(ScopeForgetter);
      if (opts.store) {
        c.register(instance(opts.store)).as(ScopeAttributeStore);
        c.register(instance(opts.store)).as(WritableScopeAttributeStore);
        c.register(instance({ contribute: () => ({ scopeAttributeSchemas: [SCHEMA] }) })).as(AuthzContributor);
      }
      opts.extra?.(c);
    },
  });
}

describe('scope.forget', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    adminConfig();
  });

  it('is handled by the core ScopeForgetHandler', () => {
    expect(new ScopeForgetHandler().kinds).to.deep.equal(['scope.forget']);
  });

  it('runs every forgetter and removes the attributes at the node only, with one change and a ScopeForgotten event', async () => {
    const forgetter = new RowForgetter();
    const store = new MemoryScopeAttributeStore({ values: [{ scope: p1, attributes: { a: 1, b: { c: true } } }, { scope: p2, attributes: { a: 2 } }] });
    const d = await domain({ forgetter, store });
    const out = await d.admin.execute(alice, [forget(p1)]);
    expect(out).to.deep.equal([{ ok: true, kind: 'scope.forget', affected: 4 }]);
    expect([...forgetter.rows.keys()]).to.deep.equal(['project:p2']);
    expect(await store.get(p1)).to.deep.equal({});
    expect(await store.get(p2)).to.deep.equal({ a: 2 });
    expect(d.bus.published).to.have.length(1);
    expect([...d.bus.published[0].tags].sort()).to.deep.equal(['rule:r1', 'rule:r2', 'scope:project:p1']);
    const types = d.sink.events.map((e) => e.type);
    expect(types).to.deep.equal(['RuleChanged', 'RuleChanged', 'ScopeForgotten']);
    const last = d.sink.events[2];
    expect(last.actor).to.deep.equal({ type: 'user', id: 'alice' });
    expect(last.data).to.deep.equal({ scope: p1, affected: 4 });
    expect(forgetter.seen[0].scope).to.deep.equal(p1);
  });

  it('publishes the scope tag even when nothing was stored there', async () => {
    const d = await domain();
    const out = await d.admin.execute(alice, [forget(p1)]);
    expect(out).to.deep.equal([{ ok: true, kind: 'scope.forget', affected: 0 }]);
    expect(d.bus.published[0].tags).to.deep.equal(['scope:project:p1']);
  });

  it('a failure later in the batch rolls the forgetters and the attributes back', async () => {
    const forgetter = new RowForgetter();
    const store = new MemoryScopeAttributeStore({ values: [{ scope: p1, attributes: { a: 1 } }] });
    const d = await domain({ forgetter, store });
    const out = await d.admin.execute(alice, [forget(p1), { kind: 'assignment.grant', subject: { type: 'user', id: 'x' }, role: 'guarded', scope: p1 }]);
    expect(out[1].ok).to.equal(false);
    expect(forgetter.seen).to.have.length(1);
    expect(forgetter.rows.get('project:p1')).to.deep.equal(['r1', 'r2']);
    expect(await store.get(p1)).to.deep.equal({ a: 1 });
    expect(d.bus.published).to.deep.equal([]);
  });

  it('refuses GLOBAL and a ref without an id (conflict)', async () => {
    const d = await domain();
    for (const scope of [GLOBAL, { type: 'project' }]) {
      const out = await d.admin.execute(alice, [forget(scope as ResourceRef)]);
      expect(out[0]).to.deep.include({ ok: false });
      expect((out[0] as { error: { code: string; field: string } }).error).to.deep.include({ code: 'conflict', field: 'scope' });
    }
  });

  it('needs authz:scope.forget at the node', async () => {
    const d = await domain();
    const out = await d.admin.execute(bob, [forget(p1)]);
    expect((out[0] as { error: { code: string } }).error.code).to.equal('forbidden');
    expect(d.model.requests.map((r) => `${r.permission}@${r.resource.type}:${r.resource.id}`)).to.deep.equal(['authz:scope.forget@project:p1']);
  });

  for (const [what, answer] of [
    ['a negative count', { affected: -1, tags: [], events: [] }],
    ['a tag that is not a string', { affected: 0, tags: [undefined], events: [] }],
    ['an event without a type', { affected: 0, tags: [], events: [{ data: {} }] }],
  ] as const) {
    it(`a forgetter answering ${what} rolls back and rejects with AuthzConfigError`, async () => {
      BrokenForgetter.answer = answer;
      const forgetter = new RowForgetter();
      const store = new MemoryScopeAttributeStore({ values: [{ scope: p1, attributes: { a: 1 } }] });
      const d = await domain({ forgetter, store, extra: (c) => c.register(BrokenForgetter).as(ScopeForgetter) });
      expect(await rejection(d.admin.execute(alice, [forget(p1)]))).to.be.instanceOf(AuthzConfigError);
      expect(forgetter.seen).to.have.length(1);
      expect(forgetter.rows.get('project:p1')).to.deep.equal(['r1', 'r2']);
      expect(await store.get(p1)).to.deep.equal({ a: 1 });
      expect(d.bus.published).to.deep.equal([]);
    });
  }

  it('sums the counts, tags and events of several forgetters', async () => {
    const forgetter = new RowForgetter();
    const d = await domain({ forgetter, extra: (c) => c.register(OtherForgetter).as(ScopeForgetter) });
    const out = await d.admin.execute(alice, [forget(p1)]);
    expect(out).to.deep.equal([{ ok: true, kind: 'scope.forget', affected: 4 }]);
    expect([...d.bus.published[0].tags].sort()).to.deep.equal(['link:p1', 'rule:r1', 'rule:r2', 'scope:project:p1']);
    expect(d.sink.events.map((e) => e.type).sort()).to.deep.equal(['LinkRevoked', 'RuleChanged', 'RuleChanged', 'ScopeForgotten']);
  });

  it('names GLOBAL in its refusal', async () => {
    const d = await domain();
    const out = await d.admin.execute(alice, [forget(GLOBAL)]);
    expect((out[0] as { error: { message: string } }).error.message).to.contain('GLOBAL');
  });

  it('forgetScope sugar sends the command', async () => {
    const forgetter = new RowForgetter();
    const d = await domain({ forgetter });
    await d.admin.forgetScope(alice, p2);
    expect([...forgetter.rows.keys()]).to.deep.equal(['project:p1']);
  });
});
