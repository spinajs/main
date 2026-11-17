import 'mocha';
import { expect } from 'chai';
import { testHost } from '@spinajs/authz-testing';
import type { ResourceRef } from '@spinajs/authz';
import { MemoryTupleStore, NamespaceSchema, RebacModel } from '@spinajs/authz-rebac';
import type { Tuple, TuplePage, TupleQuery } from '@spinajs/authz-rebac';

import { MAX_STORE_READS, parseFocus, relationsGraph, toStudioTuple } from '../src/authz/rebac.js';
import type { RebacLike, TupleLike, TupleStoreLike } from '../src/authz/rebac.js';
import type { StudioCapabilities, StudioGraph, StudioPage, StudioTuple } from '../src/contracts/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { ROOT_PERMISSIONS } from './support/config.js';
import { registerHeaderSource } from './support/principals.js';

const NAMESPACES = {
  user: {},
  group: { relations: { member: ['user'] } },
  folder: { relations: { viewer: ['user', 'group#member'] }, permissions: { view: 'viewer' } },
  document: { relations: { parent: ['folder'], viewer: ['user'] }, permissions: { view: { union: ['viewer', 'parent->view'] } } },
};

const PERMISSIONS = { 'document:read': 'document#view' };

const TUPLES: readonly Tuple[] = [
  { object: { type: 'document', id: '42' }, relation: 'parent', subject: { type: 'folder', id: '7' } },
  { object: { type: 'folder', id: '7' }, relation: 'viewer', subject: { type: 'user', id: 'ann' } },
];

/** Values a store may hold beside a tuple's fields; no Studio reply may carry them. */
const PLANTED = ['SECRET-actor', 'SECRET-mail', 'SECRET-tenant', 'SECRET-condition'] as const;

function planted(t: Tuple): Tuple {
  const subject = { ...t.subject, attributes: { email: PLANTED[1] } };
  const object = { ...t.object, tenant: PLANTED[2] };
  const row = { ...t, object, subject, created_by: PLANTED[0], condition: { expr: PLANTED[3] } };
  return row;
}

/** A memory store whose answers carry extra keys, as a database row or a custom store might. */
class PlantedTupleStore extends MemoryTupleStore {
  public override async read(object: ResourceRef, relation: string): Promise<readonly Tuple[]> {
    return (await super.read(object, relation)).map(planted);
  }

  public override async find(query: TupleQuery, page?: TuplePage): Promise<{ readonly items: readonly Tuple[]; readonly total: number }> {
    const { items, total } = await super.find(query, page);
    return { items: items.map(planted), total };
  }
}

// `RebacModel.schema()` and `store()` throw before the domain boot ran `init`; the graph functions need those two only.
function fixture(): RebacLike {
  const schema = NamespaceSchema.compile(NAMESPACES, PERMISSIONS);
  const store = new MemoryTupleStore(TUPLES);
  return { schema: () => schema, store: () => store };
}

const bootable = (): RebacModel => new RebacModel({ store: new PlantedTupleStore(TUPLES), namespaces: NAMESPACES, permissions: PERMISSIONS });

describe('ReBAC relation graph', () => {
  it('parses the focus syntax and refuses anything else without echoing it', () => {
    expect(parseFocus('document:42')).to.deep.eq({ type: 'document', id: '42' });
    expect(parseFocus('folder:7#viewer')).to.deep.eq({ type: 'folder', id: '7', relation: 'viewer' });
    expect(() => parseFocus('document')).to.throw(/type:id/);
    expect(() => parseFocus('zz<qq')).to.throw().with.property('message').that.does.not.include('zz<qq');
  });

  it('reaches user:ann from document:42 in two hops, with relation-named edges and bare ids', async () => {
    const model = fixture();
    const g = await relationsGraph(model, parseFocus('document:42'), 2, 500);
    expect(g.nodes.map((n) => n.id)).to.include.members(['document:42', 'folder:7', 'user:ann']);
    expect(g.edges.some((e) => e.source === 'document:42' && e.target === 'folder:7' && e.kind === 'parent' && e.label === 'parent')).to.eq(true);
    expect(g.edges.some((e) => e.source === 'folder:7' && e.target === 'user:ann' && e.kind === 'viewer')).to.eq(true);
    expect((await relationsGraph(model, parseFocus('document:42'), 1, 500)).nodes.map((n) => n.id)).to.not.include('user:ann');
  });

  it('expands inbound tuples too, and marks the cut when the limit is hit', async () => {
    const model = fixture();
    expect((await relationsGraph(model, parseFocus('user:ann'), 2, 500)).nodes.map((n) => n.id)).to.include.members(['folder:7', 'document:42']);
    const capped = await relationsGraph(model, parseFocus('document:42'), 2, 2);
    expect(capped.nodes).to.have.length(2);
    expect(capped.truncated).to.eq(true);
  });

  it('shows a subject set as a userset node and walks only its relation', async () => {
    const schema = NamespaceSchema.compile(NAMESPACES, PERMISSIONS);
    const store = new MemoryTupleStore([
      { object: { type: 'folder', id: '7' }, relation: 'viewer', subject: { object: { type: 'group', id: 'eng' }, relation: 'member' } },
      { object: { type: 'group', id: 'eng' }, relation: 'member', subject: { type: 'user', id: 'ann' } },
    ]);
    const g = await relationsGraph({ schema: () => schema, store: () => store }, parseFocus('folder:7'), 2, 500);
    expect(g.nodes.find((n) => n.id === 'group:eng#member')).to.include({ kind: 'userset', group: 'group' });
    expect(g.edges.some((e) => e.source === 'group:eng#member' && e.target === 'user:ann' && e.kind === 'member')).to.eq(true);
  });

  it('stops asking the store once the node limit is hit', async () => {
    const model = fixture();
    const store = model.store();
    let reads = 0;
    const counting: RebacLike = {
      schema: () => model.schema(),
      store: () => ({
        read: (object, relation) => {
          reads++;
          return store.read(object, relation);
        },
        reverse: (subject, relation, type) => {
          reads++;
          return store.reverse(subject, relation, type);
        },
        find: (query, page) => store.find(query, page),
      }),
    };
    const capped = await relationsGraph(counting, parseFocus('document:42'), 5, 1);
    expect(capped.truncated).to.eq(true);
    expect(reads).to.eq(1);
  });

  it('stops after MAX_STORE_READS store calls and marks the cut', async () => {
    // 50 relations, each read naming a new object: one hop costs 100 calls per node, far past the budget.
    const relations = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`r${i}`, ['n']]));
    const schema = NamespaceSchema.compile({ n: { relations } });
    let reads = 0;
    let next = 0;
    const store: TupleStoreLike = {
      read: async (object, relation) => {
        reads++;
        return [{ object, relation, subject: { type: 'n', id: String(next++) } }];
      },
      reverse: async () => {
        reads++;
        return [];
      },
      find: async () => ({ items: [], total: 0 }),
    };
    const g = await relationsGraph({ schema: () => schema, store: () => store }, parseFocus('n:root'), 10, 5000);
    expect(reads).to.eq(MAX_STORE_READS);
    expect(g.truncated).to.eq(true);
    expect(g.nodes.length).to.be.lessThan(5000);
  });

  it('copies a tuple field by field and cuts every value at 2 KiB', async () => {
    const long = 'x'.repeat(5000);
    const t: TupleLike = planted({ object: { type: 'document', id: long }, relation: 'viewer', subject: { object: { type: 'group', id: 'eng' }, relation: 'member' } });
    const wire = toStudioTuple(t);
    expect(wire).to.have.keys(['object', 'relation', 'subject']);
    expect(wire.object).to.have.keys(['type', 'id']);
    expect(wire.subject).to.deep.eq({ type: 'group', id: 'eng', relation: 'member' });
    expect(Buffer.byteLength(wire.object.id)).to.be.lessThan(2100);
    const text = JSON.stringify(wire);
    for (const secret of PLANTED) expect(text).to.not.include(secret);

    const store = new PlantedTupleStore([{ object: { type: 'folder', id: '7' }, relation: 'viewer', subject: { type: 'user', id: long } }]);
    const schema = NamespaceSchema.compile(NAMESPACES, PERMISSIONS);
    const g = await relationsGraph({ schema: () => schema, store: () => store }, parseFocus('folder:7'), 1, 500);
    expect(g.nodes).to.have.length(2);
    for (const n of g.nodes) expect(Buffer.byteLength(n.id)).to.be.lessThan(2100);
    for (const secret of PLANTED) expect(JSON.stringify(g)).to.not.include(secret);
  });
});

describe('Studio ReBAC routes', function () {
  this.timeout(30000);

  let app: TestApp;
  let unregister: () => void;
  const get = (path: string, user = 'bob') => app.request().get(path).set('Accept', 'application/json').set('x-user', user);

  before(async () => {
    unregister = registerHeaderSource();
    app = await startApp({
      models: [bootable()],
      config: { 'authz.permissions': { ...ROOT_PERMISSIONS, 'document:read': {} }, 'authz.combine.default.models': ['m1', 'rebac'] },
    });
    // The first guarded request boots root, which runs the model's init.
    await get('/_studio/api/capabilities');
  });

  after(async () => {
    await stopApp();
    unregister();
  });

  it('answers the namespaces schema graph', async () => {
    const g = (await get('/_studio/api/authz/namespaces')).body as StudioGraph;
    expect(g.nodes.map((n) => n.id)).to.include.members(['ns:document', 'rel:document#parent', 'rel:document#view']);
    expect(g.nodes.find((n) => n.id === 'rel:document#view')?.kind).to.eq('permission');
    expect(g.edges.some((e) => e.source === 'rel:document#view' && e.kind === 'tupleset' && e.target === 'rel:document#parent' && e.label === '->view')).to.eq(true);
    expect(g.edges.some((e) => e.source === 'rel:document#view' && e.kind === 'computed' && e.target === 'rel:document#viewer')).to.eq(true);
    expect(g.edges.some((e) => e.source === 'rel:folder#viewer' && e.kind === 'subject-set' && e.target === 'rel:group#member')).to.eq(true);
    expect(g.edges.some((e) => e.source === 'rel:document#parent' && e.kind === 'subject' && e.target === 'ns:folder')).to.eq(true);
    expect(g.truncated).to.eq(false);
    const capped = (await get('/_studio/api/authz/namespaces?limit=2')).body as StudioGraph;
    expect(capped.nodes).to.have.length(2);
    expect(capped.truncated).to.eq(true);
  });

  it('pages tuples with a total, structured refs and an opaque cursor', async () => {
    const first = (await get('/_studio/api/authz/tuples?limit=1')).body as StudioPage<StudioTuple>;
    expect(first.total).to.eq(2);
    expect(first.items[0].object).to.have.keys(['type', 'id']);
    expect(first.cursor).to.be.a('string');
    const second = (await get(`/_studio/api/authz/tuples?limit=1&cursor=${first.cursor ?? ''}`)).body as StudioPage<StudioTuple>;
    expect(second.items).to.have.length(1);
    expect(second.cursor).to.eq(undefined);
    const filtered = (await get('/_studio/api/authz/tuples?object=folder:7')).body as StudioPage<StudioTuple>;
    expect(filtered.items).to.deep.eq([{ object: { type: 'folder', id: '7' }, relation: 'viewer', subject: { type: 'user', id: 'ann' } }]);
    expect(((await get('/_studio/api/authz/tuples?object=document&relation=parent&subject=folder:7')).body as StudioPage<StudioTuple>).total).to.eq(1);
    expect(((await get('/_studio/api/authz/tuples?subject=user:bob')).body as StudioPage<StudioTuple>).total).to.eq(0);
  });

  it('answers the relation graph and refuses a bad focus without echoing it', async () => {
    expect(((await get('/_studio/api/authz/relations/graph?focus=document:42&depth=2')).body as StudioGraph).nodes.map((n) => n.id)).to.include('user:ann');
    expect((await get('/_studio/api/authz/relations/graph?focus=document')).status).to.eq(400);
    expect((await get('/_studio/api/authz/relations/graph')).status).to.eq(400);
    const bad = await get('/_studio/api/authz/relations/graph?focus=zz%3Cqq');
    expect(bad.status).to.eq(400);
    expect(bad.text).to.not.include('zz<qq');
  });

  it('sends no value a store holds beside the tuple fields', async () => {
    const texts = [(await get('/_studio/api/authz/tuples')).text, (await get('/_studio/api/authz/relations/graph?focus=document:42&depth=3')).text, (await get('/_studio/api/authz/namespaces')).text];
    for (const text of texts) for (const secret of PLANTED) expect(text).to.not.include(secret);
  });

  it('answers 400 for bad arguments and 403 without studio:read on each route', async () => {
    const statuses = await Promise.all(
      ['tuples?limit=0', 'tuples?limit=501', 'tuples?cursor=-1', 'tuples?subject=user', 'tuples?object=folder:7%23viewer', 'tuples?domain=nope', 'namespaces?domain=a/b', 'namespaces?limit=0', 'relations/graph?focus=document:42&depth=11'].map(
        async (q) => (await get(`/_studio/api/authz/${q}`)).status,
      ),
    );
    expect(statuses).to.deep.eq([400, 400, 400, 400, 400, 400, 400, 400, 400]);
    for (const q of ['namespaces', 'tuples', 'relations/graph?focus=document:42']) expect((await get(`/_studio/api/authz/${q}`, 'alice')).status).to.eq(403);
  });

  it('answers 404 for a domain without a booted ReBAC model', async () => {
    testHost.config().set(['authz', 'domains', 'tenant'], { parent: 'root', permissions: {} });
    (await testHost.domains()).create('tenant', 'root');
    for (const q of ['namespaces?domain=tenant', 'tuples?domain=tenant', 'relations/graph?focus=document:42&domain=tenant']) expect((await get(`/_studio/api/authz/${q}`)).status).to.eq(404);
  });

  it('reports rebac in the capabilities', async () => {
    expect(((await get('/_studio/api/capabilities')).body as StudioCapabilities).features.rebac).to.eq(true);
  });
});
