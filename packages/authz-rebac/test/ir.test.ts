import * as chai from 'chai';
import 'mocha';
import { IREvaluator, mergeFragments, validateIR } from '@spinajs/authz-ir';
import type { ObjectRef, TupleSource, TupleSubjectRef } from '@spinajs/authz-ir';
import { FakePermissionRegistry } from '@spinajs/authz-testing';

import { NamespaceSchema, RebacModel, isSubjectSet, rebacToIR } from '../src/index.js';
import type { TupleStore } from '../src/index.js';
import { NAMESPACES, PERMISSIONS, PERMISSION_INPUTS, setup } from './support/world.js';

const expect = chai.expect;

/** The IR evaluator's view of a TupleStore. */
function source(store: TupleStore): TupleSource {
  return {
    async *read(object: ObjectRef, relation: string): AsyncIterable<TupleSubjectRef> {
      for (const t of await store.read(object, relation)) yield isSubjectSet(t.subject) ? { type: t.subject.object.type, id: t.subject.object.id!, relation: t.subject.relation } : { type: t.subject.type, id: t.subject.id };
    },
    async *reverse(): AsyncIterable<ObjectRef> {},
    column: () => Promise.resolve(undefined),
  };
}

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
    const before = new RebacModel().toIR({ config: <T>(path: string) => (path === 'namespaces' ? NAMESPACES : PERMISSIONS) as T });
    expect(before.types).to.deep.equal(after.types);
  });

  it('agrees with RebacModel.check on every user, permission and object of the fixture', async () => {
    const s = await setup();
    const ev = new IREvaluator(mergeFragments([rebacToIR(schema)]).ir, source(s.store));
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
