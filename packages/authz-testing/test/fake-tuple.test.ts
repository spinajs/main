import { expect } from 'chai';
import 'mocha';

import { AuthzConfigError, CORE_FILTER_OPS, FALSE, TRUE } from '@spinajs/authz';
import type { DecisionRequest, PrincipalRef, ResourceRef, Vote } from '@spinajs/authz';

import { FAKE_TUPLE_OP, FakeAdapter, FakePermissionRegistry, FakeTupleModel, FakeTupleStore, TupleStore, evaluateFilter, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '../src/index.js';
import type { FakeTupleSchema, Tuple } from '../src/index.js';

const u = (id: string): PrincipalRef => ({ type: 'user', id });
// Concrete refs fit both a tuple object (ResourceRef) and an arrow subject (PrincipalRef).
type Ref = { readonly type: string; readonly id: string };
const folder = (id: string): Ref => ({ type: 'folder', id });
const file = (id: string): Ref => ({ type: 'file', id });
const tuple = (object: ResourceRef, relation: string, subject: Tuple['subject']): Tuple => ({ object, relation, subject });

const schema: FakeTupleSchema = {
  group: { relations: { member: 'user | group#member' } },
  folder: { relations: { parent: 'folder', viewer: 'user | group#member', owner: 'user' }, permissions: { view: 'viewer | owner | parent->view' } },
  file: { relations: { parent: 'folder', viewer: 'user', editor: 'user' }, permissions: { edit: 'editor', view: 'edit | viewer | parent->view' } },
};
const permissions = { 'file:read': 'file#view', 'file:edit': 'file#edit', 'folder:read': 'folder#view' };
const registry = new FakePermissionRegistry(['file:read', 'file:edit', 'folder:read', 'user:read']);
const actor = u('admin');

async function seeded() {
  const store = new FakeTupleStore();
  await store.write(
    [
      tuple(file('f1'), 'viewer', u('alice')),
      tuple(file('f1'), 'editor', u('erin')),
      tuple(file('f1'), 'parent', folder('d1')),
      tuple(folder('d1'), 'viewer', u('bob')),
      tuple(folder('d2'), 'parent', folder('d1')),
      tuple(file('f2'), 'parent', folder('d2')),
      tuple(group('g1'), 'member', u('carol')),
      tuple(folder('d1'), 'viewer', { object: group('g1'), relation: 'member' }),
      tuple(folder('d3'), 'parent', folder('d4')),
      tuple(folder('d4'), 'parent', folder('d3')),
      tuple(file('f3'), 'parent', folder('d3')),
    ],
    [],
    actor,
  );
  return store;
}

function group(id: string): Ref {
  return { type: 'group', id };
}

const req = (who: string, permission: string, resource: ResourceRef): DecisionRequest => ({ principal: userPrincipal(who), permission, resource });
const permit = async (m: FakeTupleModel, who: string, permission: string, resource: ResourceRef) => ((await m.evaluate(req(who, permission, resource), fakeEvaluationContext())) as Vote).permitWhen;

describe('FakeTupleStore', () => {
  it('is a TupleStore: read by object and relation, reverse by subject, write returns a new version', async () => {
    const store = new FakeTupleStore();
    expect(store).to.be.instanceOf(TupleStore);
    const v1 = await store.write([tuple(file('f1'), 'viewer', u('alice')), tuple(file('f1'), 'viewer', u('alice'))], [], actor);
    expect(await store.read(file('f1'), 'viewer')).to.deep.eq([tuple(file('f1'), 'viewer', u('alice'))]);
    expect(await store.reverse(u('alice'), 'viewer', 'file')).to.deep.eq([file('f1')]);
    expect(await store.reverse(u('alice'), 'viewer', 'folder')).to.deep.eq([]);
    const v2 = await store.write([], [tuple(file('f1'), 'viewer', u('alice'))], actor);
    expect(v2).to.not.eq(v1);
    expect(await store.read(file('f1'), 'viewer')).to.deep.eq([]);
    expect(store.writes.map((w) => w.actor)).to.deep.eq([actor, actor]);
  });
});

describe('FakeTupleModel', () => {
  it('direct tuples, computed usersets (union) and arrows give definite votes on a concrete resource', async () => {
    const m = new FakeTupleModel({ store: await seeded(), schema, permissions });
    expect(await permit(m, 'alice', 'file:read', file('f1'))).to.eq(TRUE);
    expect(await permit(m, 'erin', 'file:read', file('f1'))).to.eq(TRUE);
    expect(await permit(m, 'erin', 'file:edit', file('f1'))).to.eq(TRUE);
    expect(await permit(m, 'alice', 'file:edit', file('f1'))).to.eq(FALSE);
    expect(await permit(m, 'bob', 'file:read', file('f1'))).to.eq(TRUE);
    expect(await permit(m, 'bob', 'file:read', file('f2'))).to.eq(TRUE);
    expect(await permit(m, 'carol', 'file:read', file('f2'))).to.eq(TRUE);
    expect(await permit(m, 'zed', 'file:read', file('f1'))).to.eq(FALSE);
    const v = (await m.evaluate(req('zed', 'file:read', file('f1')), fakeEvaluationContext())) as Vote;
    expect(v).to.deep.eq({ model: 'rebac', permitWhen: FALSE, denyWhen: FALSE, reason: { code: 'no_access', model: 'rebac' }, cacheable: true });
  });

  it('is cycle-safe', async () => {
    const m = new FakeTupleModel({ store: await seeded(), schema, permissions });
    expect(await permit(m, 'bob', 'file:read', file('f3'))).to.eq(FALSE);
    expect(await permit(m, 'bob', 'folder:read', folder('d3'))).to.eq(FALSE);
  });

  it('a walk deeper than maxDepth makes the vote indeterminate (error), not FALSE', async () => {
    const store = new FakeTupleStore();
    const chain: Tuple[] = [tuple(folder('c0'), 'viewer', u('bob'))];
    for (let i = 1; i <= 12; i++) chain.push(tuple(folder(`c${i}`), 'parent', folder(`c${i - 1}`)));
    await store.write(chain, [], actor);
    const shallow = new FakeTupleModel({ store, schema, permissions, maxDepth: 8 });
    const v = (await shallow.evaluate(req('bob', 'folder:read', folder('c12')), fakeEvaluationContext())) as Vote;
    expect(v.error).to.match(/depth/);
    expect(v.permitWhen).to.eq(FALSE);
    expect(v.reason).to.deep.eq({ code: 'model_error', model: 'rebac' });
    const deep = new FakeTupleModel({ store, schema, permissions, maxDepth: 40 });
    expect(await permit(deep, 'bob', 'folder:read', folder('c12'))).to.eq(TRUE);
  });

  it('past maxDepth the native filter leaves the row out, as the error vote denies (check ⇔ list)', async () => {
    const store = new FakeTupleStore();
    const chain: Tuple[] = [tuple(folder('c0'), 'viewer', u('bob'))];
    for (let i = 1; i <= 12; i++) chain.push(tuple(folder(`c${i}`), 'parent', folder(`c${i - 1}`)));
    await store.write(chain, [], actor);
    const m = new FakeTupleModel({ store, schema, permissions, maxDepth: 8 });
    const init = fakeModelInitContext({ permissions: registry });
    await m.init(init);
    const ids = chain.map((_, i) => `c${i}`);
    const adapter = new FakeAdapter({ types: ['folder'], rows: { folder: ids.map((id) => ({ id })) } });
    const context = fakeEvaluationContext({ nativeFilters: init.registered.nativeFilters, permissions: registry });
    const principal = userPrincipal('bob');
    const residual = ((await m.evaluate({ principal, permission: 'folder:read', resource: { type: 'folder' } }, context)) as Vote).permitWhen;
    const listed = (await adapter.rows('folder', residual, { principal, context })).map((r) => r.id);
    const checked: string[] = [];
    for (const id of ids) {
      if ((await permit(m, 'bob', 'folder:read', folder(id))) === TRUE) checked.push(id);
    }
    // c<k>#view reaches c0#viewer at depth k + 1.
    expect(checked).to.deep.eq(ids.slice(0, 8));
    expect(listed).to.deep.eq(checked);
    expect(((await m.evaluate(req('bob', 'folder:read', folder('c12')), context)) as Vote).error).to.match(/depth/);
    expect(await evaluateFilter(residual, { id: 'c12' }, { principal, ref: folder('c12'), context })).to.eq(false);
  });

  it('walks each node once per check, so a dense graph stays fast', async () => {
    class CountingStore extends FakeTupleStore {
      reads = 0;
      override read(object: ResourceRef, relation: string) {
        this.reads++;
        return super.read(object, relation);
      }
    }
    const store = new CountingStore();
    const layers = 6;
    const width = 8;
    const g = (l: number, i: number) => group(`g${l}_${i}`);
    const tuples: Tuple[] = [];
    for (let i = 0; i < width; i++) tuples.push(tuple(folder('d1'), 'viewer', { object: g(0, i), relation: 'member' }));
    for (let l = 0; l + 1 < layers; l++) for (let i = 0; i < width; i++) for (let j = 0; j < width; j++) tuples.push(tuple(g(l, i), 'member', { object: g(l + 1, j), relation: 'member' }));
    tuples.push(tuple(g(layers - 1, width - 1), 'member', u('carol')));
    await store.write(tuples, [], actor);
    const m = new FakeTupleModel({ store, schema, permissions });

    const started = Date.now();
    expect(await permit(m, 'zed', 'folder:read', folder('d1'))).to.eq(FALSE);
    const reads = store.reads;
    expect(await permit(m, 'carol', 'folder:read', folder('d1'))).to.eq(TRUE);
    expect(Date.now() - started).to.be.below(1000);
    // d1#view, #viewer, #owner, the parent arrow, and each group's #member once.
    expect(reads).to.be.at.most(3 + layers * width + 1);
  });

  it('a type-level request yields the native residual', async () => {
    const m = new FakeTupleModel({ store: await seeded(), schema, permissions });
    expect(await permit(m, 'bob', 'file:read', { type: 'file' })).to.deep.eq({ op: FAKE_TUPLE_OP, args: { relation: 'view', principal: u('bob') } });
  });

  it('init registers a NativeFilter that answers for a row with the same walk (check ⇔ filter)', async () => {
    const store = await seeded();
    const m = new FakeTupleModel({ store, schema, permissions });
    const init = fakeModelInitContext({ permissions: registry });
    await m.init(init);
    expect(init.registered.nativeFilters.map((n) => n.op)).to.deep.eq([FAKE_TUPLE_OP]);

    const adapter = new FakeAdapter({ types: ['file'], rows: { file: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }, { id: 'f4' }] } });
    const context = fakeEvaluationContext({ nativeFilters: init.registered.nativeFilters, permissions: registry });
    for (const who of ['alice', 'bob', 'carol', 'erin', 'zed']) {
      const principal = userPrincipal(who);
      const residual = ((await m.evaluate({ principal, permission: 'file:read', resource: { type: 'file' } }, context)) as Vote).permitWhen;
      const listed = (await adapter.rows('file', residual, { principal, context })).map((r) => r.id);
      const checked: string[] = [];
      for (const id of ['f1', 'f2', 'f3', 'f4']) {
        if ((await permit(m, who, 'file:read', file(id))) === TRUE) checked.push(id);
      }
      expect(listed, who).to.deep.eq(checked);
      expect(await evaluateFilter(residual, { id: 'f1' }, { principal, ref: file('f1'), context }), who).to.eq(checked.includes('f1'));
    }
  });

  it('routes mapped permissions on their type only; honest capabilities', () => {
    const m = new FakeTupleModel({ store: new FakeTupleStore(), schema, permissions });
    expect(m.applies(registry.require('file:read'), 'file')).to.eq(true);
    expect(m.applies(registry.require('file:read'), 'folder')).to.eq(false);
    expect(m.applies(registry.require('user:read'), 'user')).to.eq(false);
    expect(m.capabilities).to.deep.eq({ effects: ['permit'], residuals: [...CORE_FILTER_OPS, FAKE_TUPLE_OP], sync: 'never', fields: false, needsSubject: false, resourceTypes: ['file', 'folder'] });
  });

  it('store writes bump the version; invalidate is recorded', async () => {
    const store = new FakeTupleStore();
    const m = new FakeTupleModel({ store, schema, permissions });
    const v0 = m.version();
    await store.write([tuple(file('f9'), 'viewer', u('x'))], [], actor);
    expect(m.version()).to.not.eq(v0);
    m.invalidate(['subject:user:x']);
    expect(m.invalidations).to.deep.eq([['subject:user:x']]);
  });

  it('rejects a schema that names unknown relations or a mapping to an unknown relation', () => {
    expect(() => new FakeTupleModel({ store: new FakeTupleStore(), schema: { file: { relations: { viewer: 'user' }, permissions: { view: 'viewer | editor' } } }, permissions: {} })).to.throw(AuthzConfigError);
    expect(() => new FakeTupleModel({ store: new FakeTupleStore(), schema: { file: { relations: { viewer: 'user' }, permissions: { view: 'nope->view' } } }, permissions: {} })).to.throw(AuthzConfigError);
    expect(() => new FakeTupleModel({ store: new FakeTupleStore(), schema, permissions: { 'file:read': 'file#nope' } })).to.throw(AuthzConfigError);
    expect(() => new FakeTupleModel({ store: new FakeTupleStore(), schema, permissions: { 'file:read': 'thing#view' } })).to.throw(AuthzConfigError);
  });
});
