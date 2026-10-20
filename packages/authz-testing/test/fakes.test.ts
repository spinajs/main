import { expect } from 'chai';
import 'mocha';

import { CORE_FILTER_OPS, ChangeBus, DecisionAudit, GLOBAL, RelationResolver } from '@spinajs/authz';
import type { AuthzChange, ResourceFilter, ResourceRef } from '@spinajs/authz';

import { FakeAdapter, FakePrincipalSource, FakeRelationResolver, FakeScopeResolver, ManualClock, RecordingAudit, RecordingChangeBus, userPrincipal } from '../src/index.js';

const alice = userPrincipal('alice');
const folder: ResourceRef = { type: 'folder', id: 'd1' };
const root: ResourceRef = { type: 'folder', id: 'root' };

function files() {
  return new FakeAdapter({
    types: ['file', 'folder'],
    rows: {
      file: [
        { id: 'f1', ownerId: 'alice', size: 5 },
        { id: 'f2', ownerId: 'bob', size: 150 },
        { id: 'f3', ownerId: 'alice', size: 500 },
      ],
      folder: [{ id: 'd1' }, { id: 'root' }],
    },
    parents: [
      [{ type: 'file', id: 'f1' }, folder],
      [{ type: 'file', id: 'f2' }, folder],
      [folder, root],
    ],
    relations: [{ type: 'file', relation: 'owner', column: 'ownerId' }],
    attributes: [[folder, { policies: { maxSize: 100 } }]],
  });
}

describe('FakeAdapter', () => {
  it('ancestors: [self, parent, ..., GLOBAL]; unknown row = null; type-level = [ref, GLOBAL]', async () => {
    const a = files();
    expect(await a.ancestors({ type: 'file', id: 'f1' })).to.deep.eq([{ type: 'file', id: 'f1' }, folder, root, GLOBAL]);
    expect(await a.ancestors({ type: 'file', id: 'f3' })).to.deep.eq([{ type: 'file', id: 'f3' }, GLOBAL]);
    expect(await a.ancestors({ type: 'file', id: 'nope' })).to.eq(null);
    expect(await a.ancestors({ type: 'file' })).to.deep.eq([{ type: 'file' }, GLOBAL]);
  });

  it('a parent cycle is a configuration error', async () => {
    const a = new FakeAdapter({ types: ['n'], rows: { n: [{ id: 'a' }, { id: 'b' }] }, parents: [[{ type: 'n', id: 'a' }, { type: 'n', id: 'b' }], [{ type: 'n', id: 'b' }, { type: 'n', id: 'a' }]] });
    let err: unknown;
    try {
      await a.ancestors({ type: 'n', id: 'a' });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).to.match(/cycle/);
  });

  it('accepts its own rows, refOf, load, attribute, scope attributes', async () => {
    const a = files();
    const f1 = (await a.load({ type: 'file', id: 'f1' })) as { id: string };
    expect(f1).to.deep.eq({ id: 'f1', ownerId: 'alice', size: 5 });
    expect(a.accepts(f1)).to.eq(true);
    expect(a.accepts({ id: 'f1' })).to.eq(false);
    expect(await a.refOf(f1 as never)).to.deep.eq({ type: 'file', id: 'f1' });
    expect(await a.load({ type: 'file', id: 'nope' })).to.eq(null);
    expect(a.attribute({ meta: { a: 1 } }, 'meta.a')).to.eq(1);
    expect(await a.scopeAttributes(folder)).to.deep.eq({ policies: { maxSize: 100 } });
    expect(await a.scopeAttributes({ type: 'file', id: 'f1' })).to.deep.eq({});
    expect(await a.scopeAttributes({ type: 'file', id: 'nope' })).to.eq(null);
  });

  it('relations by column, loading the row when no subject is given', async () => {
    const a = files();
    const [owner] = a.relations();
    expect(owner).to.be.instanceOf(RelationResolver);
    expect(await owner.holds(alice, { type: 'file', id: 'f1' })).to.eq(true);
    expect(await owner.holds(alice, { type: 'file', id: 'f2' })).to.eq(false);
    expect(await owner.holds(alice, { type: 'file', id: 'f2' }, { ownerId: 'alice' })).to.eq(true);
    expect(await owner.holds(alice, { type: 'file', id: 'nope' })).to.eq(false);
  });

  it('compiles: core ops by default, configurable, undefined = not list-scoped', () => {
    expect(files().compiles).to.eq(CORE_FILTER_OPS);
    expect(new FakeAdapter({ types: ['x'], compiles: ['true', 'cmp'] }).compiles).to.deep.eq(['true', 'cmp']);
    expect(new FakeAdapter({ types: ['x'], compiles: undefined }).compiles).to.eq(undefined);
  });

  it('rows(type, filter, env) applies a residual with the reference evaluator', async () => {
    const a = files();
    const ids = async (f: ResourceFilter) => (await a.rows('file', f, { principal: alice })).map((r) => r.id);
    expect(await ids({ op: 'true' })).to.deep.eq(['f1', 'f2', 'f3']);
    expect(await ids({ op: 'relation', relation: 'owner' })).to.deep.eq(['f1', 'f3']);
    expect(await ids({ op: 'under', scopes: [folder] })).to.deep.eq(['f1', 'f2']);
    expect(await ids({ op: 'and', args: [{ op: 'relation', relation: 'owner' }, { op: 'cmp', field: 'size', cmp: 'lt', value: { ref: 'scope.folder.policies.maxSize' } }] })).to.deep.eq(['f1']);
    expect(await ids({ op: 'not', arg: { op: 'cmp', field: 'size', cmp: 'lt', value: { ref: 'scope.folder.policies.maxSize' } } })).to.deep.eq(['f2']);
  });

  it('add and remove rows', async () => {
    const a = files();
    a.add('file', { id: 'f9', ownerId: 'x' }, folder);
    expect(await a.ancestors({ type: 'file', id: 'f9' })).to.deep.eq([{ type: 'file', id: 'f9' }, folder, root, GLOBAL]);
    a.remove('file', 'f9');
    expect(await a.ancestors({ type: 'file', id: 'f9' })).to.eq(null);
  });
});

describe('FakeScopeResolver', () => {
  const org = { type: 'org', id: 'o1' };
  const project = { type: 'project', id: 'p1' };
  const r = () =>
    new FakeScopeResolver({
      defaults: { org: { policies: { public_links: true, external_sharing: true } } },
      nodes: [
        { ref: org, attributes: { policies: { public_links: false } } },
        { ref: project, parent: org, attributes: { name: 'P1' } },
      ],
    });

  it('ancestors from the tree; unknown node = null; types derived from nodes', async () => {
    expect(await r().ancestors(project)).to.deep.eq([project, org, GLOBAL]);
    expect(await r().ancestors({ type: 'project', id: 'p9' })).to.eq(null);
    expect(r().types).to.deep.eq(['org', 'project']);
  });

  it('attributes are the defaults deep-merged under the node attributes', async () => {
    expect(await r().attributes(org)).to.deep.eq({ policies: { public_links: false, external_sharing: true } });
    expect(await r().attributes(project)).to.deep.eq({ name: 'P1' });
    expect(await r().attributes({ type: 'org', id: 'o9' })).to.eq(null);
  });

  it('add() extends the tree', async () => {
    const s = r().add({ type: 'file', id: 'f1' }, project);
    expect(await s.ancestors({ type: 'file', id: 'f1' })).to.deep.eq([{ type: 'file', id: 'f1' }, project, org, GLOBAL]);
    expect(s.types).to.include('file');
  });
});

describe('FakeRelationResolver', () => {
  it('delegates to a function and counts calls', async () => {
    const rel = new FakeRelationResolver('file', 'owner', async (p, _ref, s) => (s as { o: string }).o === p.id);
    expect(rel).to.be.instanceOf(RelationResolver);
    expect(await rel.holds(alice, { type: 'file', id: 'f1' }, { o: 'alice' })).to.eq(true);
    expect(await rel.holds(alice, { type: 'file', id: 'f1' }, { o: 'bob' })).to.eq(false);
    expect(rel.calls).to.eq(2);
  });
});

describe('FakePrincipalSource', () => {
  it('scripted by a header (case-insensitive)', async () => {
    const s = new FakePrincipalSource({ name: 'test', order: 10, header: 'X-Test-Principal', principals: { a: alice } });
    expect(s.name).to.eq('test');
    expect(s.order).to.eq(10);
    expect(await s.authenticate({ headers: { 'x-test-principal': 'a' } })).to.eq(alice);
    expect(await s.authenticate({ headers: { 'x-test-principal': 'zz' } })).to.eq(null);
    expect(await s.authenticate({ headers: {} })).to.eq(null);
  });

  it('scripted by a function', async () => {
    const s = new FakePrincipalSource({ authenticate: () => alice });
    expect(s.name).to.eq('fake');
    expect(await s.authenticate({})).to.eq(alice);
    expect(s.requests).to.have.length(1);
  });
});

describe('recording fakes', () => {
  it('RecordingAudit keeps every entry', async () => {
    const audit = new RecordingAudit();
    expect(audit).to.be.instanceOf(DecisionAudit);
    await audit.record({ kind: 'deny', principal: alice, permission: 'a:b' });
    await audit.record({ kind: 'runAs', principal: alice, reason: 'job' });
    expect(audit.entries.map((e) => e.kind)).to.deep.eq(['deny', 'runAs']);
    expect(audit.of('runAs')).to.have.length(1);
  });

  it('RecordingChangeBus fans out synchronously, logs, and unsubscribes', async () => {
    const bus = new RecordingChangeBus();
    expect(bus).to.be.instanceOf(ChangeBus);
    const seen: AuthzChange[] = [];
    const off = bus.subscribe((c) => seen.push(c));
    const change = { tags: ['role:x'], at: new Date(0) };
    const p = bus.publish(change);
    expect(seen).to.deep.eq([change]);
    await p;
    off();
    await bus.publish({ tags: ['y'], at: new Date(0) });
    expect(seen).to.have.length(1);
    expect(bus.published).to.have.length(2);
  });

  it('ManualClock moves only when told', () => {
    const clock = new ManualClock(new Date('2026-01-01T00:00:00Z'));
    const a = clock.now();
    a.setTime(0);
    expect(clock.now()).to.deep.eq(new Date('2026-01-01T00:00:00Z'));
    clock.advance(1000);
    expect(clock.now()).to.deep.eq(new Date('2026-01-01T00:00:01Z'));
    clock.set(new Date(5));
    expect(clock.now()).to.deep.eq(new Date(5));
    expect(new ManualClock().now()).to.deep.eq(new Date(0));
  });
});
