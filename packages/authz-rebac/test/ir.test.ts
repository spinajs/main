import * as chai from 'chai';
import 'mocha';
import { fileURLToPath } from 'node:url';
import { DefaultConditionCompiler } from '@spinajs/authz';
import { GLOBAL_TYPE, IREvaluator, irToRebacConfig, mergeFragments, readOpenFga, validateIR, writeOpenFga } from '@spinajs/authz-ir';
import type { PolicyIR, RebacConfig } from '@spinajs/authz-ir';
import { FakePermissionRegistry, fakeEvaluationContext, fakeModelInitContext, readScenario } from '@spinajs/authz-testing';

import { MemoryTupleStore, NamespaceSchema, RebacModel, rebacTupleSource, rebacToIR } from '../src/index.js';
import { CAVEATS, CAVEAT_TUPLES, INPUTS, NS, caveatModel } from './support/caveat-world.js';
import { NAMESPACES, PERMISSIONS, PERMISSION_INPUTS, d1, setup, tuple, user } from './support/world.js';

const expect = chai.expect;

/** The namespaces without what mergeFragments adds: `$global` (`global` in OpenFGA) and a `parent` link to it on every other type. */
function withoutGlobal(namespaces: RebacConfig['namespaces']): RebacConfig['namespaces'] {
  return Object.fromEntries(
    Object.entries(namespaces)
      .filter(([name]) => name !== 'global')
      .map(([name, { relations, ...rest }]) => {
        const kept = Object.entries(relations ?? {}).filter(([r, allowed]) => r !== 'parent' || allowed.join() !== 'global');
        return [name, { ...(kept.length > 0 ? { relations: Object.fromEntries(kept) } : {}), ...rest }];
      }),
  );
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
    const config = new Map<string, unknown>([
      ['namespaces', NAMESPACES],
      ['permissions', PERMISSIONS],
    ]);
    const before = new RebacModel().toIR({ config: <T>(path: string, d?: T) => (config.get(path) ?? d) as T });
    expect(before.types).to.deep.equal(after.types);
  });

  it('compiles conditional subject types and the caveats', () => {
    const fragment = rebacToIR(NamespaceSchema.compile(NS, {}, CAVEATS));
    expect(fragment.types!.doc.relations.viewer.allowed).to.deep.equal(['user', { type: 'user', caveat: 'office_ip' }, { type: 'group#member', caveat: 'office_ip' }]);
    expect(fragment.caveats).to.deep.equal(CAVEATS);
    expect(validateIR(mergeFragments([fragment]).ir)).to.deep.equal([]);
    expect(rebacToIR(schema)).to.not.have.property('caveats');
  });

  it('round-trips conditional subject types and caveats through an OpenFGA model, and the imported model answers alike', async () => {
    const { dsl, warnings } = writeOpenFga(mergeFragments([rebacToIR(NamespaceSchema.compile(NS, { 'doc:read': 'doc#read' }, CAVEATS))]).ir);
    expect(warnings).to.deep.equal([]);
    const config = irToRebacConfig(readOpenFga(dsl));
    expect(config.problems).to.deep.equal([]);
    expect(config.caveats).to.deep.equal(CAVEATS);
    expect(config.permissions).to.deep.equal({ 'doc:read': 'doc#read' });
    const namespaces = withoutGlobal(config.namespaces);
    expect(namespaces).to.deep.equal(NS);
    const original = await caveatModel();
    const imported = new RebacModel({ store: new MemoryTupleStore(CAVEAT_TUPLES), namespaces, permissions: config.permissions, caveats: config.caveats });
    await imported.init(fakeModelInitContext({ permissions: INPUTS, model: imported.name }));
    const ctx = fakeEvaluationContext({ conditions: new DefaultConditionCompiler() });
    for (const env of [{}, { ip: '10.0.0.1' }, { ip: '10.0.0.2' }, { day: 10 }, { day: 25 }]) {
      for (const who of ['bob', 'carl', 'dora', 'erin']) {
        for (const id of ['d1', 'd2', 'd3']) {
          const doc = { type: 'doc', id };
          expect(await imported.check(doc, 'read', user(who), ctx, { env }), `${who} ${id} ${JSON.stringify(env)}`).to.equal(await original.check(doc, 'read', user(who), ctx, { env }));
        }
      }
    }
  });

  it('round-trips an OpenFGA model with conditions through authz.rebac', async () => {
    const source = (await readScenario(fileURLToPath(new URL('../../authz-testing/test/fixtures/scenarios/conditions.fga.yaml', import.meta.url)))).ir;
    const config = irToRebacConfig(source);
    expect(config.problems).to.deep.equal([]);
    const back: PolicyIR = readOpenFga(writeOpenFga(mergeFragments([rebacToIR(NamespaceSchema.compile(config.namespaces, config.permissions, config.caveats))]).ir).dsl);
    expect(withoutGlobal(irToRebacConfig(back).namespaces)).to.deep.equal(config.namespaces);
    const backTypes = new Map(Object.entries(back.types));
    for (const [type, def] of Object.entries(source.types)) {
      expect(backTypes.get(type)?.relations, type).to.deep.include(def.relations);
      expect(backTypes.get(type)?.permissions, type).to.deep.equal(def.permissions);
    }
    expect(Object.keys(back.types).filter((t) => t !== GLOBAL_TYPE)).to.have.members(Object.keys(source.types));
    expect(back.caveats).to.deep.equal(source.caveats);
  });

  it('the tuple source yields the caveat of a conditional tuple', async () => {
    const caveat = { name: 'not_expired', context: { 'env.until': 20 } };
    const store = new MemoryTupleStore([tuple(d1, 'viewer', user('alice')), { ...tuple(d1, 'viewer', user('bob')), caveat }]);
    const read: unknown[] = [];
    for await (const s of rebacTupleSource(store).read({ type: 'doc', id: 'd1' }, 'viewer')) read.push(s);
    expect(read).to.deep.equal([{ type: 'user', id: 'alice' }, { type: 'user', id: 'bob', caveat }]);
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
