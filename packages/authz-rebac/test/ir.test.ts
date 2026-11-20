import * as chai from 'chai';
import 'mocha';
import { IREvaluator, mergeFragments, validateIR } from '@spinajs/authz-ir';
import { FakePermissionRegistry } from '@spinajs/authz-testing';

import { MemoryTupleStore, NamespaceSchema, RebacModel, rebacTupleSource, rebacToIR } from '../src/index.js';
import { NAMESPACES, PERMISSIONS, PERMISSION_INPUTS, d1, setup, tuple, user } from './support/world.js';

const expect = chai.expect;

describe('authz-rebac: rebacToIR', () => {
  const schema = NamespaceSchema.compile(NAMESPACES, PERMISSIONS);

  it('maps namespaces onto IR types and the permission map onto bindings', () => {
    const fragment = rebacToIR(schema, { permissions: new FakePermissionRegistry([...PERMISSION_INPUTS.map((p) => (p.name === 'doc:read' ? { ...p, list: true } : p))]) });
    expect(fragment.model).to.equal('rebac');
    expect(fragment.types!.group).to.deep.equal({ relations: { member: { allowed: ['user', 'group#member'], source: { kind: 'tuples', store: 'authz_rebac_tuple' } } }, permissions: {} });
    expect(fragment.types!.doc.permissions).to.deep.equal({
      read: { union: [{ computed: 'owner' }, { computed: 'viewer' }, { tupleToUserset: { tupleset: 'parent', computed: 'view' } }] },
      edit: { intersection: [{ computed: 'editor' }, { computed: 'approved' }] },
      view: { exclusion: { base: { computed: 'read' }, subtract: { computed: 'banned' } } },
    });
    expect(fragment.permissions!['doc:read']).to.deep.equal({ type: 'doc', permit: 'read', list: true, source: { origin: 'config:authz.rebac.permissions' } });
    expect(fragment.permissions!['folder:read']).to.include({ type: 'folder', permit: 'view', list: false });
  });

  it('merges into an IR that validates', () => {
    expect(validateIR(mergeFragments([rebacToIR(schema)]).ir)).to.deep.equal([]);
  });

  it('RebacModel.toIR compiles from config before init and from its schema after', async () => {
    const s = await setup({ name: 'shares' });
    const after = s.model.toIR({ config: <T>(_p: string, d?: T) => d as T });
    expect(after.model).to.equal('shares');
    expect(after.permissions!['doc:view']).to.include({ permit: 'view' });
    const config = new Map<string, unknown>([
      ['namespaces', NAMESPACES],
      ['permissions', PERMISSIONS],
    ]);
    const before = new RebacModel().toIR({ config: <T>(path: string, d?: T) => (config.get(path) ?? d) as T });
    expect(before.types).to.deep.equal(after.types);
  });

  it('refuses conditional subject types until it compiles them', () => {
    const c = { params: { 'env.x': 'string' }, expr: { attr: 'env.x', eq: 'y' } } as const;
    expect(() => rebacToIR(NamespaceSchema.compile({ user: {}, doc: { relations: { viewer: ['user', 'user with c'] } } }, {}, { c }))).to.throw(/doc#viewer: conditional subject types are not compiled yet/);
    expect(rebacToIR(NamespaceSchema.compile({ user: {}, doc: { relations: { viewer: ['user'] } } }, {}, { c })).types!.doc.relations.viewer.allowed).to.deep.equal(['user']);
  });

  it('the tuple source yields no conditional tuple', async () => {
    const store = new MemoryTupleStore([tuple(d1, 'viewer', user('alice')), { ...tuple(d1, 'viewer', user('bob')), caveat: { name: 'c' } }]);
    const read: unknown[] = [];
    for await (const s of rebacTupleSource(store).read({ type: 'doc', id: 'd1' }, 'viewer')) read.push(s);
    expect(read).to.deep.equal([{ type: 'user', id: 'alice' }]);
  });

  it('agrees with RebacModel.check on every user, permission and object of the fixture', async () => {
    const s = await setup();
    const ev = new IREvaluator(mergeFragments([rebacToIR(schema)]).ir, rebacTupleSource(s.store));
    const users = ['alice', 'bob', 'olga', 'carol', 'frank', 'eve'];
    const objects = [...['d1', 'd2', 'd3'].map((id) => ({ type: 'doc', id })), ...['f0', 'f1'].map((id) => ({ type: 'folder', id }))];
    for (const [permission, target] of Object.entries(PERMISSIONS)) {
      const [type, relation] = target.split('#');
      for (const object of objects.filter((o) => o.type === type)) {
        for (const u of users) {
          const membership = await s.model.check(object, relation, { type: 'user', id: u });
          const { truth } = await ev.check({ principal: { type: 'user', id: u }, permission, resource: object });
          expect(truth, `${u} ${permission} ${object.id}`).to.equal(membership === 'member' ? 'allow' : membership === 'not' ? 'deny' : 'unknown');
        }
      }
    }
  });
});
